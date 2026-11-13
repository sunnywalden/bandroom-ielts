import {createAudioProcessingTable, createAudioProcessingIndex} from "./audio-processing.js";
import qaAudio from "./qa-audio.js";
import {
  createRecordingObjectTable, maxHostedRecordingBytes, openRecording, readRecordingBody,
  recordingFields, saveHostedRecording,
} from "./recordings.js";
import {
  createPronunciationTable, createRecordingTable, fullSpeechFeedback, fullSpeechMode, isPronunciation,
  maxRecordingBytes, pronunciationFixture, pronunciationReview, validEvidence,
} from "./pronunciation.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const eventName = "bandroom.qa.review.requested";
export const fixture = {
  question: "Explain why a team might try a four-day schedule and how to judge the outcome.",
  answer: "A shorter workweek would give the team more time to recover. The team should compare missed deadlines and staff retention before and after an eight-week pilot.",
};
export const speakingQuestion = "Propose a schedule change and explain your reasoning.";
const isSpeaking = id => id.startsWith("qa_speech_");
const hostedPrefix = "qa_hosted_";
const uuidPattern = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
export const hostedJobPattern = "^" + hostedPrefix + uuidPattern + "$";
const eventScope = "bandroom-qa-text";
const json = (value, status = 200) => Response.json(value, {status, headers: {"cache-control": "no-store"}});

function encode(value) {
  const bytes = new Uint8Array(value);
  let result = "";
  for (let i = 0; i < bytes.length; i += 24576) {
    result += btoa(String.fromCharCode(...bytes.subarray(i, i + 24576)));
  }
  return result;
}

function decode(value) {
  return Uint8Array.from(atob(value), char => char.charCodeAt(0));
}

async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

async function key(env) {
  return crypto.subtle.importKey("raw", decode(env.QA_RELAY_KEY), "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function seal(env, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({name: "AES-GCM", iv}, await key(env), encoder.encode(JSON.stringify(value)));
  return JSON.stringify([encode(iv), encode(encrypted)]);
}

async function unseal(env, sealed) {
  const [iv, encrypted] = JSON.parse(sealed);
  return JSON.parse(decoder.decode(await crypto.subtle.decrypt({name: "AES-GCM", iv: decode(iv)}, await key(env), decode(encrypted))));
}

function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export async function prepareEvents(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_subscriptions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, destination TEXT NOT NULL,
      expires_at INTEGER NOT NULL, verified INTEGER NOT NULL DEFAULT 0
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_outbox (
      id TEXT PRIMARY KEY, subscription TEXT NOT NULL, kind TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER, error TEXT, created_at INTEGER NOT NULL,
      finished_at INTEGER
    )`),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS qa_speech_evidence (job_id TEXT PRIMARY KEY, segments TEXT NOT NULL)"),
    env.DB.prepare(createPronunciationTable),
    env.DB.prepare(createRecordingTable),
    env.DB.prepare(createRecordingObjectTable),
    env.DB.prepare(createAudioProcessingTable),
    env.DB.prepare(createAudioProcessingIndex),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_feedback (
      job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, quote TEXT NOT NULL, feedback TEXT NOT NULL, created_at INTEGER NOT NULL
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_review_recovery (
      job_id TEXT PRIMARY KEY, generation INTEGER NOT NULL DEFAULT 0,
      read_faults INTEGER NOT NULL DEFAULT 0, content_sha TEXT
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_review_reads (
      job_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL, failures INTEGER NOT NULL,
      last_error TEXT, last_at INTEGER NOT NULL
    )`),
  ]);
}

export function eventDefinition() {
  return {
    name: eventName,
    description: "An independent QA answer or recording is ready for review in the isolated Bandroom test site.",
    delivery: ["webhook"],
    inputSchema: {type: "object", properties: {}, additionalProperties: false},
    payloadSchema: {type: "object", properties: {jobId: {type: "string"}}, required: ["jobId"], additionalProperties: false},
  };
}

function callbackUrl(delivery) {
  if (delivery?.mode !== "webhook" || typeof delivery.url !== "string") return null;
  try {
    const url = new URL(delivery.url);
    if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
        !/(^|\.)(chatgpt\.com|openai\.com)$/.test(url.hostname)) return null;
    return url.href;
  } catch {
    return null;
  }
}

function callback(delivery) {
  const url = callbackUrl(delivery);
  if (!url || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(delivery.secret ?? "")) return null;
  try {
    const secretLength = decode(delivery.secret.slice(6)).length;
    return secretLength >= 24 && secretLength <= 64 ? {url, secret: delivery.secret} : null;
  } catch {
    return null;
  }
}

async function sendHostedCallback(job, target) {
  if (!callback({mode: "webhook", ...target})) return {status: "failed", code: "destination_rejected"};
  const timestamp = String(Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey("raw", decode(target.secret.slice(6)), {name: "HMAC", hash: "SHA-256"}, false, ["sign"]);
  // Transport retries retain their ID; a new consumer attempt needs a new event ID.
  const deliveryId = job.kind === "event" ? JSON.parse(job.payload).eventId : job.id;
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode([deliveryId, timestamp, job.payload].join(".")));
  try {
    const response = await fetch(target.url, {
      method: "POST", redirect: "manual", signal: AbortSignal.timeout(4_000), body: job.payload,
      headers: {
        "content-type": "application/json", "webhook-id": deliveryId,
        "webhook-timestamp": timestamp, "webhook-signature": "v1," + encode(signature),
        "x-mcp-subscription-id": job.subscription,
      },
    });
    const http = response.status;
    if (!response.ok) {
      await response.body?.cancel();
      const retry = http === 429 || http >= 500;
      return {status: retry ? "retry" : "failed", code: retry ? "remote_temporary" : "remote_rejected", http};
    }
    if (job.kind === "verify") {
      const value = await response.json();
      if (!same(value?.challenge, JSON.parse(job.payload).challenge)) return {status: "failed", code: "challenge_mismatch", http};
    } else {
      await response.body?.cancel();
    }
    return {status: "sent", code: null, http};
  } catch {
    return {status: "retry", code: "transport_error"};
  }
}

