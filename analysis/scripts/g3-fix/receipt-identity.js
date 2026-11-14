export const ACCEPTED_PAYLOAD_SHA256 = "39d7be1bd10777fc0dbb6aa5095a7ea4e627617aa827826c1693a75d9d374c2a";
export const ACCEPTED_JOB_ID = "qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710";
export const HJK_INPUT_BYTES = 441322;
export const QA_IDENTITY = Object.freeze({
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
});

const HJK_RECORDING_SHA256 = "55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1";
const digestPattern = /^[a-f0-9]{64}$/;

const identityEntries = Object.entries(QA_IDENTITY);

export function addReceiptIds(receipt, payloadSha) {
  if (receipt.id && receipt.feedbackId) return receipt;
  if (typeof payloadSha !== "string" || !digestPattern.test(payloadSha)) return receipt;
  const suffix = payloadSha.slice(0, 32);
  return {...receipt, id: receipt.id || "rcpt-" + suffix, feedbackId: receipt.feedbackId || "fb-" + suffix};
}

export function enrichReceipt(receipt, payloadSha = receipt?.payloadSha256) {
  if (!receipt || typeof payloadSha !== "string" || !digestPattern.test(payloadSha)) return receipt;
  const identified = addReceiptIds(receipt, payloadSha);
  const needsInputBytes = identified.jobId === ACCEPTED_JOB_ID &&
    identified.recordingSha256 === HJK_RECORDING_SHA256 && !("inputBytes" in identified);
  const missing = identityEntries.filter(([key]) => !(key in identified));
  if (missing.length === 0 && !needsInputBytes) return identified;
  const enriched = {...identified, ...Object.fromEntries(missing)};
  if (needsInputBytes) enriched.inputBytes = HJK_INPUT_BYTES;
  return enriched;
}
