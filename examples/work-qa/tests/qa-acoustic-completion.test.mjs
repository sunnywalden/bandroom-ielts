import assert from "node:assert/strict";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import fullInterviewAudio from "../dist/server/qa-full-interview-audio.js";

if (!process.argv[2]) throw new Error("Usage: node qa-acoustic-completion.test.mjs WRANGLER_PROJECT");
const require = createRequire(resolve(process.argv[2], "package.json"));
const {Miniflare, Response} = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "bandroom-completion-test-"));
const ownerHeaders = {"oai-authenticated-user-id": "completion-test-owner"};
const other = {"oai-authenticated-user-id": "another-owner"};
const digest = value => createHash("sha256").update(value).digest("hex");
const part = Buffer.from("isolated bundle fixture; not a model");
const manifest = Buffer.from(JSON.stringify({schema: "bandroom.qa.analysis-bundle.v1", bundleSha256: digest(part),
  byteLength: part.length, parts: [{sha256: digest(part), byteLength: part.length}]}));
const manifestSha256 = digest(manifest);
const bundleKey = randomBytes(32).toString("hex");
const relayKey = randomBytes(32).toString("base64");
const start = () => new Miniflare({host: "127.0.0.1", cf: false, modules: true, modulesRoot: root,
  scriptPath: join(root, "index.js"), modulesRules: [{type: "ESModule", include: ["**/*.js"]}],
  compatibilityDate: "2025-03-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  d1Persist: join(temp, "db"), r2Persist: join(temp, "r2"),
  bindings: {QA_ANALYSIS_MANIFEST_SHA256: manifestSha256, QA_BUNDLE_KEY: bundleKey, QA_RELAY_KEY: relayKey},
  async outboundService(request) {
    const payload = await request.json();
    return payload.type === "verification" ? Response.json({challenge: payload.challenge}) : new Response(null, {status: 204});
  },
});
let worker = start();
const request = (path, options) => worker.dispatchFetch("http://localhost" + path, options);
const rpc = async (method, params, headers = ownerHeaders) => {
  const response = await request("/mcp", {method: "POST", headers: {...headers, "content-type": "application/json"},
    body: JSON.stringify({id: 1, method, params})});
  return {http: response.status, ...await response.json()};
};
const raw = (name, args, headers) => rpc("tools/call", {name, arguments: args}, headers);
const tool = async (name, args, headers) => {
  const result = await raw(name, args, headers);
  assert.equal(result.http, 200); assert.ifError(result.error);
  return result.result.structuredContent;
};
const write = (binding, index, value) => tool("save_qa_acoustic_checkpoint", {...binding, index,
  sha256: digest(value), base64: value.toString("base64")});
const upload = (kind, bytes, headers = {}, sha = digest(bytes)) => request(
  "/qa/analysis-bundle/upload?kind=" + kind + "&sha256=" + sha, {method: "PUT",
    headers: {"x-bandroom-bundle-key": bundleKey, "content-length": String(bytes.length), ...headers}, body: bytes});
