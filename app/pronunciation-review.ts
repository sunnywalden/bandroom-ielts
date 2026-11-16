// UI-side model for the three-tier audio coach (design rev2 §0.2, §4.4, §4.7, §7).
//
// This module deliberately keeps all display decisions pure and testable. It
// never receives or exposes `isCatchTrial`: the server records that flag on the
// submitted event, and the browser must render catch trials exactly like real
// candidates so the control stays informative.

export type Verdict = 'confirmed' | 'rejected' | 'unsure';
export type ConfirmableTier = 'T2' | 'T3';

export const SAME_CLASS_CONFIRMATIONS_REQUIRED = 3;

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  confirmed: '确实读错',
  rejected: '其实没错',
  unsure: '不确定',
};

export const VERDICT_RECORDED_LABELS: Readonly<Record<Verdict, string>> = {
  confirmed: '确实读错',
  rejected: '其实没错',
  unsure: '不确定（不计入画像）',
};

export const TIER_HEADINGS: Readonly<Record<ConfirmableTier, string>> = {
  T2: '个人历史条件化建议（建议，不是断言）',
  T3: '检测器提出的回听候选（未校准，仅供回听）',
};

// A candidate that may be answered in the self-listening UI. `isCatchTrial`
// is intentionally absent from this public shape.
export type PronunciationCandidate = {
  candidateId: string;
  word: string;
  expected: string;
  actual: string;
  atMs: number;
  tier: ConfirmableTier;
  detectorConfidence?: number;
  isReprobe?: boolean;
  priorVerdict?: Verdict;
  clipStartMs?: number;
  clipEndMs?: number;
  canonicalAudioUrl?: string;
};

export type ReliabilitySummary = {
  pauseCount?: number;
  pausePrecision?: number;
  pauseRecall?: number;
  macroPrecision?: number;
  perSpeakerMin?: number;
  perSpeakerMax?: number;
  basis?: string;
};

export type ProfileClass = {
  expected: string;
  actual: string;
  nConfirmed: number;
  nRejected: number;
  nUnsure: number;
  nShown: number;
  state: string;
};

export type TierSection = { tier: ConfirmableTier; text: string };

export type ProgressPointInput = {
  label: string;
  candidates: number;
  speechMinutes?: number;
  speechSeconds?: number;
  ciLow?: number;
  ciHigh?: number;
};

export type ProgressInput = {
  expected: string;
  actual: string;
  classKey?: string;
  points?: ProgressPointInput[];
  candidates?: number;
  speechMinutes?: number;
  speechSeconds?: number;
  ciLow?: number;
  ciHigh?: number;
  ratePerMinuteWilson95?: number[];
};

export type ProgressSeriesPoint = {
  label: string;
  candidates: number;
  speechMinutes: number;
  ratePerMinute: number | null;
  ciLow: number | null;
  ciHigh: number | null;
};

export type ProgressSeries = {
  key: string;
  expected: string;
  actual: string;
  points: ProgressSeriesPoint[];
  hasCI: boolean;
  missingCI: boolean;
};

export type NormalizedPronunciation = {
  present: boolean;
  items: PronunciationCandidate[];
  sections: TierSection[];
  reliability?: ReliabilitySummary;
  profile?: { exists: boolean; classes: ProfileClass[] };
  progress: ProgressInput[];
};

export type CatchTrialSummary = {
  shown: number;
  answered: number;
  confirmed: number;
  constantConfirmerFlag: boolean;
};

