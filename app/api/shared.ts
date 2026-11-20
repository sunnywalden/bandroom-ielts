export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

// MT-3 (S8.1): shared consent gate for voice upload/playback/derived processing.
// Returns a 403 response when the tenant lacks active consent, else null.
// Dynamic imports keep this module free of a top-level DB dependency so lightweight
// tests that only use json/crossOrigin do not need to mock the database binding.
export async function consentGate(userId: string): Promise<Response | null> {
  const { env } = await import("cloudflare:workers");
  const { consentGateEnabled, assertConsent, ConsentError } = await import("@/lib/consent");
  // Explicit test-only opt-out (fixtures set BANDROOM_CONSENT_GATE=off). This is
  // the ONLY way to skip the gate; a missing DB binding must NOT silently allow
  // voice processing (security review: fail closed).
  if (!consentGateEnabled()) return null;
  if (!(env as { DB?: unknown }).DB) return json({ error: "consent_unavailable" }, 503);
  const { getDb } = await import("@/db");
  try {
    await assertConsent(getDb(), userId);
    return null;
  } catch (error) {
    if (error instanceof ConsentError) return json({ error: error.code, message: error.message }, 403);
    throw error;
  }
}

export function crossOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== new URL(request.url).origin) return true;
  // CSRF defence (rev2 S17). A browser-initiated cross-site request is refused
  // even if it omits Origin (older form posts). Non-browser clients (the runner,
  // CLI) send no Sec-Fetch-Site and are unaffected — we deliberately do NOT
  // require an Origin header, because service-token POSTs carry none.
  if (request.headers.get("Sec-Fetch-Site") === "cross-site") return true;
  return false;
}

export async function limitedBody(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer> | Response> {
  const tooLarge = () => json({ error: "payload_too_large" }, 413);
  if (Number(request.headers.get("Content-Length")) > maxBytes) return tooLarge();
  if (!request.body) return json({ error: "empty_body" }, 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return tooLarge();
      }
      chunks.push(value);
    }
  } catch {
    return json({ error: "unreadable_body" }, 400);
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
