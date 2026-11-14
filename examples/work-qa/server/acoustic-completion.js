import {activeLease, prepareAcoustics} from "./acoustic-checkpoints.js";
import {fullSpeechFeedback, pronunciationReview, fullSpeechMode} from "./pronunciation.js";

const digestPattern = /^[a-f0-9]{64}$/;
const runPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const completionProperties = {
  recipeSha256: {type: "string", pattern: digestPattern.source},
  runId: {type: "string", pattern: runPattern.source},
  fence: {type: "integer", minimum: 1},
  outputSha256: {type: "string", pattern: digestPattern.source},
  outputIndex: {type: "integer", minimum: 1, maximum: 8191},
};
export const hash = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
const bytes = value => new TextEncoder().encode(value);
const bindingMatches = (row, args) => row.recipe_sha === args.recipeSha256 && row.run_id === args.runId &&
  row.fence === args.fence && row.output_sha === args.outputSha256 && row.output_index === args.outputIndex;

// QA-diagnostic identity is derived, never platform-issued. Every synthetic or unavailable
// field is disclosed next to its value so a QA receipt cannot be mistaken for release identity.
// inputBytes is recording-specific: 441322 is the HJK fixture length and MUST NOT be applied to
// unrelated recordings (bug fix 2026-11-14: enrichReceipt previously leaked it into every receipt).
const HJK_JOB_ID = "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710";
const HJK_RECORDING_SHA256 = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1";
const HJK_INPUT_BYTES = 441322;
const qaReceiptIdentity = {
  identityScope: "qa-diagnostic",
  attemptId: null,
  attemptIdSynthetic: true,
  attemptRevision: null,
  attemptRevisionSynthetic: true,
  recordingId: null,
  recordingIdSource: "recordingSha256",
  recordingIdSynthetic: true,
  analysisVersion: "qa-diagnostic-v26",
  analysisVersionSynthetic: true,
};

// Read-time, additive enrichment for pre-migration receipts. It never rewrites binding fields,
// savedAt or payloadSha256 and it is idempotent: a fully enriched receipt is returned unchanged.
export function enrichReceipt(receipt, payloadSha) {
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) return receipt;
  if (typeof payloadSha !== "string" || !digestPattern.test(payloadSha)) return receipt;
  if (typeof receipt.payloadSha256 === "string" && receipt.payloadSha256 !== payloadSha) return receipt;
  const identityKeys = Object.keys(qaReceiptIdentity);
  if (receipt.id && receipt.feedbackId && identityKeys.every(key => key in receipt)) return receipt;
  const enriched = {...receipt};
  for (const [key, value] of Object.entries(qaReceiptIdentity)) if (!(key in enriched)) enriched[key] = value;
  if (!enriched.id) enriched.id = "rcpt-" + payloadSha.slice(0, 32);
  if (!enriched.feedbackId) enriched.feedbackId = "fb-" + payloadSha.slice(0, 32);
  // inputBytes is recording-specific: only the HJK fixture (job AND recording SHA) gets 441322.
  // Unrelated recordings must not inherit HJK's length (bug fix 2026-11-14). Aligned with the
  // canonical g3-fix/receipt-identity.js enrichReceipt condition. Leave absent otherwise.
  if (enriched.jobId === HJK_JOB_ID && enriched.recordingSha256 === HJK_RECORDING_SHA256 &&
      !("inputBytes" in enriched)) enriched.inputBytes = HJK_INPUT_BYTES;
  return enriched;
}

export async function completionReceipt(env, owner, jobId) {
  await prepareAcoustics(env);
  const row = await env.DB.prepare("SELECT receipt, payload_sha FROM qa_acoustic_completions WHERE job_id = ? AND owner = ?")
    .bind(jobId, owner).first();
  return row ? enrichReceipt(JSON.parse(row.receipt), row.payload_sha) : null;
}