async function claimHosted(env, scope, values) {
  const now = Date.now();
  const lease = crypto.randomUUID();
  await env.DB.prepare(`UPDATE qa_outbox SET status = 'failed', error = 'lease_exhausted', finished_at = ?, lease = NULL, lease_until = NULL
    WHERE id IN (SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
      WHERE (${scope}) AND q.status = 'leased' AND q.attempts >= 5 AND q.lease_until <= ?)`)
    .bind(now, ...values, now).run();
  return env.DB.prepare(`UPDATE qa_outbox SET status = 'leased', lease = ?, lease_until = ?, attempts = attempts + 1
    WHERE id = (SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
      WHERE (${scope}) AND s.expires_at > ? AND q.attempts < 5
        AND ((q.status IN ('pending', 'retry') AND q.next_at <= ?) OR (q.status = 'leased' AND q.lease_until <= ?))
      ORDER BY q.next_at, q.created_at, q.id LIMIT 1)
    RETURNING id, subscription, kind, payload, lease, attempts`)
    .bind(lease, now + 12_000, ...values, now, now, now).first();
}

async function finishHosted(env, job, outcome) {
  const now = Date.now();
  const status = outcome.status === "retry" && job.attempts >= 5 ? "failed" : outcome.status;
  const updated = await env.DB.prepare(`UPDATE qa_outbox SET status = ?, next_at = ?, error = ?, finished_at = ?, lease = NULL, lease_until = NULL
    WHERE id = ? AND lease = ? AND lease_until > ? AND status = 'leased'`)
    .bind(status, now + (status === "sent" ? 300_000 : 45_000), outcome.code, now, job.id, job.lease, now).run();
  return {jobId: job.id, attempt: job.attempts, status: updated.meta.changes === 1 ? status : "stale_lease", error: outcome.code};
}

