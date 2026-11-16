import assert from 'node:assert/strict';
import {test} from 'node:test';
import {
  COLD_START_COPY, RESET_DIALOG_COPY, SAME_CLASS_CONFIRMATIONS_REQUIRED,
  buildProgressSeries, classList, classProgress, extractPronunciation,
  formatPercent, formatTimestampSeconds, normalizeProfileResult, progressDisclosure,
  progressFromFeedback, reliabilityDisclosure, splitDeterministicSections,
} from '../app/pronunciation-review.ts';

const candidate = (overrides = {}) => ({
  candidateId: 'c-1', word: 'the', expected: 'DH', actual: 'D', atMs: 20310,
  tier: 'T3', detectorConfidence: 0.64, ...overrides,
});

const profileClass = (overrides = {}) => ({
  expected: 'DH', actual: 'D', nConfirmed: 0, nRejected: 0, nUnsure: 0, nShown: 0,
  state: 'CANDIDATE', ...overrides,
});

test('timestamps render in seconds with two decimals', () => {
  assert.equal(formatTimestampSeconds(20310), '20.31 秒');
  assert.equal(formatTimestampSeconds(0), '0.00 秒');
});

test('legacy analysis.errors is not mistaken for the confirmation contract', () => {
  const legacy = extractPronunciation({errors: [{kind: 'substitution', target: 'TH', actual: 'S'}]});
  assert.equal(legacy.present, false);
  assert.deepEqual(legacy.items, []);
});

test('extraction keeps T3 and re-probed T2 only, and never exposes catch-trial metadata', () => {
  const analysis = {
    pronunciation: {
      items: [
        candidate({candidateId: 'real', isCatchTrial: false}),
        candidate({candidateId: 'hidden-flag', isCatchTrial: true}),
        candidate({candidateId: 't2-normal', tier: 'T2'}),
        candidate({candidateId: 't2-reprobe', tier: 'T2', isReprobe: true, priorVerdict: 'confirmed'}),
      ],
      sections: {T2: '  T2 服务器原文  ', T3: 'T3 服务器原文'},
      reliability: {pauseCount: 36, pausePrecision: 0.65},
      profile: {exists: false, classes: []},
    },
  };
  const data = extractPronunciation(analysis);
  assert.equal(data.present, true);
  assert.deepEqual(data.items.map(item => item.candidateId), ['real', 'hidden-flag', 't2-reprobe']);
  assert.equal(data.items[2].priorVerdict, 'confirmed');
  assert.equal(data.items[2].isReprobe, true);
  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes('isCatchTrial'));
  assert.ok(!serialized.includes('catch'));
  assert.deepEqual(data.sections, [
    {tier: 'T2', text: '  T2 服务器原文  '},
    {tier: 'T3', text: 'T3 服务器原文'},
  ]);
  assert.equal(data.reliability.pauseCount, 36);
  assert.equal(data.profile.exists, false);
});

test('a top-level pronunciation payload and tier arrays are accepted verbatim', () => {
  const data = extractPronunciation({
    items: [candidate()],
    tiers: [{tier: 'T3', text: '逐字原文\n第二行'}],
  });
  assert.equal(data.present, true);
  assert.equal(data.items.length, 1);
  assert.equal(data.sections[0].text, '逐字原文\n第二行');
});

test('structured prosody pause count is disclosed even without a reliability block', () => {
  const data = extractPronunciation({pronunciation: {items: [candidate()]}, prosody: {pauseCount: 12}});
  assert.equal(data.reliability.pauseCount, 12);
});

test('same-class progress never uses the cross-class total and excludes unsure', () => {
  const rows = classProgress([
    profileClass({expected: 'DH', actual: 'D', nConfirmed: 1, nUnsure: 5}),
    profileClass({expected: 'TH', actual: 'S', nConfirmed: 2}),
  ]);
  const dh = rows.find(row => row.key === 'DH→D');
  const th = rows.find(row => row.key === 'TH→S');
  assert.equal(dh.nConfirmed, 1);
  assert.equal(dh.needed, SAME_CLASS_CONFIRMATIONS_REQUIRED);
  assert.equal(dh.remaining, 2);
  assert.equal(dh.reached, false);
  assert.equal(dh.nUnsure, 5);
  assert.equal(th.nConfirmed, 2);
  assert.ok(!rows.some(row => row.nConfirmed >= 3));
});