export type ProfileSnapshot = {
  exists: boolean;
  classes: ProfileClass[];
  reliability?: ReliabilitySummary;
  progress: ProgressInput[];
  ruleVersion?: string;
  detectorVersion?: string;
  inventoryVersion?: string;
  catchTrials?: CatchTrialSummary;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const text = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

const finite = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const count = (value: unknown): number | undefined => {
  const number = finite(value);
  return number !== undefined && number >= 0 ? Math.trunc(number) : undefined;
};

const fraction = (value: unknown): number | undefined => {
  const number = finite(value);
  if (number === undefined || number < 0) return undefined;
  if (number > 1 && number <= 100) return number / 100;
  return number <= 1 ? number : undefined;
};

function verdict(value: unknown): Verdict | undefined {
  return value === 'confirmed' || value === 'rejected' || value === 'unsure' ? value : undefined;
}

function tier(value: unknown): ConfirmableTier | undefined {
  if (value === 'T2' || value === 't2') return 'T2';
  if (value === 'T3' || value === 't3') return 'T3';
  return undefined;
}

function isReprobe(raw: Record<string, unknown>): boolean {
  return raw.isReprobe === true || raw.reprobe === true
    || raw.override === true || raw.override === 'reprobe' || raw.overrideTier === 'T3';
}

function audioUrl(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  const raw = record(value);
  return text(raw?.url) ?? text(raw?.canonicalAudioUrl) ?? text(raw?.href);
}

function timestampMs(raw: Record<string, unknown>): number | undefined {
  const direct = finite(raw.atMs) ?? finite(raw.timestamp_ms) ?? finite(raw.timestampMs) ?? finite(raw.time_ms);
  if (direct !== undefined) return direct;
  const seconds = finite(raw.seconds) ?? finite(raw.at);
  return seconds !== undefined ? Math.round(seconds * 1000) : undefined;
}

function toCandidate(value: unknown): PronunciationCandidate | null {
  const raw = record(value);
  if (!raw) return null;
  const candidateId = text(raw.candidateId);
  const word = text(raw.word);
  const expected = text(raw.expected) ?? text(raw.expected_phone);
  const actual = text(raw.actual) ?? text(raw.actual_phone);
  const atMs = timestampMs(raw);
  const itemTier = tier(raw.tier);
  if (!candidateId || !word || !expected || !actual || atMs === undefined || atMs < 0 || !itemTier) return null;
  // T3 is always confirmable. A T2 occurrence is confirmable only when the
  // server marks it as a re-probe; ordinary T2 rows stay prose-only.
  if (itemTier === 'T2' && !isReprobe(raw)) return null;
  const confidence = fraction(raw.detectorConfidence ?? raw.detector_confidence);
  const prior = verdict(raw.priorVerdict ?? raw.answeredVerdict ?? raw.verdict);
  const clipStartMs = finite(raw.clipStartMs);
  const clipEndMs = finite(raw.clipEndMs);
  const canonicalAudioUrl = audioUrl(raw.canonicalAudioUrl ?? raw.canonicalAudio ?? raw.contrast_audio);
  return {
    candidateId, word, expected, actual, atMs, tier: itemTier,
    ...(confidence !== undefined ? { detectorConfidence: confidence } : {}),
    ...(itemTier === 'T2' ? { isReprobe: true } : {}),
    ...(prior ? { priorVerdict: prior } : {}),
    ...(clipStartMs !== undefined ? { clipStartMs } : {}),
    ...(clipEndMs !== undefined ? { clipEndMs } : {}),
    ...(canonicalAudioUrl ? { canonicalAudioUrl } : {}),
  };
}

function toReliability(value: unknown): ReliabilitySummary | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const range = Array.isArray(raw.populationSpeakerPrecisionRange) ? raw.populationSpeakerPrecisionRange : undefined;
  const pauseCount = count(raw.pauseCount ?? raw.pauseCountInThisRecording);
  const pausePrecision = fraction(raw.pausePrecision ?? raw.userPrecision);
  const macroPrecision = fraction(raw.macroPrecision ?? raw.populationMacroPrecision);
  const perSpeakerMin = fraction(raw.perSpeakerMin ?? range?.[0]);
  const perSpeakerMax = fraction(raw.perSpeakerMax ?? range?.[1]);
  const basis = text(raw.basis) ?? text(raw.estimate) ?? text(raw.caveat);
  const summary: ReliabilitySummary = {
    ...(pauseCount !== undefined ? { pauseCount } : {}),
    ...(pausePrecision !== undefined ? { pausePrecision } : {}),
    ...(fraction(raw.pauseRecall) !== undefined ? { pauseRecall: fraction(raw.pauseRecall) } : {}),
    ...(macroPrecision !== undefined ? { macroPrecision } : {}),
    ...(perSpeakerMin !== undefined ? { perSpeakerMin } : {}),
    ...(perSpeakerMax !== undefined ? { perSpeakerMax } : {}),
    ...(basis ? { basis } : {}),
  };
  return Object.keys(summary).length ? summary : undefined;
}

function toProfileClass(value: unknown): ProfileClass | null {
  const raw = record(value);
  if (!raw) return null;
  const expected = text(raw.expected);
  const actual = text(raw.actual);
  if (!expected || !actual) return null;
  return {
    expected, actual,
    nConfirmed: count(raw.nConfirmed) ?? 0,
    nRejected: count(raw.nRejected) ?? 0,
    nUnsure: count(raw.nUnsure) ?? 0,
    nShown: count(raw.nShown) ?? 0,
    state: text(raw.state) ?? 'CANDIDATE',
  };
}