export async function pumpHostedReviews(env, id = null, owner = null) {
  await prepareEvents(env);
  const now = Date.now();
  const scope = `q.kind = 'event' AND substr(q.id, 1, ${hostedPrefix.length}) = '${hostedPrefix}'
    AND (? IS NULL OR q.id = ?) AND (? IS NULL OR s.owner = ?)
    AND NOT EXISTS (SELECT 1 FROM qa_audio_processing p WHERE p.job_id = q.id)`;
  const values = [id, id, owner, owner];
  // A callback ACK only confirms delivery. Recovery ends when feedback is durable.
  // D1 batch is a transaction, so concurrent pumps advance at most one generation.
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO qa_review_recovery (job_id)
      SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription WHERE ${scope}`).bind(...values),
    env.DB.prepare(`UPDATE qa_outbox SET subscription = (
      SELECT fresh.id FROM qa_subscriptions old JOIN qa_subscriptions fresh ON fresh.owner = old.owner
      WHERE old.id = qa_outbox.subscription AND fresh.verified = 1 AND fresh.expires_at > ? ORDER BY fresh.expires_at DESC LIMIT 1)
      WHERE id IN (SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
        WHERE ${scope} AND s.expires_at <= ? AND s.verified = 1
          AND EXISTS (SELECT 1 FROM qa_subscriptions fresh WHERE fresh.owner = s.owner AND fresh.verified = 1 AND fresh.expires_at > ?)
          AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = q.id))`).bind(now, ...values, now, now),
    env.DB.prepare(`UPDATE qa_review_recovery SET generation = generation + 1
      WHERE generation < 4 AND job_id IN (
        SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
        WHERE ${scope} AND s.verified = 1 AND s.expires_at > ? AND q.status = 'sent' AND q.next_at <= ?
          AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = q.id))`).bind(...values, now, now),
    env.DB.prepare(`UPDATE qa_outbox SET status = 'retry', attempts = 0, next_at = ?, error = 'feedback_missing',
      payload = json_set(payload, '$.eventId', id || ':review:' || (SELECT generation FROM qa_review_recovery WHERE job_id = id))
      WHERE id IN (SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
        JOIN qa_review_recovery r ON r.job_id = q.id WHERE ${scope} AND q.status = 'sent'
        AND r.generation > 0 AND json_extract(q.payload, '$.eventId') != q.id || ':review:' || r.generation
        AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = q.id))`).bind(now, ...values),
  ]);
  const job = await claimHosted(env, `q.kind = 'event' AND substr(q.id, 1, ?) = ? AND s.verified = 1
    AND (? IS NULL OR q.id = ?) AND (? IS NULL OR s.owner = ?)
    AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = q.id)
    AND NOT EXISTS (SELECT 1 FROM qa_audio_processing p WHERE p.job_id = q.id)`,
    [hostedPrefix.length, hostedPrefix, id, id, owner, owner]);
  if (!job) return {jobId: null};
  if (job.attempts === 1 && JSON.parse(job.payload).eventId === job.id) return finishHosted(env, job, {status: "retry", code: "injected_transient"});
  const sub = await env.DB.prepare("SELECT destination FROM qa_subscriptions WHERE id = ? AND verified = 1 AND expires_at > ?")
    .bind(job.subscription, Date.now()).first();
  const outcome = sub ? await sendHostedCallback(job, await unseal(env, sub.destination)) : {status: "failed", code: "subscription_expired"};
  return finishHosted(env, job, outcome);
}

export async function hostedServiceReview(env, request, ctx) {
  const params = new URL(request.url).searchParams;
  const jobId = hostedPrefix + params.get("submission");
  if (!new RegExp(hostedJobPattern).test(jobId)) {
    return json({error: "An isolated submission UUID is required"}, 400);
  }
  await prepareEvents(env);
  if (request.method === "GET") {
    // Sites service access is a separate, narrowly scoped QA route. It does not
    // impersonate a learner or grant access to the production study database.
    const existing = await hostedOwner(env, jobId);
    if (params.get("download") === "1") {
      return existing ? reviewRecording(request, env, existing.owner, jobId) : json({error: "Not found"}, 404);
    }
    return existing ? reviewStatus(env, existing.owner, jobId) : json({error: "Not found"}, 404);
  }
  return queueHostedReview(env, request, ctx, {
    jobId, hasRecording: params.get("recording") === "1",
    processAudio: params.get("processing") === "d2", failRead: params.get("readFailure") === "once",
  });
}

export async function hostedBrowserReview(env, request, ctx, owner) {
  if (!owner) return json({error: "请重新登录后提交。"}, 401);
  const url = new URL(request.url);
  if (request.headers.get("origin") !== url.origin) return json({error: "请从本站提交录音。"}, 403);
  const submission = request.headers.get("x-bandroom-submission");
  if (!new RegExp("^" + uuidPattern + "$").test(submission ?? "")) {
    return json({error: "缺少有效的录音提交编号。"}, 400);
  }
  const key = await sha256(encoder.encode(JSON.stringify(["browser-d2", owner, submission])));
  const id = [key.slice(0, 8), key.slice(8, 12), key.slice(12, 16), key.slice(16, 20), key.slice(20, 32)].join("-");
  await prepareEvents(env);
  return queueHostedReview(env, request, ctx, {
    jobId: hostedPrefix + id, hasRecording: true, processAudio: true,
    failRead: url.searchParams.get("readFailure") === "once", owner,
  });
}

function hostedOwner(env, jobId) {
  return env.DB.prepare(`SELECT s.owner FROM qa_outbox q
    JOIN qa_subscriptions s ON s.id = q.subscription WHERE q.id = ? AND q.kind = 'event'`).bind(jobId).first();
}

async function queueHostedReview(env, request, ctx, {jobId, hasRecording, processAudio, failRead, owner}) {
  let recording, mime, digest;
  if (hasRecording) {
    recording = await readRecording(request, maxHostedRecordingBytes);
    if (!recording) return json({error: "录音超过 12 MiB，请压缩后重试。"}, 413);
    if (!recording.length) return json({error: "录音为空，请重新选择文件。"}, 400);
    mime = audioMime(recording);
    if (!mime) return json({error: "Unsupported audio format"}, 415);
    digest = await sha256(recording);
  }
  if (processAudio && !recording) return json({error: "D2 processing requires a QA recording"}, 400);
  const existing = await hostedOwner(env, jobId);
  if (existing) {
    if (owner && existing.owner !== owner) return json({error: "Not found"}, 404);
    const binding = await env.DB.prepare("SELECT sha256 FROM qa_pronunciation WHERE job_id = ?").bind(jobId).first();
    if ((binding?.sha256 ?? null) !== (digest ?? null)) return json({error: "Submission already has different content"}, 409);
    const processing = await env.DB.prepare("SELECT 1 FROM qa_audio_processing WHERE job_id = ?").bind(jobId).first();
    if (Boolean(processing) !== processAudio) return json({error: "Submission already uses a different processing mode"}, 409);
    return json({jobId, duplicate: true});
  }
  const now = Date.now();
  if (!owner) {
    const {results: owners} = await env.DB.prepare(`SELECT DISTINCT owner FROM qa_subscriptions
      WHERE verified = 1 AND expires_at > ? LIMIT 2`).bind(now).all();
    if (owners.length !== 1) return json({error: "Exactly one verified QA owner is required"}, 409);
    owner = owners[0].owner;
  }
  let objectKey;
  if (recording) {
    const subscription = await env.DB.prepare("SELECT 1 FROM qa_subscriptions WHERE owner = ? AND verified = 1 AND expires_at > ?")
      .bind(owner, now).first();
    if (!subscription) return json({error: "No verified Work subscription"}, 409);
    try {
      objectKey = await saveHostedRecording(env.BUCKET, jobId, digest, mime, recording);
    } catch {
      return json({error: "录音存储暂时不可用。请保留文件并重试。"}, 503);
    }
  }
  const event = {eventId: jobId, name: eventName, timestamp: new Date(now).toISOString(), data: {jobId}, cursor: null};
  const payload = JSON.stringify(processAudio ? {...event, processing: "d2"} : event);
  const enqueue = env.DB.prepare(`INSERT OR IGNORE INTO qa_outbox (id, subscription, kind, payload, status, next_at, created_at)
    SELECT ?, id, 'event', ?, 'pending', ?, ? FROM qa_subscriptions
    WHERE owner = ? AND verified = 1 AND expires_at > ?
      AND EXISTS (SELECT 1 FROM qa_review_recovery WHERE job_id = ? AND content_sha IS ?)
    ORDER BY expires_at DESC LIMIT 1`)
    .bind(jobId, payload, now, now, owner, now, jobId, digest ?? null);
  const statements = [
    env.DB.prepare(`INSERT OR IGNORE INTO qa_review_recovery (job_id, read_faults, content_sha)
      SELECT ?, ?, ? WHERE EXISTS (
        SELECT 1 FROM qa_subscriptions WHERE owner = ? AND verified = 1 AND expires_at > ?
      )`).bind(jobId, !processAudio && failRead ? 1 : 0, digest ?? null, owner, now), enqueue];
  if (recording) statements.push(
    env.DB.prepare(`INSERT OR IGNORE INTO qa_pronunciation (job_id, mode, sha256) SELECT q.id, ?, ? FROM qa_outbox q
      JOIN qa_review_recovery r ON r.job_id = q.id JOIN qa_subscriptions s ON s.id = q.subscription
      WHERE q.id = ? AND r.content_sha = ? AND s.owner = ?`)
      .bind(fullSpeechMode, digest, jobId, digest, owner),
    env.DB.prepare(`INSERT OR IGNORE INTO qa_recording_objects (job_id, object_key, mime, byte_length) SELECT q.id, ?, ?, ? FROM qa_outbox q
      JOIN qa_review_recovery r ON r.job_id = q.id JOIN qa_subscriptions s ON s.id = q.subscription
      WHERE q.id = ? AND r.content_sha = ? AND s.owner = ?`)
      .bind(objectKey, mime, recording.length, jobId, digest, owner),
  );
  if (processAudio) statements.push(
    env.DB.prepare(`INSERT INTO qa_audio_processing (job_id, owner, input_sha, next_at, created_at, updated_at, read_faults)
      SELECT q.id, s.owner, p.sha256, q.created_at, q.created_at, q.created_at, ?
      FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
      JOIN qa_pronunciation p ON p.job_id = q.id
      WHERE q.id = ? AND json_extract(q.payload, '$.processing') = 'd2' AND p.sha256 = ? AND s.owner = ?
      ON CONFLICT(job_id) DO NOTHING`)
      .bind(failRead ? 1 : 0, jobId, digest, owner),
  );
  const [, inserted] = await env.DB.batch(statements);
  const binding = await hostedOwner(env, jobId);
  if (!binding) return json({error: "No verified Work subscription"}, 409);
  if (binding.owner !== owner) return json({error: "Not found"}, 404);
  const content = await env.DB.prepare("SELECT content_sha FROM qa_review_recovery WHERE job_id = ?").bind(jobId).first();
  if (!content || content.content_sha !== (digest ?? null)) return json({error: "Submission already has different content"}, 409);
  if (recording) {
    const bound = await env.DB.prepare("SELECT sha256 FROM qa_pronunciation WHERE job_id = ?").bind(jobId).first();
    if (bound?.sha256 !== digest) return json({error: "Submission already has different content"}, 409);
  }
  if (!inserted.meta.changes) {
    const processing = await env.DB.prepare("SELECT 1 FROM qa_audio_processing WHERE job_id = ?").bind(jobId).first();
    if (Boolean(processing) !== processAudio) return json({error: "Submission already uses a different processing mode"}, 409);
    return json({jobId, duplicate: true});
  }
  if (!processAudio) ctx.waitUntil(pumpHostedReviews(env, jobId));
  return json({jobId, status: "pending"}, 202);
}

async function subscriptionId(owner, url) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(JSON.stringify([owner, url, eventName, eventScope])));
  return "qa_sub_" + Array.from(new Uint8Array(digest).slice(0, 20), byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function subscribe(env, owner, params, reply, error) {
  if (params?.name !== eventName || Object.keys(params.arguments ?? {}).length !== 0) return error(-32602, "Invalid event or filters.");
  if (!env.QA_RELAY_KEY) return error(-32015, "QA callback relay is unavailable.", {reason: "relay_unavailable"});
  const target = callback(params.delivery);
  if (!target) {
    await prepareEvents(env);
    const evidence = JSON.stringify({
      mode: params.delivery?.mode === "webhook",
      https: typeof params.delivery?.url === "string" && params.delivery.url.startsWith("https:"),
      allowedDomain: typeof params.delivery?.url === "string" && /^https:\/\/([a-z0-9-]+\.)*(chatgpt\.com|openai\.com)(\/|$)/i.test(params.delivery.url),
      secretFormat: /^whsec_/.test(params.delivery?.secret ?? ""),
    });
    await env.DB.prepare("INSERT OR REPLACE INTO probe (name, value) VALUES ('callback_shape', ?)").bind(evidence).run();
    return error(-32015, "Callback destination was not allowed.", {reason: "invalid_callback"});
  }
  await prepareEvents(env);
  const id = await subscriptionId(owner, target.url);
  const expires = Date.now() + 4 * 60 * 60 * 1000;
  const previous = await env.DB.prepare("SELECT verified, expires_at, destination FROM qa_subscriptions WHERE id = ?").bind(id).first();
  if (previous?.verified && previous.expires_at > Date.now() && same((await unseal(env, previous.destination)).secret, target.secret)) {
    await env.DB.prepare("UPDATE qa_subscriptions SET expires_at = ? WHERE id = ? AND verified = 1").bind(expires, id).run();
    return reply({id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false});
  }
  const challenge = crypto.randomUUID();
  const verificationId = "qa_verify_" + crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO qa_subscriptions (id, owner, destination, expires_at, verified) VALUES (?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET destination = excluded.destination, expires_at = excluded.expires_at, verified = 0`)
      .bind(id, owner, await seal(env, target), expires),
    env.DB.prepare("INSERT INTO qa_outbox (id, subscription, kind, payload, status, next_at, created_at) VALUES (?, ?, 'verify', ?, 'pending', ?, ?)")
      .bind(verificationId, id, JSON.stringify({type: "verification", challenge}), Date.now(), Date.now()),
  ]);
  if (!env.QA_TEST_RELAY_ONLY) {
    const verification = await claimHosted(env, "q.kind = 'verify' AND q.id = ?", [verificationId]);
    if (verification) {
      const outcome = await sendHostedCallback(verification, target);
      await env.DB.prepare("INSERT OR REPLACE INTO probe (name, value) VALUES ('hosted_challenge', ?)")
        .bind(JSON.stringify({status: outcome.status, reason: outcome.code, http: outcome.http})).run();
      if (outcome.status === "sent") {
        await finishHosted(env, verification, outcome);
      } else {
        // The legacy QA relay can still verify existing fixtures if cloud egress is unavailable.
        await env.DB.prepare(`UPDATE qa_outbox SET status = 'pending', lease = NULL, lease_until = NULL, error = ?
          WHERE id = ? AND status = 'leased' AND lease = ?`).bind(outcome.code, verification.id, verification.lease).run();
      }
    }
  }
  for (let i = 0; i < 24; i++) {
    const verification = await env.DB.prepare("SELECT status FROM qa_outbox WHERE id = ?").bind(verificationId).first();
    if (verification?.status === "sent") {
      const updated = await env.DB.prepare("UPDATE qa_subscriptions SET verified = 1 WHERE id = ? AND expires_at = ?").bind(id, expires).run();
      if (updated.meta.changes !== 1) return error(-32015, "Callback registration changed.", {reason: "subscription_changed"});
      return reply({id, refreshBefore: new Date(expires).toISOString(), cursor: null, truncated: false});
    }
    if (verification?.status === "failed") break;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  await env.DB.prepare("UPDATE qa_outbox SET status = 'failed', error = 'challenge_timeout' WHERE id = ? AND status != 'sent'").bind(verificationId).run();
  return error(-32015, "Work callback challenge failed or timed out.", {reason: "challenge_failed"});
}

