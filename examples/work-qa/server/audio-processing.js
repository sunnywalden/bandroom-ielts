import {openRecording, readRecordingBody, recordingFields} from "./recordings.js";

const leaseMs = 5 * 60_000;
const retryMs = 5 * 60_000;
const maxAttempts = 5;
const maxAgeMs = 24 * 60 * 60_000;
const transportStage = "qa_transport_fixture";
const transportMarker = "bandroom_qa_transport_fixture_v1";
const transportDigest = "975b862f50f2f1919a9bffffc2fa2f8f0f4b3b4c98ca6cdb00868e25f84bebf6";
const transportFeedback = "工程验收测试反馈。原录音已校验并写回此题。12 秒为回听测试点。";

export const createAudioProcessingTable = `CREATE TABLE IF NOT EXISTS qa_audio_processing (
  job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, input_sha TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', stage TEXT NOT NULL DEFAULT 'read_input',
  fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER, next_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0, read_faults INTEGER NOT NULL DEFAULT 0,
  verified_sha TEXT, verified_bytes INTEGER
)`;

export const createAudioProcessingIndex = `CREATE INDEX IF NOT EXISTS qa_audio_processing_due
  ON qa_audio_processing (owner, state, next_at, job_id)`;

const ownedLease = "job_id = ? AND owner = ? AND fence = ? AND state = 'running' AND lease_until > ?";
const leaseValues = (lease, now) => [lease.job_id, lease.owner, lease.fence, now];

export async function claimAudioProcessing(db, owner, now) {
  await db.prepare(`UPDATE qa_audio_processing
    SET state = 'needs_attention', reason = 'processing_budget_exhausted', lease_until = NULL, updated_at = ?
    WHERE owner = ? AND (state IN ('queued', 'retry_wait') OR (state = 'running' AND lease_until <= ?))
      AND (attempts >= ? OR created_at <= ?)`).bind(now, owner, now, maxAttempts, now - maxAgeMs).run();
  return db.prepare(`UPDATE qa_audio_processing
    SET state = 'running', fence = fence + 1, attempts = attempts + 1, lease_until = ?, updated_at = ?
    WHERE job_id = (
      SELECT job_id FROM qa_audio_processing WHERE owner = ?
        AND ((state IN ('queued', 'retry_wait') AND next_at <= ?) OR (state = 'running' AND lease_until <= ?))
        AND attempts < ? AND created_at > ?
      ORDER BY CASE WHEN state = 'running' THEN lease_until ELSE next_at END, job_id LIMIT 1
    ) RETURNING *`).bind(now + leaseMs, now, owner, now, now, maxAttempts, now - maxAgeMs).first();
}

export async function checkpointRecording(db, lease, digest, size, now) {
  const saved = await db.prepare(`UPDATE qa_audio_processing SET verified_sha = ?, verified_bytes = ?,
    stage = 'decode', lease_until = ?, updated_at = ?
    WHERE ${ownedLease} AND input_sha = ? AND stage IN ('read_input', 'decode')`)
    .bind(digest, size, now + leaseMs, now, ...leaseValues(lease, now), digest).run();
  return saved.meta.changes === 1;
}

async function transition(db, lease, state, reason, now) {
  const delay = state === "retry_wait" ? retryMs * 2 ** (lease.attempts - 1) : 0;
  const nextAt = now + delay;
  const exhausted = state === "retry_wait" && (lease.attempts >= maxAttempts || nextAt >= lease.created_at + maxAgeMs);
  const nextState = exhausted ? "needs_attention" : state;
  const nextReason = exhausted ? "processing_budget_exhausted" : reason;
  const result = await db.prepare(`UPDATE qa_audio_processing
    SET state = ?, reason = ?, next_at = ?, lease_until = NULL, updated_at = ?
    WHERE ${ownedLease} RETURNING job_id AS jobId, fence, state, stage, reason, next_at AS nextEligibleAt,
      verified_sha AS verifiedSha256, verified_bytes AS verifiedBytes`)
    .bind(nextState, nextReason, nextAt, now, ...leaseValues(lease, now)).first();
  return result ?? {jobId: lease.job_id, fence: lease.fence, reason: "lease_lost"};
}

