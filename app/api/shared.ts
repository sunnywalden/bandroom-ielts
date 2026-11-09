export function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function crossOrigin(request: Request) {
  const origin = request.headers.get("Origin");
  return origin !== null && origin !== new URL(request.url).origin;
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
