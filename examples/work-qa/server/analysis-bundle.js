import {activeLease, prepareAcoustics} from "./acoustic-checkpoints.js";
import {hash} from "./acoustic-completion.js";

const hex = /^[a-f0-9]{64}$/;
const maxPart = 6 * 1024 * 1024;
const json = (body, status = 200) => Response.json(body, {status, headers: {"cache-control": "no-store"}});
const encode = value => new TextEncoder().encode(value);
const base64url = bytes => btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const unbase64url = str => Uint8Array.from(atob(str.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
const key = async env => crypto.subtle.importKey("raw", encode(env.QA_BUNDLE_KEY), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
const manifestKey = sha => "analysis/sha256/" + sha + "/manifest.json";
const partKey = sha => "analysis/parts/" + sha;
export const analysisBundleTool = {
  name: "get_analysis_bundle",
  description: "Issue a short-lived owner-authenticated download grant for the fixed-SHA private R2 acoustic runtime bundle. Requires this job's active recipe/run/fence. Download URLs need Sites service authorization at this same private origin; get_site supplies it. Keep credentials out of outputs. No GitHub or Hugging Face runtime download.",
  inputSchema: {type: "object", additionalProperties: false,
    properties: {jobId: {type: "string"}, recipeSha256: {type: "string", pattern: hex.source}, runId: {type: "string"}, fence: {type: "integer", minimum: 1}},
    required: ["jobId", "recipeSha256", "runId", "fence"]},
  annotations: {readOnlyHint: true, destructiveHint: false, openWorldHint: false},
};

function validManifest(m) {
  return m?.schema === "bandroom.qa.analysis-bundle.v1" && hex.test(m.bundleSha256 ?? "") &&
    Number.isSafeInteger(m.byteLength) && m.byteLength > 0 && m.byteLength <= 512 * 1024 * 1024 &&
    Array.isArray(m.parts) && m.parts.length > 0 && m.parts.length <= 100 &&
    m.parts.every(p => hex.test(p.sha256 ?? "") && Number.isSafeInteger(p.byteLength) && p.byteLength > 0 && p.byteLength <= maxPart) &&
    m.parts.reduce((n, p) => n + p.byteLength, 0) === m.byteLength;
}

async function pinnedManifest(env) {
  if (!hex.test(env.QA_ANALYSIS_MANIFEST_SHA256 ?? "") || !env.QA_BUNDLE_KEY) throw new Error("bundle_unconfigured");
  const object = await env.BUCKET.get(manifestKey(env.QA_ANALYSIS_MANIFEST_SHA256));
  if (!object || object.size > 65536) throw new Error("bundle_manifest_unavailable");
  const data = await object.arrayBuffer();
  if (await hash(data) !== env.QA_ANALYSIS_MANIFEST_SHA256) throw new Error("bundle_manifest_integrity");
  const manifest = JSON.parse(new TextDecoder().decode(data));
  if (!validManifest(manifest)) throw new Error("bundle_manifest_invalid");
  return manifest;
}

export async function getAnalysisBundle(env, owner, args, reply, error) {
  await prepareAcoustics(env);
  if (!args || Object.keys(args).some(k => !["jobId", "recipeSha256", "runId", "fence"].includes(k)) ||
    typeof args.jobId !== "string" || args.jobId.length > 80 || !hex.test(args.recipeSha256 ?? "") ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(args.runId ?? "") ||
    !Number.isSafeInteger(args.fence) || args.fence < 1) return error(-32602, "Invalid bundle lease binding.");
  const lease = await activeLease(env, owner, args);
  if (!lease) return error(-32009, "Active owner lease required for the analysis bundle.");
  let manifest;
  try { manifest = await pinnedManifest(env); }
  catch (e) { return error(-32603, e.message, {retryable: true}); }
  const expiresAt = Math.min(lease.leaseUntil, Date.now() + 5 * 60 * 1000);
  const claim = {purpose: "qa-analysis-bundle", owner, jobId: args.jobId, recipeSha256: args.recipeSha256,
    runId: args.runId, fence: args.fence, manifestSha256: env.QA_ANALYSIS_MANIFEST_SHA256, expiresAt};
  const body = base64url(encode(JSON.stringify(claim)));
  const signature = base64url(new Uint8Array(await crypto.subtle.sign("HMAC", await key(env), encode(body))));
  const grant = body + "." + signature;
  const data = {...manifest, manifestSha256: env.QA_ANALYSIS_MANIFEST_SHA256, expiresAt,
    parts: manifest.parts.map(p => ({...p, path: "/qa/hosted-review?bundlePart=" + p.sha256 + "&grant=" + grant})),
    authorization: "Use OAI-Sites-Authorization from get_site at the QA origin only. Never log credentials or grants."};
  return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
}

export async function analysisBundleRequest(request, env) {
  const url = new URL(request.url);
  // The private Sites front door authenticates service callers. Browser-origin
  // requests are excluded; uploading additionally requires a separate QA key.
  if (request.headers.has("origin") || request.headers.has("oai-authenticated-user-id")) return json({error: "Site service access required"}, 401);
  if (url.pathname === "/qa/analysis-bundle/upload" && request.method === "PUT") {
    if (!env.QA_BUNDLE_KEY || request.headers.get("x-bandroom-bundle-key") !== env.QA_BUNDLE_KEY) return json({error: "Unauthorized"}, 401);
    const sha = url.searchParams.get("sha256");
    const kind = url.searchParams.get("kind");
    if (!hex.test(sha ?? "") || !["part", "manifest"].includes(kind)) return json({error: "Invalid upload"}, 400);
    const limit = kind === "manifest" ? 65536 : maxPart;
    const size = Number(request.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size < 1 || size > limit) return json({error: "Bounded content-length required"}, 413);
    const data = await request.arrayBuffer();
    if (data.byteLength !== size || await hash(data) !== sha) return json({error: "Digest or length mismatch"}, 400);
    if (kind === "manifest") {
      if (sha !== env.QA_ANALYSIS_MANIFEST_SHA256) return json({error: "Manifest is not pinned"}, 409);
      let manifest;
      try { manifest = JSON.parse(new TextDecoder().decode(data)); } catch { return json({error: "Invalid manifest JSON"}, 400); }
      if (!validManifest(manifest)) return json({error: "Invalid manifest"}, 400);
      for (const part of manifest.parts) {
        const object = await env.BUCKET.head(partKey(part.sha256));
        if (!object || object.size !== part.byteLength) return json({error: "Bundle part missing", sha256: part.sha256}, 409);
      }
    }
    const objectKey = kind === "manifest" ? manifestKey(sha) : partKey(sha);
    const written = await env.BUCKET.put(objectKey, data, {onlyIf: {etagDoesNotMatch: "*"}, sha256: sha});
    if (!written) {
      const existing = await env.BUCKET.get(objectKey);
      if (!existing || existing.size !== size || await hash(await existing.arrayBuffer()) !== sha) return json({error: "Immutable object conflict"}, 409);
    }
    return json({sha256: sha, byteLength: size, duplicate: !written});
  }
  const digest = url.pathname === "/qa/hosted-review" ? url.searchParams.get("bundlePart")
    : /^\/qa\/analysis-bundle\/parts\/([a-f0-9]{64})$/.exec(url.pathname)?.[1];
  if (!hex.test(digest ?? "") || request.method !== "GET" || !env.QA_BUNDLE_KEY) return json({error: "Not found"}, 404);
  const grant = url.searchParams.get("grant") ?? "";
  if (grant.length > 2048) return json({error: "Invalid grant"}, 401);
  const [body, signature, extra] = grant.split(".");
  let claim;
  try {
    if (extra || !await crypto.subtle.verify("HMAC", await key(env), unbase64url(signature), encode(body))) throw new Error();
    claim = JSON.parse(new TextDecoder().decode(unbase64url(body)));
    if (claim.purpose !== "qa-analysis-bundle" || claim.manifestSha256 !== env.QA_ANALYSIS_MANIFEST_SHA256 || claim.expiresAt <= Date.now()) throw new Error();
  } catch { return json({error: "Invalid or expired grant"}, 401); }
  await prepareAcoustics(env);
  if (!await activeLease(env, claim.owner, claim)) return json({error: "Lease lost"}, 409);
  let manifest;
  try { manifest = await pinnedManifest(env); } catch { return json({error: "Bundle unavailable"}, 503); }
  const part = manifest.parts.find(p => p.sha256 === digest);
  if (!part) return json({error: "Part is not in pinned bundle"}, 404);
  const object = await env.BUCKET.get(partKey(part.sha256));
  if (!object || object.size !== part.byteLength) return json({error: "Part unavailable"}, 503);
  return new Response(object.body, {headers: {"content-type": "application/octet-stream", "content-length": String(part.byteLength),
    "x-content-sha256": part.sha256, "cache-control": "no-store"}});
}
