// G5-local server-writeback regression (QA/local only).
//
// Drives the REAL Work-QA worker modules (examples/work-qa/server/index.js ->
// work-events.js -> acoustic-completion.js) inside Miniflare with local D1 + R2.
// It discharges the four server-side G5-local retained clauses by measurement,
// not by assumption:
//
//   1. G3-fence-monotonic            lease fence strictly increases per new run
//   2. G3-writeback-idempotent       concurrent + sequential replay commits once
//   3. G3-writeback-lost-replay      receipt survives a worker restart; replay
//                                    returns the same durable receipt
//   4. G3-writeback-old-fence-reject a write carrying a stale fence/run/binding
//                                    is rejected with JSON-RPC -32009
//
// No production Worker is contacted and no production D1/R2 is written. This is
// an isolated local regression; it is NOT official Work/cloud acceptance.
//
// Usage:
//   node analysis/scripts/g5-local/writeback_regression_local.mjs \
//     [WRANGLER_PROJECT] [--out PATH]
//
// WRANGLER_PROJECT defaults to the repository root (used only to resolve
// Wrangler's bundled Miniflare). --out writes the JSON record; stdout always
// receives the same JSON.

import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import fullInterviewAudio from "../../../examples/work-qa/server/qa-full-interview-audio.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../..");
const modulesRoot = resolve(repoRoot, "examples/work-qa/server");
const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex === -1 ? null : args[outIndex + 1];
const wranglerProject = resolve(args.find((value, index) =>
  value !== "--out" && args[index - 1] !== "--out") ?? repoRoot);
const require = createRequire(resolve(wranglerProject, "package.json"));
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const {Miniflare, Response} = wranglerRequire("miniflare");
const miniflareVersion = (() => {
  try { return wranglerRequire("miniflare/package.json").version; }
  catch { return null; }
})();

const sourceFiles = ["index.js", "work-events.js", "acoustic-completion.js", "acoustic-checkpoints.js"];
const sourceHashes = {};
for (const name of sourceFiles) {
  sourceHashes[name] = createHash("sha256").update(await readFile(join(modulesRoot, name))).digest("hex");
}

const digest = value => createHash("sha256").update(value).digest("hex");
const startedAt = new Date().toISOString();
const temp = await mkdtemp(join(tmpdir(), "bandroom-g5-writeback-"));
const ownerHeaders = {"oai-authenticated-user-id": "g5-writeback-owner"};
const other = {"oai-authenticated-user-id": "g5-writeback-other-owner"};
const relayKey = randomBytes(32).toString("base64");
const bundleKey = randomBytes(32).toString("hex");

const start = () => new Miniflare({
  host: "127.0.0.1", cf: false, modules: true, modulesRoot,
  scriptPath: join(modulesRoot, "index.js"),
  modulesRules: [{type: "ESModule", include: ["**/*.js"]}],
  compatibilityDate: "2025-03-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  d1Persist: join(temp, "db"), r2Persist: join(temp, "r2"),
  bindings: {QA_RELAY_KEY: relayKey, QA_BUNDLE_KEY: bundleKey},
  async outboundService(request) {
    const payload = await request.json();
    return payload.type === "verification" ? Response.json({challenge: payload.challenge})
      : new Response(null, {status: 204});
  },
});

let worker = start();
const request = (path, options) => worker.dispatchFetch("http://localhost" + path, options);
const rpc = async (method, params, headers = ownerHeaders) => {
  const response = await request("/mcp", {
    method: "POST", headers: {...headers, "content-type": "application/json"},
    body: JSON.stringify({id: 1, method, params}),
  });
  return {http: response.status, ...(await response.json())};
};
const raw = (name, callArgs, headers = ownerHeaders) =>
  rpc("tools/call", {name, arguments: callArgs}, headers);
const tool = async (name, callArgs, headers = ownerHeaders) => {
  const result = await raw(name, callArgs, headers);
  assert.equal(result.http, 200);
  assert.ifError(result.error);
  return result.result.structuredContent;
};
const writePart = (binding, index, value) => tool("save_qa_acoustic_checkpoint", {
  ...binding, index, sha256: digest(value), base64: value.toString("base64"),
});

const clauses = [];
const clause = (id, test, assertion, status, observed, detail = "") =>
  clauses.push({id, test, assertion, status, observed, detail});

// ---------------------------------------------------------------------------
// Fixture setup: verified Work subscription + a D2 recording job.
// ---------------------------------------------------------------------------
const subscribed = await rpc("events/subscribe", {
  name: "bandroom.qa.review.requested", arguments: {},
  delivery: {mode: "webhook", url: "https://chatgpt.com/g5-writeback-regression",
    secret: "whsec_" + randomBytes(32).toString("base64")},
});
assert.ifError(subscribed.error);

