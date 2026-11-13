// v26 server-side acceptance regression: append-only wake log (M13), queue
// drain (M6), durable subscription observation (M7), prefix part boundary
// (B1) and the output-manifest contract (B2) plus the server-side negative
// matrix from M14. This is an isolated Miniflare run, not official Work.
import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";
import fullInterviewAudio from "../dist/server/qa-full-interview-audio.js";

const [wranglerProject, artifactDirectory, exportDirectory] = process.argv.slice(2);
if (!wranglerProject || Boolean(artifactDirectory) !== Boolean(exportDirectory)) {
  throw new Error("Usage: node qa-v26-acceptance.test.mjs WRANGLER_PROJECT [PREFIX_ARTIFACT_DIR EXPORT_DIR]");
}
const require = createRequire(resolve(wranglerProject, "package.json"));
const {Miniflare, Response} = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "bandroom-v26-acceptance-"));
const owner = "v26-admin-owner";
const otherOwner = "v26-other-owner";
const ownerHeaders = {"oai-authenticated-user-id": owner};
const otherHeaders = {"oai-authenticated-user-id": otherOwner};
const serviceKey = "v26-local-probe-service-key";
const relayKey = randomBytes(32).toString("base64");
const digest = value => createHash("sha256").update(value).digest("hex");
const maxPart = 24 * 1024;
const prefixBytes = 125_976;
const prefixParts = 6;
const encoderSha = "913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c";
const probeHeadSha = "813c832bebffb68087be08544a1be100c1e73dda6f431d7a4731084e22430370";
const truthSha = "394fcb74a4221278aa7df02ead49a3743da6293c527617c7f973b1a52c062e28";
const feedback = "声学链路验收（不代表纠音盲测达标）。v26 本地回归：检查点链、冷续等价与绑定回写均通过。";
const anchors = [
  {source: "human_annotation", truthSha256: truthSha, word: "business", start: 3.36, end: 3.66},
  {source: "human_annotation", truthSha256: truthSha, word: "and", start: 11.44, end: 11.74},
  {source: "human_annotation", truthSha256: truthSha, word: "suitcase", start: 55.209724, end: 55.509724},
];
const hjkJobId = "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710";
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const eightMiB = Buffer.alloc(8 * 1024 * 1024, 7);

// Override the pinned owner/service hashes for this isolated local run only.
const catalogName = "runtime-probe-catalog.js";
const files = ["index.js", ...(await readdir(root)).filter(name => name.endsWith(".js") && name !== "index.js")];
const modules = await Promise.all(files.map(async name => {
  let contents = await readFile(join(root, name), "utf8");
  if (name === catalogName) {
    contents = contents
      .replace(/ownerSha256 = "[a-f0-9]{64}"/, `ownerSha256 = ${JSON.stringify(digest(owner))}`)
      .replace(/uploadKeySha256 = "[a-f0-9]{64}"/, `uploadKeySha256 = ${JSON.stringify(digest(serviceKey))}`)
      .replaceAll("0f1441ff6d472cf6a88941021563d6be4d5e86e64ae3820c9005bced5ae79c23", digest(eightMiB));
  }
  return {type: "ESModule", path: join(root, name), contents};
}));
const worker = new Miniflare({
  host: "127.0.0.1", cf: false, modulesRoot: root, modules,
  compatibilityDate: "2025-03-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  bindings: {QA_RELAY_KEY: relayKey},
  async outboundService(request) {
    const payload = await request.json();
    return payload.type === "verification" ? Response.json({challenge: payload.challenge}) : new Response(null, {status: 204});
  },
});
const request = (path, options) => worker.dispatchFetch("http://localhost" + path, options);
const rpc = async (method, params, headers = ownerHeaders) => {
  const response = await request("/mcp", {method: "POST", headers: {...headers, "content-type": "application/json"},
    body: JSON.stringify({id: 1, method, params})});
  return {http: response.status, ...await response.json()};
};
const raw = (name, args, headers) => rpc("tools/call", {name, arguments: args}, headers);
const tool = async (name, args, headers) => {
  const response = await raw(name, args, headers);
  assert.equal(response.http, 200);
  assert.ifError(response.error);
  return response.result.structuredContent;
};
const binding = ({jobId, recipeSha256, runId, fence}) => ({jobId, recipeSha256, runId, fence});
const claimBinding = ({jobId, recipeSha256, runId}) => ({jobId, recipeSha256, runId});
const write = (args, index, bytes) => tool("save_qa_acoustic_checkpoint", {
  ...binding(args), index, sha256: digest(bytes), base64: bytes.toString("base64"),
});
const readPart = (args, index) => tool("read_qa_acoustic_checkpoint", {...binding(args), index});
const status = (headers = ownerHeaders) => tool("read_qa_status", {}, headers);
const events = (args = {}) => tool("read_qa_site_events", args);
const drain = (args = {}) => tool("drain_qa_queue", args);
const runEvent = (args = {}) => tool("record_qa_run_event", args);
const rawRunEvent = (args = {}, headers) => raw("record_qa_run_event", args, headers);
const db = await worker.getD1Database("DB");
const bucket = await worker.getR2Bucket("BUCKET");
let subscription;

