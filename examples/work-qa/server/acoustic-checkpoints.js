import {isProbeOwner, prepareProbeScratch, probeCheckpointKey, readProbeScratch, scratchJobPattern} from "./runtime-probe.js";
import {fullSpeechMode} from "./pronunciation.js";
import {hostedJobPattern, prepareEvents} from "./work-events.js";

const maxBytes = 24 * 1024;
const maxParts = 8192;
const leaseMs = 10 * 60_000;
const retryMs = 30_000;
const jobPattern = new RegExp(hostedJobPattern);
const checkpointJobPattern = `(?:${hostedJobPattern})|(?:${scratchJobPattern.source})`;
const isScratch = args => scratchJobPattern.test(args.jobId);
const digestPattern = /^[a-f0-9]{64}$/;
const runPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const base64Pattern = /^[A-Za-z0-9+/]+={0,2}$/;
const retryReasons = ["recording_read_failed", "checkpoint_read_failed", "checkpoint_write_failed", "bundle_read_failed", "bundle_integrity_failed", "runtime_unavailable", "compute_budget"];
const binding = {
  jobId: {type: "string", pattern: checkpointJobPattern},
  recipeSha256: {type: "string", pattern: digestPattern.source},
  runId: {type: "string", pattern: runPattern.source},
};
const lease = {...binding, fence: {type: "integer", minimum: 1}};
const part = {type: "integer", minimum: 0, maximum: maxParts - 1};
const tools = [
  ["claim_qa_acoustic", "Acquire an acoustic checkpoint lease for this isolated original recording. Reclaim before expiry with the same run ID to renew without changing the fence. Use a new UUID for each distinct Work execution and reuse the same recipe SHA-256 across runs. Returns the committed prefix length and original recording SHA-256.", binding, false],
  ["save_qa_acoustic_checkpoint", "Append one SHA-256 verified checkpoint part (maximum 24576 bytes). Parts start at zero and must be contiguous. Use the same bytes and index after an ambiguous write. A receipt only proves stored bytes.", {...lease, index: part, sha256: {type: "string", pattern: digestPattern.source}, base64: {type: "string", maxLength: maxBytes * 4 / 3}}, false],
  ["read_qa_acoustic_checkpoint", "Read and integrity-check one committed checkpoint part from the current job and recipe under an active lease. Keep checkpoint bytes private.", {...lease, index: part}, true],
  ["retry_qa_acoustic", "Release the acoustic lease and make the same isolated job eligible for the next Work run after server backoff. All committed parts remain available.", {...lease, reason: {type: "string", enum: retryReasons}}, false],
];

export const acousticTools = tools.map(([name, description, properties, readOnlyHint]) => ({
  name, description,
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
    properties, required: Object.keys(properties), additionalProperties: false,
  },
  annotations: {readOnlyHint, destructiveHint: false, idempotentHint: true, openWorldHint: false},
}));

