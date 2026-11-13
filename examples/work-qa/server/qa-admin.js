// Owner-only QA administration: append-only wake log (M13), queue drain (M6)
// and durable subscription observations (M7). This worker only ever sees the
// isolated QA D1/R2 bindings; none of these paths can reach production data.
import {pendingAcoustics} from "./acoustic-checkpoints.js";
import {cleanupScratch, isProbeOwner, prepareProbeScratch, scratchJobPattern} from "./runtime-probe.js";
import {fixture, hostedJobPattern, pendingReviews, prepareEvents, reviewTool} from "./work-events.js";

const drainJobPattern = new RegExp(`^(?:${hostedJobPattern.slice(1, -1)}|${scratchJobPattern.source})$`);
// The official HJK original job is retained until its bound completion exists.
// It is never silently removed as an incomplete fixture.
export const hjkJobId = "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710";
const defaultDrainFeedback = "隔离 QA 队列清空：通过既有写回路径完成本题批改，不涉及生产数据或真实评分。";
const digestPattern = /^[a-f0-9]{64}$/;
// G5 verify_work expects exactly these cloud event types per A/B/C run.
const runEventTypes = ["claimed", "retry_wait", "recording_verified", "checkpoint_saved", "interrupted",
  "checkpoint_restored", "suffix_completed", "feedback_committed", "receipt_readback", "offline_run"];
const runDetailKeys = ["taskId", "attemptId", "recordingId", "recordingSha256", "inputBytes", "reason",
  "nextAttemptAt", "recoverableAt", "receiptId", "feedbackId", "outputSha256"];

const noArgs = {
  $schema: "https://json-schema.org/draft/2020-12/schema", type: "object",
  properties: {}, required: [], additionalProperties: false,
};
const eventArgs = {
  ...noArgs,
  properties: {
    since: {type: "integer", minimum: 0, description: "Include events whose wall-clock time is at or after this Unix millisecond value."},
    afterId: {type: "integer", minimum: 0, description: "Return only events with a strictly larger append-only row id."},
    type: {type: "string", enum: [...runEventTypes, "wake", "drain_qa_queue"]},
    officialRunId: {type: "string", maxLength: 128},
    limit: {type: "integer", minimum: 1, maximum: 1000},
  },
};
const runEventArgs = {
  ...noArgs,
  properties: {
    type: {type: "string", enum: runEventTypes},
    officialRunId: {type: "string", maxLength: 128},
    fence: {type: "integer", minimum: 1},
    jobId: {type: "string", pattern: drainJobPattern.source},
    automationId: {type: "string", maxLength: 128},
    isolated: {type: "boolean"},
    bytes: {type: "integer", minimum: 0},
    sha256: {type: "string", pattern: digestPattern.source},
    recordingSha256: {type: "string", pattern: digestPattern.source},
    inputBytes: {type: "integer", minimum: 0},
    taskId: {type: "string", maxLength: 256},
    attemptId: {type: "string", maxLength: 256},
    recordingId: {type: "string", maxLength: 256},
    stage: {type: "string", maxLength: 16},
    at: {type: "integer", minimum: 0},
    source: {type: "string", maxLength: 64},
    reason: {type: "string", maxLength: 128},
    nextAttemptAt: {type: "string", maxLength: 64},
    recoverableAt: {type: "string", maxLength: 64},
    receiptId: {type: "string", maxLength: 256},
    feedbackId: {type: "string", maxLength: 256},
    outputSha256: {type: "string", pattern: digestPattern.source},
    detail: {type: "object"},
  },
  required: ["type", "officialRunId", "fence"],
};
const drainArgs = {
  ...noArgs,
  properties: {
    dryRun: {type: "boolean"},
    completeText: {type: "boolean"},
    cleanupScratch: {type: "boolean"},
    excludeJobIds: {type: "array", maxItems: 50, uniqueItems: true, items: {type: "string", pattern: drainJobPattern.source}},
    allowIncompleteExclude: {type: "boolean", description: "QA-only fixtures may be marked excluded without a completion. The HJK original job is never excluded incomplete."},
    feedback: {type: "string", minLength: 25, maxLength: 1200},
  },
};

