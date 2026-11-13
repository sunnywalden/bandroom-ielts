import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import fullInterviewAudio from "../dist/server/qa-full-interview-audio.js";

const [wranglerProject, recordingPath, artifactDirectory, exportDirectory] = process.argv.slice(2);
if (!wranglerProject || Boolean(recordingPath) !== Boolean(artifactDirectory) ||
    Boolean(recordingPath) !== Boolean(exportDirectory)) {
  throw new Error("Usage: node qa-acoustic-checkpoints.test.mjs WRANGLER_PROJECT [ORIGINAL ARTIFACT_DIR EXPORT_DIR]");
}
const require = createRequire(resolve(wranglerProject, "package.json"));
const {Miniflare, Response} = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "bandroom-qa-checkpoints-"));
const owner = "d2-checkpoint-owner";
const ownerHeaders = {"oai-authenticated-user-id": owner};
const otherHeaders = {"oai-authenticated-user-id": "other-owner"};
const maxPart = 24 * 1024;
const recording = recordingPath ? await readFile(recordingPath) : Buffer.from(fullInterviewAudio, "base64");
const digest = data => createHash("sha256").update(data).digest("hex");
const recordingSha256 = digest(recording);
const files = artifactDirectory ? (await readdir(artifactDirectory)).filter(name => /^\d{2}\.bin$/.test(name)).sort() : ["00.bin"];
assert.ok(files.length > 0);
const artifacts = await Promise.all(files.map(async name => {
  const bytes = artifactDirectory ? await readFile(join(artifactDirectory, name)) : Buffer.alloc(maxPart * 2 + 9, 161);
  return {name, bytes, sha256: digest(bytes)};
}));
const parts = [];
for (const artifact of artifacts) {
  artifact.startIndex = parts.length;
  for (let offset = 0; offset < artifact.bytes.length; offset += maxPart) {
    parts.push(artifact.bytes.subarray(offset, offset + maxPart));
  }
  artifact.endIndex = parts.length;
}
const [firstPart, secondPart] = parts;
const relayKey = randomBytes(32).toString("base64");
const start = () => new Miniflare({
  host: "127.0.0.1", cf: false, modules: true, modulesRoot: root, scriptPath: join(root, "index.js"),
  modulesRules: [{type: "ESModule", include: ["**/*.js"]}], compatibilityDate: "2025-03-01",
  d1Databases: ["DB"], r2Buckets: ["BUCKET"], d1Persist: join(temp, "db"), r2Persist: join(temp, "r2"),
  bindings: {QA_RELAY_KEY: relayKey},
  async outboundService(request) {
    const payload = await request.json();
    return payload.type === "verification" ? Response.json({challenge: payload.challenge}) : new Response(null, {status: 204});
  },
});
let worker = start();
const request = (path, options) => worker.dispatchFetch("http://localhost" + path, options);
const rpc = async (method, params, headers = ownerHeaders) => {
  const response = await request("/mcp", {
    method: "POST", headers: {...headers, "content-type": "application/json"},
    body: JSON.stringify({id: 1, method, params}),
  });
  return {http: response.status, ...await response.json()};
};
const raw = (name, args, headers) => rpc("tools/call", {name, arguments: args}, headers);
const tool = async (name, args, headers) => {
  const response = await raw(name, args, headers);
  assert.equal(response.http, 200);
  assert.ifError(response.error);
  return response.result.structuredContent;
};
const claim = (args, headers) => tool("claim_qa_acoustic", args, headers);
const write = (args, index, bytes) => tool("save_qa_acoustic_checkpoint", {
  ...args, index, sha256: digest(bytes), base64: bytes.toString("base64"),
});
const read = (args, index) => tool("read_qa_acoustic_checkpoint", {...args, index});
const retry = (args, reason) => tool("retry_qa_acoustic", {...args, reason});
const pending = async headers => (await tool("read_qa_status", {}, headers)).pendingAcoustics;