export async function prepareAcoustics(env) {
  await prepareEvents(env);
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_acoustic_leases (
      job_id TEXT PRIMARY KEY, recipe_sha TEXT NOT NULL, owner TEXT NOT NULL, recording_sha TEXT NOT NULL,
      run_id TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER NOT NULL DEFAULT 0,
      retry_at INTEGER NOT NULL DEFAULT 0, retry_reason TEXT, next_index INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_acoustic_parts (
      job_id TEXT NOT NULL, recipe_sha TEXT NOT NULL, part_index INTEGER NOT NULL,
      sha256 TEXT NOT NULL, byte_length INTEGER NOT NULL, object_key TEXT NOT NULL,
      run_id TEXT NOT NULL, fence INTEGER NOT NULL,
      PRIMARY KEY (job_id, recipe_sha, part_index)
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_acoustic_completions (
      job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, recipe_sha TEXT NOT NULL,
      recording_sha TEXT NOT NULL, run_id TEXT NOT NULL, fence INTEGER NOT NULL,
      output_sha TEXT NOT NULL, output_index INTEGER NOT NULL, payload_sha TEXT NOT NULL,
      receipt TEXT NOT NULL, created_at INTEGER NOT NULL
    )`),
  ]);
}

const candidateTables = `FROM qa_audio_processing a
  JOIN qa_outbox q ON q.id = a.job_id AND q.kind = 'event'
  JOIN qa_subscriptions s ON s.id = q.subscription AND s.owner = a.owner
  JOIN qa_pronunciation p ON p.job_id = a.job_id AND p.sha256 = a.input_sha
  JOIN qa_recording_objects o ON o.job_id = a.job_id`;
const candidateConditions = `s.verified = 1 AND p.mode = '${fullSpeechMode}' AND o.byte_length > 0
    AND a.state <> 'complete' AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = a.job_id)`;
const candidates = `${candidateTables} WHERE ${candidateConditions}`;
const eligible = `EXISTS (SELECT 1 ${candidates} AND a.job_id = qa_acoustic_leases.job_id
  AND a.owner = qa_acoustic_leases.owner AND a.input_sha = qa_acoustic_leases.recording_sha
  AND NOT EXISTS (SELECT 1 FROM qa_drained_jobs d
    WHERE d.job_id = a.job_id AND d.owner = a.owner))`;
const scope = "job_id = ? AND recipe_sha = ? AND owner = ?";
const scratchEligible = `EXISTS (SELECT 1 FROM qa_runtime_probe_scratch s
  WHERE s.job_id = qa_acoustic_leases.job_id AND s.owner = qa_acoustic_leases.owner
  AND s.recipe_sha = qa_acoustic_leases.recipe_sha AND s.closing = 0
  AND s.expires_at > CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`;
const availableScope = scratch => scope + " AND " + (scratch ? scratchEligible : eligible);
const liveScope = scratch => availableScope(scratch) + " AND run_id = ? AND fence = ? AND lease_until > ?";
const leaseFields = `recording_sha AS recordingSha256, run_id AS runId, fence, lease_until AS leaseUntil,
  retry_at AS retryAt, retry_reason AS retryReason, next_index AS nextIndex`;
const partFields = "part_index AS 'index', sha256, byte_length AS byteLength, run_id AS writtenByRun, fence AS writtenByFence";

function identity(owner, args) {
  return [args.jobId, args.recipeSha256, owner];
}

function liveIdentity(owner, args, now = Date.now()) {
  return [...identity(owner, args), args.runId, args.fence, now];
}

function readLease(env, owner, args) {
  return env.DB.prepare(`SELECT ${leaseFields} FROM qa_acoustic_leases WHERE ${availableScope(isScratch(args))}`).bind(...identity(owner, args)).first();
}

export function activeLease(env, owner, args) {
  return scopedActiveLease(env, owner, args, false);
}

function scopedActiveLease(env, owner, args, scratch = isScratch(args)) {
  return env.DB.prepare(`SELECT ${leaseFields} FROM qa_acoustic_leases WHERE ${liveScope(scratch)}`).bind(...liveIdentity(owner, args)).first();
}

function readPart(env, args) {
  return env.DB.prepare(`SELECT ${partFields}, object_key AS objectKey FROM qa_acoustic_parts
    WHERE job_id = ? AND recipe_sha = ? AND part_index = ?`).bind(args.jobId, args.recipeSha256, args.index).first();
}

function encode(bytes) {
  return btoa(String.fromCharCode(...bytes));
}

async function sha256(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function storePart(bucket, key, bytes, digest) {
  let condition = {etagDoesNotMatch: "*"};
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await bucket.put(key, bytes, {onlyIf: condition, sha256: digest})) return true;
    const object = await bucket.get(key);
    if (object && await sha256(await object.arrayBuffer()) === digest) return true;
    condition = object ? {etagMatches: object.etag} : {etagDoesNotMatch: "*"};
  }
  return false;
}

async function claim(env, owner, args) {
  const now = Date.now();
  if (!isScratch(args)) {
    await env.DB.prepare(`INSERT OR IGNORE INTO qa_acoustic_leases (job_id, recipe_sha, owner, recording_sha)
      SELECT a.job_id, ?, a.owner, a.input_sha ${candidates} AND a.job_id = ? AND a.owner = ?`)
      .bind(args.recipeSha256, args.jobId, owner).run();
  }
  const acquired = await env.DB.prepare(`UPDATE qa_acoustic_leases
    SET run_id = ?, fence = CASE WHEN run_id = ? THEN fence ELSE fence + 1 END,
      lease_until = MAX(lease_until, ?), retry_at = 0, retry_reason = NULL
    WHERE ${availableScope(isScratch(args))} AND (
      (run_id = ? AND lease_until > ?) OR
      (lease_until <= ? AND retry_at <= ? AND (run_id IS NULL OR run_id <> ?))
    )
    RETURNING ${leaseFields}`)
    .bind(args.runId, args.runId, now + leaseMs, ...identity(owner, args), args.runId, now, now, now, args.runId).first();
  const current = acquired ?? await readLease(env, owner, args);
  if (!current) return {status: "unavailable"};
  if (current.runId === args.runId && current.leaseUntil > now) return {status: "leased", ...current};
  if (current.leaseUntil > now) return {status: "busy", availableAt: current.leaseUntil};
  if (current.retryAt > now) return {status: "waiting", availableAt: current.retryAt};
  return {status: "new_run_required"};
}

export async function pendingAcoustics(env, owner) {
  await prepareAcoustics(env);
  const now = Date.now();
  const {results} = await env.DB.prepare(`SELECT a.job_id AS jobId, a.input_sha AS recordingSha256,
      l.recipe_sha AS recipeSha256, COALESCE(l.next_index, 0) AS nextIndex, l.retry_reason AS retryReason,
      MAX(COALESCE(l.retry_at, 0), COALESCE(l.lease_until, 0)) AS availableAt
    ${candidateTables} LEFT JOIN qa_acoustic_leases l ON l.job_id = a.job_id
    WHERE ${candidateConditions} AND a.owner = ?
      AND NOT EXISTS (SELECT 1 FROM qa_drained_jobs d WHERE d.job_id = a.job_id AND d.owner = ?)
    ORDER BY availableAt > ? ASC, availableAt ASC, a.created_at ASC, a.job_id ASC LIMIT 50`)
    .bind(owner, owner, now).all();
  return results;
}

async function save(env, owner, args) {
  const bytes = Uint8Array.from(atob(args.base64), char => char.charCodeAt(0));
  if (!bytes.length || encode(bytes) !== args.base64 || await sha256(bytes) !== args.sha256) {
    return {status: "invalid_checkpoint"};
  }
  const current = await scopedActiveLease(env, owner, args);
  if (!current) return {status: "lease_lost"};
  const receipt = entry => {
    if (entry.sha256 !== args.sha256) return {status: "index_conflict", nextIndex: current.nextIndex};
    const data = {...entry};
    delete data.objectKey;
    return {status: "stored", ...data, nextIndex: Math.max(current.nextIndex, args.index + 1)};
  };
  if (args.index < current.nextIndex) {
    const prior = await readPart(env, args);
    if (!prior) return {status: "checkpoint_unavailable"};
    if (prior.sha256 !== args.sha256) return receipt(prior);
    if (!await storePart(env.BUCKET, prior.objectKey, bytes, prior.sha256)) {
      return {status: "checkpoint_unavailable"};
    }
    if (!await scopedActiveLease(env, owner, args)) return {status: "lease_lost"};
    return receipt(prior);
  }
  if (args.index !== current.nextIndex) return {status: "out_of_order", nextIndex: current.nextIndex};

  const objectKey = isScratch(args) ? probeCheckpointKey(args.jobId, args.sha256)
    : `qa-acoustic/${args.jobId}/${current.recordingSha256}/${args.recipeSha256}/${args.index}/${args.sha256}`;
  if (!await storePart(env.BUCKET, objectKey, bytes, args.sha256)) return {status: "checkpoint_unavailable"};
  const now = Date.now();
  const [committed] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO qa_acoustic_parts
      (job_id, recipe_sha, part_index, sha256, byte_length, object_key, run_id, fence)
      SELECT job_id, recipe_sha, ?, ?, ?, ?, run_id, fence FROM qa_acoustic_leases
      WHERE ${liveScope(isScratch(args))} AND next_index = ? RETURNING ${partFields}`)
      .bind(args.index, args.sha256, bytes.length, objectKey, ...liveIdentity(owner, args, now), args.index),
    env.DB.prepare(`UPDATE qa_acoustic_leases SET next_index = next_index + 1
      WHERE ${liveScope(isScratch(args))} AND next_index = ? AND EXISTS (
        SELECT 1 FROM qa_acoustic_parts p WHERE p.job_id = qa_acoustic_leases.job_id
          AND p.recipe_sha = qa_acoustic_leases.recipe_sha AND p.part_index = qa_acoustic_leases.next_index
      )`).bind(...liveIdentity(owner, args, now), args.index),
  ]);
  if (committed.results.length) return receipt(committed.results[0]);
  if (!await scopedActiveLease(env, owner, args)) {
    if (isScratch(args) && !await readProbeScratch(env, owner, args)) await env.BUCKET.delete(objectKey);
    return {status: "lease_lost"};
  }
  const prior = await readPart(env, args);
  return prior ? receipt(prior) : {status: "checkpoint_unavailable"};
}