export const adminTools = [
  {
    name: "read_qa_site_events",
    description: "Owner-only export of the append-only isolated QA wake log. Each official read_qa_status or recovery wake records UTC, pending text count, pending acoustic count, subscription liveness/expiry and jobId. Rows are inserted, never replaced; use afterId for incremental official-run-history emptyQueueWakes exports.",
    inputSchema: eventArgs,
    annotations: {readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "record_qa_run_event",
    description: "Owner-only append-only record of one isolated cloud run event for G5/site-event export. G5 requires a B-run recording_verified event with bytes and sha256, and offline_run records with automationId and isolated=true. Replays are idempotent per owner/officialRunId/type/fence; rows are never replaced.",
    inputSchema: runEventArgs,
    annotations: {readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false},
  },
  {
    name: "drain_qa_queue",
    description: "Owner-only isolated QA queue drain before the 24h empty-queue test. Completes pending text reviews through the existing write path, cleans qa_probe_ synthetic checkpoint fixtures, and durably marks explicitly named completed hosted jobs (including the HJK original after completion) so they no longer appear in pending counts. Returns before/after read_qa_status snapshots. Never touches production or learner data.",
    inputSchema: drainArgs,
    annotations: {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false},
  },
];

export async function prepareSiteEvents(env) {
  await prepareEvents(env);
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS qa_site_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    owner TEXT NOT NULL,
    at INTEGER NOT NULL,
    utc TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'wake',
    official_run_id TEXT,
    fence INTEGER,
    job_id TEXT,
    automation_id TEXT,
    isolated INTEGER,
    bytes INTEGER,
    sha256 TEXT,
    stage TEXT,
    detail TEXT,
    pending_count INTEGER NOT NULL,
    pending_acoustics INTEGER NOT NULL,
    subscription_active INTEGER NOT NULL,
    subscription_verified INTEGER NOT NULL,
    subscription_expires_at INTEGER,
    source TEXT NOT NULL
  )`).run();
  // Pre-deploy QA databases may already have the wake-only table. Add the G5
  // run-event columns in place without touching existing rows.
  const info = await env.DB.prepare("PRAGMA table_info(qa_site_events)").all();
  const present = new Set(info.results.map(row => row.name));
  for (const [name, ddl] of [
    ["kind", "TEXT NOT NULL DEFAULT 'wake'"],
    ["official_run_id", "TEXT"], ["fence", "INTEGER"], ["automation_id", "TEXT"],
    ["isolated", "INTEGER"], ["bytes", "INTEGER"], ["sha256", "TEXT"],
    ["stage", "TEXT"], ["detail", "TEXT"],
  ]) {
    if (!present.has(name)) await env.DB.prepare(`ALTER TABLE qa_site_events ADD COLUMN ${name} ${ddl}`).run();
  }
  await env.DB.prepare(`CREATE INDEX IF NOT EXISTS qa_site_events_owner_id
    ON qa_site_events (owner, id)`).run();
  // Idempotent run-event recording. Wake rows have a null official_run_id, and
  // SQLite treats null keys as distinct, so wakes remain freely appendable.
  await env.DB.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS qa_site_events_run_event
    ON qa_site_events (owner, official_run_id, kind, fence)`).run();
}

export async function subscriptionSnapshot(env, owner, now = Date.now()) {
  await prepareEvents(env);
  const row = await env.DB.prepare(`SELECT id AS subscriptionId, verified, expires_at AS expiresAt
    FROM qa_subscriptions WHERE owner = ?
    ORDER BY verified DESC, expires_at DESC, id ASC LIMIT 1`).bind(owner).first();
  if (!row) return {subscriptionId: null, verified: false, active: false, expiresAt: null};
  const verified = Boolean(row.verified);
  const expiresAt = Number.isSafeInteger(row.expiresAt) ? row.expiresAt : null;
  return {subscriptionId: row.subscriptionId, verified, expiresAt,
    active: verified && expiresAt !== null && expiresAt > now};
}