export function classList(value: unknown): ProfileClass[] {
  const raw = record(value);
  const rows = Array.isArray(value) ? value
    : Array.isArray(raw?.classes) ? raw.classes
    : Array.isArray(raw?.rows) ? raw.rows
    : Array.isArray(raw?.perClass) ? raw.perClass
    : Array.isArray(raw?.profile) ? raw.profile
    : raw?.profile !== undefined ? classList(raw.profile)
    : raw ? Object.values(raw) : [];
  return rows.map(toProfileClass).filter((row): row is ProfileClass => Boolean(row));
}

function splitClassKey(value: string | undefined): { expected: string; actual: string } | null {
  if (!value) return null;
  const parts = value.split(/\s*(?:->|→)\s*/);
  return parts.length === 2 && parts[0] && parts[1] ? { expected: parts[0], actual: parts[1] } : null;
}

function toProgressInput(value: unknown): ProgressInput | null {
  const raw = record(value);
  if (!raw) return null;
  const key = splitClassKey(text(raw.classKey) ?? text(raw.class));
  const expected = text(raw.expected) ?? key?.expected;
  const actual = text(raw.actual) ?? key?.actual;
  if (!expected || !actual) return null;
  const points = Array.isArray(raw.points) ? raw.points.map(toProgressPoint).filter((point): point is ProgressPointInput => Boolean(point)) : undefined;
  const interval = Array.isArray(raw.ratePerMinuteWilson95) ? raw.ratePerMinuteWilson95 : undefined;
  const ciLow = finite(raw.ciLow) ?? finite(interval?.[0]);
  const ciHigh = finite(raw.ciHigh) ?? finite(interval?.[1]);
  return {
    expected, actual,
    ...(points?.length ? { points } : {}),
    ...(count(raw.candidates) !== undefined ? { candidates: count(raw.candidates) } : {}),
    ...(finite(raw.speechMinutes) !== undefined ? { speechMinutes: finite(raw.speechMinutes) } : {}),
    ...(finite(raw.speechSeconds) !== undefined ? { speechSeconds: finite(raw.speechSeconds) } : {}),
    ...(ciLow !== undefined ? { ciLow } : {}),
    ...(ciHigh !== undefined ? { ciHigh } : {}),
  };
}

function toProgressPoint(value: unknown, index: number): ProgressPointInput | null {
  const raw = record(value);
  if (!raw) return null;
  const candidates = count(raw.candidates);
  if (candidates === undefined) return null;
  return {
    label: text(raw.label) ?? `第 ${index + 1} 次`,
    candidates,
    ...(finite(raw.speechMinutes) !== undefined ? { speechMinutes: finite(raw.speechMinutes) } : {}),
    ...(finite(raw.speechSeconds) !== undefined ? { speechSeconds: finite(raw.speechSeconds) } : {}),
    ...(finite(raw.ciLow) !== undefined ? { ciLow: finite(raw.ciLow) } : {}),
    ...(finite(raw.ciHigh) !== undefined ? { ciHigh: finite(raw.ciHigh) } : {}),
  };
}

export function progressList(value: unknown): ProgressInput[] {
  const raw = record(value);
  if (Array.isArray(value)) return value.map(toProgressInput).filter((row): row is ProgressInput => Boolean(row));
  const candidate = raw?.classes ?? raw?.series ?? raw?.progressSeries;
  if (Array.isArray(candidate)) return candidate.map(toProgressInput).filter((row): row is ProgressInput => Boolean(row));
  const mapped = record(candidate);
  if (mapped) return Object.values(mapped).map(toProgressInput).filter((row): row is ProgressInput => Boolean(row));
  if (raw && Object.values(raw).some(entry => record(entry)?.classKey)) {
    return Object.values(raw).map(toProgressInput).filter((row): row is ProgressInput => Boolean(row));
  }
  if (Array.isArray(raw?.points) && raw.expected !== undefined) {
    const row = toProgressInput(raw);
    return row ? [row] : [];
  }
  return [];
}

function sections(value: unknown): TierSection[] {
  if (Array.isArray(value)) {
    const rows: TierSection[] = [];
    for (const entry of value) {
      const raw = record(entry);
      const label = tier(raw?.tier);
      const content = text(raw?.text);
      if (label && content !== undefined && !rows.some(row => row.tier === label)) rows.push({ tier: label, text: content });
    }
    return rows;
  }
  const raw = record(value);
  if (!raw) return [];
  const result: TierSection[] = [];
  for (const key of ['T2', 't2', 'T3', 't3'] as const) {
    const item = raw[key];
    const label = key.toUpperCase() === 'T2' ? 'T2' : 'T3';
    const textValue = typeof item === 'string' ? item
      : record(item)?.text !== undefined ? text(record(item)?.text)
      : undefined;
    if (textValue !== undefined && textValue.length && !result.some(row => row.tier === label)) {
      result.push({ tier: label, text: textValue });
    }
  }
  return result;
}