export async function unsubscribe(env, owner, params, reply) {
  const url = callbackUrl(params?.delivery);
  const matchingEvent = params?.name === eventName && Object.keys(params.arguments ?? {}).length === 0;
  const id = params?.delivery ? (url && matchingEvent && await subscriptionId(owner, url)) : params?.id ?? params?.subscriptionId;
  if (typeof id !== "string") return reply({});
  await prepareEvents(env);
  await env.DB.prepare("UPDATE qa_subscriptions SET verified = 0, expires_at = ? WHERE id = ? AND owner = ?")
    .bind(Date.now(), id, owner).run();
  return reply({});
}

export async function relay(request, env) {
  const accessKey = env.QA_RELAY_ACCESS_KEY ?? env.QA_RELAY_KEY;
  const authorized = accessKey && same(request.headers.get("x-bandroom-qa-relay"), accessKey);
  if (!authorized) return json({error: "Unauthorized"}, 401);
  await prepareEvents(env);
  if (request.method !== "POST") return json({error: "Method not allowed"}, 405);
  const params = await request.json();
  const now = Date.now();
  if (params.action === "claim") {
    await env.DB.prepare(`UPDATE qa_outbox SET status = 'failed', error = 'lease_exhausted', finished_at = ?, lease = NULL, lease_until = NULL
      WHERE status = 'leased' AND attempts >= 5 AND lease_until <= ? AND substr(id, 1, ?) != ?`)
      .bind(now, now, hostedPrefix.length, hostedPrefix).run();
    const lease = crypto.randomUUID();
    const job = await env.DB.prepare(`UPDATE qa_outbox
      SET status = 'leased', lease = ?, lease_until = ? + CASE
        WHEN EXISTS (SELECT 1 FROM qa_pronunciation p WHERE p.job_id = qa_outbox.id AND p.mode = 'pronunciation-full') THEN 120000
        WHEN substr(id, 1, 10) = 'qa_speech_' OR substr(id, 1, 9) = 'qa_phone_' THEN 40000 ELSE 12000 END, attempts = attempts + 1
      WHERE id = (SELECT q.id FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
        WHERE s.expires_at > ? AND (q.kind = 'verify' OR s.verified = 1)
          AND substr(q.id, 1, ?) != ?
          AND q.attempts < 5
          AND ((q.status IN ('pending', 'retry') AND q.next_at <= ?) OR (q.status = 'leased' AND q.lease_until <= ?))
        ORDER BY q.kind = 'verify' DESC, q.created_at LIMIT 1)
      RETURNING id, subscription, kind, payload, lease, attempts`)
      .bind(lease, now, now, hostedPrefix.length, hostedPrefix, now, now).first();
    if (!job) return json({job: null});
    const sub = await env.DB.prepare("SELECT destination FROM qa_subscriptions WHERE id = ?").bind(job.subscription).first();
    if (isSpeaking(job.id)) {
      const evidence = await env.DB.prepare("SELECT 1 FROM qa_speech_evidence WHERE job_id = ?").bind(job.id).first();
      if (!evidence) job.recording = qaAudio;
    }
    if (isPronunciation(job.id)) {
      const binding = await env.DB.prepare("SELECT mode, sha256, evidence FROM qa_pronunciation WHERE job_id = ?").bind(job.id).first();
      if (!binding) return json({error: "Missing recording binding"}, 409);
      if (!binding.evidence) {
        if (binding.mode === fullSpeechMode) {
          const recording = await env.DB.prepare("SELECT audio FROM qa_recordings WHERE job_id = ?").bind(job.id).first();
          if (!recording) return json({error: "Missing recording"}, 409);
          job.acousticSample = {base64: recording.audio, sha256: binding.sha256, fullSpeech: true};
        } else {
          const clip = pronunciationFixture(binding.mode);
          if (!clip || clip.sha256 !== binding.sha256) return json({error: "Missing or changed recording"}, 409);
          job.acousticSample = clip;
        }
      }
    }
    return json({job: {...job, destination: await unseal(env, sub.destination)}});
  }
  if (params.action === "pronunciation_evidence") {
    const {id, lease} = params;
    if (typeof id !== "string" || !isPronunciation(id) || typeof lease !== "string") {
      return json({error: "Invalid acoustic evidence"}, 400);
    }
    const binding = await env.DB.prepare("SELECT mode FROM qa_pronunciation WHERE job_id = ?").bind(id).first();
    const evidence = binding && validEvidence(params.evidence, binding.mode);
    if (!evidence) return json({error: "Invalid acoustic evidence"}, 400);
    const saved = await env.DB.prepare(`UPDATE qa_pronunciation SET evidence = ?
      WHERE job_id = ? AND sha256 = ? AND mode = ? AND evidence IS NULL AND EXISTS (
        SELECT 1 FROM qa_outbox WHERE id = qa_pronunciation.job_id AND lease = ? AND lease_until > ? AND status = 'leased'
      )`).bind(JSON.stringify(evidence), id, evidence.audioSha256, binding.mode, lease, now).run();
    return saved.meta.changes === 1 ? json({saved: true}) : json({error: "Stale lease, mismatched recording or existing evidence"}, 409);
  }
  if (params.action === "evidence") {
    const {id, lease, segments} = params;
    if (typeof id !== "string" || !isSpeaking(id) || typeof lease !== "string" ||
        !Array.isArray(segments) || segments.length === 0 || segments.length > 40 ||
        segments.some(segment => !segment || !Number.isFinite(segment.start) || segment.start < 0 ||
          !Number.isFinite(segment.duration) || segment.duration <= 0 || segment.start + segment.duration > 8 ||
          typeof segment.text !== "string" || !segment.text.trim() || segment.text.length > 400)) {
      return json({error: "Invalid synthetic recording evidence"}, 400);
    }
    const saved = await env.DB.prepare(`INSERT OR IGNORE INTO qa_speech_evidence (job_id, segments)
      SELECT id, ? FROM qa_outbox WHERE id = ? AND lease = ? AND lease_until > ? AND status = 'leased'`)
      .bind(JSON.stringify(segments.map(({start, duration, text}) => ({start, duration, text}))), id, lease, now).run();
    return saved.meta.changes === 1 ? json({saved: true}) : json({error: "Stale lease or evidence already saved"}, 409);
  }
  if (params.action !== "finish" || typeof params.id !== "string" || typeof params.lease !== "string") return json({error: "Invalid operation"}, 400);
  const job = await env.DB.prepare(`SELECT q.attempts, q.kind, p.evidence AS acousticEvidence
    FROM qa_outbox q LEFT JOIN qa_pronunciation p ON p.job_id = q.id
    WHERE q.id = ? AND q.lease = ? AND q.lease_until > ? AND q.status = 'leased'`)
    .bind(params.id, params.lease, now).first();
  if (!job) return json({error: "Stale lease"}, 409);
  if (params.ok === true && isPronunciation(params.id) && !job.acousticEvidence) return json({error: "Acoustic evidence is required"}, 409);
  const codes = new Set(["injected_transient", "transport_error", "destination_rejected", "remote_temporary", "remote_rejected", "challenge_mismatch", "transcription_unavailable", "acoustic_analysis_unavailable"]);
  const code = codes.has(params.code) ? params.code : "transport_error";
  const retry = job.kind === "event" && job.attempts < 5 && params.retry === true;
  const result = params.ok === true ? "sent" : retry ? "retry" : "failed";
  const updated = await env.DB.prepare(`UPDATE qa_outbox SET status = ?, next_at = ?, error = ?, finished_at = ?, lease = NULL, lease_until = NULL
    WHERE id = ? AND lease = ? AND lease_until > ? AND status = 'leased'`)
    .bind(result, now + Math.min(12_000, 3_000 * 2 ** job.attempts), result === "sent" ? null : code, now, params.id, params.lease, now).run();
  return json({updated: updated.meta.changes === 1});
}

