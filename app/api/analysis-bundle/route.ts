import { env } from "cloudflare:workers";
import { verifyBundleToken } from "@/lib/analysis-bundle";

export const dynamic = "force-dynamic";

function denied(status: number) {
  return new Response(JSON.stringify({ error: "bundle_access_denied" }), {
    status, headers: { "Cache-Control": "private, no-store", "Content-Type": "application/json", "Referrer-Policy": "no-referrer" },
  });
}

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

export async function GET(request: Request) {
  // Capability URLs are for code-capable cloud runs, not browser fetch.
  if (request.headers.get("Origin")) return denied(403);
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const secret = env.ANALYSIS_SIGNING_KEY;
  if (!secret || secret.length < 32) return denied(503);
  const payload = await verifyBundleToken(secret, token, Date.now());
  if (!payload || !/^analysis\/[A-Za-z0-9._-]{1,120}\/bundle\.tar\.zst$/.test(payload.key)) return denied(403);
  const bucket = env.BUCKET;
  if (!bucket) return denied(503);
  const metadata = await bucket.head(payload.key);
  if (!metadata) return denied(404);
  const rangeHeader = request.headers.get("Range");
  const range = rangeHeader ? byteRange(rangeHeader, metadata.size) : null;
  if (rangeHeader && !range) {
    return new Response(null, {
      status: 416, headers: {
        "Cache-Control": "private, no-store", "Content-Range": `bytes */${metadata.size}`, "Referrer-Policy": "no-referrer",
      },
    });
  }
  const file = await bucket.get(payload.key, range ? { range } : undefined);
  if (!file) return denied(404);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Type": "application/zstd",
    "Content-Disposition": 'attachment; filename="bandroom-analysis-bundle.tar.zst"',
    "Content-Length": String(range?.length ?? file.size),
    "Accept-Ranges": "bytes",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${metadata.size}`);
  return new Response(file.body, { status: range ? 206 : 200, headers });
}