test('reliability disclosure states the pause count and the user estimate without alarm', () => {
  const disclosure = reliabilityDisclosure({pauseCount: 36, pausePrecision: 0.65});
  assert.match(disclosure.pauseLine, /36 次停顿/);
  assert.match(disclosure.detail, /65%/);
  assert.match(disclosure.detail, /可能多计约 13 次/);
  assert.match(disclosure.detail, /估计/);
  assert.equal(disclosure.estimatedOvercount, 13);

  const macro = reliabilityDisclosure({pauseCount: 36, macroPrecision: 0.8124, perSpeakerMin: 0.333, perSpeakerMax: 1});
  assert.match(macro.detail, /81\.2%/);
  assert.match(macro.detail, /33\.3%–100%/);
  assert.match(macro.detail, /个人估计/);
  assert.equal(reliabilityDisclosure(undefined), null);
  assert.equal(formatPercent(0.333), '33.3%');
});

test('progress uses per-minute candidate rate with CI when supplied', () => {
  const series = buildProgressSeries([{
    expected: 'DH', actual: 'D',
    points: [
      {label: '第 1 次', candidates: 4, speechMinutes: 2, ciLow: 1, ciHigh: 3},
      {label: '第 2 次', candidates: 6, speechMinutes: 3, ciLow: 1.5, ciHigh: 2.5},
    ],
  }]);
  assert.equal(series.length, 1);
  assert.deepEqual(series[0].points.map(point => point.ratePerMinute), [2, 2]);
  assert.equal(series[0].hasCI, true);
  assert.equal(series[0].missingCI, false);
  assert.match(progressDisclosure(series), /置信区间/);
});

test('progress accepts seconds and never derives rates from posterior or rejection counts', () => {
  const seconds = buildProgressSeries([{expected: 'DH', actual: 'D', candidates: 4, speechSeconds: 120}]);
  assert.equal(seconds[0].points[0].ratePerMinute, 2);
  const posteriorOnly = buildProgressSeries([{
    expected: 'DH', actual: 'D', nConfirmed: 3, nRejected: 5, speechMinutes: 2,
  }]);
  assert.deepEqual(posteriorOnly, []);
});

test('missing CI is rendered as a point-estimate note, never fabricated bounds', () => {
  const series = buildProgressSeries([{
    expected: 'DH', actual: 'D', candidates: 4, speechMinutes: 2,
  }]);
  assert.equal(series[0].points[0].ciLow, null);
  assert.equal(series[0].missingCI, true);
  const note = progressDisclosure(series);
  assert.match(note, /只显示点估计/);
  assert.match(note, /不推测区间/);
  assert.deepEqual(buildProgressSeries([]), []);
  assert.match(progressDisclosure([]), /暂无足够数据/);
});

test('more than three classes fold into an explicit Other series', () => {
  const inputs = ['A', 'B', 'C', 'D'].map((expected, index) => ({
    expected, actual: 'X', candidates: index + 1, speechMinutes: 1,
  }));
  const series = buildProgressSeries(inputs);
  assert.equal(series.length, 4);
  assert.equal(series[3].key, '其他');
  assert.equal(series[3].points[0].ratePerMinute, 4);
  assert.equal(series[3].missingCI, true);
});

test('cold-start copy is same-class, session-aware and does not promise 3–5 confirmations', () => {
  const all = `${COLD_START_COPY.title} ${COLD_START_COPY.body} ${COLD_START_COPY.sameClassRule} ${COLD_START_COPY.pedagogy}`;
  assert.match(all, /还没有你的个人发音画像/);
  assert.match(all, /同一类别至少 3 次确认/);
  assert.match(all, /每次会话最多展示 3 条候选/);
  assert.match(all, /多次会话/);
  assert.doesNotMatch(all, /3\s*[–-]\s*5/);
  assert.match(all, /不会逐条告诉你判断是否正确/);
  assert.match(all, /可能固化错误/);
  assert.doesNotMatch(all, /即使.*判断错.*训练/);
});

test('reset copy states the profile-and-confirmations scope and the recording/backup retention', () => {
  assert.equal(RESET_DIALOG_COPY.clear, '这会清除你的发音画像和确认记录。');
  assert.equal(RESET_DIALOG_COPY.retention, '不会删除你的录音或备份。');
  assert.match(RESET_DIALOG_COPY.done, /录音和备份未受影响/);
});