const recording = Buffer.from(fullInterviewAudio, "base64");
const submit = await request("/qa/reviews?mode=d2", {
  method: "POST",
  headers: {...ownerHeaders, "content-type": "audio/mp4", origin: "http://localhost",
    "x-bandroom-submission": randomUUID()},
  body: recording,
});
assert.equal(submit.status, 202);
const {jobId} = await submit.json();
const recipeSha256 = digest("g5-writeback-regression-v1");
const db = await worker.getD1Database("DB");
const feedback = "声学链路验收（不代表纠音盲测达标）。本条只验证 G5 回写 fence/幂等/重放/旧 fence 拒绝四组本地回归。";
const prefix = Buffer.alloc(21440, 137);

let first, second, third, output, outputSha256, completionArgs;
let firstReceipt = null;

try {
  // -------------------------------------------------------------------------
  // Clause 1: fence monotonic. Acquire three consecutive leases. Every new run
  // must advance the fence by exactly one; the committed column must agree.
  // -------------------------------------------------------------------------
  first = {jobId, recipeSha256, runId: randomUUID()};
  first.fence = (await tool("claim_qa_acoustic", {jobId, recipeSha256, runId: first.runId})).fence;
  assert.equal((await writePart(first, 0, prefix)).status, "stored");

  await db.prepare("UPDATE qa_acoustic_leases SET lease_until = 0 WHERE job_id = ?").bind(jobId).run();
  second = {jobId, recipeSha256, runId: randomUUID()};
  second.fence = (await tool("claim_qa_acoustic", {jobId, recipeSha256, runId: second.runId})).fence;

  await db.prepare("UPDATE qa_acoustic_leases SET lease_until = 0 WHERE job_id = ?").bind(jobId).run();
  third = {jobId, recipeSha256, runId: randomUUID()};
  third.fence = (await tool("claim_qa_acoustic", {jobId, recipeSha256, runId: third.runId})).fence;

  const committedFence = (await db.prepare(
    "SELECT fence FROM qa_acoustic_leases WHERE job_id = ?").bind(jobId).first()).fence;
  const sequence = [first.fence, second.fence, third.fence];
  const strictlyIncreasing = sequence.every((value, index) =>
    Number.isSafeInteger(value) && value >= 1 && (index === 0 || value > sequence[index - 1]));
  const stepOne = second.fence === first.fence + 1 && third.fence === second.fence + 1;
  const dbAgrees = committedFence === third.fence;
  clause("G3-fence-monotonic",
    "fence_monotonic_three_leases",
    "each new run advances fence by exactly 1 and the durable lease row agrees",
    strictlyIncreasing && stepOne && dbAgrees ? "pass" : "fail",
    {sequence, committedFence, strictlyIncreasing, stepOne, dbAgrees});

  // Recovered prefix under the current (third) lease proves checkpoint continuity.
  const resumed = await tool("read_qa_acoustic_checkpoint", {...third, index: 0});
  assert.equal(resumed.sha256, digest(prefix));

  // Write the final completed output checkpoint under the current lease.
  output = Buffer.from(JSON.stringify({
    schema: "bandroom.qa.acoustic-output.v1", mode: "diagnostic",
    recordingSha256: digest(recording), recipeSha256, runId: third.runId, fence: third.fence,
    coldOutputSha256: digest(prefix), resumedOutputSha256: digest(prefix),
    windows: 8, duration: 20, rawOutputBytes: 1000,
    pcmSha256: digest("g5-local-pcm"), modelSha256: digest("g5-local-model"),
    runtime: {threads: 2, torch: "fixture", ffmpeg: "fixture"}, prefixSha256: digest(prefix),
    feedback,
    markers: [{source: "human_annotation", truthSha256: digest("g5-local-truth"),
      word: "fixture", start: 1, end: 2}],
  }));
  outputSha256 = digest(output);
  assert.equal((await writePart(third, 1, output)).status, "stored");
  completionArgs = {...third, outputSha256, outputIndex: 1, quote: "[原声录音]", feedback};

  // -------------------------------------------------------------------------
  // Clause 2: writeback idempotent. Two concurrent identical writes must yield
  // exactly one insert and one duplicate replay with the same payload SHA, and
  // exactly one feedback row. A later sequential replay must also be duplicate.
  // -------------------------------------------------------------------------
  const concurrent = await Promise.all([
    tool("write_qa_text_feedback", completionArgs),
    tool("write_qa_text_feedback", completionArgs),
  ]);
  firstReceipt = concurrent.find(row => row.duplicate === false) ?? concurrent[0];
  const freshCount = concurrent.filter(row => row.duplicate === false).length;
  const samePayload = concurrent[0].payloadSha256 === concurrent[1].payloadSha256;
  const sameSavedAt = concurrent[0].savedAt === concurrent[1].savedAt;
  const feedbackRows = (await db.prepare(
    "SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(jobId).first()).n;
  const sequential = await tool("write_qa_text_feedback", completionArgs);
  const processingState = (await db.prepare(
    "SELECT state FROM qa_audio_processing WHERE job_id = ?").bind(jobId).first()).state;
  clause("G3-writeback-idempotent",
    "concurrent_and_sequential_replay_commit_once",
    "2 concurrent writes => 1 fresh + 1 duplicate, same payloadSha/savedAt; replay duplicate; 1 feedback row",
    freshCount === 1 && samePayload && sameSavedAt && sequential.duplicate === true &&
      feedbackRows === 1 && processingState === "complete" ? "pass" : "fail",
    {freshCount, duplicateCount: 2 - freshCount, samePayload, sameSavedAt,
      replayDuplicate: sequential.duplicate, payloadSha256: concurrent[0].payloadSha256,
      feedbackRows, processingState});

  // -------------------------------------------------------------------------
  // Clause 3: lost-receipt replay recovery. Drop the worker (simulating a lost
  // completion response) and restart against the same D1/R2. Replaying the same
  // request must return the SAME durable receipt (savedAt/outputSha), not a new
  // write, and must not create a second feedback row.
  // -------------------------------------------------------------------------
  await worker.dispose();
  worker = start();
  const recovered = await tool("write_qa_text_feedback", completionArgs);
  const recoveredRows = (await (await worker.getD1Database("DB")).prepare(
    "SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(jobId).first()).n;
  const sameReceipt = recovered.duplicate === true &&
    recovered.savedAt === firstReceipt.savedAt &&
    recovered.outputSha256 === outputSha256 &&
    recovered.payloadSha256 === firstReceipt.payloadSha256 &&
    recoveredRows === 1;
  clause("G3-writeback-lost-replay",
    "restart_then_replay_returns_durable_receipt",
    "after worker restart, identical replay returns duplicate=true with identical savedAt/outputSha and no extra feedback row",
    sameReceipt ? "pass" : "fail",
    {duplicate: recovered.duplicate, savedAt: recovered.savedAt,
      originalSavedAt: firstReceipt.savedAt, outputSha256: recovered.outputSha256,
      expectedOutputSha256: outputSha256, feedbackRows: recoveredRows});

  // -------------------------------------------------------------------------
  // Clause 4: old-fence rejection. A write carrying any stale binding (old
  // fence, old run, changed recipe) must be rejected with -32009 and must not
  // alter the durable receipt.
  // -------------------------------------------------------------------------
  const staleFence = await raw("write_qa_text_feedback", {...completionArgs, ...first});
  const staleRun = await raw("write_qa_text_feedback", {
    ...completionArgs, runId: first.runId, fence: first.fence});
  const changedRecipe = await raw("write_qa_text_feedback", {
    ...completionArgs, recipeSha256: digest("changed-recipe")});
  const otherOwner = await raw("write_qa_text_feedback", completionArgs, other);
  const finalRows = (await (await worker.getD1Database("DB")).prepare(
    "SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(jobId).first()).n;
  const codes = {
    staleFence: staleFence.error?.code ?? null,
    staleRun: staleRun.error?.code ?? null,
    changedRecipe: changedRecipe.error?.code ?? null,
    otherOwner: otherOwner.error?.code ?? null,
  };
  const rejected = codes.staleFence === -32009 && codes.staleRun === -32009 &&
    codes.changedRecipe === -32009 && finalRows === 1;
  clause("G3-writeback-old-fence-reject",
    "stale_fence_run_and_recipe_rejected_32009",
    "old fence, old run and changed recipe each return JSON-RPC -32009; feedback row count unchanged",
    rejected ? "pass" : "fail",
    {codes, feedbackRows: finalRows,
      messages: {
        staleFence: staleFence.error?.message ?? null,
        staleRun: staleRun.error?.message ?? null,
        changedRecipe: changedRecipe.error?.message ?? null,
        otherOwner: otherOwner.error?.message ?? null,
      }});
} finally {
  await worker.dispose();
  await rm(temp, {recursive: true, force: true});
}

const summary = {
  pass: clauses.filter(row => row.status === "pass").length,
  fail: clauses.filter(row => row.status === "fail").length,
  total: clauses.length,
};
const record = {
  schema: "bandroom.g5-local.writeback-regression.v1",
  generatedAt: new Date().toISOString(),
  startedAt,
  identityScope: "local-attestation",
  scope: "isolated local Miniflare regression; NOT production and NOT official Work/cloud acceptance",
  harness: {
    script: "analysis/scripts/g5-local/writeback_regression_local.mjs",
    runtime: process.version,
    miniflare: miniflareVersion,
    transport: "Miniflare D1 + R2 driving the real worker entrypoint index.js",
    modulesRoot: "examples/work-qa/server",
    sourceSha256: sourceHashes,
    jobId,
    owner: ownerHeaders["oai-authenticated-user-id"],
    recordingSha256: digest(recording),
  },
  clauses,
  summary,
};
const text = JSON.stringify(record, null, 2) + "\n";
if (outPath) {
  const target = resolve(outPath);
  await writeFile(target, text);
  console.error("wrote " + target);
}
process.stdout.write(text);
process.exitCode = summary.fail === 0 && summary.total === 4 ? 0 : 1;