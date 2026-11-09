import { env } from "cloudflare:workers";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { crossOrigin, json, limitedBody } from "../shared";

export const dynamic = "force-dynamic";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function audioFormat(type: string, bytes: Uint8Array) {
  if(bytes.length<32)return false;
  const ascii=(start:number,length:number)=>new TextDecoder().decode(bytes.subarray(start,start+length));
  const head=ascii(0,Math.min(bytes.length,65536));
  switch(type){
    case "audio/webm":return bytes[0]===0x1a&&bytes[1]===0x45&&bytes[2]===0xdf&&bytes[3]===0xa3
      && head.includes("webm")&&/A_(OPUS|VORBIS|AAC|PCM)/.test(head);
    case "audio/ogg":return head.startsWith("OggS")&&/OpusHead|vorbis|Speex   |FLAC/.test(head);
    case "audio/mp4":return ascii(4,4)==="ftyp"&&(head.includes("soun")||ascii(Math.max(0,bytes.length-65536),65536).includes("soun"));
    case "audio/wav":case "audio/x-wav":return head.startsWith("RIFF")&&ascii(8,4)==="WAVE"&&head.includes("fmt ")&&head.includes("data");
    default:return false;
  }
}

function audioKey(userId: string, id: string) {
  return `speaking/${encodeURIComponent(userId)}/${id}`;
}

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if (!env.BUCKET) return json({ error: "recordings_unavailable" }, 503);
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!["audio/webm","audio/ogg","audio/mp4","audio/wav","audio/x-wav"].includes(type)) return json({ error: "unsupported_audio" },415);
  const bytes = await limitedBody(request, 12 * 1024 * 1024);
  if (bytes instanceof Response) return bytes;
  if (!audioFormat(type, bytes)) return json({ error: "unsupported_audio" }, 415);
  const id = crypto.randomUUID();
  await env.BUCKET.put(audioKey(user.userId, id), bytes, { httpMetadata: { contentType: type } });
  return json({ id }, 201);
}

function byteRange(header: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(start) || start < 0 || start >= size || end < start) return null;
  return { offset: start, length: end - start + 1 };
}

export async function GET(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!uuid.test(id)) return json({ error: "invalid_recording_id" }, 400);
  const bucket = env.BUCKET;
  if (!bucket) return json({ error: "recordings_unavailable" }, 503);
  const key = audioKey(user.userId, id);
  const rangeHeader = request.headers.get("Range");
  let range: ReturnType<typeof byteRange> = null;
  if (rangeHeader !== null) {
    const metadata = await bucket.head(key);
    if (!metadata) return json({ error: "recording_not_found" }, 404);
    range = byteRange(rangeHeader, metadata.size);
    if (!range) return new Response(null, { status: 416, headers: {
      "Cache-Control": "private, no-store", "Content-Range": `bytes */${metadata.size}`,
    } });
  }
  const file = await bucket.get(key, range ? { range } : undefined);
  if (!file) return json({ error: "recording_not_found" }, 404);
  const headers = new Headers({
    "Accept-Ranges": "bytes", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store",
    "Content-Type": file.httpMetadata?.contentType ?? "application/octet-stream",
    "Content-Length": String(range?.length ?? file.size),
  });
  if (range) headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${file.size}`);
  return new Response(file.body, { status: range ? 206 : 200, headers });
}