test('profile responses normalize both flat and nested shapes', () => {
  const flat = normalizeProfileResult({
    classes: [profileClass({nConfirmed: 2})],
    reliability: {pauseCount: 5, pausePrecision: 0.7},
    progress: [{expected: 'DH', actual: 'D', candidates: 2, speechMinutes: 1}],
    ruleVersion: 'r1', detectorVersion: 'd1',
  });
  assert.equal(flat.exists, true);
  assert.equal(flat.classes[0].nConfirmed, 2);
  assert.equal(flat.reliability.pausePrecision, 0.7);
  assert.equal(flat.progress[0].candidates, 2);
  assert.equal(flat.ruleVersion, 'r1');
  const empty = normalizeProfileResult({profileExists: false, classes: []});
  assert.equal(empty.exists, false);
  const nested = normalizeProfileResult({profile: {classes: [profileClass({nConfirmed: 1})]}});
  assert.equal(nested.exists, true);
  assert.equal(nested.classes.length, 1);
  const mapped = classList({'DH→D': profileClass()});
  assert.equal(mapped.length, 1);
});

test('actual server read-profile rows and reliability document keys are accepted', () => {
  const profile = normalizeProfileResult({
    rows: [profileClass({nConfirmed: 2, ruleVersion: 'r6-suppress-1', detectorVersion: 'det-1'})],
    totals: {nConfirmed: 2},
  });
  assert.equal(profile.exists, true);
  assert.equal(profile.classes.length, 1);
  assert.equal(profile.ruleVersion, 'r6-suppress-1');
  assert.equal(profile.detectorVersion, 'det-1');
  const disclosure = reliabilityDisclosure({
    userPrecision: 0.65,
    populationMacroPrecision: 0.8124,
    populationSpeakerPrecisionRange: [0.333, 1],
    pauseCountInThisRecording: 36,
  });
  assert.match(disclosure.pauseLine, /36 次停顿/);
  assert.match(disclosure.detail, /65%/);
  assert.match(disclosure.detail, /可能多计约 13 次/);
});

test('actual runner tier_assignment items and contrast_audio are accepted', () => {
  const data = extractPronunciation({
    tier_assignment: {
      t2_items: [{word: 'think', tier: 'T2', timestamp_ms: 8100, expected_phone: 'TH', actual_phone: 'S',
        detector_confidence: 0.7, candidateId: 't2-reprobe', isReprobe: true}],
      t3_items: [{word: 'the', tier: 'T3', timestamp_ms: 20310, expected_phone: 'DH', actual_phone: 'D',
        detector_confidence: 0.64, candidateId: 't3-real', contrast_audio: {url: 'https://fixture.example/c.mp3'}}],
    },
    t1_reliability: {userPrecision: 0.65, populationMacroPrecision: 0.8124,
      populationSpeakerPrecisionRange: [0.333, 1], pauseCountInThisRecording: 36},
    calibrated_prosody: {pause_count: 36},
  });
  assert.deepEqual(data.items.map(item => item.candidateId), ['t2-reprobe', 't3-real']);
  assert.equal(data.items[0].atMs, 8100);
  assert.equal(data.items[0].expected, 'TH');
  assert.equal(data.items[0].actual, 'S');
  assert.equal(data.items[0].isReprobe, true);
  assert.equal(data.items[1].canonicalAudioUrl, 'https://fixture.example/c.mp3');
  assert.equal(data.reliability.pauseCount, 36);
  assert.equal(data.reliability.pausePrecision, 0.65);
});

test('actual runner progress-metric documents are per-minute with Wilson bounds', () => {
  const series = buildProgressSeries([{
    classKey: 'DH->D', candidates: 4, speechSeconds: 120,
    ratePerMinute: 2, ratePerMinuteWilson95: [1, 3],
  }]);
  assert.equal(series.length, 1);
  assert.equal(series[0].key, 'DH→D');
  assert.equal(series[0].points[0].ratePerMinute, 2);
  assert.equal(series[0].points[0].ciLow, 1);
  assert.equal(series[0].points[0].ciHigh, 3);
  assert.equal(series[0].hasCI, true);
  const mapped = normalizeProfileResult({
    rows: [],
    progress_metrics: {'DH->D': {classKey: 'DH->D', candidates: 2, speechSeconds: 60, ratePerMinuteWilson95: [0.5, 4]}},
  });
  assert.equal(mapped.progress.length, 1);
  assert.equal(mapped.progress[0].expected, 'DH');
  assert.equal(mapped.progress[0].actual, 'D');
});