const checks = [];
try {
  assert.ifError((await rpc("events/subscribe", {name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url: "https://chatgpt.com/isolated-completion-test", secret: "whsec_" + randomBytes(32).toString("base64")}})).error);
  const recording = Buffer.from(fullInterviewAudio, "base64");
  const submit = await request("/qa/reviews?mode=d2", {method: "POST", headers: {...ownerHeaders,
    "content-type": "audio/mp4", origin: "http://localhost", "x-bandroom-submission": randomUUID()}, body: recording});
  assert.equal(submit.status, 202);
  const {jobId} = await submit.json();
  const recipeSha256 = digest("isolated-completion-test-v1");
  const first = {jobId, recipeSha256, runId: randomUUID()};
  first.fence = (await tool("claim_qa_acoustic", first)).fence;
  const db = await worker.getD1Database("DB");
  assert.equal((await raw("write_qa_text_feedback", {jobId, quote: "[原声录音]", feedback: "unbound feedback must fail"})).error.code, -32602);
  assert.equal((await raw("get_analysis_bundle", first)).error.code, -32603);
  assert.equal((await upload("part", part, {"x-bandroom-bundle-key": "wrong"})).status, 401);
  assert.equal((await upload("part", part, {origin: "http://localhost"})).status, 401);
  assert.equal((await upload("part", part, {}, digest("different"))).status, 400);
  assert.equal((await upload("manifest", manifest)).status, 409);
  assert.equal((await upload("part", part)).status, 200);
  assert.equal((await (await upload("part", part)).json()).duplicate, true);
  assert.equal((await upload("manifest", manifest)).status, 200);
  assert.equal((await raw("get_analysis_bundle", {...first, owner: "forged"})).error.code, -32602);
  assert.equal((await raw("get_analysis_bundle", first, other)).error.code, -32009);
  assert.equal((await raw("get_analysis_bundle", first, {})).http, 401);
  const granted = await tool("get_analysis_bundle", first);
  const partUrl = new URL(granted.parts[0].path, "http://localhost");
  assert.equal(partUrl.pathname, "/qa/hosted-review");
  assert.equal(partUrl.searchParams.get("bundlePart"), digest(part));
  const download = await request(granted.parts[0].path);
  assert.equal(download.status, 200);
  assert.equal(digest(Buffer.from(await download.arrayBuffer())), digest(part));
  assert.equal((await request(granted.parts[0].path, {headers: ownerHeaders})).status, 401);
  assert.equal((await request(granted.parts[0].path, {headers: {origin: "http://localhost"}})).status, 401);
  assert.equal((await request("/qa/hosted-review?bundlePart=" + digest(part))).status, 401);
  const previousPartPath = "/qa/analysis-bundle/parts/" + digest(part) + "?grant=" + partUrl.searchParams.get("grant");
  assert.equal((await request(previousPartPath)).status, 200);
  const tampered = granted.parts[0].path.replace("grant=", "grant=x");
  assert.equal((await request(tampered)).status, 401);
  checks.push("private bundle upload auth, immutable SHA, pinned manifest, owner lease, signed download");

  const prefix = Buffer.alloc(21440, 137);
  assert.equal((await write(first, 0, prefix)).status, "stored");
  await db.prepare("UPDATE qa_acoustic_leases SET lease_until = 0 WHERE job_id = ?").bind(jobId).run();
  const second = {jobId, recipeSha256, runId: randomUUID()};
  const acquired = await tool("claim_qa_acoustic", second);
  second.fence = acquired.fence;
  assert.equal(second.fence, first.fence + 1);
  assert.equal(acquired.nextIndex, 1);
  assert.equal((await request(granted.parts[0].path)).status, 409);
  assert.equal((await raw("get_analysis_bundle", first)).error.code, -32009);
  const resumed = await tool("read_qa_acoustic_checkpoint", {...second, index: 0});
  assert.equal(resumed.sha256, digest(prefix));
  const feedback = "声学链路验收（不代表纠音盲测达标）。本条只验证检查点恢复和反馈单次写回。";
  const output = Buffer.from(JSON.stringify({schema: "bandroom.qa.acoustic-output.v1", mode: "diagnostic",
    recordingSha256: digest(recording), recipeSha256, runId: second.runId, fence: second.fence,
    coldOutputSha256: digest(prefix), resumedOutputSha256: digest(prefix), windows: 8, duration: 20,
    rawOutputBytes: 1000, pcmSha256: digest("test-only-pcm"), modelSha256: digest("test-only-model"),
    runtime: {threads: 2, torch: "fixture", ffmpeg: "fixture"}, prefixSha256: digest(prefix),
    feedback, markers: [{source: "human_annotation", truthSha256: digest("test-only-truth"), word: "fixture", start: 1, end: 2}]}));
  assert.equal((await write(second, 1, output)).status, "stored");
  const args = {...second, outputSha256: digest(output), outputIndex: 1, quote: "[原声录音]", feedback};
  assert.equal((await raw("write_qa_text_feedback", {...args, ...first})).error.code, -32009);
  assert.equal((await raw("write_qa_text_feedback", {...args, outputSha256: digest("different")})).error.code, -32602);
  assert.equal((await raw("write_qa_text_feedback", args, other)).error.code, -32602);
  const bucket = await worker.getR2Bucket("BUCKET");
  const finalPart = await db.prepare("SELECT object_key FROM qa_acoustic_parts WHERE job_id = ? AND part_index = 1").bind(jobId).first();
  await bucket.delete(finalPart.object_key);
  assert.equal((await raw("write_qa_text_feedback", args)).error.code, -32603);
  assert.equal((await write(second, 1, output)).status, "stored");
  // Expired webhook TTL does not revoke an already accepted owned acoustic job.
  await db.prepare("UPDATE qa_subscriptions SET expires_at = 0").run();
  const concurrent = await Promise.all([tool("write_qa_text_feedback", args), tool("write_qa_text_feedback", args)]);
  assert.equal(concurrent.filter(r => r.duplicate === false).length, 1);
  assert.equal(concurrent[0].payloadSha256, concurrent[1].payloadSha256);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(jobId).first()).n, 1);
  assert.equal((await db.prepare("SELECT state FROM qa_audio_processing WHERE job_id = ?").bind(jobId).first()).state, "complete");
  checks.push("stale fence rejected, checkpoint recovery, output digest validation, missing-object repair, concurrent single commit");

  // Drop the first completion response and restart the worker: only durable DB/R2 survive.
  const receipt = concurrent[0];
  await worker.dispose(); worker = start();
  const recovered = await tool("write_qa_text_feedback", args);
  assert.equal(recovered.duplicate, true);
  assert.equal(recovered.savedAt, receipt.savedAt);
  assert.equal(recovered.outputSha256, digest(output));
  assert.equal((await raw("write_qa_text_feedback", {...args, ...first})).error.code, -32009);
  assert.equal((await raw("write_qa_text_feedback", {...args, feedback: feedback + " changed"})).error.code, -32009);
  assert.equal((await raw("write_qa_text_feedback", {...args, recipeSha256: digest("changed recipe")})).error.code, -32009);
  const status = await (await request("/qa/reviews/" + jobId, {headers: ownerHeaders})).json();
  const stored = status;
  assert.equal(stored.completion.outputSha256, digest(output));
  assert.equal(stored.completion.markers[0].start, 1);
  const reopened = await worker.getD1Database("DB");
  const queued = await reopened.prepare(`SELECT q.status, COALESCE(r.generation, 0) AS generation
    FROM qa_outbox q LEFT JOIN qa_review_recovery r ON r.job_id = q.id WHERE q.id = ?`).bind(jobId).first();
  assert.deepEqual(queued, {status: "pending", generation: 0});
  const readback = await raw("read_qa_text_answer", {jobId});
  assert.ifError(readback.error);
  const answer = JSON.parse(readback.result.content[0].text);
  assert.equal(answer.kind, "acoustic_diagnostic");
  assert.equal(answer.quote, "[原声录音]");
  assert.equal(answer.quoteForWrite, "[原声录音]");
  assert.equal(answer.feedback, feedback);
  assert.deepEqual(answer.completion, stored.completion);
  assert.equal((await raw("read_qa_text_answer", {jobId}, other)).error.code, -32602);
  await reopened.prepare("UPDATE qa_subscriptions SET verified = 0").run();
  assert.equal((await raw("write_qa_text_feedback", args)).error.code, -32602);
  assert.equal((await raw("read_qa_text_answer", {jobId})).error.code, -32602);
  assert.equal((await reopened.prepare("SELECT COUNT(*) AS n FROM qa_feedback WHERE job_id = ?").bind(jobId).first()).n, 1);
  checks.push("lost receipt after restart, identical replay, changed-payload conflict, old fence conflict, marker readback, revocation");
  checks.push("diagnostic receipt and feedback readable with pending outbox and expired webhook TTL, verified owner required");
  console.log(JSON.stringify({status: "passed", scope: "isolated local regression; not official Work acceptance", checks}));
} finally { await worker.dispose(); await rm(temp, {recursive: true, force: true}); }