async function insertSiteEvent(env, event) {
  await prepareSiteEvents(env);
  const inserted = await env.DB.prepare(`INSERT INTO qa_site_events
    (owner, at, utc, kind, job_id, pending_count, pending_acoustics, subscription_active,
      subscription_verified, subscription_expires_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(event.owner, event.at, event.utc, event.kind ?? "wake", event.jobId,
      event.pendingCount, event.pendingAcoustics,
      event.subscriptionActive ? 1 : 0, event.subscriptionVerified ? 1 : 0,
      event.subscriptionExpiresAt, event.source).run();
  return Number(inserted.meta.last_row_id ?? 0);
}

export async function recordWake(env, owner, {pendingCount, pendingAcoustics: pendingAcousticCount, jobId = null, subscription, source}) {
  if (!subscription) subscription = await subscriptionSnapshot(env, owner);
  const at = Date.now();
  const event = {
    owner, at, utc: new Date(at).toISOString(), jobId,
    kind: source === "drain_qa_queue" ? "drain_qa_queue" : "wake",
    pendingCount, pendingAcoustics: pendingAcousticCount,
    subscriptionActive: subscription.active, subscriptionVerified: subscription.verified,
    subscriptionExpiresAt: subscription.expiresAt, source,
  };
  const id = await insertSiteEvent(env, event);
  return {...event, id, subscriptionId: subscription.subscriptionId ?? null,
    emptyQueueAccepted: pendingCount === 0 && pendingAcousticCount === 0 && subscription.active};
}

export async function observeWake(env, owner, source) {
  const reviews = await pendingReviews(env, owner);
  const acoustics = await pendingAcoustics(env, owner);
  const subscription = await subscriptionSnapshot(env, owner);
  const jobId = reviews.pendingReviews.length === 1 ? reviews.pendingReviews[0].jobId : null;
  return recordWake(env, owner, {pendingCount: reviews.pendingCount,
    pendingAcoustics: acoustics.length, jobId, subscription, source});
}

async function recordRunEvent(env, owner, args) {
  await prepareSiteEvents(env);
  const subscription = await subscriptionSnapshot(env, owner);
  const at = args.at ?? Date.now();
  const detail = {};
  for (const key of runDetailKeys) if (args[key] !== undefined) detail[key] = args[key];
  if (args.detail) Object.assign(detail, args.detail);
  const detailJson = Object.keys(detail).length ? JSON.stringify(detail) : null;
  if (detailJson && detailJson.length > 16_384) throw new Error("run event detail too large");
  const isolated = args.isolated === undefined ? null : (args.isolated ? 1 : 0);
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO qa_site_events
    (owner, at, utc, kind, official_run_id, fence, job_id, automation_id, isolated, bytes, sha256, stage, detail,
      pending_count, pending_acoustics, subscription_active, subscription_verified, subscription_expires_at, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`)
    .bind(owner, at, new Date(at).toISOString(), args.type, args.officialRunId, args.fence,
      args.jobId ?? null, args.automationId ?? null, isolated, args.bytes ?? null, args.sha256 ?? null,
      args.stage ?? null, detailJson, subscription.active ? 1 : 0, subscription.verified ? 1 : 0,
      subscription.expiresAt, args.source ?? "cloud").run();
  const existing = await env.DB.prepare(`SELECT id FROM qa_site_events
    WHERE owner = ? AND official_run_id = ? AND kind = ? AND fence = ?`)
    .bind(owner, args.officialRunId, args.type, args.fence).first();
  return {id: existing?.id ?? null, recorded: inserted.meta.changes === 1, duplicate: inserted.meta.changes === 0,
    type: args.type, officialRunId: args.officialRunId, fence: args.fence,
    automationId: args.automationId ?? null, bytes: args.bytes ?? null, sha256: args.sha256 ?? null,
    source: args.source ?? "cloud"};
}

