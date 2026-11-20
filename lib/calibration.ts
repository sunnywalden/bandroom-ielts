// Personal pronunciation calibration data layer (design rev2 §8/§9).
//
// Authorization: every function takes the authenticated userId as its first
// argument. No MCP tool input contains a userId field; the MCP route passes
// auth.user.userId, which in the current single-owner deployment is the owner
// account. Multi-user isolation therefore needs an auth-scope redesign before a
// second user is onboarded (rev2 §10); this module already scopes every SQL
// statement by user_id so the data model is ready for that change.
//
// Idempotency: calibration_events has UNIQUE(user_id, attempt_id, candidate_id).
// Replaying the same verdict conflicts and is ignored, then the stored event is
// returned unchanged.
//
// Transaction strategy: counts are never read-modified-written in application
// code. A verdict appends an event and rebuilds the category row from the event
// log (event sourcing). Issuance increments n_shown with an atomic UPSERT
// (`n_shown = n_shown + 1`). Both run inside one D1 batch, which D1 executes as
// a single transaction.
import { z } from "zod/v4";

type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<{ meta?: { changes?: number } }>;
};

export type CalibrationDb = {
  prepare(query: string): Prepared;
  batch(statements: Prepared[]): Promise<unknown[]>;
};

export class CalibrationError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = "CalibrationError";
    this.code = code;
  }
}
const reject = (code: string, message: string): never => {
  throw new CalibrationError(code, message);
};

export const CALIBRATION_RULE_VERSION = "r6-suppress-1";
export const CALIBRATION_UNKNOWN_DETECTOR_VERSION = "unknown";
export const CALIBRATION_UNKNOWN_INVENTORY_VERSION = "unknown";
export const calibrationVerdicts = ["confirmed", "rejected", "unsure"] as const;
export type CalibrationVerdict = (typeof calibrationVerdicts)[number];
export type CalibrationState = "CANDIDATE" | "TRUSTED" | "SUPPRESSED";

const profileColumns = `expected, actual, n_confirmed AS nConfirmed, n_rejected AS nRejected,
  n_unsure AS nUnsure, n_shown AS nShown, state, rule_version AS ruleVersion,
  detector_version AS detectorVersion, inventory_version AS inventoryVersion,
  updated_at AS updatedAt`;

const eventColumns = `id, attempt_id AS attemptId, candidate_id AS candidateId, expected, actual,
  verdict, is_catch_trial AS isCatchTrial, created_at AS createdAt`;

export type CalibrationProfileRow = {
  expected: string;
  actual: string;
  nConfirmed: number;
  nRejected: number;
  nUnsure: number;
  nShown: number;
  state: CalibrationState;
  ruleVersion: string;
  detectorVersion: string;
  inventoryVersion: string;
  updatedAt: number;
};

export type CalibrationEventRow = {
  id: number;
  attemptId: string;
  candidateId: string;
  expected: string;
  actual: string;
  verdict: CalibrationVerdict;
  isCatchTrial: boolean;
  createdAt: number;
};

export type CalibrationCandidateRow = {
  candidateId: string;
  attemptId: string;
  recordingId: string;
  word: string;
  expected: string;
  actual: string;
  atMs: number;
  detectorConfidence: number;
  shownAt: number;
  answeredAt: number | null;
};

const phoneme = z.string().trim().min(1).max(24).regex(/^[A-Z0-9_]+$/, "Canonical ARPABET symbol expected.");
const candidateInput = z.strictObject({
  word: z.string().trim().min(1).max(160),
  expected: phoneme,
  actual: phoneme,
  atMs: z.number().int().min(0),
  detectorConfidence: z.number().min(0).max(1),
  catchTrial: z.boolean().optional(),
});
const issueInput = z.strictObject({
  attemptId: z.string().trim().min(1).max(200),
  recordingId: z.string().trim().min(1).max(200),
  detectorVersion: z.string().trim().min(1).max(120),
  inventoryVersion: z.string().trim().min(1).max(120),
  ruleVersion: z.string().trim().min(1).max(120).optional(),
  candidates: z.array(candidateInput).min(1).max(64),
});

