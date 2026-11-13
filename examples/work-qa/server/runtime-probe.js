import {maxProbeBytes, ownerSha256, probeAssets, uploadKeySha256} from "./runtime-probe-catalog.js";

export const scratchJobPattern = /^qa_probe_[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hex = /^[a-f0-9]{64}$/;
const scratchLifetimeMs = 60 * 60_000;
const root = "qa-runtime-probe/v26";
const assetKey = (name, index) => `${root}/assets/${name}/${index}`;
const scratchPrefix = jobId => `${root}/scratch/${jobId}/`;
const json = (body, status = 200) => Response.json(body, {status, headers: {"cache-control": "no-store"}});
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)),
  b => b.toString(16).padStart(2, "0")).join("");
const hashText = value => digest(new TextEncoder().encode(value));
const schema = (properties, required = Object.keys(properties)) => ({
  type: "object", properties, required, additionalProperties: false,
});
const job = {type: "string", pattern: scratchJobPattern.source};
const sha = {type: "string", pattern: hex.source};
const assetNames = Object.keys(probeAssets);

export const probeTools = [
  {
    name: "read_qa_probe_blob",
    description: "Owner-only isolated QA transport measurement. Read one bounded range of a pinned synthetic probe, ONNX graph, or wheel from private storage. Use structuredContent.base64 as opaque bytes with a code tool. Keep bytes out of messages.",
    inputSchema: schema({
      artifact: {type: "string", enum: assetNames},
      offset: {type: "integer", minimum: 0},
      length: {type: "integer", minimum: 1, maximum: maxProbeBytes},
    }),
    outputSchema: schema({
      artifact: {type: "string"}, offset: {type: "integer"}, length: {type: "integer"},
      totalBytes: {type: "integer"}, artifactSha256: sha, sha256: sha,
      serverMs: {type: "number"}, base64: {type: "string"},
    }),
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "manage_qa_probe_scratch",
    description: "Owner-only isolated synthetic checkpoint fixture. Create with a qa_probe_ UUID, recipeSha256 and checkpointSha256. Cleanup deletes this fixture, lease and checkpoints from QA storage. Hosted jobs are excluded.",
    inputSchema: schema({
      action: {type: "string", enum: ["create", "cleanup"]}, jobId: job,
      recipeSha256: sha, checkpointSha256: sha,
    }, ["action", "jobId"]),
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  },
];

export async function isProbeOwner(owner) {
  return typeof owner === "string" && await hashText(owner) === ownerSha256;
}

function getAsset(name) {
  return Object.hasOwn(probeAssets, name) ? probeAssets[name] : null;
}

function encodeBase64(bytes) {
  const stride = 12 * 1024;
  const encoded = [];
  for (let offset = 0; offset < bytes.length; offset += stride) {
    encoded.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + stride))));
  }
  return encoded.join("");
}

async function readBlob(env, args, reply, error) {
  const {artifact, offset, length} = args;
  const asset = typeof artifact === "string" && getAsset(artifact);
  if (!asset || Object.keys(args).length !== 3 || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 1 || length > maxProbeBytes || length > asset.byteLength - offset) {
    return error(-32602, "Invalid pinned probe range.");
  }
  const start = performance.now();
  const bytes = new Uint8Array(length);
  for (let copied = 0; copied < length;) {
    const position = offset + copied;
    const index = Math.floor(position / maxProbeBytes);
    const partOffset = position % maxProbeBytes;
    const part = asset.parts[index];
    const count = Math.min(length - copied, part.byteLength - partOffset);
    const object = await env.BUCKET.get(assetKey(artifact, index), {range: {offset: partOffset, length: count}});
    if (!object || object.size !== part.byteLength) return error(-32603, "Pinned probe asset unavailable.");
    const data = new Uint8Array(await object.arrayBuffer());
    if (data.byteLength !== count) return error(-32603, "Pinned probe range incomplete.");
    bytes.set(data, copied);
    copied += count;
  }
  const sha256 = await digest(bytes);
  const base64 = encodeBase64(bytes);
  const metadata = {artifact, offset, length, totalBytes: asset.byteLength, artifactSha256: asset.sha256,
    sha256, serverMs: performance.now() - start};
  return reply({structuredContent: {...metadata, base64}, content: [{type: "text", text: JSON.stringify(metadata)}]});
}

export function prepareProbeScratch(env) {
  return env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_runtime_probe_scratch (
    job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipe_sha TEXT NOT NULL,
    checkpoint_sha TEXT NOT NULL, expires_at INTEGER NOT NULL, closing INTEGER NOT NULL DEFAULT 0
  )`).run();
}

export function readProbeScratch(env, owner, args) {
  return env.DB.prepare(`SELECT checkpoint_sha AS checkpointSha256 FROM qa_runtime_probe_scratch
    WHERE job_id = ? AND owner = ? AND recipe_sha = ? AND closing = 0 AND expires_at > ?`)
    .bind(args.jobId, owner, args.recipeSha256, Date.now()).first();
}

export function probeCheckpointKey(jobId, sha256) {
  return scratchPrefix(jobId) + sha256;
}

async function createScratch(env, owner, args) {
  const {jobId, recipeSha256, checkpointSha256} = args;
  const recordingSha = await hashText(jobId);
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO qa_runtime_probe_scratch (job_id, owner, recipe_sha, checkpoint_sha, expires_at)
      VALUES (?, ?, ?, ?, ?)`).bind(jobId, owner, recipeSha256, checkpointSha256, Date.now() + scratchLifetimeMs),
    env.DB.prepare(`INSERT OR IGNORE INTO qa_acoustic_leases (job_id, recipe_sha, owner, recording_sha)
      SELECT job_id, recipe_sha, owner, ? FROM qa_runtime_probe_scratch
      WHERE job_id = ? AND owner = ? AND recipe_sha = ? AND checkpoint_sha = ? AND closing = 0 AND expires_at > ?`)
      .bind(recordingSha, jobId, owner, recipeSha256, checkpointSha256, Date.now()),
  ]);
  const scratch = await readProbeScratch(env, owner, args);
  if (scratch?.checkpointSha256 !== checkpointSha256) return {status: "fixture_conflict", jobId};
  return {status: "created", jobId, recipeSha256, checkpointSha256, recordingSha256: recordingSha};
}