async function readSiteEvents(env, owner, args) {
  await prepareSiteEvents(env);
  const since = args.since ?? 0;
  const afterId = args.afterId ?? 0;
  const limit = args.limit ?? 500;
  let where = "owner = ? AND id > ? AND at >= ?";
  const values = [owner, afterId, since];
  if (args.type !== undefined) { where += " AND kind = ?"; values.push(args.type); }
  if (args.officialRunId !== undefined) { where += " AND official_run_id = ?"; values.push(args.officialRunId); }
  values.push(limit);
  const {results} = await env.DB.prepare(`SELECT id, at, utc, kind, official_run_id AS officialRunId,
      fence, job_id AS jobId, automation_id AS automationId, isolated, bytes, sha256, stage, detail, source,
      pending_count AS pendingCount, pending_acoustics AS pendingAcoustics,
      subscription_active AS subscriptionActive, subscription_verified AS subscriptionVerified,
      subscription_expires_at AS subscriptionExpiresAt
    FROM qa_site_events WHERE ${where}
    ORDER BY id ASC LIMIT ?`).bind(...values).all();
  const events = results.map(row => {
    let detail = {};
    if (row.detail) { try { detail = JSON.parse(row.detail); } catch { detail = {}; } }
    const core = {
      id: row.id, kind: row.kind, type: row.kind, at: row.at, utc: row.utc,
      officialRunId: row.officialRunId, fence: row.fence, jobId: row.jobId,
      automationId: row.automationId, isolated: row.isolated === null ? null : Boolean(row.isolated),
      bytes: row.bytes, sha256: row.sha256, stage: row.stage, source: row.source,
      pendingCount: row.pendingCount, pendingAcoustics: row.pendingAcoustics,
      subscriptionActive: Boolean(row.subscriptionActive),
      subscriptionVerified: Boolean(row.subscriptionVerified),
      subscriptionExpiresAt: row.subscriptionExpiresAt,
    };
    return {...detail, ...core,
      emptyQueueAccepted: row.kind === "wake" && row.pendingCount === 0 && row.pendingAcoustics === 0 &&
        Boolean(row.subscriptionActive)};
  });
  return {owner, events, count: events.length, lastId: events.at(-1)?.id ?? afterId, limit};
}

async function drainSnapshot(env, owner) {
  await prepareProbeScratch(env);
  const [reviews, acoustics, subscription] = [await pendingReviews(env, owner),
    await pendingAcoustics(env, owner), await subscriptionSnapshot(env, owner)];
  const scratch = await env.DB.prepare(`SELECT job_id AS jobId, expires_at AS expiresAt
    FROM qa_runtime_probe_scratch WHERE owner = ? AND closing = 0 AND expires_at > ?
    ORDER BY job_id`).bind(owner, Date.now()).all();
  return {
    pendingCount: reviews.pendingCount,
    pendingReviews: reviews.pendingReviews.map(row => ({jobId: row.jobId, kind: row.kind, evidenceReady: row.evidenceReady})),
    pendingReviewIds: reviews.pendingReviews.map(row => row.jobId),
    pendingAcoustics: acoustics.map(row => ({jobId: row.jobId, nextIndex: row.nextIndex, recipeSha256: row.recipeSha256})),
    scratchFixtures: scratch.results,
    subscription,
  };
}

async function completeTextReview(env, owner, jobId, feedback) {
  let outcome = null;
  const reply = value => { outcome = {ok: true, value}; return value; };
  const error = (code, message, data) => { outcome = {ok: false, code, message, data}; return {code, message}; };
  await reviewTool(env, owner, "write_qa_text_feedback", {jobId, quote: fixture.answer, feedback}, reply, error);
  if (!outcome) return {jobId, status: "error", code: -32603, message: "No write result."};
  if (!outcome.ok) return {jobId, status: "error", code: outcome.code, message: outcome.message};
  let value = outcome.value?.structuredContent;
  if (!value?.saved && typeof outcome.value?.content?.[0]?.text === "string") {
    try { value = JSON.parse(outcome.value.content[0].text); } catch { value = null; }
  }
  if (!value?.saved) return {jobId, status: "error", message: "Write was not saved."};
  return {jobId, status: value.duplicate ? "duplicate" : "completed", duplicate: Boolean(value.duplicate)};
}