async function read(env, owner, args) {
  const current = await scopedActiveLease(env, owner, args);
  if (!current) return {status: "lease_lost"};
  if (args.index >= current.nextIndex) return {status: "checkpoint_not_found", nextIndex: current.nextIndex};
  const entry = await readPart(env, args);
  if (!entry) return {status: "checkpoint_unavailable"};
  const {objectKey, ...receipt} = entry;
  const object = await env.BUCKET.get(objectKey);
  if (!object) return {status: "checkpoint_unavailable"};
  if (object.size !== entry.byteLength) {
    await object.body.cancel();
    return {status: "checkpoint_corrupt"};
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== entry.byteLength || await sha256(bytes) !== entry.sha256) {
    return {status: "checkpoint_corrupt"};
  }
  if (!await scopedActiveLease(env, owner, args)) return {status: "lease_lost"};
  return {status: "available", ...receipt, base64: encode(bytes)};
}

async function retry(env, owner, args) {
  const now = Date.now();
  const released = await env.DB.prepare(`UPDATE qa_acoustic_leases
    SET lease_until = 0, retry_at = ?, retry_reason = ? WHERE ${liveScope(isScratch(args))} RETURNING ${leaseFields}`)
    .bind(now + retryMs, args.reason, ...liveIdentity(owner, args, now)).first();
  const current = released ?? await readLease(env, owner, args);
  if (current?.runId === args.runId && current.fence === args.fence && current.retryAt > 0 && current.retryReason === args.reason) {
    return {status: "retry_scheduled", availableAt: current.retryAt, nextIndex: current.nextIndex};
  }
  return {status: "lease_lost"};
}