export async function completeAcousticFeedback(env, owner, args, evidence, reply, error) {
  await prepareAcoustics(env);
  const {jobId, recipeSha256, runId, fence, outputSha256, outputIndex, quote, feedback, evidenceReceipt = null, evidenceIds = []} = args;
  if (!digestPattern.test(recipeSha256 ?? "") || !digestPattern.test(outputSha256 ?? "") || !runPattern.test(runId ?? "") ||
      !Number.isSafeInteger(fence) || fence < 1 || !Number.isSafeInteger(outputIndex) || outputIndex < 1 || outputIndex > 8191 ||
      typeof quote !== "string" || quote.length > 4000 || typeof feedback !== "string" || feedback.length > 4000 ||
      !Array.isArray(evidenceIds) || evidenceIds.length > 6) return error(-32602, "Acoustic feedback requires the recipe, run, current fence and completed output SHA/index.");
  const payloadSha = await hash(bytes(JSON.stringify({jobId, recipeSha256, runId, fence, outputSha256, outputIndex, quote, feedback, evidenceReceipt, evidenceIds})));
  const respond = (receipt, duplicate) => {
    const data = {...receipt, saved: true, duplicate};
    return reply({structuredContent: data, content: [{type: "text", text: JSON.stringify(data)}]});
  };
  const existing = await env.DB.prepare("SELECT * FROM qa_acoustic_completions WHERE job_id = ? AND owner = ?").bind(jobId, owner).first();
  if (existing) {
    if (!bindingMatches(existing, args)) return error(-32009, "Completion binding conflict; a previous fence or different output cannot write.");
    if (existing.payload_sha !== payloadSha) return error(-32009, "Idempotency conflict: feedback changed for the same completed output.");
    return respond(enrichReceipt(JSON.parse(existing.receipt), existing.payload_sha), true);
  }
  const current = await activeLease(env, owner, args);
  if (!current) return error(-32009, "Acoustic lease lost or expired. Obtain the current fence before writing.");
  if (current.nextIndex !== outputIndex + 1) return error(-32602, "Complete output must be the final committed checkpoint after the acoustic prefix.");
  const part = await env.DB.prepare(`SELECT object_key, sha256, byte_length FROM qa_acoustic_parts
    WHERE job_id = ? AND recipe_sha = ? AND part_index = ? AND run_id = ? AND fence = ?`)
    .bind(jobId, recipeSha256, outputIndex, runId, fence).first();
  if (!part || part.sha256 !== outputSha256) return error(-32602, "Completed output does not match this run's stored checkpoint.");
  let output;
  try {
    const object = await env.BUCKET.get(part.object_key);
    if (!object || object.size !== part.byte_length) throw new Error();
    const data = await object.arrayBuffer();
    if (await hash(data) !== outputSha256) throw new Error();
    output = JSON.parse(new TextDecoder().decode(data));
  } catch { return error(-32603, "Completed output is missing or failed integrity validation.", {retryable: true}); }
  if (output.schema !== "bandroom.qa.acoustic-output.v1" || output.recordingSha256 !== current.recordingSha256 ||
      output.recipeSha256 !== recipeSha256 || output.runId !== runId || output.fence !== fence ||
      !digestPattern.test(output.coldOutputSha256 ?? "") || output.coldOutputSha256 !== output.resumedOutputSha256 ||
      !Number.isSafeInteger(output.windows) || output.windows < 1 ||
      !Number.isFinite(output.duration) || output.duration <= 0 || output.duration > 181 ||
      !Number.isSafeInteger(output.rawOutputBytes) || output.rawOutputBytes < 1 ||
      !digestPattern.test(output.pcmSha256 ?? "") || !digestPattern.test(output.modelSha256 ?? "") ||
      !output.runtime || typeof output.runtime !== "object" || Array.isArray(output.runtime) ||
      !digestPattern.test(output.prefixSha256 ?? output.prefixSha ?? "")) {
    return error(-32602, "Completed output must bind this recording/run and matching full cold/resumed acoustic outputs.");
  }
  let rendered;
  if (output.mode === "diagnostic") {
    // Transport/inference evidence is not a qualified pronunciation judgement.
    if (quote !== "[原声录音]" || feedback !== output.feedback || feedback.length < 10 || feedback.length > 800 ||
        !feedback.startsWith("声学链路验收（不代表纠音盲测达标）。")) return error(-32602, "Diagnostic output must be explicitly labelled and match its immutable feedback.");
    rendered = feedback;
  } else {
    if (output.mode !== "measured_feedback" || !evidence) return error(-32602, "Measured pronunciation evidence is unavailable; only a labelled QA diagnostic can complete.");
    const review = await pronunciationReview(jobId, JSON.parse(evidence), fullSpeechMode);
    rendered = quote === review.quoteForWrite && fullSpeechFeedback(review, args);
    if (!rendered) return error(-32602, "Use the exact answer quote and sound evidence from this recording.");
  }
  const markers = output.markers ?? [];
  if (!Array.isArray(markers) || markers.length > 6 || markers.some(m =>
    m.source !== "human_annotation" || !digestPattern.test(m.truthSha256 ?? "") ||
    !Number.isFinite(m.start) || !Number.isFinite(m.end) || m.start < 0 || m.end <= m.start || m.end > output.duration ||
    typeof m.word !== "string" || !m.word.trim() || m.word.length > 80)) {
    return error(-32602, "QA replay anchors must identify their human annotation source and fit this recording.");
  }
  const now = Date.now();
  const receipt = {jobId, recipeSha256, runId, fence, outputSha256, outputIndex,
    recordingSha256: current.recordingSha256, payloadSha256: payloadSha, savedAt: now, mode: output.mode,
    coldOutputSha256: output.coldOutputSha256, resumedOutputSha256: output.resumedOutputSha256, markers};
  // D1 batch is a transaction. The first insert is the single linearization point;
  // every later mutation requires that exact committed receipt and payload.
  const committed = "job_id = ? AND owner = ? AND recipe_sha = ? AND run_id = ? AND fence = ? AND output_sha = ? AND payload_sha = ?";
  const values = [jobId, owner, recipeSha256, runId, fence, outputSha256, payloadSha];
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO qa_acoustic_completions
      (job_id, owner, recipe_sha, recording_sha, run_id, fence, output_sha, output_index, payload_sha, receipt, created_at)
      SELECT l.job_id, l.owner, l.recipe_sha, l.recording_sha, l.run_id, l.fence, ?, ?, ?, ?, ?
      FROM qa_acoustic_leases l JOIN qa_audio_processing a ON a.job_id = l.job_id AND a.owner = l.owner
      JOIN qa_outbox q ON q.id = l.job_id JOIN qa_subscriptions s ON s.id = q.subscription AND s.owner = l.owner
      WHERE l.job_id = ? AND l.owner = ? AND l.recipe_sha = ? AND l.run_id = ? AND l.fence = ? AND l.lease_until > ?
        AND l.next_index = ? AND a.input_sha = l.recording_sha AND a.state <> 'complete' AND s.verified = 1
        AND NOT EXISTS (SELECT 1 FROM qa_feedback f WHERE f.job_id = l.job_id)`)
      .bind(outputSha256, outputIndex, payloadSha, JSON.stringify(receipt), now, jobId, owner, recipeSha256, runId, fence, now, outputIndex + 1),
    env.DB.prepare(`INSERT OR IGNORE INTO qa_feedback (job_id, owner, quote, feedback, created_at)
      SELECT job_id, owner, ?, ?, created_at FROM qa_acoustic_completions WHERE ${committed}`).bind(quote, rendered, ...values),
    env.DB.prepare(`UPDATE qa_audio_processing SET state = 'complete', stage = ?, reason = NULL, updated_at = ?, lease_until = NULL
      WHERE job_id = ? AND owner = ? AND EXISTS (SELECT 1 FROM qa_acoustic_completions WHERE ${committed})`)
      .bind(output.mode === "diagnostic" ? "qa_acoustic_diagnostic" : "acoustic_feedback", now, jobId, owner, ...values),
    env.DB.prepare(`UPDATE qa_acoustic_leases SET lease_until = 0, retry_at = 0, retry_reason = NULL
      WHERE job_id = ? AND owner = ? AND EXISTS (SELECT 1 FROM qa_acoustic_completions WHERE ${committed})`).bind(jobId, owner, ...values),
  ]);
  const saved = await env.DB.prepare("SELECT * FROM qa_acoustic_completions WHERE job_id = ? AND owner = ?").bind(jobId, owner).first();
  if (!saved || !bindingMatches(saved, args) || saved.payload_sha !== payloadSha) return error(-32009, "Lease changed or completion conflicted; no feedback from this request was saved.");
  return respond(enrichReceipt(JSON.parse(saved.receipt), saved.payload_sha), inserted.meta.changes === 0);
}