async function subscribe() {
  const response = await rpc("events/subscribe", {name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url: "https://chatgpt.com/v26-admin-callback",
      secret: "whsec_" + randomBytes(32).toString("base64")}});
  assert.ifError(response.error);
  return response.result;
}

async function waitFor(fn, label) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const value = await fn();
    if (value) return value;
    await delay(25);
  }
  throw new Error("Timed out waiting for " + label);
}

async function createCandidate(jobId = "qa_hosted_" + randomUUID()) {
  const now = Date.now();
  const recordingSha256 = digest("recording:" + jobId);
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO qa_outbox (id, subscription, kind, payload, status, attempts, next_at, created_at)
      VALUES (?, ?, 'event', ?, 'sent', 0, ?, ?)`).bind(jobId, subscription.id,
      JSON.stringify({eventId: jobId, name: "bandroom.qa.review.requested", data: {jobId}}), now, now),
    db.prepare("INSERT OR IGNORE INTO qa_pronunciation (job_id, mode, sha256) VALUES (?, 'pronunciation-full', ?)")
      .bind(jobId, recordingSha256),
    db.prepare(`INSERT OR IGNORE INTO qa_audio_processing
      (job_id, owner, input_sha, state, next_at, created_at, updated_at)
      VALUES (?, ?, ?, 'queued', ?, ?, ?)`).bind(jobId, owner, recordingSha256, now, now, now),
    db.prepare("INSERT OR IGNORE INTO qa_recording_objects (job_id, object_key, mime, byte_length) VALUES (?, ?, 'audio/mp4', 1)")
      .bind(jobId, "recordings/" + jobId),
  ]);
  return {jobId, recordingSha256, recipeSha256: digest("v26-recipe:" + jobId), runId: randomUUID()};
}

async function claimJob(candidate) {
  const acquired = await tool("claim_qa_acoustic", claimBinding(candidate));
  assert.equal(acquired.status, "leased");
  return {...candidate, fence: acquired.fence, nextIndex: acquired.nextIndex};
}

function manifestFor(job, overrides = {}) {
  return {
    schema: "bandroom.qa.acoustic-output.v1", mode: "diagnostic",
    recordingSha256: job.recordingSha256, recipeSha256: job.recipeSha256, runId: job.runId, fence: job.fence,
    coldOutputSha256: digest("cold:" + job.jobId), resumedOutputSha256: digest("cold:" + job.jobId),
    windows: 859, duration: 68.699728, rawOutputBytes: 1_718_000,
    pcmSha256: digest("pcm:" + job.jobId), modelSha256: encoderSha,
    runtime: {ort: "1.24.4", target: "cp312-manylinux-x86_64"}, prefixSha256: digest("prefix:" + job.jobId),
    prefixBytes, partCount: prefixParts, feedback, markers: anchors.map(marker => ({...marker})),
    ...overrides,
  };
}

async function prepareCompletion(manifestOverrides = {}, {prefix = false} = {}) {
  const candidate = await createCandidate();
  const job = await claimJob(candidate);
  await write(job, 0, Buffer.from(JSON.stringify({schema: "bandroom.qa.acoustic-checkpoint-chain.v1", partCount: prefix ? prefixParts : 0})));
  let outputIndex = 1;
  if (prefix) {
    const parts = Array.from({length: prefixParts}, (_, index) => Buffer.alloc(prefixBytes / prefixParts, index + 1));
    for (let index = 0; index < parts.length; index += 1) await write(job, index + 1, parts[index]);
    outputIndex = prefixParts + 1;
  }
  const manifest = manifestFor(job, manifestOverrides);
  const output = Buffer.from(JSON.stringify(manifest));
  await write(job, outputIndex, output);
  return {
    job, manifest, output, outputIndex,
    args: {...binding(job), outputSha256: digest(output), outputIndex, quote: "[原声录音]", feedback: manifest.feedback},
  };
}

const checks = [];
try {
  const catalog = await rpc("tools/list", {});
  const names = catalog.result.tools.map(item => item.name);
  assert.ok(names.includes("read_qa_site_events"));
  assert.ok(names.includes("drain_qa_queue"));
  for (const {annotations} of catalog.result.tools) {
    assert.equal(typeof annotations.readOnlyHint, "boolean");
    assert.equal(typeof annotations.destructiveHint, "boolean");
    assert.equal(annotations.openWorldHint, false);
  }
  checks.push("MCP catalog exposes owner-only site event export and queue drain");

  // A non-owner cannot call the administration tools.
  assert.equal((await raw("read_qa_site_events", {}, otherHeaders)).error.code, -32001);
  assert.equal((await raw("drain_qa_queue", {}, otherHeaders)).error.code, -32001);
  assert.equal((await raw("read_qa_site_events", {limit: 0})).error.code, -32602);
  assert.equal((await raw("read_qa_site_events", {extra: 1})).error.code, -32602);
  assert.equal((await raw("drain_qa_queue", {excludeJobIds: ["bad"]})).error.code, -32602);
  assert.equal((await raw("drain_qa_queue", {feedback: "too short"})).error.code, -32602);
  assert.equal((await raw("drain_qa_queue", {dryRun: "yes"})).error.code, -32602);
  checks.push("owner-only administration and argument validation");

  subscription = await subscribe();
  assert.match(subscription.id, /^qa_sub_/);

  // M13/M7: every wake appends one immutable row with durable subscription data.
  const initial = await status();
  assert.equal(initial.pendingCount, 0);
  assert.deepEqual(initial.pendingAcoustics, []);
  assert.equal(initial.subscription.active, true);
  assert.equal(initial.subscriptionVerified, true);
  assert.ok(initial.subscriptionExpiresAt > Date.now());
  assert.equal(initial.wake.emptyQueueAccepted, true);
  assert.equal(initial.wake.subscriptionActive, true);
  const firstExport = await events();
  assert.equal(firstExport.count, 1);
  assert.equal(firstExport.events[0].pendingCount, 0);
  assert.equal(firstExport.events[0].pendingAcoustics, 0);
  assert.equal(firstExport.events[0].subscriptionActive, true);
  assert.equal(firstExport.events[0].emptyQueueAccepted, true);
  assert.equal(Number.isNaN(Date.parse(firstExport.events[0].utc)), false);
  await status();
  const secondExport = await events();
  assert.equal(secondExport.count, 2);
  assert.deepEqual(secondExport.events[0], firstExport.events[0]);
  assert.ok(secondExport.events[1].id > secondExport.events[0].id);
  assert.equal(await db.prepare("SELECT COUNT(*) AS n FROM qa_site_events").first().then(row => row.n), 2);
  checks.push("M13 append-only wake log: one row per wake, prior rows unchanged");

  // An empty queue with an expired subscription must not be accepted as empty.
  await db.prepare("UPDATE qa_subscriptions SET expires_at = 0 WHERE id = ?").bind(subscription.id).run();
  const expired = await status();
  assert.equal(expired.subscription.active, false);
  assert.equal(expired.subscriptionExpiresAt, 0);
  assert.equal(expired.wake.emptyQueueAccepted, false);
  const expiredExport = await events({afterId: secondExport.lastId});
  assert.equal(expiredExport.events.at(-1).subscriptionActive, false);
  await subscribe();
  const renewed = await status();
  assert.equal(renewed.subscription.active, true);
  assert.ok(renewed.subscriptionExpiresAt > Date.now());
  assert.equal(renewed.wake.emptyQueueAccepted, true);
  checks.push("M7 durable subscription expiry/renewal observation gates empty-queue acceptance");

  // Other owners' wakes are recorded separately and never exported.
  await status(otherHeaders);
  const ownerOnlyExport = await events();
  assert.ok(ownerOnlyExport.events.every(event => event.id > 0));
  const otherCount = await db.prepare("SELECT COUNT(*) AS n FROM qa_site_events WHERE owner = ?").bind(otherOwner).first();
  assert.equal(otherCount.n, 1);
  checks.push("wake log is owner-scoped and append-only");

  // G5: typed run events, including B-run recording_verified bytes/sha256 and
  // offline_run automationId/isolated, are append-only and idempotent.
  const g5Run = randomUUID();
  const g5Automation = "Automation_c2ca080ec67481919b9db50329e9e943";
  const g5Job = "qa_hosted_" + randomUUID();
  const recordingDigest = digest("g5-recording");
  const g5Common = {officialRunId: g5Run, fence: 2, automationId: g5Automation, isolated: true,
    jobId: g5Job, stage: "B", source: "cloud",
    detail: {taskId: "task-g5", attemptId: "attempt-g5", recordingId: "recording-g5",
      recordingSha256: recordingDigest, inputBytes: 441322, step: "B"}};
  assert.equal((await rawRunEvent({...g5Common, type: "claimed"})).error, undefined);
  const verified = await runEvent({...g5Common, type: "recording_verified", bytes: 441322, sha256: recordingDigest});
  assert.equal(verified.recorded, true);
  assert.equal(verified.duplicate, false);
  assert.ok(verified.id > 0);
  assert.equal((await runEvent({...g5Common, type: "checkpoint_saved"})).recorded, true);
  assert.equal((await runEvent({...g5Common, type: "interrupted"})).recorded, true);
  const offlineRun = await runEvent({...g5Common, type: "offline_run"});
  assert.equal(offlineRun.recorded, true);
  const verifiedReplay = await runEvent({...g5Common, type: "recording_verified", bytes: 441322, sha256: recordingDigest});
  assert.equal(verifiedReplay.duplicate, true);
  assert.equal(verifiedReplay.id, verified.id);
  const g5Export = await events({officialRunId: g5Run, limit: 50});
  assert.deepEqual(g5Export.events.map(event => event.type),
    ["claimed", "recording_verified", "checkpoint_saved", "interrupted", "offline_run"]);
  const g5Verified = g5Export.events[1];
  assert.equal(g5Verified.bytes, 441322);
  assert.equal(g5Verified.sha256, recordingDigest);
  assert.equal(g5Verified.automationId, g5Automation);
  assert.equal(g5Verified.isolated, true);
  assert.equal(g5Verified.source, "cloud");
  assert.equal(g5Verified.taskId, "task-g5");
  assert.equal(g5Verified.recordingSha256, recordingDigest);
  assert.equal(g5Export.events[4].type, "offline_run");
  assert.equal(g5Export.events[4].automationId, g5Automation);
  assert.equal(g5Export.events[4].isolated, true);
  assert.equal((await events({type: "recording_verified", officialRunId: g5Run})).count, 1);
  assert.equal((await rawRunEvent({...g5Common, type: "recording_verified", bytes: 441322})).error.code, -32602);
  assert.equal((await rawRunEvent({...g5Common, type: "recording_verified", sha256: recordingDigest})).error.code, -32602);
  assert.equal((await rawRunEvent({...g5Common, type: "offline_run", automationId: undefined, isolated: true})).error.code, -32602);
  assert.equal((await rawRunEvent({...g5Common, type: "offline_run", isolated: false})).error.code, -32602);
  assert.equal((await rawRunEvent({...g5Common, type: "recording_verified", bytes: 441322,
    sha256: recordingDigest, unexpected: true})).error.code, -32602);
  assert.equal((await rawRunEvent({...g5Common, type: "claimed"}, otherHeaders)).error.code, -32001);
  assert.equal((await raw("read_qa_site_events", {type: "not-a-type"})).error.code, -32602);
  assert.deepEqual((await events({type: "wake"})).events[0], firstExport.events[0]);
  checks.push("G5 typed run events: recording_verified bytes/sha256, offline_run automationId/isolated, idempotent append-only");

  // M6: complete a pending hosted text review through the existing write path.
  const textSubmission = await request("/qa/reviews?mode=hosted-retry", {
    method: "POST", headers: {...ownerHeaders, origin: "http://localhost"}});
  assert.equal(textSubmission.status, 202);
  const textJobId = (await textSubmission.json()).jobId;
  await waitFor(async () => {
    const body = await (await request("/qa/reviews/" + textJobId, {headers: ownerHeaders})).json();
    return body.status === "retry";
  }, "hosted text injected transient");
  await db.prepare("UPDATE qa_outbox SET next_at = 0 WHERE id = ?").bind(textJobId).run();
  assert.equal((await request("/qa/hosted-retry", {method: "POST"})).status, 200);
  await waitFor(async () => (await status()).pendingReviews.some(row => row.jobId === textJobId), "hosted text delivery");
  const dry = await drain({dryRun: true});
  assert.equal(dry.text.find(row => row.jobId === textJobId).status, "planned");
  assert.equal((await status()).pendingReviews.some(row => row.jobId === textJobId), true);
  const drainedText = await drain();
  assert.equal(drainedText.text.find(row => row.jobId === textJobId).status, "completed", JSON.stringify(drainedText.text));
  assert.equal(drainedText.after.pendingCount, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(textJobId).first()).n, 1);
  checks.push("M6 text drain uses the existing write path and is dry-run safe");

  // M6: clean an isolated scratch fixture with the existing cleanup pattern.
  const scratchJobId = "qa_probe_" + randomUUID();
  const scratchCheckpoint = Buffer.from("v26 scratch cleanup fixture");
  const scratchRecipe = digest("scratch-recipe");
  assert.equal((await tool("manage_qa_probe_scratch", {action: "create", jobId: scratchJobId,
    recipeSha256: scratchRecipe, checkpointSha256: digest(scratchCheckpoint)})).status, "created");
  const scratchBinding = await claimJob({jobId: scratchJobId, recipeSha256: scratchRecipe, runId: randomUUID()});
  assert.equal((await write(scratchBinding, 0, scratchCheckpoint)).status, "stored");
  const drainedScratch = await drain();
  const cleaned = drainedScratch.scratch.find(row => row.jobId === scratchJobId);
  assert.equal(cleaned.status, "cleaned");
  assert.equal(cleaned.remainingObjects, 0);
  assert.equal((await tool("claim_qa_acoustic", {...claimBinding(scratchBinding), runId: randomUUID()})).status, "unavailable");
  checks.push("M6 scratch cleanup removes fixture, lease, parts and objects");

  // M6: hosted jobs are marked only after definition; HJK requires completion.
  const fixtureJob = await createCandidate();
  const hjkCandidate = await createCandidate(hjkJobId);
  const pendingBefore = (await status()).pendingAcoustics.map(row => row.jobId);
  assert.ok(pendingBefore.includes(fixtureJob.jobId));
  assert.ok(pendingBefore.includes(hjkJobId));
  const partialExclude = await drain({excludeJobIds: [fixtureJob.jobId, hjkJobId], allowIncompleteExclude: true});
  assert.equal(partialExclude.excluded.find(row => row.jobId === fixtureJob.jobId).status, "excluded");
  assert.equal(partialExclude.excluded.find(row => row.jobId === hjkJobId).reason, "hjk_requires_completion");
  await db.prepare(`INSERT OR IGNORE INTO qa_feedback (job_id, owner, quote, feedback, created_at)
    VALUES (?, ?, ?, ?, ?)`).bind(hjkJobId, owner, "isolated", feedback, Date.now()).run();
  const completedExclude = await drain({excludeJobIds: [hjkJobId]});
  assert.equal(completedExclude.excluded.find(row => row.jobId === hjkJobId).status, "excluded");
  assert.equal(completedExclude.excluded.find(row => row.jobId === hjkJobId).reason, "completed");
  const afterExclude = await status();
  assert.ok(!afterExclude.pendingAcoustics.some(row => [fixtureJob.jobId, hjkJobId].includes(row.jobId)));
  assert.equal((await tool("claim_qa_acoustic", {...claimBinding(fixtureJob), runId: randomUUID()})).status, "unavailable");
  assert.equal((await tool("claim_qa_acoustic", {...claimBinding(hjkCandidate), runId: randomUUID()})).status, "unavailable");
  // Same-batch isolation: a bad id does not stop a valid exclusion.
  const isolatedJob = await createCandidate();
  const isolated = await drain({excludeJobIds: ["qa_hosted_" + randomUUID(), isolatedJob.jobId], allowIncompleteExclude: true});
  assert.equal(isolated.excluded.find(row => row.jobId === isolatedJob.jobId).status, "excluded");
  assert.equal(isolated.excluded.find(row => row.jobId !== isolatedJob.jobId).status, "skipped");
  checks.push("M6 hosted HJK marking requires completion; same-batch bad jobs are isolated");

  // B1: exact 24576-byte part boundary and base64/SHA validation.
  const boundaryJob = await claimJob(await createCandidate());
  assert.equal((await write(boundaryJob, 0, Buffer.alloc(maxPart, 7))).status, "stored");
  assert.equal((await raw("save_qa_acoustic_checkpoint", {...binding(boundaryJob), index: 1,
    sha256: digest("x"), base64: Buffer.alloc(maxPart + 1, 1).toString("base64")})).error.code, -32602);
  assert.equal((await raw("save_qa_acoustic_checkpoint", {...binding(boundaryJob), index: 1,
    sha256: digest("x"), base64: "!!!!"})).error.code, -32602);
  assert.equal((await tool("save_qa_acoustic_checkpoint", {...binding(boundaryJob), index: 1,
    sha256: digest("other"), base64: Buffer.from("bytes").toString("base64")})).status, "invalid_checkpoint");
  assert.equal((await write(boundaryJob, 1, Buffer.alloc(maxPart, 8))).status, "stored");
  checks.push("B1 24576-byte part accepted; 24577, malformed base64 and SHA mismatch rejected");

  // B1: 125,976-byte prefix = 6 contiguous parts; partial A resumes mid-chain.
  const partialJob = await claimJob(await createCandidate());
  await write(partialJob, 0, Buffer.from(JSON.stringify({schema: "bandroom.qa.acoustic-checkpoint-chain.v1", partCount: prefixParts})));
  const prefix = Array.from({length: prefixParts}, (_, index) => Buffer.alloc(prefixBytes / prefixParts, index + 11));
  assert.equal((await write(partialJob, 1, prefix[0])).status, "stored");
  assert.equal((await write(partialJob, 2, prefix[1])).status, "stored");
  await db.prepare("UPDATE qa_acoustic_leases SET lease_until = 0 WHERE job_id = ?").bind(partialJob.jobId).run();
  const takeoverB = await claimJob({...binding(partialJob), runId: randomUUID()});
  assert.equal(takeoverB.fence, partialJob.fence + 1);
  assert.equal(takeoverB.nextIndex, 3);
  assert.equal((await readPart(partialJob, 0)).status, "lease_lost");
  for (let index = 2; index < prefixParts; index += 1) {
    assert.equal((await write(takeoverB, index + 1, prefix[index])).status, "stored");
  }
  const retried = await tool("retry_qa_acoustic", {...binding(takeoverB), reason: "compute_budget"});
  assert.equal(retried.status, "retry_scheduled");
  assert.equal(retried.nextIndex, prefixParts + 1);
  await db.prepare("UPDATE qa_acoustic_leases SET retry_at = ? WHERE job_id = ?").bind(Date.now() - 1, partialJob.jobId).run();
  const takeoverC = await claimJob({...binding(takeoverB), runId: randomUUID()});
  assert.equal(takeoverC.fence, takeoverB.fence + 1);
  assert.equal(takeoverC.nextIndex, prefixParts + 1);
  const recovered = [];
  for (let index = 0; index < prefixParts + 1; index += 1) {
    const part = await readPart(takeoverC, index);
    assert.equal(part.status, "available");
    if (index > 0) recovered.push(Buffer.from(part.base64, "base64"));
  }
  assert.deepEqual(Buffer.concat(recovered), Buffer.concat(prefix));
  assert.equal(Buffer.concat(recovered).length, prefixBytes);
  assert.equal((await db.prepare(`SELECT run_id AS runId FROM qa_acoustic_parts
    WHERE job_id = ? ORDER BY part_index`).bind(partialJob.jobId).all()).results[0].runId, partialJob.runId);
  if (artifactDirectory) {
    await mkdir(exportDirectory, {recursive: false, mode: 0o700});
    const sourceFiles = (await readdir(artifactDirectory)).filter(name => /^\d{2}\.bin$/.test(name)).sort();
    for (const file of sourceFiles) await writeFile(join(exportDirectory, file),
      await readFile(join(artifactDirectory, file)), {mode: 0o600, flag: "wx"});
  }
  checks.push("B1 6-part 125976-byte prefix chain, partial A index0/mid-prefix/retry takeover, monotonic fences");

  // Claim-response loss and concurrent claim.
  const lossy = await createCandidate();
  const firstClaim = await tool("claim_qa_acoustic", claimBinding(lossy));
  assert.equal(firstClaim.status, "leased");
  const replayClaim = await tool("claim_qa_acoustic", claimBinding(lossy));
  assert.equal(replayClaim.status, "leased");
  assert.equal(replayClaim.fence, firstClaim.fence);
  assert.ok(replayClaim.leaseUntil >= firstClaim.leaseUntil);
  const contenders = await Promise.all([tool("claim_qa_acoustic", {...claimBinding(lossy), runId: randomUUID()}),
    tool("claim_qa_acoustic", {...claimBinding(lossy), runId: randomUUID()})]);
  assert.equal(contenders.filter(row => row.status === "busy").length, 2);
  checks.push("concurrent claim serialization and lost claim-response retry");

  // Save before/after crash, object unpublished, repair.
  const crashJob = await claimJob(await createCandidate());
  const crashBytes = Buffer.from("v26 crash window fixture");
  const crashKey = `qa-acoustic/${crashJob.jobId}/${crashJob.recordingSha256}/${crashJob.recipeSha256}/0/${digest(crashBytes)}`;
  await bucket.put(crashKey, crashBytes);
  assert.equal((await write(crashJob, 0, crashBytes)).status, "stored");
  await bucket.delete(crashKey);
  assert.equal((await readPart(crashJob, 0)).status, "checkpoint_unavailable");
  assert.equal((await write(crashJob, 0, crashBytes)).status, "stored");
  assert.equal((await readPart(crashJob, 0)).status, "available");
  checks.push("save before/after crash, unpublished object, and repair");

  // B2: valid diagnostic manifest completes once and is idempotent.
  const positive = await prepareCompletion({}, {prefix: true});
  const completed = await tool("write_qa_text_feedback", positive.args);
  assert.equal(completed.saved, true);
  assert.equal(completed.duplicate, false);
  assert.equal(completed.outputSha256, digest(positive.output));
  assert.equal(completed.coldOutputSha256, positive.manifest.coldOutputSha256);
  assert.equal(completed.markers.length, 3);
  const replay = await tool("write_qa_text_feedback", positive.args);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.savedAt, completed.savedAt);
  assert.equal(replay.payloadSha256, completed.payloadSha256);
  assert.equal((await raw("write_qa_text_feedback", {...positive.args, feedback: feedback + " changed"})).error.code, -32009);
  assert.equal((await raw("write_qa_text_feedback", {...positive.args, runId: randomUUID(), fence: positive.args.fence + 1})).error.code, -32009);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(positive.job.jobId).first()).n, 1);
  const answer = await raw("read_qa_text_answer", {jobId: positive.job.jobId});
  assert.ifError(answer.error);
  const answerBody = JSON.parse(answer.result.content[0].text);
  assert.equal(answerBody.kind, "acoustic_diagnostic");
  const {saved: _saved, duplicate: _duplicate, ...receipt} = completed;
  assert.deepEqual(answerBody.completion, receipt);
  checks.push("B2 valid bandroom.qa.acoustic-output.v1 manifest, duplicate receipt, changed-payload and old-fence rejection");

  // B2 negative contract matrix: each case uses a fresh final checkpoint.
  const negative = async manifestOverrides => {
    const setup = await prepareCompletion(manifestOverrides);
    const result = await raw("write_qa_text_feedback", setup.args);
    return result;
  };
  const negatives = [
    ["wrong output schema", {schema: "bandroom.qa.cupe-output.v1"}],
    ["cold and resumed differ", {resumedOutputSha256: digest("different")}],
    ["duration zero", {duration: 0}],
    ["duration above 181", {duration: 181.001}],
    ["recording mismatch", {recordingSha256: digest("other-recording")}],
    ["recipe mismatch", {recipeSha256: digest("other-recipe")}],
    ["run mismatch", {runId: randomUUID()}],
    ["fence mismatch", {fence: 999}],
    ["windows below one", {windows: 0}],
    ["marker model source", {markers: [{...anchors[0], source: "model"}]}],
    ["marker truth digest", {markers: [{...anchors[0], truthSha256: "abcd"}]}],
    ["marker word too long", {markers: [{...anchors[0], word: "x".repeat(81)}]}],
    ["marker negative start", {markers: [{...anchors[0], start: -0.1}]}],
    ["marker empty span", {markers: [{...anchors[0], end: anchors[0].start}]}],
    ["marker beyond duration", {markers: [{...anchors[0], end: 200}]}],
    ["feedback prefix missing", {feedback: "未标注验收范围的反馈，长度足够但缺少固定前缀。"}],
    ["feedback above 800", {feedback: "声学链路验收（不代表纠音盲测达标）。" + "x".repeat(800)}],
    ["measured mode lacks evidence", {mode: "measured_feedback"}],
    ["raw output bytes missing", {rawOutputBytes: 0}],
    ["pcm sha invalid", {pcmSha256: "abcd"}],
    ["model sha invalid", {modelSha256: "abcd"}],
    ["runtime missing", {runtime: null}],
    ["prefix sha invalid", {prefixSha256: "abcd"}],
  ];
  for (const [name, overrides] of negatives) {
    const result = await negative(overrides);
    assert.equal(result.http, 200, name);
    assert.ok(result.error, name);
    assert.equal(result.error.code, -32602, `${name}: ${JSON.stringify(result.error)}`);
  }
  const wrongQuote = await prepareCompletion();
  assert.equal((await raw("write_qa_text_feedback", {...wrongQuote.args, quote: "wrong"})).error.code, -32602);
  checks.push("B2 negative manifest matrix: schema/cold-resumed/duration/binding/windows/markers/feedback/quote/mode");

  // 8 MiB probe transport boundary.
  const stage = (headers, body = eightMiB) => request(
    "/qa/analysis-bundle/upload?kind=runtime-probe&artifact=f1.bin&index=0",
    {method: "PUT", headers: {...headers, "content-length": String(body.length)}, body});
  const serviceHeaders = {"x-bandroom-probe-key": serviceKey, "content-length": String(eightMiB.length)};
  assert.equal((await stage({})).status, 401);
  assert.equal((await stage(serviceHeaders)).status, 200);
  const maximum = await tool("read_qa_probe_blob", {artifact: "f1.bin", offset: 0, length: 8 * 1024 * 1024});
  assert.equal(Buffer.from(maximum.base64, "base64").length, eightMiB.length);
  assert.equal((await raw("read_qa_probe_blob", {artifact: "f1.bin", offset: 0, length: 8 * 1024 * 1024 + 1})).error.code, -32602);
  await request("/qa/analysis-bundle/upload?kind=runtime-probe&artifact=f1.bin&index=0", {method: "DELETE", headers: serviceHeaders});
  checks.push("8 MiB transport maximum accepted; 8 MiB + 1 rejected");

  // Re-record revision conflict with the same submission UUID.
  const submission = randomUUID();
  const original = Buffer.from(fullInterviewAudio, "base64");
  const firstUpload = await request("/qa/reviews?mode=d2", {method: "POST",
    headers: {...ownerHeaders, origin: "http://localhost", "content-type": "audio/mp4", "x-bandroom-submission": submission}, body: original});
  assert.equal(firstUpload.status, 202);
  const reRecordJob = (await firstUpload.json()).jobId;
  const changed = Buffer.from(original); changed[100] ^= 1;
  const secondUpload = await request("/qa/reviews?mode=d2", {method: "POST",
    headers: {...ownerHeaders, origin: "http://localhost", "content-type": "audio/mp4", "x-bandroom-submission": submission}, body: changed});
  assert.equal(secondUpload.status, 409);
  checks.push("same-submission re-record revision conflict rejected");

  // Revocation hides delivery-backed reads and marks the subscription inactive.
  assert.ifError((await rpc("events/unsubscribe", {id: subscription.id})).error);
  const revoked = await status();
  assert.equal(revoked.subscription.active, false);
  assert.equal((await raw("read_qa_text_answer", {jobId: reRecordJob})).error.code, -32602);
  checks.push("revocation updates durable subscription state and denies writes");

  // Final append-only integrity: every wake row is still present and unique.
  const finalExport = await events({limit: 1000});
  const total = await db.prepare("SELECT COUNT(*) AS n FROM qa_site_events WHERE owner = ?").bind(owner).first();
  assert.equal(finalExport.count, Number(total.n));
  assert.equal(new Set(finalExport.events.map(event => event.id)).size, finalExport.count);
  for (let index = 1; index < finalExport.events.length; index += 1) {
    assert.ok(finalExport.events[index].id > finalExport.events[index - 1].id);
  }
  assert.deepEqual(finalExport.events[0], firstExport.events[0]);
  checks.push("append-only wake history survives every regression path without overwrite");

  console.log(JSON.stringify({status: "passed", environment: "Miniflare with local D1/R2",
    scope: "v26 server-side acceptance regression; not official Work acceptance",
    wakeEvents: finalExport.count, checks}));
} finally {
  await worker.dispose();
  await rm(temp, {recursive: true, force: true});
}