const handlers = {
  claim_qa_acoustic: claim, save_qa_acoustic_checkpoint: save,
  read_qa_acoustic_checkpoint: read, retry_qa_acoustic: retry,
};

function validArgs(name, args) {
  const schema = acousticTools.find(tool => tool.name === name)?.inputSchema;
  if (!schema || typeof args !== "object" || args === null || Array.isArray(args) ||
      Object.keys(args).some(key => !Object.hasOwn(schema.properties, key)) ||
      typeof args.jobId !== "string" || !(jobPattern.test(args.jobId) || isScratch(args)) ||
      typeof args.recipeSha256 !== "string" || !digestPattern.test(args.recipeSha256) ||
      typeof args.runId !== "string" || !runPattern.test(args.runId)) return false;
  if (name === "claim_qa_acoustic") return true;
  if (!Number.isSafeInteger(args.fence) || args.fence < 1) return false;
  if (name === "retry_qa_acoustic") return retryReasons.includes(args.reason);
  if (!Number.isSafeInteger(args.index) || args.index < 0 || args.index >= maxParts) return false;
  if (name === "read_qa_acoustic_checkpoint") return true;
  return typeof args.sha256 === "string" && digestPattern.test(args.sha256) &&
    typeof args.base64 === "string" && args.base64.length <= maxBytes * 4 / 3 &&
    args.base64.length % 4 === 0 && base64Pattern.test(args.base64);
}

export async function acousticTool(env, owner, name, args, reply, error) {
  if (!validArgs(name, args)) return error(-32602, "Invalid acoustic checkpoint parameters.");
  try {
    if (isScratch(args) && !await isProbeOwner(owner)) return error(-32001, "Probe owner access required.");
    await prepareAcoustics(env);
    if (isScratch(args)) {
      await prepareProbeScratch(env);
      const scratch = await readProbeScratch(env, owner, args);
      if (!scratch) return reply({structuredContent: {status: "unavailable"}, content: [{type: "text", text: "Scratch fixture unavailable."}]});
      if (args.index > 0 || (name === "save_qa_acoustic_checkpoint" && args.sha256 !== scratch.checkpointSha256)) {
        return error(-32602, "Only the pinned synthetic checkpoint is allowed.");
      }
    }
    const data = {jobId: args.jobId, recipeSha256: args.recipeSha256, ...await handlers[name](env, owner, args)};
    return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
  } catch {
    return error(-32603, "Acoustic checkpoint storage is temporarily unavailable.", {retryable: true});
  }
}