async function readRecording(request, maxBytes) {
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  if (!request.body) return new Uint8Array();
  const chunks = [];
  const reader = request.body.getReader();
  let length = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function audioMime(bytes) {
  const header = String.fromCharCode(...bytes.subarray(0, 12));
  if (header.startsWith("ID3") || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return "audio/mpeg";
  if (header.startsWith("\x1a\x45\xdf\xa3")) return "audio/webm";
  if (header.startsWith("OggS")) return "audio/ogg";
  if (header.slice(4, 8) === "ftyp") return "audio/mp4";
  if (header.startsWith("RIFF") && header.slice(8, 12) === "WAVE") return "audio/wav";
  return null;
}

export async function startReview(request, env, owner, ctx) {
  if (!owner || request.headers.get("origin") !== new URL(request.url).origin) return json({error: "Unauthorized"}, 401);
  await prepareEvents(env);
  const sub = await env.DB.prepare("SELECT id FROM qa_subscriptions WHERE owner = ? AND verified = 1 AND expires_at > ? ORDER BY expires_at DESC LIMIT 1")
    .bind(owner, Date.now()).first();
  if (!sub) return json({error: "No verified Work subscription"}, 409);
  const mode = new URL(request.url).searchParams.get("mode");
  const hosted = mode === "hosted-retry";
  const clip = pronunciationFixture(mode);
  const fullSpeech = mode === fullSpeechMode;
  if (mode !== null && mode !== "speaking" && !clip && !fullSpeech && !hosted) return json({error: "Invalid QA mode"}, 400);
  const submissionId = request.headers.get("x-bandroom-submission");
  let recording, mime, digest;
  if (fullSpeech) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(submissionId ?? "")) return json({error: "录音缺少提交编号。"}, 400);
    if (Number(request.headers.get("content-length")) > maxRecordingBytes) return json({error: "录音超过 1.2 MB。"}, 413);
    recording = await readRecording(request, maxRecordingBytes);
    if (!recording?.length) return json({error: "请提交一段 1.2 MB 以内的录音。"}, 413);
    mime = audioMime(recording);
    if (!mime) return json({error: "请选择 MP3、WebM、Ogg、M4A 或 WAV 录音。"}, 415);
    digest = await sha256(recording);
  }
  const prefix = hosted ? hostedPrefix : clip || fullSpeech ? "qa_phone_" : mode === "speaking" ? "qa_speech_" : "qa_review_";
  const jobId = prefix + (fullSpeech ? (await sha256(encoder.encode(JSON.stringify([owner, submissionId])))).slice(0, 32) : crypto.randomUUID());
  const now = Date.now();
  const event = {eventId: jobId, name: eventName, timestamp: new Date(now).toISOString(), data: {jobId}, cursor: null};
  const enqueue = env.DB.prepare("INSERT OR IGNORE INTO qa_outbox (id, subscription, kind, payload, status, next_at, created_at) VALUES (?, ?, 'event', ?, 'pending', ?, ?)")
    .bind(jobId, sub.id, JSON.stringify(event), hosted ? now : now + 2_000, now);
  if (fullSpeech) {
    const [queued, , , bound] = await env.DB.batch([
      enqueue,
      env.DB.prepare("INSERT OR IGNORE INTO qa_pronunciation (job_id, mode, sha256) VALUES (?, ?, ?)").bind(jobId, mode, digest),
      env.DB.prepare("INSERT OR IGNORE INTO qa_recordings (job_id, audio, mime) VALUES (?, ?, ?)").bind(jobId, encode(recording), mime),
      env.DB.prepare("SELECT sha256 FROM qa_pronunciation WHERE job_id = ? AND mode = ?").bind(jobId, mode),
    ]);
    if (bound.results[0]?.sha256 !== digest) return json({error: "提交编号已用于另一段录音。"}, 409);
    if (!queued.meta.changes) return json({jobId, duplicate: true}, 200);
  } else if (clip) {
    await env.DB.batch([enqueue, env.DB.prepare("INSERT INTO qa_pronunciation (job_id, mode, sha256) VALUES (?, ?, ?)").bind(jobId, mode, clip.sha256)]);
  } else {
    await enqueue.run();
    if (hosted) ctx.waitUntil(pumpHostedReviews(env, jobId));
  }
  return json({jobId, status: "pending"}, 202);
}