try {
  const catalog = await rpc("tools/list", {});
  assert.deepEqual(catalog.result.tools.filter(item => /qa_acoustic/.test(item.name)).map(item => item.name), [
    "claim_qa_acoustic", "save_qa_acoustic_checkpoint", "read_qa_acoustic_checkpoint", "retry_qa_acoustic",
  ]);
  const subscription = await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url: "https://chatgpt.com/bandroom-qa-callback", secret: "whsec_" + randomBytes(32).toString("base64")},
  });
  assert.ifError(subscription.error);
  const upload = await request("/qa/reviews?mode=d2", {
    method: "POST", headers: {...ownerHeaders, "content-type": "audio/mp4", origin: "http://localhost",
      "x-bandroom-submission": randomUUID()}, body: recording,
  });
  assert.equal(upload.status, 202);
  const {jobId} = await upload.json();
  const originalPath = "/qa/reviews/" + jobId + "/recording";
  const original = await request(originalPath, {headers: ownerHeaders});
  assert.equal(original.status, 200);
  assert.equal(digest(Buffer.from(await original.arrayBuffer())), recordingSha256);
  const initialRange = await tool("read_qa_recording_bytes", {jobId, offset: 0, length: maxPart});
  assert.equal(initialRange.sha256, recordingSha256);
  assert.deepEqual(Buffer.from(initialRange.base64, "base64"), recording.subarray(0, maxPart));
  assert.equal((await request(originalPath, {headers: otherHeaders})).status, 404);

  const ordinaryUpload = await request("/qa/hosted-review?submission=" + randomUUID() + "&recording=1", {
    method: "POST", headers: {"content-type": "audio/mp4"}, body: recording,
  });
  assert.equal(ordinaryUpload.status, 202);
  const ordinary = await ordinaryUpload.json();
  const recipeSha256 = digest("checkpoint-transport-test-v1");
  const run1 = {jobId, recipeSha256, runId: randomUUID()};
  const run2 = {...run1, runId: randomUUID()};
  const run3 = {...run1, runId: randomUUID()};
  assert.equal((await raw("claim_qa_acoustic", run1, {})).http, 401);
  assert.equal((await raw("claim_qa_acoustic", {...run1, extra: true})).error.code, -32602);
  assert.equal((await claim(run1, otherHeaders)).status, "unavailable");
  assert.equal((await claim({...run1, jobId: "qa_hosted_" + randomUUID()})).status, "unavailable");
  assert.equal((await claim({...run1, jobId: ordinary.jobId})).status, "unavailable");
  assert.deepEqual(await pending(otherHeaders), []);
  assert.deepEqual(await pending(), [{jobId, recordingSha256, recipeSha256: null, nextIndex: 0, retryReason: null, availableAt: 0}]);
  const acquired = await claim(run1);
  assert.equal(acquired.status, "leased");
  assert.equal(acquired.recordingSha256, recordingSha256);
  assert.equal(acquired.nextIndex, 0);
  const initialDb = await worker.getD1Database("DB");
  const shortenedLease = Date.now() + 30_000;
  await initialDb.prepare("UPDATE qa_acoustic_leases SET lease_until = ? WHERE job_id = ?")
    .bind(shortenedLease, jobId).run();
  const renewed = await claim(run1);
  assert.deepEqual({...renewed, leaseUntil: acquired.leaseUntil}, acquired);
  assert.ok(renewed.leaseUntil > shortenedLease);
  assert.equal((await claim(run2)).status, "busy");
  assert.equal((await claim({...run1, recipeSha256: digest("other-recipe")})).status, "unavailable");
  const first = {...run1, fence: acquired.fence};
  assert.equal((await read(first, 0)).status, "checkpoint_not_found");
  assert.equal((await tool("read_qa_acoustic_checkpoint", {...first, index: 0}, otherHeaders)).status, "lease_lost");
  assert.equal((await write(first, 1, secondPart)).status, "out_of_order");
  assert.equal((await tool("save_qa_acoustic_checkpoint", {
    ...first, index: 0, sha256: digest(secondPart.subarray(0, 9)), base64: firstPart.toString("base64"),
  })).status, "invalid_checkpoint");
  const duplicate = await Promise.all([write(first, 0, firstPart), write(first, 0, firstPart)]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  assert.equal(duplicate[0].status, "stored");
  assert.equal(duplicate[0].writtenByRun, run1.runId);
  assert.equal((await write(first, 0, Buffer.from("different"))).status, "index_conflict");

  const key = `qa-acoustic/${jobId}/${recordingSha256}/${recipeSha256}/0/${digest(firstPart)}`;
  const bucket = await worker.getR2Bucket("BUCKET");
  await bucket.put(key, Buffer.alloc(firstPart.length, 0));
  assert.equal((await read(first, 0)).status, "checkpoint_corrupt");
  assert.equal((await write(first, 0, firstPart)).status, "stored");
  await bucket.delete(key);
  assert.equal((await read(first, 0)).status, "checkpoint_unavailable");
  assert.equal((await write(first, 0, firstPart)).status, "stored");
  assert.equal((await read(first, 0)).status, "available");

  for (let index = 1; index < parts.length; index += 1) {
    assert.equal((await write(first, index, parts[index])).status, "stored");
  }
  const scheduled = await retry(first, "checkpoint_read_failed");
  assert.equal(scheduled.status, "retry_scheduled");
  assert.equal(scheduled.nextIndex, parts.length);
  assert.deepEqual(await retry(first, "checkpoint_read_failed"), scheduled);
  assert.equal((await claim(run2)).status, "waiting");
  assert.equal((await write(first, 1, secondPart)).status, "lease_lost");
  assert.deepEqual(await pending(), [{
    jobId, recordingSha256, recipeSha256, nextIndex: parts.length,
    retryReason: "checkpoint_read_failed", availableAt: scheduled.availableAt,
  }]);
  await worker.dispose();
  worker = start();
  assert.equal((await claim(run2)).status, "waiting");
  const db = await worker.getD1Database("DB");
  // Advance the persisted clock boundary without adding a wall-clock wait.
  await db.prepare("UPDATE qa_acoustic_leases SET retry_at = ? WHERE job_id = ?")
    .bind(Date.now() - 1, jobId).run();
  // Expiring a webhook prevents fresh uploads but must not discard an accepted job.
  await db.prepare("UPDATE qa_subscriptions SET expires_at = ? WHERE id = ?")
    .bind(Date.now() - 1, subscription.result.id).run();
  assert.equal((await pending())[0].jobId, jobId);
  assert.equal((await claim(run1)).status, "new_run_required");
  const contenders = await Promise.all([claim(run2), claim(run3)]);
  const winner = contenders.find(result => result.status === "leased");
  assert.equal(contenders.filter(result => result.status === "busy").length, 1);
  assert.equal(winner.fence, acquired.fence + 1);
  assert.equal(winner.nextIndex, parts.length);
  assert.equal(winner.recordingSha256, recordingSha256);
  const second = {...run2, runId: winner.runId, fence: winner.fence};
  assert.equal((await read(first, 0)).status, "lease_lost");
  const recoveredParts = [];
  for (let index = 0; index < parts.length; index += 1) {
    const result = await read(second, index);
    assert.equal(result.status, "available");
    assert.equal(result.writtenByFence, acquired.fence);
    assert.equal(result.writtenByRun, run1.runId);
    assert.equal(result.sha256, digest(parts[index]));
    recoveredParts.push(Buffer.from(result.base64, "base64"));
  }
  if (exportDirectory) await mkdir(exportDirectory, {recursive: false, mode: 0o700});
  for (const artifact of artifacts) {
    const bytes = Buffer.concat(recoveredParts.slice(artifact.startIndex, artifact.endIndex));
    assert.deepEqual(bytes, artifact.bytes);
    if (exportDirectory) await writeFile(join(exportDirectory, artifact.name), bytes, {mode: 0o600, flag: "wx"});
  }
  const appended = await write(second, parts.length, Buffer.from("second-run-checkpoint"));
  assert.equal(appended.status, "stored");
  assert.equal(appended.writtenByFence, winner.fence);
  assert.equal(appended.writtenByRun, winner.runId);

  await db.prepare("UPDATE qa_acoustic_leases SET lease_until = ? WHERE job_id = ?")
    .bind(Date.now() - 1, jobId).run();
  assert.equal((await claim({...run1, runId: winner.runId})).status, "new_run_required");
  const replacement = {...run1, runId: randomUUID()};
  const next = await claim(replacement);
  assert.equal(next.status, "leased");
  assert.equal(next.fence, winner.fence + 1);
  assert.equal(next.nextIndex, parts.length + 1);
  assert.equal((await write(second, next.nextIndex, firstPart)).status, "lease_lost");

  // B1: the checkpoint part limit is exactly 24576 bytes.
  const active = {...replacement, fence: next.fence};
  assert.equal((await write(active, next.nextIndex, Buffer.alloc(maxPart, 77))).status, "stored");
  const tooLarge = Buffer.alloc(maxPart + 1, 78);
  assert.equal((await raw("save_qa_acoustic_checkpoint", {...active, index: next.nextIndex + 1,
    sha256: digest(tooLarge), base64: tooLarge.toString("base64")})).error.code, -32602);
  assert.equal((await raw("save_qa_acoustic_checkpoint", {...active, index: next.nextIndex + 1,
    sha256: digest("x"), base64: "!!!!"})).error.code, -32602);

  const unsubscribe = await rpc("events/unsubscribe", {id: subscription.result.id});
  assert.ifError(unsubscribe.error);
  assert.deepEqual(await pending(), []);
  assert.equal((await read({...replacement, fence: next.fence}, 0)).status, "lease_lost");
  assert.equal((await claim({...run1, runId: randomUUID()})).status, "unavailable");
  const state = await db.prepare("SELECT count(*) AS count FROM qa_feedback").first();
  assert.equal(state.count, 0);
  console.log(JSON.stringify({
    tests: "pass", environment: "Miniflare with local persistent D1 and R2",
    artifactKind: recordingPath ? "external-checkpoints" : "fixture-bytes",
    artifacts: artifacts.map(({name, bytes, sha256}) => ({name, bytes: bytes.length, sha256})),
    originalBytes: recording.length, originalSha256: recordingSha256, jobId,
    resumedPartCount: winner.nextIndex, fences: [acquired.fence, winner.fence, next.fence],
    checks: ["MCP catalog", "owner isolation", "integrity", "lease renewal", "lease expiry takeover", "ordered writes", "concurrent append",
      "corruption repair", "missing object repair", "retry idempotence", "retry backoff",
      "runtime restart", "stale lease", "concurrent claim", "same byte sequence", "cross-run append",
      "D2 job scope", "fixed recipe", "pending discovery", "subscription expiration and revocation", "no feedback writes", "24576-byte part boundary"],
  }));
} finally {
  await worker.dispose();
  await rm(temp, {recursive: true, force: true});
}
