import { env } from "cloudflare:workers";
import { requireUserScope } from "@/lib/route-guard";
import { consentGate, crossOrigin, json, limitedBody } from "../shared";
import { uuid } from "@/lib/recording-recovery";

export const dynamic = "force-dynamic";

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
  const auth = await requireUserScope({ write: true });
  if (auth instanceof Response) return auth;
  const user = auth.user;
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if(request.headers.get("X-Bandroom-Account")!==user.userId)return json({error:"refresh_account"},428);
  const denied = await consentGate(user.userId);
  if (denied) return denied;
  if (!env.BUCKET) return json({ error: "recordings_unavailable" }, 503);
  const type = (request.headers.get("Content-Type") ?? "").split(";")[0].trim().toLowerCase();
  if (!["audio/webm","audio/ogg","audio/mp4","audio/wav","audio/x-wav"].includes(type)) return json({ error: "unsupported_audio" },415);
  const bytes = await limitedBody(request, 12 * 1024 * 1024);
  if (bytes instanceof Response) return bytes;
  if (!audioFormat(type, bytes)) return json({ error: "unsupported_audio" }, 415);
  const day=request.headers.get("X-Bandroom-Day"),phase=request.headers.get("X-Bandroom-Phase"),attempt=request.headers.get("X-Bandroom-Attempt");
  if(day!==null||phase!==null||attempt!==null){
    if(!day||!/^\d{2}$/.test(day)||Number(day)<11||Number(day)>62||(phase!=="part2"&&phase!=="followup")||!attempt||!uuid.test(attempt))
      return json({error:"invalid_recording_context"},400);
    const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),x=>x.toString(16).padStart(2,"0")).join("");
    const key=audioKey(user.userId,attempt);
    const stored=await env.BUCKET.put(key,bytes,{onlyIf:{etagDoesNotMatch:"*"},httpMetadata:{contentType:type},customMetadata:{purpose:"speaking",day,phase,digest}});
    if(stored)return json({id:attempt},201);
    const old=await env.BUCKET.head(key),m=old?.customMetadata;
    if(m?.purpose==="speaking"&&m.day===day&&m.phase===phase&&m.digest===digest
      &&old?.size===bytes.byteLength&&old.httpMetadata?.contentType===type)return json({id:attempt},200);
    return json({error:"recording_id_conflict"},409);
  }
  const id = crypto.randomUUID();
  const assessment=request.headers.get("X-Bandroom-Purpose")==="assessment";
  await env.BUCKET.put(audioKey(user.userId, id), bytes, { httpMetadata: { contentType: type }, ...(assessment?{customMetadata:{purpose:"assessment"}}:{}) });
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
  const auth = await requireUserScope();
  if (auth instanceof Response) return auth;
  const user = auth.user;
  const denied = await consentGate(user.userId);
  if (denied) return denied;
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