async function recordReviewRead(env, id, reason = null) {
  await env.DB.prepare(`INSERT INTO qa_review_reads (job_id, attempts, failures, last_error, last_at)
    VALUES (?, 1, ?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET
      attempts = attempts + 1, failures = failures + excluded.failures,
      last_error = excluded.last_error, last_at = excluded.last_at`)
    .bind(id, reason ? 1 : 0, reason, Date.now()).run();
}

// Events are wake-up hints. Discover durable work even if several callbacks
// arrive during one listener turn. Never expose another owner's pending jobs.
export async function pendingReviews(env, owner) {
  await prepareEvents(env);
  const {results} = await env.DB.prepare(`SELECT q.id AS jobId, q.created_at AS createdAt,
      CASE WHEN p.mode IS NOT NULL THEN 'recording' ELSE 'text' END AS kind,
      p.mode IS NULL OR p.evidence IS NOT NULL AS evidenceReady,
      COALESCE(r.attempts, 0) AS readAttempts, COALESCE(r.failures, 0) AS readFailures,
      r.last_error AS lastReadError, r.last_at AS lastReadAt, COUNT(*) OVER() AS pendingCount
    FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
    LEFT JOIN qa_pronunciation p ON p.job_id = q.id
    LEFT JOIN qa_review_reads r ON r.job_id = q.id
    WHERE s.owner = ? AND s.verified = 1 AND s.expires_at > ? AND q.kind = 'event'
      AND substr(q.id, 1, ?) = ?
      AND (q.status = 'sent' OR (q.status = 'leased' AND q.lease_until > ?)
        OR EXISTS (SELECT 1 FROM qa_review_recovery c WHERE c.job_id = q.id AND c.generation > 0))
      AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = q.id)
    ORDER BY evidenceReady DESC, q.created_at, q.id LIMIT 50`)
    .bind(owner, Date.now(), hostedPrefix.length, hostedPrefix, Date.now()).all();
  return {pendingCount: results[0]?.pendingCount ?? 0,
    pendingReviews: results.map(result => {
      const row = {...result, evidenceReady: Boolean(result.evidenceReady)};
      delete row.pendingCount;
      return row;
    })};
}