async function finishVerifiedRecording(db, lease, transportFixtureJobId, now) {
  if (lease.job_id !== transportFixtureJobId || lease.input_sha !== transportDigest) {
    return transition(db, lease, "blocked", "qualified_analyzer_unavailable", now);
  }
  const verifiedLease = `${ownedLease} AND stage = 'decode' AND verified_sha = input_sha`;
  const values = leaseValues(lease, now);
  const [, written] = await db.batch([
    db.prepare(`INSERT OR IGNORE INTO qa_feedback (job_id, owner, quote, feedback, created_at)
      SELECT job_id, owner, ?, ?, ? FROM qa_audio_processing WHERE ${verifiedLease}`)
      .bind(transportMarker, transportFeedback, now, ...values),
    db.prepare(`UPDATE qa_audio_processing
      SET state = 'complete', stage = ?, reason = NULL, next_at = ?, lease_until = NULL, updated_at = ?
      WHERE ${verifiedLease} AND EXISTS (SELECT 1 FROM qa_feedback
        WHERE qa_feedback.job_id = qa_audio_processing.job_id AND qa_feedback.owner = qa_audio_processing.owner
          AND qa_feedback.quote = ? AND qa_feedback.feedback = ?)
      RETURNING job_id AS jobId, fence, state, stage, updated_at AS feedbackAt,
        verified_sha AS verifiedSha256, verified_bytes AS verifiedBytes`)
      .bind(transportStage, now, now, ...values, transportMarker, transportFeedback),
  ]);
  return written.results[0] ?? {jobId: lease.job_id, fence: lease.fence, reason: "fixture_write_not_committed"};
}

export async function advanceAudioProcessing(db, owner, transportFixtureJobId, bucket) {
  const lease = await claimAudioProcessing(db, owner, Date.now());
  if (!lease) return {jobId: null};
  if (lease.verified_sha === lease.input_sha && lease.stage === "decode") {
    return finishVerifiedRecording(db, lease, transportFixtureJobId, Date.now());
  }
  let bytes, digest;
  try {
    const fault = await db.prepare(`UPDATE qa_audio_processing SET read_faults = read_faults - 1
      WHERE ${ownedLease} AND read_faults > 0 RETURNING job_id`).bind(...leaseValues(lease, Date.now())).first();
    if (fault) return transition(db, lease, "retry_wait", "temporary_read_failure", Date.now());
    const row = await db.prepare(`SELECT ${recordingFields} FROM qa_audio_processing a
      LEFT JOIN qa_recordings r ON r.job_id = a.job_id LEFT JOIN qa_recording_objects o ON o.job_id = a.job_id
      WHERE a.job_id = ? AND a.owner = ?`).bind(lease.job_id, owner).first();
    let recording;
    try {
      recording = openRecording(row);
    } catch {
      return transition(db, lease, "needs_attention", "recording_corrupt", Date.now());
    }
    const body = recording && await readRecordingBody(bucket, recording);
    if (!body) return transition(db, lease, "needs_attention", "recording_missing", Date.now());
    bytes = body instanceof Uint8Array ? body : new Uint8Array(await new Response(body).arrayBuffer());
    const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    digest = Array.from(hash, byte => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    return transition(db, lease, "retry_wait", "temporary_read_failure", Date.now());
  }
  if (digest !== lease.input_sha) return transition(db, lease, "needs_attention", "recording_digest_mismatch", Date.now());
  if (!await checkpointRecording(db, lease, digest, bytes.length, Date.now())) {
    return {jobId: lease.job_id, fence: lease.fence, reason: "lease_lost"};
  }
  return finishVerifiedRecording(db, lease, transportFixtureJobId, Date.now());
}
