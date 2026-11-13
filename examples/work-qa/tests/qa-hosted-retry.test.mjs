import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const [wranglerProject] = process.argv.slice(2);
if (!wranglerProject) throw new Error("Pass the installed Wrangler project path.");
const require = createRequire(resolve(wranglerProject, "package.json"));
const { Miniflare, Response } = createRequire(require.resolve("wrangler/package.json"))("miniflare");
const root = fileURLToPath(new URL("../dist/server/", import.meta.url));
const origin = "http://localhost";
const owner = "qa-owner";
const url = "https://chatgpt.com/bandroom-qa-callback";
const signingKey = randomBytes(32);
const encryptionKey = randomBytes(32).toString("base64");
const accessKey = randomBytes(32).toString("base64");
const deliveries = [];
const mf = new Miniflare({
  host: "127.0.0.1", cf: false, modules: true, modulesRoot: root, scriptPath: join(root, "index.js"),
  modulesRules: [{ type: "ESModule", include: ["**/*.js"] }],
  compatibilityDate: "2025-03-01", d1Databases: ["DB"], r2Buckets: ["BUCKET"],
  bindings: { QA_RELAY_KEY: encryptionKey, QA_RELAY_ACCESS_KEY: accessKey },
  async outboundService(request) {
    const body = await request.text();
    const id = request.headers.get("webhook-id");
    const timestamp = request.headers.get("webhook-timestamp");
    const expected = createHmac("sha256", signingKey).update(`${id}.${timestamp}.${body}`).digest("base64");
    assert.ok([url, url + "/renewed"].includes(request.url));
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("webhook-signature"), "v1," + expected);
    assert.ok(Math.abs(Date.now() / 1000 - Number(timestamp)) < 5);
    const payload = JSON.parse(body);
    const subscription = request.headers.get("x-mcp-subscription-id");
    if (payload.type === "verification") {
      assert.match(id, /^qa_verify_/);
      return Response.json({ challenge: payload.challenge });
    }
    assert.equal(payload.eventId, id);
    assert.equal(payload.data.jobId, id.split(":review:")[0]);
    deliveries.push({ id, body, subscription });
    await delay(60);
    return new Response(null, { status: deliveries.length === 1 ? 429 : 200 });
  },
});