export async function reviewTool(env, owner, name, args, reply, error) {
  await prepareEvents(env);
  const id = typeof args?.jobId === "string" ? args.jobId : "";
  const available = `q.id = ? AND s.owner = ? AND s.verified = 1 AND s.expires_at > ? AND q.kind = 'event'
    AND (q.status = 'sent' OR (q.status = 'leased' AND q.lease_until > ?)
      OR EXISTS (SELECT 1 FROM qa_review_recovery r WHERE r.job_id = q.id AND r.generation > 0))`;
  const unavailable = () => error(-32602, "This QA review is unavailable for the signed-in owner.");
  const now = Date.now();
  const job = await env.DB.prepare(`SELECT p.evidence AS acousticEvidence, p.mode AS acousticMode FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
    LEFT JOIN qa_pronunciation p ON p.job_id = q.id
    WHERE ${available}`).bind(id, owner, now, now).first();
  if (!job) return unavailable();
  const result = value => reply({content: [{type: "text", text: JSON.stringify(value)}]});
  const missingEvidence = async (reason, message) => {
    // Count only authorized answer reads, including a blocked read. A failed
    // write or another owner's request must not alter the read audit.
    if (name === "read_qa_text_answer") await recordReviewRead(env, id, reason);
    return error(-32602, message, {retryable: false, reason});
  };
  if (name === "read_qa_text_answer") {
    const fault = await env.DB.prepare("UPDATE qa_review_recovery SET read_faults = read_faults - 1 WHERE job_id = ? AND read_faults > 0 RETURNING job_id")
      .bind(id).first();
    if (fault) {
      await recordReviewRead(env, id, "temporary_read_failure");
      return error(-32603, "Isolated acceptance test: one temporary answer-read failure. No feedback was saved.",
        {retryable: true, retryAfterSeconds: 5});
    }
  }
  let review = {...fixture, kind: "text", synthetic: true};
  if (isPronunciation(id) || job.acousticMode) {
    if (!job.acousticEvidence) return missingEvidence("acoustic_evidence_missing", "Acoustic evidence has not been recorded. Read the original with read_qa_recording_bytes; do not infer pronunciation from a transcript.");
    review = await pronunciationReview(id, JSON.parse(job.acousticEvidence), job.acousticMode);
  } else if (isSpeaking(id)) {
    const evidence = await env.DB.prepare("SELECT segments FROM qa_speech_evidence WHERE job_id = ?").bind(id).first();
    if (!evidence) return missingEvidence("transcript_missing", "The recording has not been transcribed.");
    const segments = JSON.parse(evidence.segments);
    review = {kind: "speaking_transcript", synthetic: true, question: speakingQuestion,
      answer: segments.map(segment => segment.text.trim()).join(" "), segments,
      scope: "Review the answer's content and wording only. Pronunciation cannot be assessed from this transcript."};
  }
  if (name === "read_qa_text_answer") {
    await recordReviewRead(env, id);
    return result({jobId: id, ...review});
  }
  const {quote} = args;
  let {feedback} = args;
  if (job.acousticMode === fullSpeechMode) {
    feedback = quote === review.quoteForWrite && fullSpeechFeedback(review, args);
    if (!feedback) return error(-32602, "Use the exact answer quote and sound evidence from this recording.");
  } else if (typeof quote !== "string" || (review.writePrefix ? quote !== review.answer : quote.length < 18 || !review.answer.includes(quote)) ||
      typeof feedback !== "string" || feedback.trim().length < 25 || feedback.length > 1200) {
    return error(-32602, "Quote the isolated answer exactly and provide specific feedback.");
  }
  if (review.writePrefix && (!feedback.startsWith(review.writePrefix) ||
      feedback.slice(review.writePrefix.length).trim().length < 25)) {
    return error(-32602, "Feedback needs the acoustic evidence receipt for this exact recording.");
  }
  const writtenAt = Date.now();
  const [stored, check] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO qa_feedback (job_id, owner, quote, feedback, created_at)
      SELECT q.id, s.owner, ?, ?, ? FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription WHERE ${available}`)
      .bind(quote, feedback, writtenAt, id, owner, writtenAt, writtenAt),
    env.DB.prepare(`SELECT 1 FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription WHERE ${available}`)
      .bind(id, owner, writtenAt, writtenAt),
  ]);
  if (!check.results.length) return unavailable();
  return result({jobId: id, saved: true, duplicate: stored.meta.changes === 0});
}

export async function reviewStatus(env, owner, target = null) {
  if (!owner) return json({error: "Unauthorized"}, 401);
  await prepareEvents(env);
  const {results} = await env.DB.prepare(`SELECT q.id AS jobId, q.kind, q.status, q.attempts, q.error,
    COALESCE(recovery.generation, 0) AS reviewRetries,
    a.fence AS processingFence, a.stage AS processingStage, a.reason AS processingReason,
    a.next_at AS processingNextAt, a.verified_sha AS verifiedSha256, a.verified_bytes AS verifiedBytes,
    CASE WHEN a.job_id IS NOT NULL THEN a.state
      WHEN f.job_id IS NOT NULL THEN 'complete'
      WHEN recovery.generation >= 4 AND q.status = 'sent' AND q.next_at <= ? THEN 'needs_attention'
      WHEN q.status = 'sent' THEN 'awaiting_feedback' ELSE q.status END AS reviewState,
    q.created_at AS createdAt, q.finished_at AS finishedAt, f.quote, f.feedback, f.created_at AS feedbackAt, e.segments,
    p.evidence AS acousticEvidence, COALESCE(o.job_id, r.job_id) AS recordingId,
    COALESCE(reads.attempts, 0) AS readAttempts, COALESCE(reads.failures, 0) AS readFailures,
    reads.last_error AS lastReadError, reads.last_at AS lastReadAt,
    s.verified = 1 AND s.expires_at > ? AS subscriptionActive
    FROM qa_outbox q JOIN qa_subscriptions s ON s.id = q.subscription
    LEFT JOIN qa_feedback f ON f.job_id = q.id AND f.owner = s.owner
    LEFT JOIN qa_speech_evidence e ON e.job_id = q.id
    LEFT JOIN qa_pronunciation p ON p.job_id = q.id
    LEFT JOIN qa_recordings r ON r.job_id = q.id
    LEFT JOIN qa_recording_objects o ON o.job_id = q.id
    LEFT JOIN qa_review_recovery recovery ON recovery.job_id = q.id
    LEFT JOIN qa_review_reads reads ON reads.job_id = q.id
    LEFT JOIN qa_audio_processing a ON a.job_id = q.id AND a.owner = s.owner
    WHERE s.owner = ? AND (? IS NULL OR q.id = ?) ORDER BY q.created_at DESC LIMIT 12`).bind(Date.now(), Date.now(), owner, target, target).all();
  const jobs = results.map(({segments, acousticEvidence, recordingId, ...job}) => ({
    ...job,
    subscriptionActive: Boolean(job.subscriptionActive),
    ...(recordingId && {recordingUrl: "/qa/reviews/" + recordingId + "/recording"}),
    ...(segments && {segments: JSON.parse(segments)}),
    ...(acousticEvidence && {acousticEvidence: JSON.parse(acousticEvidence)}),
  }));
  return target ? jobs.length ? json(jobs[0]) : json({error: "Not found"}, 404) : json({jobs});
}

export async function recordingBytesTool(env, owner, args, reply, error) {
  const {jobId, offset = 0, length = 24576} = args ?? {};
  if (typeof jobId !== "string" || !Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 1 || length > 24576) {
    return error(-32602, "Use a jobId, a nonnegative integer offset, and a length from 1 to 24576.");
  }
  await prepareEvents(env);
  const row = await ownedRecording(env, owner, jobId);
  let value;
  try {
    const recording = openRecording(row);
    if (!recording) return error(-32602, "Recording unavailable for this owner.");
    if (offset >= recording.length) return error(-32602, "Offset is outside the recording.");
    const size = Math.min(length, recording.length - offset);
    const body = await readRecordingBody(env.BUCKET, recording, {offset, length: size});
    if (!body) return error(-32603, "Recording is missing from storage.");
    const bytes = new Uint8Array(await new Response(body).arrayBuffer());
    if (bytes.length !== size) throw new Error("Incomplete recording range");
    value = {jobId, sha256: row.sha256, mimeType: recording.mime, totalBytes: recording.length,
      offset, length: size, nextOffset: offset + size < recording.length ? offset + size : null,
      base64: encode(bytes)};
  } catch {
    return error(-32603, "Recording storage is temporarily unavailable.", {retryable: true});
  }
  return reply({structuredContent: value, content: [{type: "text", text: JSON.stringify(value)}]});
}

function ownedRecording(env, owner, id) {
  return env.DB.prepare(`SELECT ${recordingFields}, p.sha256 FROM qa_outbox q
    JOIN qa_subscriptions s ON s.id = q.subscription JOIN qa_pronunciation p ON p.job_id = q.id
    LEFT JOIN qa_recordings r ON r.job_id = q.id LEFT JOIN qa_recording_objects o ON o.job_id = q.id
    WHERE q.id = ? AND s.owner = ?`).bind(id, owner).first();
}

export async function reviewRecording(request, env, owner, id) {
  if (!owner) return json({error: "Unauthorized"}, 401);
  await prepareEvents(env);
  try {
    const recording = openRecording(await ownedRecording(env, owner, id));
    if (!recording) return json({error: "Not found"}, 404);
    const headers = {"content-type": recording.mime, "cache-control": "private, no-store", "x-content-type-options": "nosniff", "accept-ranges": "bytes"};
    const rawRange = request.headers.get("range");
    let range;
    if (rawRange) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(rawRange);
      const start = match?.[1] ? Number(match[1]) : Math.max(0, recording.length - Number(match?.[2]));
      const end = match?.[1] && match[2] ? Math.min(Number(match[2]), recording.length - 1) : recording.length - 1;
      if (!match || !(match[1] || match[2]) || start > end) {
        return new Response(null, {status: 416, headers: {...headers, "content-range": "bytes */" + recording.length}});
      }
      range = {offset: start, length: end - start + 1};
      headers["content-range"] = `bytes ${start}-${end}/${recording.length}`;
    }
    const body = await readRecordingBody(env.BUCKET, recording, range);
    if (!body) return json({error: "Recording is missing from storage"}, 404);
    headers["content-length"] = String(range?.length ?? recording.length);
    return new Response(body, {status: range ? 206 : 200, headers});
  } catch {
    return json({error: "Recording storage temporarily unavailable"}, 503);
  }
}