export async function cleanupScratch(env, owner, jobId) {
  const fixture = await env.DB.prepare(`UPDATE qa_runtime_probe_scratch SET closing = 1
    WHERE job_id = ? AND owner = ? RETURNING checkpoint_sha AS checkpointSha256`).bind(jobId, owner).first();
  const other = fixture ? null : await env.DB.prepare(
    "SELECT 1 FROM qa_runtime_probe_scratch WHERE job_id = ?").bind(jobId).first();
  if (other) return {status: "unavailable", jobId};

  const objects = await env.BUCKET.list({prefix: scratchPrefix(jobId), limit: 10});
  if (objects.truncated) throw new Error("Scratch object bound exceeded.");
  if (objects.objects.length) await env.BUCKET.delete(objects.objects.map(object => object.key));
  const [parts, lease, record] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM qa_acoustic_parts WHERE job_id = ? AND EXISTS (
      SELECT 1 FROM qa_runtime_probe_scratch WHERE job_id = ? AND owner = ? AND closing = 1
    )`).bind(jobId, jobId, owner),
    env.DB.prepare("DELETE FROM qa_acoustic_leases WHERE job_id = ? AND owner = ?").bind(jobId, owner),
    env.DB.prepare("DELETE FROM qa_runtime_probe_scratch WHERE job_id = ? AND owner = ?").bind(jobId, owner),
  ]);
  const remaining = await env.BUCKET.list({prefix: scratchPrefix(jobId), limit: 1});
  return {status: remaining.objects.length ? "cleanup_pending" : "cleaned", jobId,
    deletedParts: parts.meta.changes, deletedLease: lease.meta.changes, deletedFixture: record.meta.changes,
    deletedObjects: objects.objects.length, remainingObjects: remaining.objects.length};
}

export async function probeTool(env, owner, name, args, reply, error, prepareAcoustics) {
  if (!await isProbeOwner(owner)) return error(-32001, "Probe owner access required.");
  if (!args || typeof args !== "object" || Array.isArray(args)) return error(-32602, "Invalid probe parameters.");
  try {
    if (name === "read_qa_probe_blob") return await readBlob(env, args, reply, error);
    const {action, jobId, recipeSha256, checkpointSha256} = args;
    const creating = action === "create" && Object.keys(args).length === 4 &&
      typeof recipeSha256 === "string" && hex.test(recipeSha256) &&
      typeof checkpointSha256 === "string" && hex.test(checkpointSha256);
    if (typeof jobId !== "string" || !scratchJobPattern.test(jobId) ||
        !(creating || action === "cleanup" && Object.keys(args).length === 2)) {
      return error(-32602, "Invalid synthetic probe fixture parameters.");
    }
    await prepareAcoustics(env);
    await prepareProbeScratch(env);
    const data = creating ? await createScratch(env, owner, args) : await cleanupScratch(env, owner, jobId);
    return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
  } catch {
    return error(-32603, "QA probe storage unavailable.", {retryable: true});
  }
}

export async function probeAssetRequest(request, env, url) {
  const key = request.headers.get("x-bandroom-probe-key");
  if (request.headers.has("origin") || request.headers.has("oai-authenticated-user-id") ||
      !key || key.length > 128 || await hashText(key) !== uploadKeySha256) {
    return json({error: "Probe service access required"}, 401);
  }
  if (request.method === "DELETE") {
    const keys = assetNames.flatMap(name => probeAssets[name].parts.map((_, index) => assetKey(name, index)));
    await env.BUCKET.delete(keys);
    return json({status: "deleted", objectSlots: keys.length});
  }
  if (request.method !== "PUT") return json({error: "Method not allowed"}, 405);
  const name = url.searchParams.get("artifact");
  const index = Number(url.searchParams.get("index"));
  const part = getAsset(name)?.parts[index];
  if (!part || !url.searchParams.has("index") || Number(request.headers.get("content-length")) !== part.byteLength) {
    return json({error: "Pinned probe part and exact content-length required"}, 400);
  }
  const data = await request.arrayBuffer();
  if (data.byteLength !== part.byteLength || await digest(data) !== part.sha256) {
    return json({error: "Probe part integrity mismatch"}, 400);
  }
  await env.BUCKET.put(assetKey(name, index), data, {sha256: part.sha256});
  return json({artifact: name, index, ...part});
}