test('progress falls back to per-minute rates derived from feedback history', () => {
  const inputs = progressFromFeedback([
    {day: 1, createdAt: '2026-11-01T01:00:00Z', analysis: {
      speechSeconds: 60,
      tier_assignment: {
        t2_items: [
          {expected_phone: 'DH', actual_phone: 'D', nShown: 99, nRejected: 99},
          {expected_phone: 'DH', actual_phone: 'D'},
        ],
        t3_items: [{expected_phone: 'TH', actual_phone: 'TH'}],
      },
    }},
    {day: 2, createdAt: '2026-11-02T01:00:00Z', analysis: {
      calibrated_prosody: {speech_duration_seconds: 120},
      tier_assignment: {t2_items: [{expected_phone: 'DH', actual_phone: 'D'}], t3_items: []},
    }},
    {day: 3, createdAt: '2026-11-03T01:00:00Z', analysis: {errors: []}},
  ]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].expected, 'DH');
  assert.equal(inputs[0].actual, 'D');
  const series = buildProgressSeries(inputs);
  assert.deepEqual(series[0].points.map(point => point.ratePerMinute), [2, 0.5]);
  assert.deepEqual(series[0].points.map(point => point.label), ['11/1', '11/2']);
  assert.equal(series[0].missingCI, true);
  assert.equal(series[0].points[0].ciLow, null);
});

test('actual bandroom-grounded-analysis-v1 shape is accepted and catch flag stays hidden', () => {
  const data = extractPronunciation({
    schema: 'bandroom-grounded-analysis-v1',
    detectorVersion: 'det-1',
    inventoryVersion: 'arpabet-v1',
    speechSeconds: 60,
    items: [
      {candidateId: 'c-real', word: 'the', expected: 'DH', actual: 'D', atMs: 20310,
        detectorConfidence: 0.64, tier: 'T3', requestedTier: 'T3', isCatchTrial: false},
      {candidateId: 'c-control', word: 'the', expected: 'DH', actual: 'DH', atMs: 20310,
        detectorConfidence: 0.64, tier: 'T3', requestedTier: 'T3', isCatchTrial: true},
    ],
  });
  assert.equal(data.present, true);
  assert.deepEqual(data.items.map(item => item.candidateId), ['c-real', 'c-control']);
  assert.equal(data.items[1].expected, 'DH');
  assert.equal(data.items[1].actual, 'DH');
  assert.ok(!JSON.stringify(data).includes('isCatchTrial'));
  const progress = progressFromFeedback([{
    day: 4, createdAt: '2026-11-04T01:00:00Z', analysis: {
      schema: 'bandroom-grounded-analysis-v1', speechSeconds: 120,
      items: [{candidateId: 'x', word: 'the', expected: 'DH', actual: 'D', atMs: 1, tier: 'T3'}],
    },
  }]);
  assert.equal(progress.length, 1);
  assert.equal(buildProgressSeries(progress)[0].points[0].ratePerMinute, 0.5);
});

test('deterministic T3/T2/portrait/reliability prose is split verbatim', () => {
  const t1 = '一、评估\nT1 韵律建议。';
  const t3 = '六、建议自听对比（非错误断言）：\n1. 在 20.31 秒处的 the，可对比标准读音自听判断。';
  const portrait = '七、你的发音画像（建议性质）：\n本画像只记录检测器提出的类别。';
  const t2 = '【T2 历史确认】\n1. 你在 8.10 秒处的 think：这一类常被读成 /d/。';
  const reliability = '【T1 可靠性披露】本次检测到 36 个停顿，该计数仅供参考。';
  const parts = splitDeterministicSections(`${t1}\n${t3}\n${portrait}\n${t2}\n${reliability}`);
  assert.equal(parts.t1, t1);
  assert.equal(parts.t3, t3);
  assert.equal(parts.portraitIntro, portrait);
  assert.equal(parts.t2, t2);
  assert.equal(parts.reliabilityTail, reliability);
  assert.deepEqual(splitDeterministicSections('纯 T1 散文'), {t1: '纯 T1 散文'});
});