// The review-task path carries the tier contract under `analysis.pronunciation`.
// The fallbacks are intentionally narrow: legacy `analysis.errors` must not be
// mistaken for the new confirmation contract.
export function extractPronunciation(analysis: unknown): NormalizedPronunciation {
  const root = record(analysis);
  if (!root) return { present: false, items: [], sections: [], progress: [] };
  const nested = record(root.pronunciation) ?? record(root.pronunciationCoach);
  const source = nested ?? root;
  const tierAssignment = record(source.tier_assignment) ?? record(root.tier_assignment);
  const tierItems = [
    ...(Array.isArray(tierAssignment?.t2_items) ? tierAssignment.t2_items : []),
    ...(Array.isArray(tierAssignment?.t3_items) ? tierAssignment.t3_items : []),
  ];
  const rawItems = Array.isArray(source.items) ? source.items
    : Array.isArray(source.candidates) ? source.candidates
    : Array.isArray(root.items) ? root.items
    : Array.isArray(root.candidates) ? root.candidates
    : Array.isArray(root.pronunciationCandidates) ? root.pronunciationCandidates
    : Array.isArray(source.self_listen_suggestions) ? source.self_listen_suggestions
    : Array.isArray(root.self_listen_suggestions) ? root.self_listen_suggestions
    : tierItems;
  const sourceSections = sections(source.sections);
  const sourceTiers = sections(source.tiers);
  const sourceTierSections = sections(source.tier_sections);
  const rawSections = sourceSections.length ? sourceSections
    : sourceTiers.length ? sourceTiers
    : sourceTierSections.length ? sourceTierSections
    : sections(root.sections).length ? sections(root.sections)
    : sections(root.tiers).length ? sections(root.tiers)
    : sections(root.tier_sections);
  const items = rawItems.map(toCandidate).filter((item): item is PronunciationCandidate => Boolean(item));
  const parsedReliability = toReliability(source.reliability) ?? toReliability(source.reliabilitySummary)
    ?? toReliability(source.t1_reliability) ?? toReliability(root.reliability)
    ?? toReliability(root.reliabilitySummary) ?? toReliability(root.t1_reliability);
  const structuredPauseCount = count(record(root.calibrated_prosody)?.pause_count)
    ?? count(record(root.calibrated_prosody)?.pauseCount)
    ?? count(record(root.prosody)?.pauseCount) ?? count(record(root.prosody)?.pause_count)
    ?? count(record(root.t1)?.pauseCount);
  const reliability = parsedReliability || structuredPauseCount !== undefined
    ? { ...(parsedReliability ?? {}),
        ...(parsedReliability?.pauseCount === undefined && structuredPauseCount !== undefined
          ? { pauseCount: structuredPauseCount } : {}) }
    : undefined;
  const profileRaw = record(source.profile) ?? record(root.profile) ?? record(root.pronunciationProfile);
  const profile = profileRaw ? {
    exists: profileRaw.exists !== false && profileRaw.profileExists !== false
      && profileRaw.established !== false && profileRaw.coldStart !== true,
    classes: classList(profileRaw),
  } : undefined;
  const sourceProgress = progressList(source.progress);
  const progress = sourceProgress.length ? sourceProgress
    : progressList(root.progress).length ? progressList(root.progress)
    : progressList(root.progress_metrics).length ? progressList(root.progress_metrics)
    : progressList(root.progressMetrics).length ? progressList(root.progressMetrics)
    : progressList(root.candidate_rates);
  const present = Boolean(nested) || items.length > 0 || rawSections.length > 0
    || Boolean(reliability) || Boolean(profile) || progress.length > 0;
  return { present, items, sections: rawSections, ...(reliability ? { reliability } : {}),
    ...(profile ? { profile } : {}), progress };
}

export function formatTimestampSeconds(atMs: number): string {
  return `${(atMs / 1000).toFixed(2)} 秒`;
}

