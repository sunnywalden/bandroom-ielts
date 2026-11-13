import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash, randomBytes, randomUUID} from "node:crypto";
import {createRequire} from "node:module";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {claimAudioProcessing, checkpointRecording} from "../dist/server/audio-processing.js";
import fullInterviewAudio from "../dist/server/qa-full-interview-audio.js";

const [wranglerProject] = process.argv.slice(2);
if (!wranglerProject) throw new Error("Pass the installed Wrangler project path.");
const require = createRequire(resolve(wranglerProject, "package.json"));
const {Miniflare, Response} = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
const owner = "d2-test-owner";
const unrelated = "other-owner";
const site = "http://localhost";
const user = {"oai-authenticated-user-id": owner};
const fullAudio = Buffer.from(fullInterviewAudio, "base64");
const digest = createHash("sha256").update(fullAudio).digest("hex");
const fixtureSubmission = randomUUID();
const fixtureKey = createHash("sha256").update(JSON.stringify(["browser-d2", owner, fixtureSubmission])).digest("hex");
const fixtureJobId = "qa_hosted_" + [fixtureKey.slice(0, 8), fixtureKey.slice(8, 12), fixtureKey.slice(12, 16),
  fixtureKey.slice(16, 20), fixtureKey.slice(20, 32)].join("-");
const mf = new Miniflare({
  host: "127.0.0.1", cf: false, modules: true, modulesRoot: root, scriptPath: join(root, "index.js"),
  modulesRules: [{type: "ESModule", include: ["**/*.js"]}],
  compatibilityDate: "2025-03-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  bindings: {QA_RELAY_KEY: randomBytes(32).toString("base64"), QA_TRANSPORT_FIXTURE_JOB_ID: fixtureJobId},
  async outboundService(request) {
    const payload = await request.json();
    assert.equal(payload.type, "verification");
    return Response.json({challenge: payload.challenge});
  },
});
const request = (path, options) => mf.dispatchFetch(site + path, options);
const rpc = async (method, params, headers = user) => {
  const response = await request("/mcp", {
    method: "POST", headers: {...headers, "content-type": "application/json"},
    body: JSON.stringify({id: 1, method, params}),
  });
  return {status: response.status, ...await response.json()};
};
const call = (name, args = {}, headers = user) => rpc("tools/call", {name, arguments: args}, headers);
const recover = async (headers = user) => JSON.parse((await call("recover_qa_reviews", {}, headers)).result.content[0].text);
const queue = () => "/qa/hosted-review?submission=" + randomUUID() + "&recording=1";
const status = async path => (await request(path)).json();
const submit = (path, bytes = fullAudio, headers = {}) => request(path, {
  method: "POST", headers: {"content-type": "audio/mp4", ...headers}, body: bytes,
});

