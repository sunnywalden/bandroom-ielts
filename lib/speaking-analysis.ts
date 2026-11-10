// Server-side validation for the acoustic analysis payload. The MCP tool and
// the completion transaction must not trust a cloud run's JSON by itself.

export type SpeakingAnalysis = {
  schemaVersion: 1;
  analysisVersion: string;
  inputSha256: string;
  decoded: { sampleRateHz: number; sampleCount: number };
  coverage: { analyzedSamples: Array<[number, number]>; fraction?: number };
  errors: Array<Record<string, unknown>>;
  state?: string;
  reason?: string | null;
  [key: string]: unknown;
};

const KINDS = new Set(["substitution", "deletion", "addition"]);

function isInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isHex64(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function mergeRanges(ranges: unknown, sampleCount: number): { ranges: Array<[number, number]>; error?: string } {
  if (!Array.isArray(ranges)) return { ranges: [], error: "coverage.analyzedSamples must be an array" };
  const normalized: Array<[number, number]> = [];
  for (const range of ranges) {
    if (!Array.isArray(range) || range.length !== 2 || !isInt(range[0]) || !isInt(range[1])
      || range[0] < 0 || range[1] > sampleCount || range[0] >= range[1])
      return { ranges: [], error: "coverage.analyzedSamples contains an invalid half-open range" };
    normalized.push([range[0], range[1]]);
  }
  normalized.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of normalized) {
    if (!merged.length || start > merged[merged.length - 1][1]) merged.push([start, end]);
    else merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], end);
  }
  if (!merged.length || merged[0][0] !== 0 || merged[merged.length - 1][1] !== sampleCount)
    return { ranges: merged, error: "coverage.analyzedSamples must cover [0, sampleCount]" };
  for (let index = 1; index < merged.length; index += 1) {
    if (merged[index][0] > merged[index - 1][1]) return { ranges: merged, error: "coverage.analyzedSamples contains a gap" };
  }
  return { ranges: merged };
}

export function validateSpeakingAnalysis(
  value: unknown,
  options: { recordingSha256: string; analysisVersion: string; expectedSampleCount?: number },
): { ok: true; analysis: SpeakingAnalysis } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, errors: ["analysis must be an object"] };
  const analysis = value as Record<string, unknown>;
  if (analysis.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (analysis.analysisVersion !== options.analysisVersion) errors.push("analysisVersion differs from the task/request");
  if (analysis.state !== "completed") errors.push(`analysis is not completed (state=${String(analysis.state ?? "missing")})`);
  if (!isHex64(options.recordingSha256)) errors.push("recordingSha256 is invalid");
  if (analysis.inputSha256 !== options.recordingSha256) errors.push("analysis.inputSha256 differs from the original recording");
  const decoded = analysis.decoded;
  if (!decoded || typeof decoded !== "object") errors.push("decoded object is required");
  const sampleRate = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).sampleRateHz : undefined;
  const sampleCount = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).sampleCount : undefined;
  if (sampleRate !== 16_000) errors.push("decoded.sampleRateHz must be 16000");
  if (!isInt(sampleCount) || sampleCount <= 0) errors.push("decoded.sampleCount must be positive");
  if (options.expectedSampleCount !== undefined && sampleCount !== options.expectedSampleCount)
    errors.push("decoded.sampleCount differs from the server-side recording timeline");
  const count = isInt(sampleCount) && sampleCount > 0 ? sampleCount : 0;
  const durationMs = count * 1000 / 16_000;
  const coverage = analysis.coverage;
  if (!coverage || typeof coverage !== "object") errors.push("coverage object is required");
  if (count) {
    const merged = mergeRanges((coverage as Record<string, unknown> | undefined)?.analyzedSamples, count);
    if (merged.error) errors.push(merged.error);
  }
  const events = analysis.errors;
  if (!Array.isArray(events)) errors.push("errors must be an array");
  else {
    if (events.length > 500) errors.push("too many error events");
    const identities = new Set<string>();
    events.forEach((event, index) => {
      const prefix = `errors[${index}]`;
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const row = event as Record<string, unknown>;
      const kind = row.kind;
      if (typeof kind !== "string" || !KINDS.has(kind)) errors.push(`${prefix}.kind is invalid`);
      if (!isInt(row.wordIndex) || row.wordIndex < 0) errors.push(`${prefix}.wordIndex is invalid`);
      if (!isInt(row.phoneIndex) || row.phoneIndex < 0) errors.push(`${prefix}.phoneIndex is invalid`);
      if (typeof row.target !== "string" || !row.target) errors.push(`${prefix}.target is required`);
      if (typeof row.actual !== "string" || !row.actual) errors.push(`${prefix}.actual is required`);
      if (kind === "deletion") {
        if (row.actual !== "∅") errors.push(`${prefix}.actual must be ∅ for a deletion`);
        if (!isNumber(row.anchorMs) || row.anchorMs < 0 || row.anchorMs > durationMs)
          errors.push(`${prefix}.anchorMs is outside the recording`);
      } else if (kind === "substitution" || kind === "addition") {
        if (kind === "addition" && row.target !== "∅") errors.push(`${prefix}.target must be ∅ for an addition`);
        if (kind === "substitution" && (row.target === "∅" || row.actual === "∅"))
          errors.push(`${prefix} substitution needs non-empty target and actual`);
        if (row.target === row.actual) errors.push(`${prefix}.target equals actual`);
        if (!isNumber(row.startMs) || !isNumber(row.endMs) || row.startMs < 0 || row.startMs >= row.endMs || row.endMs > durationMs)
          errors.push(`${prefix} has an invalid startMs/endMs`);
      }
      if (row.probability !== undefined && (!isNumber(row.probability) || row.probability < 0 || row.probability > 1))
        errors.push(`${prefix}.probability must be within [0,1]`);
      const identity = `${String(row.wordIndex)}:${String(row.phoneIndex)}:${String(kind)}:${String(row.target)}:${String(row.actual)}`;
      if (identities.has(identity)) errors.push(`${prefix} duplicates an error identity`);
      identities.add(identity);
    });
  }
  return errors.length ? { ok: false, errors } : { ok: true, analysis: analysis as SpeakingAnalysis };
}