async function request(path, method = "GET", headers = {}, body) {
  const response = await mf.dispatchFetch(origin + path, {
    method, headers: { ...headers, ...(body && { "content-type": "application/json" }) },
    body: body && JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

const user = { "oai-authenticated-user-id": owner };
const rpc = (method, params, headers = user) => request("/mcp", "POST", headers, { id: 1, method, params });
const review = (name, args, headers) => rpc("tools/call", { name, arguments: args }, headers);
const decoded = response => JSON.parse(response.body.result.content[0].text);
const pump = headers => request("/qa/hosted-retry", "POST", headers);
const queue = () => request("/qa/reviews?mode=hosted-retry", "POST", { ...user, origin });
const servicePath = "/qa/hosted-review?submission=" + randomUUID();

try {
  assert.equal((await pump({ origin })).status, 401);
  assert.equal((await pump({ ...user, origin })).status, 401);
  assert.equal((await request(servicePath, "POST", { origin })).status, 401);
  assert.equal((await request(servicePath, "GET", user)).status, 401);
  assert.equal((await request(servicePath, "PUT")).status, 405);
  assert.equal((await request("/qa/hosted-review?submission=bad", "POST")).status, 400);
  assert.equal((await request(servicePath, "POST")).status, 409);
  assert.equal((await request(servicePath)).status, 404);
  const { body: registration } = await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: { mode: "webhook", url, secret: "whsec_" + signingKey.toString("base64") },
  });
  assert.ifError(registration.error);
  const subscription = registration.result;
  assert.match(subscription.id, /^qa_sub_/);
  assert.deepEqual(JSON.parse((await request("/probe")).body.hosted_challenge),
    { status: "sent", reason: null, http: 200 });

  const submissions = await Promise.all([request(servicePath, "POST"), request(servicePath, "POST")]);
  assert.deepEqual(submissions.map(({ status }) => status).sort(), [200, 202]);
  const queued = submissions.find(({ status }) => status === 202);
  const { jobId } = queued.body;
  assert.deepEqual(submissions.find(({ status }) => status === 200).body, { jobId, duplicate: true });
  const path = "/qa/reviews/" + jobId;
  const status = () => request(path, "GET", user);
  const pending = async (headers = user) => decoded(await review("read_qa_status", {}, headers));
  const retry = (headers, target = jobId) => review("retry_qa_work_delivery", { jobId: target }, headers);
  let initial;
  for (let n = 0; n < 40; n++) {
    initial = (await status()).body;
    if (initial.status === "retry") break;
    await delay(25);
  }
  assert.equal(initial.status, "retry");
  assert.equal(initial.attempts, 1);
  assert.equal(initial.error, "injected_transient");
  assert.equal((await request(path, "GET", { "oai-authenticated-user-id": "unrelated-owner" })).status, 404);
  assert.equal((await review("read_qa_text_answer", { jobId })).body.error.code, -32602);
  assert.deepEqual((await request("/qa/relay", "POST", { "x-bandroom-qa-relay": accessKey }, { action: "claim" })).body, { job: null });
  assert.deepEqual((await pump()).body, { jobId: null });
  assert.deepEqual(decoded(await retry()), { jobId: null });
  assert.equal((await retry({}, jobId)).status, 401);
  assert.equal((await retry(user, "qa_phone_" + randomUUID())).body.error.code, -32602);
  const db = await mf.getD1Database("DB");
  const makeDue = () => db.prepare("UPDATE qa_outbox SET next_at = 0 WHERE id = ?").bind(jobId).run();
  await makeDue();
  assert.deepEqual(decoded(await retry({ "oai-authenticated-user-id": "unrelated-owner" })), { jobId: null });
  assert.deepEqual(decoded(await retry(user, "qa_hosted_" + randomUUID())), { jobId: null });
  assert.equal((await status()).body.attempts, 1);
  const concurrent = await Promise.all([retry(), retry()]);
  assert.deepEqual(concurrent.map(decoded).filter(row => row.jobId),
    [{ jobId, attempt: 2, status: "retry", error: "remote_temporary" }]);
  assert.equal(deliveries.length, 1);
  assert.deepEqual((await pump()).body, { jobId: null });

  await makeDue();
  assert.deepEqual(decoded(await retry()), { jobId, attempt: 3, status: "sent", error: null });
  const { at, ...delivery } = JSON.parse((await request("/probe")).body.hosted_pump);
  assert.ok(Date.parse(at));
  assert.deepEqual(delivery, { via: "mcp", jobId, attempt: 3, status: "sent", error: null });
  assert.deepEqual(decoded(await retry()), { jobId: null });
  assert.equal(deliveries.length, 2);
  assert.deepEqual(deliveries[0], deliveries[1]);
  assert.equal(deliveries[0].subscription, subscription.id);
  assert.equal((await status()).body.feedback, null);
  assert.deepEqual((await pending()).pendingReviews.map(row => row.jobId), [jobId]);
  assert.equal((await pending()).pendingReviews[0].evidenceReady, true);
  assert.equal((await pending({"oai-authenticated-user-id": "unrelated-owner"})).pendingCount, 0);
  const answer = decoded(await review("read_qa_text_answer", { jobId }));
  const feedback = "Add a concrete baseline when comparing staff retention before and after the eight-week pilot.";
  const feedbackArgs = { jobId, quote: answer.answer, feedback };
  assert.equal((await review("write_qa_text_feedback", feedbackArgs, { "oai-authenticated-user-id": "unrelated-owner" })).body.error.code, -32602);
  assert.deepEqual(decoded(await review("write_qa_text_feedback", feedbackArgs)), { jobId, saved: true, duplicate: false });
  assert.deepEqual(decoded(await review("write_qa_text_feedback", feedbackArgs)), { jobId, saved: true, duplicate: true });
  assert.equal((await status()).body.feedback, feedback);
  assert.equal((await pending()).pendingCount, 0);
  assert.equal((await request(servicePath)).body.feedback, feedback);
  assert.equal((await request("/qa/hosted-review?submission=" + randomUUID())).status, 404);
  assert.equal((await status()).body.attempts, 3);
  assert.deepEqual((await pump()).body, { jobId: null });

  // A Work event can ACK successfully and then fail reading the answer.
  // Only persisted feedback completes the job; the next generation has a new event ID.
  const recoveryPath = "/qa/hosted-review?submission=" + randomUUID() + "&readFailure=once";
  const recoveryId = (await request(recoveryPath, "POST")).body.jobId;
  const recoveryStatus = async () => (await request(recoveryPath)).body;
  for (let n = 0; n < 40 && (await recoveryStatus()).status !== "retry"; n++) await delay(25);
  const due = id => db.prepare("UPDATE qa_outbox SET next_at = 0 WHERE id = ?").bind(id).run();
  await due(recoveryId);
  assert.equal(decoded(await retry(user, recoveryId)).status, "sent");
  const readFailure = (await review("read_qa_text_answer", {jobId: recoveryId})).body.error;
  assert.equal(readFailure.code, -32603);
  assert.deepEqual(readFailure.data, {retryable: true, retryAfterSeconds: 5});
  assert.equal((await pending()).pendingReviews[0].readFailures, 1);
  assert.equal((await pending()).pendingReviews[0].lastReadError, "temporary_read_failure");
  // A second delivered item stays discoverable while the first item's read
  // fails. The listener must drain state, not rely on the last callback alone.
  const companionPath = "/qa/hosted-review?submission=" + randomUUID();
  const companionId = (await request(companionPath, "POST")).body.jobId;
  for (let n = 0; n < 40 && (await request(companionPath)).body.status !== "retry"; n++) await delay(25);
  await due(companionId);
  assert.equal(decoded(await retry(user, companionId)).status, "sent");
  assert.deepEqual(new Set((await pending()).pendingReviews.map(row => row.jobId)), new Set([recoveryId, companionId]));
  const companionAnswer = decoded(await review("read_qa_text_answer", {jobId: companionId}));
  assert.equal(decoded(await review("write_qa_text_feedback", {jobId: companionId, quote: companionAnswer.answer, feedback})).saved, true);
  assert.deepEqual((await pending()).pendingReviews.map(row => row.jobId), [recoveryId]);
  assert.equal((await recoveryStatus()).reviewState, "awaiting_feedback");
  assert.deepEqual(decoded(await retry(user, recoveryId)), {jobId: null});
  await due(recoveryId);
  const beforeRecovery = deliveries.length;
  const recoveries = await Promise.all([retry(user, recoveryId), retry(user, recoveryId)]);
  assert.equal(recoveries.map(decoded).filter(row => row.jobId).length, 1);
  assert.equal(deliveries.length, beforeRecovery + 1);
  assert.equal(deliveries.at(-1).id, recoveryId + ":review:1");
  assert.equal(JSON.parse(deliveries.at(-1).body).data.jobId, recoveryId);
  assert.equal((await recoveryStatus()).reviewRetries, 1);
  const recoveredAnswer = decoded(await review("read_qa_text_answer", {jobId: recoveryId}));
  assert.equal((await recoveryStatus()).readAttempts, 2);
  assert.equal((await recoveryStatus()).readFailures, 1);
  assert.equal((await recoveryStatus()).lastReadError, null);
  // A delayed write is accepted during retry and stops any later retry delivery.
  await db.prepare("UPDATE qa_outbox SET status = 'retry', next_at = 0 WHERE id = ?").bind(recoveryId).run();
  assert.equal(decoded(await review("write_qa_text_feedback", {jobId: recoveryId, quote: recoveredAnswer.answer, feedback})).saved, true);
  assert.deepEqual(decoded(await retry(user, recoveryId)), {jobId: null});
  assert.equal((await recoveryStatus()).reviewState, "complete");
  assert.equal((await recoveryStatus()).feedback, feedback);

  // Bounded original bytes survive odd chunk lengths and do not cross owners.
  const audio = randomBytes(52_001);
  audio.write("RIFF", 0); audio.write("WAVE", 8);
  const audioPath = "/qa/hosted-review?submission=" + randomUUID() + "&recording=1";
  const submitAudio = bytes => mf.dispatchFetch(origin + audioPath, {method: "POST", headers: {"content-type": "audio/wav"}, body: bytes});
  const uploaded = await submitAudio(audio);
  assert.equal(uploaded.status, 202);
  const audioId = (await uploaded.json()).jobId;
  await db.prepare("UPDATE qa_outbox SET status = 'sent' WHERE id = ?").bind(audioId).run();
  const blockedReads = await Promise.all([
    review("read_qa_text_answer", {jobId: audioId}),
    review("read_qa_text_answer", {jobId: audioId}),
  ]);
  for (const response of blockedReads) {
    assert.equal(response.body.error.code, -32602);
    assert.deepEqual(response.body.error.data, {retryable: false, reason: "acoustic_evidence_missing"});
  }
  const blockedStatus = (await request(audioPath)).body;
  assert.equal(blockedStatus.readAttempts, 2);
  assert.equal(blockedStatus.readFailures, 2);
  assert.equal(blockedStatus.lastReadError, "acoustic_evidence_missing");
  assert.ok(blockedStatus.lastReadAt > 0);
  assert.equal(blockedStatus.feedback, null);
  assert.equal((await pending()).pendingReviews.find(row => row.jobId === audioId).evidenceReady, false);
  await review("read_qa_text_answer", {jobId: audioId}, {"oai-authenticated-user-id": "unrelated-owner"});
  await review("write_qa_text_feedback", {jobId: audioId, quote: "missing evidence", feedback});
  assert.equal((await request(audioPath)).body.readAttempts, 2);
  const download = await mf.dispatchFetch(origin + audioPath + "&download=1");
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), audio);
  assert.equal(download.headers.get("cache-control"), "private, no-store");
  assert.equal((await request(audioPath + "&download=1", "GET", user)).status, 401);
  assert.equal((await request(audioPath + "&download=1", "GET", {origin})).status, 401);
  assert.equal((await request(servicePath + "&download=1")).status, 404);
  assert.equal((await submitAudio(audio)).status, 200);
  const otherAudio = Buffer.from(audio); otherAudio[99] ^= 1;
  assert.equal((await submitAudio(otherAudio)).status, 409);
  const parts = [];
  let offset = 0;
  do {
    const response = await review("read_qa_recording_bytes", {jobId: audioId, offset, length: 20_003});
    const part = decoded(response);
    assert.deepEqual(response.body.result.structuredContent, part);
    assert.equal(part.sha256, createHash("sha256").update(audio).digest("hex"));
    assert.equal(part.totalBytes, audio.length);
    assert.equal(part.offset, offset);
    parts.push(Buffer.from(part.base64, "base64"));
    offset = part.nextOffset;
  } while (offset !== null);
  assert.deepEqual(Buffer.concat(parts), audio);
  for (const invalid of [{offset: -1}, {offset: 0.5}, {offset: audio.length}, {length: 24577}, {length: 0}]) {
    assert.equal((await review("read_qa_recording_bytes", {jobId: audioId, ...invalid})).body.error.code, -32602);
  }
  assert.equal((await review("read_qa_recording_bytes", {jobId: audioId}, {"oai-authenticated-user-id": "unrelated-owner"})).body.error.code, -32602);
  assert.equal((await review("read_qa_recording_bytes", {jobId: audioId}, {})).status, 401);
  await db.prepare("UPDATE qa_subscriptions SET expires_at = 0 WHERE id = ?").bind(subscription.id).run();
  assert.equal((await pending()).pendingCount, 0);
  assert.equal(decoded(await review("read_qa_recording_bytes", {jobId: audioId, length: 1})).length, 1);
  await db.prepare("UPDATE qa_subscriptions SET expires_at = ? WHERE id = ?").bind(Date.now() + 3600_000, subscription.id).run();

  // Recovery is bounded, never moves a job to another account, and can use a
  // renewed listener for the same account after the original listener expires.
  const boundedPath = "/qa/hosted-review?submission=" + randomUUID();
  const boundedId = (await request(boundedPath, "POST")).body.jobId;
  const boundedStatus = async () => (await request(boundedPath)).body;
  for (let n = 0; n < 40 && (await boundedStatus()).status !== "retry"; n++) await delay(25);
  await due(boundedId);
  assert.equal(decoded(await retry(user, boundedId)).status, "sent");
  await db.prepare("UPDATE qa_subscriptions SET expires_at = 0 WHERE id = ?").bind(subscription.id).run();
  await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url, secret: "whsec_" + signingKey.toString("base64")},
  }, {"oai-authenticated-user-id": "unrelated-owner"});
  await due(boundedId);
  assert.deepEqual(decoded(await retry(user, boundedId)), {jobId: null});
  assert.equal((await boundedStatus()).subscriptionActive, false);
  const renewed = await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url, secret: "whsec_" + signingKey.toString("base64")},
  });
  assert.ifError(renewed.body.error);
  for (let generation = 1; generation <= 4; generation++) {
    await due(boundedId);
    assert.equal(decoded(await retry(user, boundedId)).status, "sent");
    assert.equal(deliveries.at(-1).id, boundedId + ":review:" + generation);
    assert.equal(deliveries.at(-1).subscription, renewed.body.result.id);
    assert.equal((await boundedStatus()).reviewRetries, generation);
  }
  await due(boundedId);
  const attemptsAtLimit = deliveries.length;
  assert.deepEqual(decoded(await retry(user, boundedId)), {jobId: null});
  assert.equal(deliveries.length, attemptsAtLimit);
  assert.equal((await boundedStatus()).reviewState, "needs_attention");

  // Explicitly pausing a listener must not silently move its jobs to a different
  // active listener, even when both belong to the same owner.
  await db.prepare("UPDATE qa_subscriptions SET expires_at = 0 WHERE owner = ?").bind("unrelated-owner").run();
  const pausedPath = "/qa/hosted-review?submission=" + randomUUID();
  const pausedSubmission = await request(pausedPath, "POST");
  assert.equal(pausedSubmission.status, 202);
  const pausedId = pausedSubmission.body.jobId;
  for (let n = 0; n < 40 && (await request(pausedPath)).body.status !== "retry"; n++) await delay(25);
  const otherListener = await rpc("events/subscribe", {
    name: "bandroom.qa.review.requested", arguments: {},
    delivery: {mode: "webhook", url: url + "/renewed", secret: "whsec_" + signingKey.toString("base64")},
  });
  assert.ifError(otherListener.body.error);
  await rpc("events/unsubscribe", {id: renewed.body.result.id});
  await due(pausedId);
  assert.deepEqual(decoded(await retry(user, pausedId)), {jobId: null});
  assert.equal((await request(pausedPath)).body.subscriptionActive, false);
  assert.ok(!(await pending()).pendingReviews.some(row => row.jobId === pausedId));

  assert.equal((await queue()).status, 202);
  console.log("PASS signed callbacks, durable owner-scoped pending queue, recorded read failure/recovery, bounded delivery and consumer retry, listener renewal, concurrent recovery, delayed/duplicate writeback, owner isolation, immutable recording and byte reconstruction");
} finally {
  await mf.dispose();
}