try {
  assert.equal((await call("recover_qa_reviews", {}, {})).status, 401);
  assert.equal((await submit(queue() + "&processing=d2", fullAudio, user)).status, 401);
  const subscription = await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url: "https://chatgpt.com/bandroom-qa-callback", secret: "whsec_" + randomBytes(32).toString("base64")},
  });
  assert.ifError(subscription.error);
  const db = await mf.getD1Database("DB");
  const set = (sql, ...args) => db.prepare(sql).bind(...args).run();
  const path = queue();
  const d2 = path + "&processing=d2&readFailure=once";
  const submissions = await Promise.all([submit(d2), submit(d2)]);
  assert.deepEqual(submissions.map(item => item.status).sort(), [200, 202]);
  const {jobId} = await submissions.find(item => item.status === 202).json();
  const changedAudio = Buffer.from(fullAudio);
  changedAudio[50] ^= 1;
  assert.equal((await submit(d2, changedAudio)).status, 409);
  assert.equal((await submit(path)).status, 409);
  assert.equal((await request("/qa/reviews/" + jobId, {headers: {"oai-authenticated-user-id": unrelated}})).status, 404);
  assert.deepEqual(await recover({"oai-authenticated-user-id": unrelated}), {jobId: null});
  assert.deepEqual((await status(d2)).reviewState, "queued");
  const first = (await recover()).audioProcessing;
  assert.equal(first.jobId, jobId);
  assert.equal(first.fence, 1);
  assert.equal(first.reason, "temporary_read_failure");
  assert.equal(first.state, "retry_wait");
  assert.ok(first.nextEligibleAt > Date.now() + 290_000);
  assert.equal((await status(d2)).feedback, null);
  assert.deepEqual(await recover(), {jobId: null});
  await set("UPDATE qa_audio_processing SET next_at = 0 WHERE job_id = ?", jobId);
  const restarted = await Promise.all([recover(), recover()]);
  assert.equal(restarted.filter(item => item.audioProcessing).length, 1);
  const second = restarted.find(item => item.audioProcessing).audioProcessing;
  assert.equal(second.jobId, jobId);
  assert.equal(second.fence, 2);
  assert.equal(second.state, "blocked");
  assert.equal(second.stage, "decode");
  assert.equal(second.reason, "qualified_analyzer_unavailable");
  assert.equal(second.verifiedSha256, digest);
  assert.equal(second.verifiedBytes, fullAudio.length);
  assert.equal((await status(d2)).feedback, null);
  const download = await request(path + "&download=1", {headers: {range: "bytes=8-19"}});
  assert.equal(download.status, 206);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fullAudio.subarray(8, 20));
  assert.equal((await call("read_qa_text_answer", {jobId})).error.code, -32602);
  assert.equal((await call("write_qa_text_feedback", {jobId, quote: "wrong", feedback: "wrong"})).error.code, -32602);

  const leasedPath = queue() + "&processing=d2";
  const leased = await (await submit(leasedPath)).json();
  const now = Date.now();
  const stale = await claimAudioProcessing(db, owner, now);
  assert.equal(stale.job_id, leased.jobId);
  assert.equal(await claimAudioProcessing(db, owner, now + 1), null);
  const reclaimedAt = now + 300_001;
  const active = await claimAudioProcessing(db, owner, reclaimedAt);
  assert.equal(active.fence, stale.fence + 1);
  assert.equal(await checkpointRecording(db, stale, digest, fullAudio.length, reclaimedAt), false);
  assert.equal(await checkpointRecording(db, {...active, owner: unrelated}, digest, fullAudio.length, reclaimedAt), false);
  assert.equal(await checkpointRecording(db, active, "bad digest", fullAudio.length, reclaimedAt), false);
  assert.equal(await checkpointRecording(db, active, digest, fullAudio.length, reclaimedAt), true);
  await set("UPDATE qa_audio_processing SET lease_until = 0 WHERE job_id = ?", leased.jobId);
  const resumed = (await recover()).audioProcessing;
  assert.equal(resumed.jobId, leased.jobId);
  assert.equal(resumed.fence, active.fence + 1);
  assert.equal(resumed.verifiedSha256, digest);

  const corrupt = await (await submit(queue() + "&processing=d2")).json();
  const bucket = await mf.getR2Bucket("BUCKET");
  const {object_key: corruptKey} = await db.prepare("SELECT object_key FROM qa_recording_objects WHERE job_id = ?")
    .bind(corrupt.jobId).first();
  await bucket.put(corruptKey, changedAudio);
  const corruptResult = (await recover()).audioProcessing;
  assert.equal(corruptResult.reason, "recording_digest_mismatch");
  assert.equal(corruptResult.verifiedSha256, null);

  const exhausted = await (await submit(queue() + "&processing=d2&readFailure=once")).json();
  await set("UPDATE qa_audio_processing SET attempts = 4 WHERE job_id = ?", exhausted.jobId);
  const exhaustedResult = (await recover()).audioProcessing;
  assert.equal(exhaustedResult.state, "needs_attention");
  assert.equal(exhaustedResult.reason, "processing_budget_exhausted");

  const mixed = queue();
  const race = await Promise.all([submit(mixed), submit(mixed + "&processing=d2")]);
  assert.deepEqual(race.map(item => item.status).sort(), [202, 409]);
  const state = await status(mixed);
  assert.equal(Boolean(state.processingFence !== undefined && state.processingFence !== null), race[1].status === 202);
  if (state.processingFence === 0) assert.equal((await recover()).audioProcessing.jobId, state.jobId);

  const browserPath = "/qa/reviews?mode=d2&readFailure=once";
  const submission = randomUUID();
  const browserHeaders = {...user, origin: site, "x-bandroom-submission": submission};
  assert.equal((await submit(browserPath, fullAudio, {origin: site})).status, 401);
  assert.equal((await submit(browserPath, fullAudio, {...browserHeaders, origin: "https://unrelated.example"})).status, 403);
  assert.equal((await submit(browserPath, fullAudio, {...browserHeaders, "x-bandroom-submission": "invalid"})).status, 400);
  assert.equal((await submit(browserPath, changedAudio, {...browserHeaders, "oai-authenticated-user-id": unrelated})).status, 409);
  const browserQueue = await Promise.all([submit(browserPath, fullAudio, browserHeaders), submit(browserPath, fullAudio, browserHeaders)]);
  assert.deepEqual(browserQueue.map(item => item.status).sort(), [200, 202]);
  const [browserOne, browserTwo] = await Promise.all(browserQueue.map(item => item.json()));
  assert.equal(browserOne.jobId, browserTwo.jobId);
  const target = "/qa/reviews/" + browserOne.jobId;
  const browserStatus = async () => (await request(target, {headers: user})).json();
  assert.equal((await browserStatus()).reviewState, "queued");
  assert.equal((await request(target, {headers: {"oai-authenticated-user-id": unrelated}})).status, 404);
  assert.equal((await submit(browserPath, changedAudio, browserHeaders)).status, 409);
  assert.equal((await recover()).audioProcessing.reason, "temporary_read_failure");
  assert.equal((await browserStatus()).reviewState, "retry_wait");
  await set("UPDATE qa_audio_processing SET next_at = 0 WHERE job_id = ?", browserOne.jobId);
  assert.equal((await recover()).audioProcessing.jobId, browserOne.jobId);
  const original = await browserStatus();
  assert.equal(original.reviewState, "blocked");
  assert.equal(original.processingReason, "qualified_analyzer_unavailable");
  assert.equal(original.verifiedSha256, digest);
  assert.equal(original.feedback, null);
  const playback = await request(original.recordingUrl, {headers: {...user, range: "bytes=8-19"}});
  assert.equal(playback.status, 206);
  assert.deepEqual(Buffer.from(await playback.arrayBuffer()), fullAudio.subarray(8, 20));
  const fixtureHeaders = {...browserHeaders, "x-bandroom-submission": fixtureSubmission};
  const fixture = await (await submit(browserPath, fullAudio, fixtureHeaders)).json();
  const fixtureTarget = "/qa/reviews/" + fixture.jobId;
  assert.equal((await recover()).audioProcessing.reason, "temporary_read_failure");
  assert.deepEqual(await recover(), {jobId: null});
  await set("UPDATE qa_audio_processing SET next_at = 0 WHERE job_id = ?", fixture.jobId);
  const fixtureRecoveries = await Promise.all([recover(), recover()]);
  assert.equal(fixtureRecoveries.filter(item => item.audioProcessing).length, 1);
  const fixtureReceipt = fixtureRecoveries.find(item => item.audioProcessing).audioProcessing;
  assert.equal(fixtureReceipt.jobId, fixture.jobId);
  assert.equal(fixtureReceipt.fence, 2);
  assert.equal(fixtureReceipt.state, "complete");
  assert.equal(fixtureReceipt.verifiedSha256, digest);
  const fixtureReadback = await (await request(fixtureTarget, {headers: user})).json();
  assert.equal(fixtureReadback.feedbackAt, fixtureReceipt.feedbackAt);
  assert.match(fixtureReadback.feedback, /工程验收测试反馈/);
  assert.equal(fixtureReadback.acousticEvidence, undefined);
  assert.equal((await request(fixtureTarget, {headers: {"oai-authenticated-user-id": unrelated}})).status, 404);
  assert.deepEqual(await recover(), {jobId: null});

  // Keep previously saved inline recordings readable after adding the bucket.
  await db.batch([
    db.prepare("INSERT INTO qa_recordings (job_id, audio, mime) VALUES (?, ?, ?)")
      .bind(fixture.jobId, fullAudio.toString("base64"), "audio/mp4"),
    db.prepare("DELETE FROM qa_recording_objects WHERE job_id = ?").bind(fixture.jobId),
  ]);
  const legacy = await request(fixtureReadback.recordingUrl, {headers: {...user, range: "bytes=-33"}});
  assert.equal(legacy.status, 206);
  assert.deepEqual(Buffer.from(await legacy.arrayBuffer()), fullAudio.subarray(-33));

  for (const [mime, output] of [
    ["audio/webm", ["-c:a", "libopus", "-f", "webm"]],
    ["audio/mp4", ["-c:a", "aac", "-movflags", "empty_moov+frag_keyframe", "-f", "mp4"]],
  ]) {
    const bytes = execFileSync(process.env.FFMPEG_BIN || "ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "anoisesrc=color=pink:seed=381:sample_rate=48000",
      "-t", "180", "-b:a", "96k", ...output, "pipe:1",
    ], {maxBuffer: 12 * 1024 * 1024});
    assert.ok(bytes.length > 1_200_000);
    const headers = {...user, origin: site, "x-bandroom-submission": randomUUID(), "content-type": mime};
    const path = "/qa/reviews?mode=d2";
    const created = await submit(path, bytes, headers);
    assert.equal(created.status, 202);
    const {jobId: longJobId} = await created.json();
    const duplicate = await submit(path, bytes, headers);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).jobId, longJobId);
    const originalPath = "/qa/reviews/" + longJobId + "/recording";
    const original = await request(originalPath, {headers: user});
    assert.equal(original.status, 200);
    assert.equal(original.headers.get("content-type"), mime);
    assert.equal(original.headers.get("content-length"), String(bytes.length));
    const originalSha = createHash("sha256").update(bytes).digest("hex");
    assert.equal(createHash("sha256").update(Buffer.from(await original.arrayBuffer())).digest("hex"), originalSha);
    const suffix = await request(originalPath, {headers: {...user, range: "bytes=-33"}});
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), `bytes ${bytes.length - 33}-${bytes.length - 1}/${bytes.length}`);
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), bytes.subarray(-33));
    const unsatisfied = await request(originalPath, {headers: {...user, range: `bytes=${bytes.length}-`}});
    assert.equal(unsatisfied.status, 416);
    assert.equal(unsatisfied.headers.get("content-range"), "bytes */" + bytes.length);
    assert.equal((await request(originalPath, {headers: {"oai-authenticated-user-id": unrelated}})).status, 404);
    const chunk = await call("read_qa_recording_bytes", {jobId: longJobId, offset: bytes.length - 33});
    assert.equal(chunk.result.structuredContent.sha256, originalSha);
    assert.equal(chunk.result.structuredContent.nextOffset, null);
    assert.deepEqual(Buffer.from(chunk.result.structuredContent.base64, "base64"), bytes.subarray(-33));
    assert.equal((await recover()).audioProcessing.verifiedSha256, originalSha);
    console.log(`PASS 180 s ${mime}, ${bytes.length} bytes, SHA-256 ${originalSha}`);
  }
  const tooLarge = Buffer.alloc(12 * 1024 * 1024 + 1);
  const limit = await submit("/qa/reviews?mode=d2", tooLarge,
    {...browserHeaders, "x-bandroom-submission": randomUUID()});
  assert.equal(limit.status, 413);
  assert.match((await limit.json()).error, /12 MiB/);
  console.log("PASS D2 original-byte recovery, browser submission, retry eligibility, concurrency, lease fencing, owner isolation, SHA-256, retry budget, legacy playback and upload size limit");
} finally {
  await mf.dispose();
}