/** Derive catch-trial status server-side. Never trust a client-supplied flag. */
export function isCatchTrialCandidate(candidate: { expected: string; actual: string }): boolean {
  return candidate.expected === candidate.actual;
}

function changes(result: unknown): number {
  const value = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  return Number.isFinite(value) ? Number(value) : 0;
}

/**
 * Server-side candidate issuance. This is intentionally NOT an MCP tool: the
 * feedback pipeline calls it after it has produced calibrated phoneme
 * candidates, so a client can never mint a candidateId or choose the tuple.
 *
 * Every candidate gets a fresh server-generated UUID and is recorded as shown
 * to this user. Non-catch candidates atomically increment n_shown for their
 * (expected, actual) category, creating the profile row with the detector and
 * inventory versions in force. If an existing row was produced by a different
 * detector/inventory version, issuance fails closed and requires a mapped
 * migration or reset (rev2 FIX-17).
 */
export async function issueCalibrationCandidates(
  db: CalibrationDb,
  userId: string,
  input: unknown,
): Promise<{ candidateIds: string[]; issuedAt: number }> {
  if (typeof userId !== "string" || !userId) return reject("user_required", "Authenticated user is required.");
  const parsed = issueInput.parse(input);
  const issuedAt = Date.now();
  const ruleVersion = parsed.ruleVersion ?? CALIBRATION_RULE_VERSION;
  const statements: Prepared[] = [];
  const candidateIds: string[] = [];

  // Fail closed if the profile for this category was built by another detector
  // or inventory. Silent relabelling would violate FIX-17.
  const seen = new Set<string>();
  for (const candidate of parsed.candidates) {
    if (candidate.catchTrial) candidate.actual = candidate.expected;
    if (isCatchTrialCandidate(candidate)) continue;
    const key = `${candidate.expected}\u0000${candidate.actual}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = await db.prepare(`SELECT detector_version AS detectorVersion,
      inventory_version AS inventoryVersion FROM personal_calibration
      WHERE user_id=? AND expected=? AND actual=?`).bind(userId, candidate.expected, candidate.actual).first();
    if (existing
      && (String(existing.detectorVersion) !== parsed.detectorVersion
        || String(existing.inventoryVersion) !== parsed.inventoryVersion)) {
      reject("detector_version_mismatch",
        "The existing profile was produced by a different detector or inventory. Migrate or reset it before issuing new candidates.");
    }
  }

  for (const candidate of parsed.candidates) {
    const actual = candidate.catchTrial ? candidate.expected : candidate.actual;
    const candidateId = crypto.randomUUID();
    candidateIds.push(candidateId);
    statements.push(db.prepare(`INSERT INTO calibration_candidates
      (candidate_id, user_id, attempt_id, recording_id, word, expected, actual, at_ms,
       detector_confidence, shown_at, answered_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`).bind(
      candidateId, userId, parsed.attemptId, parsed.recordingId, candidate.word,
      candidate.expected, actual, candidate.atMs, candidate.detectorConfidence, issuedAt));
    if (candidate.expected !== actual) {
      statements.push(db.prepare(`INSERT INTO personal_calibration
        (user_id, expected, actual, n_confirmed, n_rejected, n_unsure, n_shown, state,
         rule_version, detector_version, inventory_version, updated_at)
        VALUES (?,?,?,0,0,0,1,'CANDIDATE',?,?,?,?)
        ON CONFLICT(user_id, expected, actual) DO UPDATE SET
          n_shown = personal_calibration.n_shown + 1,
          rule_version = excluded.rule_version,
          updated_at = excluded.updated_at`).bind(
        userId, candidate.expected, actual, ruleVersion, parsed.detectorVersion,
        parsed.inventoryVersion, issuedAt));
    }
  }
  await db.batch(statements);
  return { candidateIds, issuedAt };
}

async function readEvent(
  db: CalibrationDb, userId: string, attemptId: string, candidateId: string,
): Promise<CalibrationEventRow | null> {
  const row = await db.prepare(`SELECT ${eventColumns} FROM calibration_events
    WHERE user_id=? AND attempt_id=? AND candidate_id=?`)
    .bind(userId, attemptId, candidateId).first();
  return row ? toEvent(row) : null;
}

/**
 * Verdicts already recorded for a set of server-issued candidateIds.
 *
 * The speaking redesign's transcript colors (red/green = the learner's own
 * self-listen verdict) must survive a page reload; the stored analysisJson
 * never contains verdicts, so the coach read path decorates items with these.
 * Bounded by the caller (<= 24 candidates per review).
 */
export async function verdictsForCandidates(
  db: CalibrationDb, userId: string, candidateIds: string[],
): Promise<Record<string, CalibrationVerdict>> {
  const ids = [...new Set(candidateIds.filter((id) => typeof id === "string" && id))];
  if (!ids.length) return {};
  const out: Record<string, CalibrationVerdict> = {};
  // D1 caps bound parameters at 100 per statement; the coach read path can
  // accumulate candidates across every reviewed day, so chunk with one slot
  // reserved for userId.
  const CHUNK = 90;
  for (let start = 0; start < ids.length; start += CHUNK) {
    const chunk = ids.slice(start, start + CHUNK);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await db.prepare(
      `SELECT candidate_id AS candidateId, verdict FROM calibration_events
       WHERE user_id=? AND candidate_id IN (${placeholders})`,
    ).bind(userId, ...chunk).all<{ candidateId: string; verdict: string }>();
    for (const row of rows.results ?? []) {
      if (calibrationVerdicts.includes(row.verdict as CalibrationVerdict)) {
        out[row.candidateId] = row.verdict as CalibrationVerdict;
      }
    }
  }
  return out;
}

async function readProfileRow(
  db: CalibrationDb, userId: string, expected: string, actual: string,
): Promise<CalibrationProfileRow | null> {
  const row = await db.prepare(`SELECT ${profileColumns} FROM personal_calibration
    WHERE user_id=? AND expected=? AND actual=?`).bind(userId, expected, actual).first();
  return row ? toProfile(row) : null;
}

function toEvent(row: Record<string, unknown>): CalibrationEventRow {
  return {
    id: Number(row.id),
    attemptId: String(row.attemptId),
    candidateId: String(row.candidateId),
    expected: String(row.expected),
    actual: String(row.actual),
    verdict: String(row.verdict) as CalibrationVerdict,
    isCatchTrial: Boolean(row.isCatchTrial),
    createdAt: Number(row.createdAt),
  };
}

function toProfile(row: Record<string, unknown>): CalibrationProfileRow {
  return {
    expected: String(row.expected),
    actual: String(row.actual),
    nConfirmed: Number(row.nConfirmed),
    nRejected: Number(row.nRejected),
    nUnsure: Number(row.nUnsure),
    nShown: Number(row.nShown),
    state: String(row.state) as CalibrationState,
    ruleVersion: String(row.ruleVersion),
    detectorVersion: String(row.detectorVersion),
    inventoryVersion: String(row.inventoryVersion),
    updatedAt: Number(row.updatedAt),
  };
}

const candidateIdSpec = z.string().trim().min(1).max(200)
  .describe("Opaque server-issued candidateId that was actually shown to this user.");
const verdictInput = z.strictObject({
  candidateId: candidateIdSpec,
  verdict: z.enum(calibrationVerdicts),
});

/**
 * Record one verdict against a server-issued candidate. The user and attempt
 * are resolved from the stored candidate row, never from the client. A repeated
 * call returns the original event and does not change counts.
 */
export async function recordCalibrationVerdict(
  db: CalibrationDb, userId: string, input: unknown,
): Promise<{
  saved: true; duplicate: boolean; candidateId: string; verdict: CalibrationVerdict;
  attemptId: string; isCatchTrial: boolean; event: CalibrationEventRow;
  profile: CalibrationProfileRow | null;
}> {
  if (typeof userId !== "string" || !userId) return reject("user_required", "Authenticated user is required.");
  const parsed = verdictInput.parse(input);
  // The subset is scoped by user_id, so another user's candidateId is
  // indistinguishable from a forged one and is rejected the same way.
  const candidate = await db.prepare(`SELECT candidate_id AS candidateId, attempt_id AS attemptId,
    expected, actual FROM calibration_candidates WHERE candidate_id=? AND user_id=?`)
    .bind(parsed.candidateId, userId).first<CalibrationCandidateRow>();
  if (!candidate) {
    return reject("candidate_not_found",
      "This candidateId was not issued to the authenticated user. Re-read the displayed candidate.");
  }
  const catchTrial = isCatchTrialCandidate(candidate);
  // Read the prior event before writing. The first successful insert wins; a
  // concurrent duplicate is detected from meta.changes when the adapter exposes
  // it, otherwise from the presence of this pre-read row.
  const prior = await readEvent(db, userId, candidate.attemptId, candidate.candidateId);
  const now = Date.now();
  const statements: Prepared[] = [
    // The EXISTS guard keeps a concurrent reset authoritative: if the candidate
    // row was deleted after the pre-read, no orphan event can be written.
    db.prepare(`INSERT INTO calibration_events
      (user_id, attempt_id, candidate_id, expected, actual, verdict, is_catch_trial, created_at)
      SELECT ?,?,?,?,?,?,?,?
      WHERE EXISTS (SELECT 1 FROM calibration_candidates WHERE candidate_id=? AND user_id=?)
      ON CONFLICT(user_id, attempt_id, candidate_id) DO NOTHING`).bind(
      userId, candidate.attemptId, candidate.candidateId, candidate.expected, candidate.actual,
      parsed.verdict, catchTrial ? 1 : 0, now, candidate.candidateId, userId),
    db.prepare(`UPDATE calibration_candidates SET answered_at=COALESCE(answered_at, ?)
      WHERE candidate_id=? AND user_id=?`).bind(now, candidate.candidateId, userId),
  ];
  if (!catchTrial) {
    statements.push(recomputeProfileStatement(db, userId, candidate.expected, candidate.actual, now));
    // FIX-14: user-level cap must run after the per-category rebuild, in the
    // same batch, so the global invariant holds atomically.
    statements.push(applySuppressedCapStatement(db, userId, now));
  }
  const results = await db.batch(statements);
  const meta = (results[0] as { meta?: { changes?: number } } | undefined)?.meta;
  const inserted = Number.isFinite(meta?.changes) ? Number(meta?.changes) > 0 : prior === null;
  const event = await readEvent(db, userId, candidate.attemptId, candidate.candidateId);
  if (!event) return reject("event_write_failed", "The verdict could not be read back after writing.");
  const duplicate = !inserted;
  const profile = catchTrial ? null : await readProfileRow(db, userId, candidate.expected, candidate.actual);
  return {
    saved: true, duplicate, candidateId: candidate.candidateId, verdict: event.verdict,
    attemptId: candidate.attemptId, isCatchTrial: event.isCatchTrial, event, profile,
  };
}

/**
 * FIX-14 / MJ-03: user-level cap on SUPPRESSED categories.
 *
 * The per-category R6 rule is local, but "do not let the filter disable the
 * detector" is a GLOBAL property of a user's profile, so it cannot be enforced
 * by a single-row read-modify-write. This statement runs AFTER the per-category
 * rebuild inside the SAME D1 batch, so it sees the updated states and the whole
 * update stays atomic (concurrent verdicts cannot leave the cap violated).
 *
 * Definition (frozen, rev2 §4.3):
 *   denominator = number of this user's categories with n_shown >= 1
 *   allowed     = floor(denominator / 2)
 *   ordering    = Beta(1+c,1+r) posterior ASC (worst first),
 *                 tie-break n_rejected DESC, then expected/actual ASC for determinism
 *   action      = SUPPRESSED rows ranked beyond `allowed` revert to CANDIDATE
 *
 * Edge case, deliberate: with 1 observed category allowed = 0, so it cannot be
 * suppressed. That is the intended behaviour — the cap exists to stop the filter
 * from silencing the detector, and a lone bad category still yields hedged T3
 * suggestions, which are non-assertive and therefore safe.
 */
function applySuppressedCapStatement(db: CalibrationDb, userId: string, now: number): Prepared {
  return db.prepare(`UPDATE personal_calibration
    SET state='CANDIDATE', updated_at=?
    WHERE user_id=? AND state='SUPPRESSED'
      AND EXISTS (
        SELECT 1 FROM (
          SELECT expected AS e, actual AS a,
                 ROW_NUMBER() OVER (
                   ORDER BY (1.0 + n_confirmed) / (2.0 + n_confirmed + n_rejected) ASC,
                            n_rejected DESC, expected ASC, actual ASC
                 ) AS rn
          FROM personal_calibration
          WHERE user_id=? AND state='SUPPRESSED' AND n_shown >= 1
        ) ranked
        WHERE ranked.e = personal_calibration.expected
          AND ranked.a = personal_calibration.actual
          AND ranked.rn > (
            SELECT COUNT(*) / 2 FROM personal_calibration
            WHERE user_id=? AND n_shown >= 1
          )
      )`).bind(now, userId, userId, userId);
}

/**
 * Event-sourced profile rebuild for one (expected, actual) category. Counts are
 * recomputed from calibration_events; catch-trial answers are excluded because
 * they are control items, not pronunciation evidence. n_shown is preserved from
 * the issuance UPSERT. SUPPRESSED uses the measured R6 rule (r > c and r >= 2).
 * TRUSTED is never derived here: T2 phoneme-assertion promotion is RETIRED
 * (owner 2026-11-19, structurally unreachable: single-user data volume +
 * precision ceiling + low-prior panel calibration). See iteration-27
 * T2_STRUCTURAL_UNREACHABILITY.md. The V3 gates remain as versioned tooling.
 */
function recomputeProfileStatement(
  db: CalibrationDb, userId: string, expected: string, actual: string, now: number,
): Prepared {
  return db.prepare(`INSERT INTO personal_calibration
    (user_id, expected, actual, n_confirmed, n_rejected, n_unsure, n_shown, state,
     rule_version, detector_version, inventory_version, updated_at)
    SELECT ?, ?, ?,
      COALESCE(SUM(CASE WHEN verdict='confirmed' THEN 1 ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN verdict='rejected' THEN 1 ELSE 0 END),0),
      COALESCE(SUM(CASE WHEN verdict='unsure' THEN 1 ELSE 0 END),0),
      0,
      CASE WHEN COALESCE(SUM(CASE WHEN verdict='rejected' THEN 1 ELSE 0 END),0)
                > COALESCE(SUM(CASE WHEN verdict='confirmed' THEN 1 ELSE 0 END),0)
            AND COALESCE(SUM(CASE WHEN verdict='rejected' THEN 1 ELSE 0 END),0) >= 2
           THEN 'SUPPRESSED' ELSE 'CANDIDATE' END,
      ?,
      COALESCE((SELECT detector_version FROM personal_calibration
        WHERE user_id=? AND expected=? AND actual=?), ?),
      COALESCE((SELECT inventory_version FROM personal_calibration
        WHERE user_id=? AND expected=? AND actual=?), ?),
      ?
    FROM calibration_events
    WHERE user_id=? AND expected=? AND actual=? AND is_catch_trial=0
    HAVING COUNT(*) > 0
    ON CONFLICT(user_id, expected, actual) DO UPDATE SET
      n_confirmed = excluded.n_confirmed,
      n_rejected = excluded.n_rejected,
      n_unsure = excluded.n_unsure,
      state = excluded.state,
      rule_version = excluded.rule_version,
      updated_at = excluded.updated_at`).bind(
    userId, expected, actual,
    CALIBRATION_RULE_VERSION,
    userId, expected, actual, CALIBRATION_UNKNOWN_DETECTOR_VERSION,
    userId, expected, actual, CALIBRATION_UNKNOWN_INVENTORY_VERSION,
    now, userId, expected, actual);
}

export type CalibrationProfile = {
  rows: CalibrationProfileRow[];
  /** Alias consumed by the UI normalizer (app/pronunciation-review.ts). */
  classes: CalibrationProfileRow[];
  totals: { nConfirmed: number; nRejected: number; nUnsure: number; nShown: number; categories: number };
  /**
   * Control-item signal. A catch trial has expected === actual, so "confirmed"
   * is definitionally non-discriminating. A listener who confirms most controls
   * is not distinguishing errors, and their profile must not be trusted.
   * This never changes promotion (T2 retired); it exposes the evidence.
   */
  catchTrials: {
    shown: number;
    confirmed: number;
    rejected: number;
    unsure: number;
    answered: number;
    /** null until enough controls have been answered to judge. */
    confirmRate: number | null;
    constantConfirmerFlag: boolean;
    minAnsweredForFlag: number;
    confirmRateFlagThreshold: number;
  };
  notes: {
    scope: "single-owner";
    trustPromotion: "retired-structurally-unreachable";
    countsExcludeCatchTrials: true;
    voiceMayBeBiometric: true;
  };
};

/** Frozen thresholds for the constant-confirmer rule. */
export const CATCH_TRIAL_MIN_ANSWERED = 5;
export const CATCH_TRIAL_CONFIRM_RATE_FLAG = 0.8;

export async function readCalibrationProfile(
  db: CalibrationDb, userId: string,
): Promise<CalibrationProfile> {
  if (typeof userId !== "string" || !userId) return reject("user_required", "Authenticated user is required.");
  const result = await db.prepare(`SELECT ${profileColumns} FROM personal_calibration
    WHERE user_id=? ORDER BY n_shown DESC, expected, actual`).bind(userId).all();
  const rows = (result.results ?? []).map(toProfile);
  const catchShown = await db.prepare(`SELECT COUNT(*) AS n FROM calibration_candidates
    WHERE user_id=? AND expected=actual`).bind(userId).first();
  const catchEvents = await db.prepare(`SELECT verdict, COUNT(*) AS n FROM calibration_events
    WHERE user_id=? AND is_catch_trial=1 GROUP BY verdict`).bind(userId).all();
  const byVerdict: Record<string, number> = {};
  for (const row of (catchEvents.results ?? []) as { verdict: string; n: number }[]) {
    byVerdict[row.verdict] = Number(row.n);
  }
  const confirmed = byVerdict.confirmed ?? 0;
  const rejected = byVerdict.rejected ?? 0;
  const unsure = byVerdict.unsure ?? 0;
  const answered = confirmed + rejected + unsure;
  const confirmRate = answered > 0 ? confirmed / answered : null;
  return {
    rows,
    classes: rows,
    catchTrials: {
      shown: Number((catchShown as { n?: number } | null)?.n ?? 0),
      confirmed, rejected, unsure, answered,
      confirmRate,
      constantConfirmerFlag: answered >= CATCH_TRIAL_MIN_ANSWERED
        && (confirmRate ?? 0) >= CATCH_TRIAL_CONFIRM_RATE_FLAG,
      minAnsweredForFlag: CATCH_TRIAL_MIN_ANSWERED,
      confirmRateFlagThreshold: CATCH_TRIAL_CONFIRM_RATE_FLAG,
    },
    totals: {
      nConfirmed: rows.reduce((n, row) => n + row.nConfirmed, 0),
      nRejected: rows.reduce((n, row) => n + row.nRejected, 0),
      nUnsure: rows.reduce((n, row) => n + row.nUnsure, 0),
      nShown: rows.reduce((n, row) => n + row.nShown, 0),
      categories: rows.length,
    },
    notes: {
      scope: "single-owner",
      trustPromotion: "retired-structurally-unreachable",
      countsExcludeCatchTrials: true,
      voiceMayBeBiometric: true,
    },
  };
}

export type CalibrationResetResult = {
  deleted: { profileRows: number; candidates: number; events: number };
  retained: readonly string[];
};

/**
 * Clear one user's calibration data. Scoped by the authenticated user_id, so
 * another user's profile, candidates and events are untouched.
 *
 * This tool deletes D1 rows only. It deliberately does NOT delete:
 *  - R2 recordings (speaking/<userId>/<recordingId>),
 *  - exported backup archives or the R2 objects they reference,
 *  - teacher_feedback, review_tasks, review_receipts or analysis_artifacts.
 * PIPL/GDPR erasure of voice audio requires a separate R2/backup deletion
 * workflow; see lib/CALIBRATION_DATA_LAYER.md.
 */
export async function resetCalibrationProfile(
  db: CalibrationDb, userId: string,
): Promise<CalibrationResetResult> {
  if (typeof userId !== "string" || !userId) return reject("user_required", "Authenticated user is required.");
  const results = await db.batch([
    db.prepare("DELETE FROM calibration_events WHERE user_id=?").bind(userId),
    db.prepare("DELETE FROM calibration_candidates WHERE user_id=?").bind(userId),
    db.prepare("DELETE FROM personal_calibration WHERE user_id=?").bind(userId),
  ]);
  return {
    deleted: { events: changes(results[0]), candidates: changes(results[1]), profileRows: changes(results[2]) },
    retained: ["r2_recordings", "backups", "feedback", "review_artifacts"],
  };
}

const recordSpec = z.strictObject({
  candidateId: candidateIdSpec.describe("Server-issued candidateId that was actually shown to this user. Do not invent or reuse another user's ID."),
  verdict: z.enum(calibrationVerdicts)
    .describe("confirmed = the flagged pronunciation is real; rejected = it is not; unsure = cannot tell."),
});
const readSpec = z.strictObject({});
const resetSpec = z.strictObject({});

export const calibrationTools = [
  {
    name: "record_pronunciation_verdict",
    description: "Record the owner's three-state verdict (confirmed/rejected/unsure) for one server-issued pronunciation candidate that was actually displayed. The user is taken from the authenticated session; no userId argument exists. candidateId must come from a previously issued calibration candidate for this user, otherwise the call is rejected. Idempotent: a retried, double-clicked or replayed call returns the original result and never double-counts. Counts exclude catch trials and are rebuilt from the event log. Current deployment is single-owner; multi-user use needs an auth-scope and consent/DPA design.",
    schema: recordSpec,
    readOnly: false,
    destructive: false,
  },
  {
    name: "read_pronunciation_profile",
    description: "Read the authenticated owner's personal pronunciation calibration profile: per (expected, actual) ARPABET pair counts, n_shown, state (CANDIDATE/SUPPRESSED; TRUSTED promotion is RETIRED — T2 phoneme assertions are structurally unreachable for a single low-volume user given the precision ceiling and low-prior panel calibration; owner retired 2026-11-19, not a future unlock), and detector/inventory/rule versions. Catch-trial answers are excluded from counts. The user is taken from the session; no userId argument exists. Current deployment is single-owner. Voice recordings may be biometric personal data under PIPL/GDPR, so a multi-user deployment requires consent, retention and DPA design first.",
    schema: readSpec,
    readOnly: true,
    destructive: false,
  },
  {
    name: "reset_pronunciation_profile",
    description: "Delete the authenticated owner's personal_calibration rows, calibration_candidates and calibration_events. Scoped to the session user only. This does NOT delete R2 audio recordings, exported backup archives, teacher feedback, review tasks/receipts or acoustic analysis artifacts; PIPL/GDPR erasure of voice audio requires a separate recording and backup deletion workflow. Current deployment is single-owner; onboarding a second user requires consent/DPA and the P5 licence retrain first.",
    schema: resetSpec,
    readOnly: false,
    destructive: true,
  },
].map(({ schema, readOnly, destructive, ...tool }) => ({
  ...tool,
  inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: readOnly, destructiveHint: destructive, idempotentHint: true },
}));

export const calibrationToolNames = new Set(calibrationTools.map(tool => tool.name));

function toolError(message: string, code?: string) {
  return {
    content: [{ type: "text", text: JSON.stringify(code ? { error: code, message } : { error: message }) }],
    isError: true,
  };
}

/**
 * MCP entry point. `db` and `userId` are supplied by the authenticated route,
 * never by the tool arguments (each spec is a strictObject without userId).
 */
export async function callCalibrationTool(
  db: CalibrationDb, userId: string, name: string, args: unknown,
) {
  try {
    switch (name) {
      case "record_pronunciation_verdict": {
        const result = await recordCalibrationVerdict(db, userId, args ?? {});
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "read_pronunciation_profile": {
        readSpec.parse(args ?? {});
        const result = await readCalibrationProfile(db, userId);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      case "reset_pronunciation_profile": {
        resetSpec.parse(args ?? {});
        const result = await resetCalibrationProfile(db, userId);
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      }
      default:
        return toolError("unknown_calibration_tool", "unknown_calibration_tool");
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      return toolError(error.issues.slice(0, 5).map(issue => `${issue.path.join(".")} ${issue.message}`).join(" | "), "invalid_input");
    }
    if (error instanceof CalibrationError) return toolError(error.message, error.code);
    throw error;
  }
}