async function jobOwner(env, jobId) {
  return env.DB.prepare(`SELECT s.owner AS owner FROM qa_outbox q
    JOIN qa_subscriptions s ON s.id = q.subscription WHERE q.id = ?`).bind(jobId).first();
}

async function completionExists(env, owner, jobId) {
  return env.DB.prepare(`SELECT
      EXISTS (SELECT 1 FROM qa_feedback WHERE job_id = ? AND owner = ?) AS feedback,
      EXISTS (SELECT 1 FROM qa_acoustic_completions WHERE job_id = ? AND owner = ?) AS completion`)
    .bind(jobId, owner, jobId, owner).first();
}

async function excludeJob(env, owner, jobId, {dryRun, allowIncompleteExclude}) {
  const ownerRow = await jobOwner(env, jobId);
  if (!ownerRow || ownerRow.owner !== owner) return {jobId, status: "skipped", reason: "not_owned_or_missing"};
  const completion = await completionExists(env, owner, jobId);
  const completed = Boolean(completion?.feedback || completion?.completion);
  if (!completed && (jobId === hjkJobId || !allowIncompleteExclude)) {
    return {jobId, status: "skipped", reason: jobId === hjkJobId ? "hjk_requires_completion" : "not_complete"};
  }
  const reason = completed ? "completed" : "fixture_excluded";
  if (dryRun) return {jobId, status: "planned", reason};
  const inserted = await env.DB.prepare(`INSERT OR IGNORE INTO qa_drained_jobs (job_id, owner, reason, at)
    VALUES (?, ?, ?, ?)`).bind(jobId, owner, reason, Date.now()).run();
  return {jobId, status: inserted.meta.changes === 1 ? "excluded" : "already_marked", reason};
}

async function drainQueue(env, owner, args) {
  const dryRun = args.dryRun === true;
  const completeText = args.completeText !== false;
  const cleanupScratchFixtures = args.cleanupScratch !== false;
  const allowIncompleteExclude = args.allowIncompleteExclude === true;
  const feedback = args.feedback ?? defaultDrainFeedback;
  const excludeJobIds = args.excludeJobIds ?? [];
  const before = await drainSnapshot(env, owner);
  const text = [];
  const scratch = [];
  const excluded = [];
  const skipped = [];

  if (completeText) {
    for (const {jobId} of before.pendingReviews.filter(row => row.kind === "text")) {
      if (dryRun) { text.push({jobId, status: "planned"}); continue; }
      try { text.push(await completeTextReview(env, owner, jobId, feedback)); }
      catch (error) { text.push({jobId, status: "error", message: "Text completion failed."}); }
    }
  }

  if (cleanupScratchFixtures) {
    for (const row of before.scratchFixtures) {
      if (dryRun) { scratch.push({jobId: row.jobId, status: "planned"}); continue; }
      try { scratch.push(await cleanupScratch(env, owner, row.jobId)); }
      catch (error) { scratch.push({jobId: row.jobId, status: "error", message: "Scratch cleanup failed."}); }
    }
  }

  for (const jobId of excludeJobIds) {
    try { excluded.push(await excludeJob(env, owner, jobId, {dryRun, allowIncompleteExclude})); }
    catch (error) { skipped.push({jobId, status: "error", message: "Exclusion failed."}); }
  }

  const after = await drainSnapshot(env, owner);
  const wake = await recordWake(env, owner, {
    pendingCount: after.pendingCount,
    pendingAcoustics: after.pendingAcoustics.length,
    jobId: after.pendingReviewIds.length === 1 ? after.pendingReviewIds[0] : null,
    subscription: after.subscription,
    source: "drain_qa_queue",
  });
  return {owner, dryRun, before, after, text, scratch, excluded, skipped, wake};
}

function validRunEventArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const allowed = ["type", "officialRunId", "fence", "jobId", "automationId", "isolated", "bytes", "sha256",
    "stage", "at", "source", "detail", ...runDetailKeys];
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (!runEventTypes.includes(args.type)) return false;
  if (typeof args.officialRunId !== "string" || !args.officialRunId || args.officialRunId.length > 128) return false;
  if (!Number.isSafeInteger(args.fence) || args.fence < 1) return false;
  if (args.jobId !== undefined && (typeof args.jobId !== "string" || !drainJobPattern.test(args.jobId))) return false;
  if (args.automationId !== undefined &&
      (typeof args.automationId !== "string" || args.automationId.length > 128)) return false;
  if (args.isolated !== undefined && typeof args.isolated !== "boolean") return false;
  if (args.bytes !== undefined && (!Number.isSafeInteger(args.bytes) || args.bytes < 0)) return false;
  if (args.inputBytes !== undefined && (!Number.isSafeInteger(args.inputBytes) || args.inputBytes < 0)) return false;
  if (args.at !== undefined && (!Number.isSafeInteger(args.at) || args.at < 0)) return false;
  for (const key of ["sha256", "recordingSha256", "outputSha256"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || !digestPattern.test(args[key]))) return false;
  }
  for (const key of ["taskId", "attemptId", "recordingId", "receiptId", "feedbackId"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length > 256)) return false;
  }
  for (const key of ["stage", "source", "reason", "nextAttemptAt", "recoverableAt"]) {
    if (args[key] !== undefined && (typeof args[key] !== "string" || args[key].length > 128)) return false;
  }
  if (args.detail !== undefined &&
      (args.detail === null || typeof args.detail !== "object" || Array.isArray(args.detail))) return false;
  if (args.type === "recording_verified" &&
      (!Number.isSafeInteger(args.bytes) || args.bytes < 0 || typeof args.sha256 !== "string" ||
        !digestPattern.test(args.sha256))) return false;
  if (args.type === "offline_run" &&
      (typeof args.automationId !== "string" || !args.automationId || args.isolated !== true)) return false;
  return true;
}

function validAdminArgs(name, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  if (name === "record_qa_run_event") return validRunEventArgs(args);
  const allowed = name === "read_qa_site_events" ? ["since", "afterId", "type", "officialRunId", "limit"]
    : ["dryRun", "completeText", "cleanupScratch", "excludeJobIds", "allowIncompleteExclude", "feedback"];
  if (Object.keys(args).some(key => !allowed.includes(key))) return false;
  if (name === "read_qa_site_events") {
    for (const key of ["since", "afterId", "limit"]) {
      if (args[key] !== undefined && (!Number.isSafeInteger(args[key]) || args[key] < 0)) return false;
    }
    if (args.type !== undefined && (typeof args.type !== "string" || ![...runEventTypes, "wake", "drain_qa_queue"].includes(args.type))) return false;
    if (args.officialRunId !== undefined &&
        (typeof args.officialRunId !== "string" || args.officialRunId.length > 128)) return false;
    return args.limit === undefined || (args.limit >= 1 && args.limit <= 1000);
  }
  for (const key of ["dryRun", "completeText", "cleanupScratch", "allowIncompleteExclude"]) {
    if (args[key] !== undefined && typeof args[key] !== "boolean") return false;
  }
  if (args.feedback !== undefined &&
      (typeof args.feedback !== "string" || args.feedback.length < 25 || args.feedback.length > 1200)) return false;
  if (args.excludeJobIds !== undefined) {
    if (!Array.isArray(args.excludeJobIds) || args.excludeJobIds.length > 50 ||
        new Set(args.excludeJobIds).size !== args.excludeJobIds.length ||
        args.excludeJobIds.some(id => typeof id !== "string" || !drainJobPattern.test(id))) return false;
  }
  return true;
}

export async function adminTool(env, owner, name, args, reply, error) {
  if (!await isProbeOwner(owner)) return error(-32001, "Probe owner access required.");
  if (!validAdminArgs(name, args)) return error(-32602, "Invalid QA administration parameters.");
  try {
    if (name === "read_qa_site_events") {
      const data = await readSiteEvents(env, owner, args);
      return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
    }
    if (name === "record_qa_run_event") {
      const data = await recordRunEvent(env, owner, args);
      return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
    }
    const data = await drainQueue(env, owner, args);
    return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
  } catch {
    return error(-32603, "QA administration storage is temporarily unavailable.", {retryable: true});
  }
}
