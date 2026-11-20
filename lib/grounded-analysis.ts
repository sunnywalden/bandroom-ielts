// Grounded-prosody speaking completion contract (iteration-31 rev3).
//
// The queue path (complete_review_task) recognises this analysis class and
// completes a speaking task with the SAME honest T1 prosody + T3 self-listen
// output the owner path (add_coach_feedback) serves today. It deliberately does
// NOT use the QA acoustic-track phoneme schema (validateSpeakingAnalysis): T2
// phoneme assertions are retired, so there are no phoneme error events and no
// pronunciation band. Integrity comes from the recording digest binding plus a
// committed decoded-PCM checkpoint (requireDecodedInput), not from phoneme proof.
//
// Two shapes are kept distinct (review U-BL-3):
//   - wire input (runner -> server, untrusted): raw `candidates`, NO candidateId.
//   - stored (server-enriched): `items` with server-issued candidateId, tier T3.
// A client can never mint a candidateId or choose the tuple; issuance is
// server-side and idempotent (see issueCalibrationCandidatesIdempotent).
import { z } from "zod/v4";
import { CalibrationError, isCatchTrialCandidate } from "./calibration";

export const GROUNDED_ANALYSIS_SCHEMA = "bandroom-grounded-analysis-v1";

const phoneme = z.string().trim().min(1).max(8).regex(/^[A-Z0-9_]+$/, "Canonical ARPABET symbol expected.");
// Wire candidate: mirrors runner content_rules.coerce_grounded_analysis caps.
// candidateId is intentionally absent — a strictObject rejects it if supplied.
const wireCandidate = z.strictObject({
  word: z.string().trim().min(1).max(80),
  expected: phoneme,
  actual: phoneme,
  atMs: z.number().int().min(0).max(10_800_000),
  detectorConfidence: z.number().min(0).max(1),
  tier: z.enum(["T2", "T3"]),
  catchTrial: z.boolean().optional(),
});
const wireGroundedAnalysis = z.strictObject({
  schema: z.literal(GROUNDED_ANALYSIS_SCHEMA),
  analysisVersion: z.string().trim().min(1).max(120),
  detectorVersion: z.string().trim().min(1).max(80),
  inventoryVersion: z.string().trim().min(1).max(80),
  speechSeconds: z.number().min(0).max(10_800),
  candidates: z.array(wireCandidate).max(64),
  // T1 reliability disclosure object (UI toReliability consumes). Bounded record,
  // derived from the runner's pause calibration — not free-form assertion text.
  reliability: z.record(z.string(), z.unknown()).optional(),
  // Calibrated prosody metrics (UI root.calibrated_prosody.pause_count consumes).
  // Only metrics the prosody module marks calibrated (pauses/timing) belong here.
  calibrated_prosody: z.record(z.string(), z.unknown()).optional(),
});

export type WireGroundedAnalysis = z.infer<typeof wireGroundedAnalysis>;

export function isGroundedAnalysis(value: unknown): boolean {
  return !!value && typeof value === "object"
    && (value as Record<string, unknown>).schema === GROUNDED_ANALYSIS_SCHEMA;
}

/** Validate the untrusted wire shape; fail closed with a classified code. */
export function validateGroundedAnalysis(value: unknown): WireGroundedAnalysis {
  const parsed = wireGroundedAnalysis.safeParse(value);
  if (!parsed.success) {
    throw new CalibrationError("invalid_analysis",
      `grounded analysis invalid: ${parsed.error.issues.map(i => i.path.join(".") + " " + i.message).join("; ").slice(0, 300)}`);
  }
  return parsed.data;
}

// Deterministic UUIDv5 (RFC 4122, SHA-1) so a replayed completion re-uses the
// exact candidateIds instead of minting new ones (review U-BL-1). The namespace
// is a fixed UUID; the name binds the tenant, attempt and phoneme tuple.
const CANDIDATE_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // UUID DNS namespace
function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
function bytesToUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function deterministicCandidateId(
  userId: string, attemptId: string, expected: string, actual: string, atMs: number,
): Promise<string> {
  const sep = String.fromCharCode(31); // unit separator; no collision with UUID/ARPABET/int
  const name = [userId, attemptId, expected, actual, String(atMs)].join(sep);
  const nsBytes = uuidToBytes(CANDIDATE_NAMESPACE);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(nsBytes.length + nameBytes.length);
  input.set(nsBytes, 0);
  input.set(nameBytes, nsBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  const bytes = digest.slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(bytes);
}

export type GroundedTaskRef = { attemptId: string; recordingId: string };

/** Build the calibration issue input from the wire analysis + claimed task.
 *  attemptId/recordingId come from the SERVER task row, never the client. */
export function toIssueInput(g: WireGroundedAnalysis, task: GroundedTaskRef) {
  return {
    attemptId: task.attemptId,
    recordingId: task.recordingId,
    detectorVersion: g.detectorVersion,
    inventoryVersion: g.inventoryVersion,
    candidates: g.candidates.map(c => ({
      word: c.word, expected: c.expected, actual: c.actual,
      atMs: c.atMs, detectorConfidence: c.detectorConfidence,
      ...(c.catchTrial ? { catchTrial: true } : {}),
    })),
  };
}

type StoredItem = {
  candidateId: string; word: string; expected: string; actual: string;
  atMs: number; detectorConfidence: number; tier: "T3"; requestedTier: string;
  isCatchTrial: boolean;
};

function baseStored(g: WireGroundedAnalysis) {
  return {
    schema: GROUNDED_ANALYSIS_SCHEMA,
    analysisVersion: g.analysisVersion,
    detectorVersion: g.detectorVersion,
    inventoryVersion: g.inventoryVersion,
    speechSeconds: g.speechSeconds,
    ...(g.reliability ? { reliability: g.reliability } : {}),
    ...(g.calibrated_prosody ? { calibrated_prosody: g.calibrated_prosody } : {}),
  };
}

/** Server-enriched stored shape: items with issued candidateIds, tier forced T3
 *  (T2 retired). 1:1 order preserved with issued.candidateIds. */
export function enrichCandidateIds(
  g: WireGroundedAnalysis, issued: { candidateIds: string[] },
): Record<string, unknown> {
  const items: StoredItem[] = g.candidates.map((c, i) => {
    const catchTrial = isCatchTrialCandidate(c); // server-derived, never trust client flag
    return {
      candidateId: issued.candidateIds[i],
      word: c.word, expected: c.expected, actual: catchTrial ? c.expected : c.actual,
      atMs: c.atMs, detectorConfidence: c.detectorConfidence,
      tier: "T3", requestedTier: c.tier, isCatchTrial: catchTrial,
    };
  });
  return { ...baseStored(g), items };
}

/** Prosody-only completion (no candidates): items empty, no fabricated rows. */
export function toStoredProsodyOnly(g: WireGroundedAnalysis): Record<string, unknown> {
  return { ...baseStored(g), items: [] as StoredItem[] };
}