export function formatPercent(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '';
  const percent = Math.round(value * 1000) / 10;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

export type ReliabilityDisclosure = {
  pauseLine: string;
  detail: string;
  caveat: string;
  estimatedOvercount: number | null;
};

// Honest, non-alarming wording. A per-speaker pause precision of 0.333 means a
// count of 36 can include roughly 24 over-detections; saying "36 pauses" without
// that context would present an estimate as an exact measurement.
export function reliabilityDisclosure(reliability: ReliabilitySummary | undefined): ReliabilityDisclosure | null {
  const normalized = toReliability(reliability);
  if (!normalized) return null;
  const hasAny = ['pauseCount', 'pausePrecision', 'pauseRecall', 'macroPrecision', 'perSpeakerMin', 'perSpeakerMax']
    .some(key => normalized[key as keyof ReliabilitySummary] !== undefined);
  if (!hasAny) return null;
  const pauseCount = normalized.pauseCount;
  const pauseLine = pauseCount !== undefined
    ? `本次检测到 ${pauseCount} 次停顿。`
    : '本次分析的停顿检测可靠性如下。';
  let detail: string;
  let estimatedOvercount: number | null = null;
  if (normalized.pausePrecision !== undefined) {
    if (pauseCount !== undefined) {
      estimatedOvercount = Math.round(pauseCount * (1 - normalized.pausePrecision));
    }
    detail = `按你个人的停顿检测可靠性估计（精确率约 ${formatPercent(normalized.pausePrecision)}）`
      + (estimatedOvercount !== null ? `，其中可能多计约 ${estimatedOvercount} 次` : '')
      + '；请把这个数量当作估计，而不是精确计数。';
  } else if (normalized.macroPrecision !== undefined) {
    const range = normalized.perSpeakerMin !== undefined && normalized.perSpeakerMax !== undefined
      ? `，但不同说话人的精确率在 ${formatPercent(normalized.perSpeakerMin)}–${formatPercent(normalized.perSpeakerMax)} 之间`
      : '';
    detail = `系统整体的停顿精确率约为 ${formatPercent(normalized.macroPrecision)}${range}；`
      + '目前还没有你的个人估计，因此这个数量应视为估计，而不是精确计数。';
  } else {
    detail = '目前没有可用的可靠性估计，因此这个数量应视为估计，而不是精确计数。';
  }
  return { pauseLine, detail, caveat: '停顿计数用于节奏练习，不是评分依据。', estimatedOvercount };
}

export const COLD_START_COPY = {
  title: '还没有你的个人发音画像',
  body: '目前的发音提示来自尚未用你的确认校准过的检测器，只能作为回听建议，不是评分结论。',
  sameClassRule: `建立画像需要同一类别至少 ${SAME_CLASS_CONFIRMATIONS_REQUIRED} 次确认。每次会话最多展示 3 条候选，所以通常需要多次会话；不同类别出现频率差别很大，无法保证在固定时间内出现。`,
  pedagogy: '对照标准发音做 A/B 听辨是常见的听辨练习。但系统不会逐条告诉你判断是否正确；长期只靠自判可能固化错误，因此这里不声称它一定能训练听音。',
} as const;

export const RESET_DIALOG_COPY = {
  title: '重置发音画像？',
  clear: '这会清除你的发音画像和确认记录。',
  retention: '不会删除你的录音或备份。',
  retentionDetail: '历史反馈与候选发生率曲线会保留。',
  consequence: '重置后需要重新积累同一类别的确认，个人历史条件化建议才会再次出现。',
  manage: '前往「学习档案」管理录音',
  confirm: '确认重置',
  cancel: '取消',
  done: '已重置个人发音画像。你的录音和备份未受影响。',
} as const;

export type ClassProgress = {
  key: string;
  expected: string;
  actual: string;
  nConfirmed: number;
  nUnsure: number;
  nRejected: number;
  nShown: number;
  needed: number;
  remaining: number;
  reached: boolean;
};

// Progress is per class, never a total across classes. `nUnsure` is carried for
// display but excluded from the threshold because the server excludes it from
// the posterior too.
export function classProgress(classes: ProfileClass[], needed = SAME_CLASS_CONFIRMATIONS_REQUIRED): ClassProgress[] {
  return classes.map(row => {
    const nConfirmed = Math.max(0, row.nConfirmed);
    return {
      key: `${row.expected}→${row.actual}`,
      expected: row.expected,
      actual: row.actual,
      nConfirmed,
      nUnsure: row.nUnsure,
      nRejected: row.nRejected,
      nShown: row.nShown,
      needed,
      remaining: Math.max(0, needed - nConfirmed),
      reached: nConfirmed >= needed,
    };
  }).sort((left, right) => right.nConfirmed - left.nConfirmed || left.key.localeCompare(right.key));
}

function minutesOf(point: { speechMinutes?: number; speechSeconds?: number }): number | null {
  if (point.speechMinutes !== undefined && Number.isFinite(point.speechMinutes) && point.speechMinutes > 0) {
    return point.speechMinutes;
  }
  if (point.speechSeconds !== undefined && Number.isFinite(point.speechSeconds) && point.speechSeconds > 0) {
    return point.speechSeconds / 60;
  }
  return null;
}

function bounds(point: { ciLow?: number; ciHigh?: number }): { low: number; high: number } | null {
  if (point.ciLow === undefined || point.ciHigh === undefined) return null;
  if (!Number.isFinite(point.ciLow) || !Number.isFinite(point.ciHigh)) return null;
  if (point.ciLow < 0 || point.ciHigh < point.ciLow) return null;
  return { low: point.ciLow, high: point.ciHigh };
}

function pointsFor(input: ProgressInput): ProgressServerPoint[] {
  if (input.points?.length) {
    return input.points.map(point => ({
      label: point.label,
      candidates: point.candidates,
      minutes: minutesOf(point),
      bounds: bounds(point),
    }));
  }
  const minutes = minutesOf(input);
  if (minutes === null || input.candidates === undefined) return [];
  return [{ label: '累计', candidates: input.candidates, minutes, bounds: bounds(input) }];
}

type ProgressServerPoint = {
  label: string;
  candidates: number;
  minutes: number | null;
  bounds: { low: number; high: number } | null;
};

// The progress metric is **per-class candidate rate per minute of speech**.
// It is invariant to how often the product showed that class. Posterior and
// rejection-ratio measures are deliberately not accepted here.
export function buildProgressSeries(inputs: ProgressInput[], maxSeries = 3): ProgressSeries[] {
  const normalized = inputs
    .map(input => toProgressInput(input))
    .filter((input): input is ProgressInput => Boolean(input));
  const series = normalized.map(input => {
    const points = pointsFor(input).map(point => {
      const ratePerMinute = point.minutes === null ? null : point.candidates / point.minutes;
      return {
        label: point.label,
        candidates: point.candidates,
        speechMinutes: point.minutes ?? 0,
        ratePerMinute,
        ciLow: point.bounds?.low ?? null,
        ciHigh: point.bounds?.high ?? null,
      };
    }).filter(point => point.ratePerMinute !== null);
    return {
      key: `${input.expected}→${input.actual}`,
      expected: input.expected,
      actual: input.actual,
      points,
      hasCI: points.length > 0 && points.every(point => point.ciLow !== null && point.ciHigh !== null),
      missingCI: points.some(point => point.ciLow === null || point.ciHigh === null),
    };
  }).filter(row => row.points.length > 0);
  if (series.length <= maxSeries) return series;
  const kept = series.slice(0, maxSeries);
  const rest = series.slice(maxSeries);
  const labels: string[] = [];
  for (const row of rest) for (const point of row.points) if (!labels.includes(point.label)) labels.push(point.label);
  const folded = labels.map(label => {
    const rows = rest.map(row => row.points.find(point => point.label === label)).filter((point): point is ProgressSeriesPoint => Boolean(point));
    const candidates = rows.reduce((total, point) => total + point.candidates, 0);
    const speechMinutes = rows.reduce((total, point) => total + point.speechMinutes, 0);
    return {
      label, candidates, speechMinutes,
      ratePerMinute: speechMinutes > 0 ? candidates / speechMinutes : null,
      ciLow: null, ciHigh: null,
    };
  }).filter(point => point.ratePerMinute !== null);
  if (folded.length) kept.push({
    key: '其他', expected: '其他', actual: '其他', points: folded,
    hasCI: false, missingCI: true,
  });
  return kept;
}

export function progressDisclosure(series: ProgressSeries[]): string {
  if (!series.length) return '暂无足够数据绘制候选发生率曲线。';
  if (series.some(row => row.missingCI)) {
    return '部分时间点缺少置信区间数据；曲线只显示点估计，不画置信区间，也不推测区间。';
  }
  return '误差线表示该时间点候选发生率的置信区间。';
}

export const PROGRESS_METRIC_LABEL = '每分钟语音的候选数（展示策略不变量）';
export const PROGRESS_METRIC_NOTE = '该指标按语音时长归一化，不受页面展示或你是否确认的影响；它描述检测器在你语音中提出该类候选的频率，不等于错误率。只有与独立度量对照验证后，才能把它解释为进步。';

export type ProgressFeedbackRow = { day?: number; createdAt?: string; analysis?: unknown };
const MAX_PROGRESS_SESSIONS = 12;

type TierObservation = { expected: string; actual: string };

function tierObservations(analysis: unknown): {
  seconds: number | null;
  observations: TierObservation[];
  hasTierData: boolean;
} {
  const root = record(analysis);
  if (!root) return { seconds: null, observations: [], hasTierData: false };
  const nested = record(root.pronunciation) ?? record(root.pronunciationCoach) ?? root;
  const assignment = record(nested.tier_assignment) ?? record(root.tier_assignment);
  const explicitItems = Array.isArray(nested.items) ? nested.items
    : Array.isArray(nested.candidates) ? nested.candidates
    : Array.isArray(root.items) ? root.items
    : Array.isArray(root.candidates) ? root.candidates
    : null;
  const raw = assignment
    ? [
      ...(Array.isArray(assignment.t2_items) ? assignment.t2_items : []),
      ...(Array.isArray(assignment.t3_items) ? assignment.t3_items : []),
    ]
    : explicitItems ?? [];
  const observations: TierObservation[] = [];
  for (const value of raw) {
    const item = record(value);
    const expected = text(item?.expected) ?? text(item?.expected_phone);
    const actual = text(item?.actual) ?? text(item?.actual_phone);
    if (expected && actual && expected !== actual) observations.push({ expected, actual });
  }
  const prosody = record(root.calibrated_prosody) ?? record(root.prosody);
  const seconds = finite(prosody?.speech_duration_seconds) ?? finite(prosody?.speech_seconds)
    ?? finite(prosody?.total_duration_seconds) ?? finite(prosody?.totalDurationSeconds)
    ?? finite(root.speechSeconds) ?? finite(root.speech_seconds) ?? null;
  return {
    seconds: seconds !== null && seconds > 0 ? seconds : null,
    observations,
    hasTierData: Boolean(assignment) || explicitItems !== null,
  };
}

// Fallback progress source: derive per-class candidate occurrences and speech
// exposure from the feedback history when the profile tool has no time series.
// The denominator is speech time, never the number of classes shown or answers
// given. No CI is invented here.
export function progressFromFeedback(rows: ProgressFeedbackRow[], maxSessions = MAX_PROGRESS_SESSIONS): ProgressInput[] {
  type ProgressSession = {
    label: string;
    sortKey: number;
    seconds: number;
    counts: Map<string, { expected: string; actual: string; count: number }>;
  };
  const sessions = rows.map((row, index): ProgressSession | null => {
    const parsed = tierObservations(row.analysis);
    if (!parsed.hasTierData || parsed.seconds === null) return null;
    const counts = new Map<string, { expected: string; actual: string; count: number }>();
    for (const observation of parsed.observations) {
      const key = `${observation.expected}\u0000${observation.actual}`;
      const current = counts.get(key);
      counts.set(key, {
        expected: observation.expected,
        actual: observation.actual,
        count: (current?.count ?? 0) + 1,
      });
    }
    const parsedDate = row.createdAt ? Date.parse(row.createdAt) : Number.NaN;
    const sortKey = Number.isFinite(parsedDate) ? parsedDate : (row.day ?? index);
    const iso = row.createdAt ? /^(\d{4})-(\d{2})-(\d{2})/.exec(row.createdAt) : null;
    const dateLabel = iso ? `${Number(iso[2])}/${Number(iso[3])}`
      : Number.isFinite(parsedDate)
        ? `${new Date(parsedDate).getUTCMonth() + 1}/${new Date(parsedDate).getUTCDate()}`
        : row.day !== undefined ? `Day ${row.day}` : `第 ${index + 1} 次`;
    return { label: dateLabel, sortKey, seconds: parsed.seconds, counts };
  }).filter((session): session is ProgressSession => session !== null)
    .sort((left, right) => left.sortKey - right.sortKey)
    .slice(-Math.max(1, maxSessions));
  const occurrences = new Map<string, number>();
  for (const session of sessions) for (const label of session.counts.keys()) {
    occurrences.set(label, (occurrences.get(label) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const labelled = sessions.map(session => {
    const count = (seen.get(session.label) ?? 0) + 1;
    seen.set(session.label, count);
    return { ...session, label: count === 1 ? session.label : `${session.label} #${count}` };
  });
  return [...occurrences.keys()].map(key => {
    const [expected, actual] = key.split('\u0000');
    return {
      expected, actual,
      points: labelled.map(session => ({
        label: session.label,
        candidates: session.counts.get(key)?.count ?? 0,
        speechSeconds: session.seconds,
      })),
    };
  });
}

// The runner's deterministic T3/portrait/T2/reliability blocks are appended to
// the feedback text with fixed headers. Split only on those constants so the
// browser can keep them in their own sections without rephrasing model prose.
export const T3_PROSE_HEADER = '六、建议自听对比（非错误断言）';
export const PORTRAIT_PROSE_HEADER = '七、你的发音画像（建议性质）';
export const T2_PROSE_MARKER = '【T2 历史确认】';
export const RELIABILITY_PROSE_MARKER = '【T1 可靠性披露】';

export type FeedbackProseSections = {
  t1: string;
  t3?: string;
  t2?: string;
  portraitIntro?: string;
  reliabilityTail?: string;
};

export function splitDeterministicSections(text: string): FeedbackProseSections {
  const t3Index = text.indexOf(T3_PROSE_HEADER);
  const portraitIndex = text.indexOf(PORTRAIT_PROSE_HEADER);
  if (t3Index === -1 && portraitIndex === -1) return { t1: text };
  const first = [t3Index, portraitIndex].filter(index => index >= 0).sort((left, right) => left - right)[0];
  const t1 = text.slice(0, first).trimEnd();
  const t3 = t3Index === -1 ? undefined
    : text.slice(t3Index, portraitIndex > t3Index ? portraitIndex : text.length).trimEnd();
  const portrait = portraitIndex === -1 ? undefined : text.slice(portraitIndex).trimEnd();
  if (!portrait) return { t1, ...(t3 ? { t3 } : {}) };
  const t2Index = portrait.indexOf(T2_PROSE_MARKER);
  const reliabilityIndex = portrait.indexOf(RELIABILITY_PROSE_MARKER);
  if (t2Index === -1) {
    return { t1, ...(t3 ? { t3 } : {}), portraitIntro: portrait };
  }
  const t2End = reliabilityIndex > t2Index ? reliabilityIndex : portrait.length;
  return {
    t1,
    ...(t3 ? { t3 } : {}),
    portraitIntro: portrait.slice(0, t2Index).trimEnd(),
    t2: portrait.slice(t2Index, t2End).trimEnd(),
    ...(reliabilityIndex > t2Index ? { reliabilityTail: portrait.slice(reliabilityIndex).trimEnd() } : {}),
  };
}

export function normalizeProfileResult(raw: unknown): ProfileSnapshot {
  const root = record(raw) ?? {};
  const profileRaw = record(root.profile) ?? root;
  const classes = classList(profileRaw);
  const exists = root.profileExists !== false && profileRaw.exists !== false
    && root.established !== false && profileRaw.established !== false
    && root.coldStart !== true && profileRaw.coldStart !== true
    && (root.profileExists === true || profileRaw.exists === true || classes.length > 0);
  const reliability = toReliability(profileRaw.reliability) ?? toReliability(profileRaw.reliabilitySummary)
    ?? toReliability(root.reliability) ?? toReliability(root.reliabilitySummary)
    ?? toReliability(root.t1_reliability);
  const firstRawClass = Array.isArray(profileRaw.classes)
    ? record(profileRaw.classes[0])
    : Array.isArray(profileRaw.rows) ? record(profileRaw.rows[0])
    : Array.isArray(profileRaw.perClass) ? record(profileRaw.perClass[0]) : null;
  const ruleVersion = text(root.ruleVersion) ?? text(firstRawClass?.ruleVersion);
  const detectorVersion = text(root.detectorVersion) ?? text(firstRawClass?.detectorVersion);
  const inventoryVersion = text(root.inventoryVersion) ?? text(firstRawClass?.inventoryVersion);
  const progressSource = profileRaw.progress ?? root.progress ?? root.progress_metrics
    ?? root.progressMetrics ?? root.candidate_rates;
  const catchRaw = record(profileRaw.catchTrials) ?? record(root.catchTrials);
  const catchTrials = catchRaw ? {
    shown: count(catchRaw.shown) ?? 0,
    answered: count(catchRaw.answered) ?? 0,
    confirmed: count(catchRaw.confirmed) ?? 0,
    constantConfirmerFlag: catchRaw.constantConfirmerFlag === true,
  } : undefined;
  return {
    exists,
    classes,
    ...(reliability ? { reliability } : {}),
    progress: progressList(progressSource),
    ...(ruleVersion ? { ruleVersion } : {}),
    ...(detectorVersion ? { detectorVersion } : {}),
    ...(inventoryVersion ? { inventoryVersion } : {}),
    ...(catchTrials ? { catchTrials } : {}),
  };
}