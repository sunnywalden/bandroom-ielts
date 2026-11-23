// Phase 0 realtime review: polling cadence, honest labels, empty-claim audit filter.
import test from "node:test";
import assert from "node:assert/strict";
import { nextPollDelay, runningLabel, etaText, FAST_POLL_MS, FAST_POLL_WINDOW_MS } from "../app/review-polling.ts";

const base = { elapsedMs: 0, step: 0, inFlight: true, connected: true, disconnected: false };

test("in-flight review with a connected runner polls every 2 s for 3 minutes", () => {
  assert.deepEqual(nextPollDelay(base), { delay: FAST_POLL_MS, fast: true, degraded: false });
  assert.equal(nextPollDelay({ ...base, elapsedMs: FAST_POLL_WINDOW_MS - 1 }).delay, 2_000);
  const after = nextPollDelay({ ...base, elapsedMs: FAST_POLL_WINDOW_MS });
  assert.equal(after.fast, false);
  assert.equal(after.delay, 3_000);
});

test("no fast polling without a connected runner or without an in-flight task", () => {
  assert.equal(nextPollDelay({ ...base, connected: false }).fast, false);
  assert.equal(nextPollDelay({ ...base, inFlight: false }).fast, false);
  assert.equal(nextPollDelay({ ...base, connected: false, disconnected: true }).delay, 60_000);
});

test("backoff has no 111 s → 411 s cliff and degrades after 30 minutes", () => {
  const delays = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(step => nextPollDelay({ ...base, inFlight: false, step }).delay);
  assert.deepEqual(delays, [3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000]);
  const degraded = nextPollDelay({ ...base, elapsedMs: 30 * 60_000 });
  assert.deepEqual(degraded, { delay: 300_000, fast: false, degraded: true });
});

test("text tasks never claim to read a recording", () => {
  const speaking = { read_input: "读取原录音", acoustic: "分析声学" };
  assert.equal(runningLabel("text", "read_input", speaking), "正在生成批改");
  assert.equal(runningLabel("text", "validate", speaking), "正在校验批改");
  assert.equal(runningLabel("speaking", "acoustic", speaking), "分析声学");
  assert.equal(runningLabel("speaking", "unknown_stage", speaking), "unknown_stage");
});

test("ETA: always-on runner shows no fabricated clock; scheduled runner shows its next check", () => {
  const now = 1_000_000, clock = ms => `T${ms}`;
  assert.equal(etaText(undefined, now, clock), "");
  assert.equal(etaText({ connected: false, nextExpectedAt: now + 10 }, now, clock), "");
  assert.equal(etaText({ connected: true, nextExpectedAt: null }, now, clock), "");
  assert.equal(etaText({ connected: true, nextExpectedAt: now + 60_000 }, now, clock), "批改服务在线，通常几秒内领取。");
  assert.equal(etaText({ connected: true, nextExpectedAt: now + 300_000 }, now, clock), `预计下次检查约 T${now + 300_000}。`);
});

test("only a successful empty claim skips the audit row", async () => {
  const mod = await import("../lib/claim-audit.ts");
  const wrap = body => ({ content: [{ type: "text", text: JSON.stringify(body) }] });
  assert.equal(mod.isEmptyClaim(wrap({ serverNow: 1, task: null, otherTenantsDue: false })), true);
  assert.equal(mod.isEmptyClaim(wrap({ serverNow: 1, task: { id: "t" } })), false);
  assert.equal(mod.isEmptyClaim({ ...wrap({ task: null }), isError: true }), false);
  assert.equal(mod.isEmptyClaim({ content: [{ type: "text", text: "not json" }] }), false);
  assert.equal(mod.isEmptyClaim(null), false);
});

test("latency report: percentiles, 30-minute visible window, indicative label", async () => {
  const { summarize, percentile } = await import("../scripts/review-latency-report.mjs");
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 90), 4);
  const rows = [
    { kind: "text", created: 0, claimed: 3_000, ready: 30_000, rendered: 32_000 },
    { kind: "text", created: 0, claimed: 5_000, ready: 40_000, rendered: 40_000 + 31 * 60_000 },
    { kind: "speaking", created: 0, claimed: 4_000, ready: null, rendered: null },
  ];
  const report = summarize(rows);
  assert.deepEqual(report.text.queue, { n: 2, p50Seconds: 3, p90Seconds: 5, label: "indicative" });
  assert.equal(report.text.visible.n, 1, "a render 31 min after the receipt is excluded");
  assert.equal(report.text.visible.p50Seconds, 32);
  assert.equal(report.speaking.ready.n, 0);
});

test("writing anchor hit rate: pure summary labels target, floor and indicative sample size", async () => {
  const { summarizeAnchors, ANCHOR_TARGET, ANCHOR_FLOOR } = await import("../scripts/review-latency-report.mjs");
  assert.equal(ANCHOR_TARGET, 0.9);
  assert.equal(ANCHOR_FLOOR, 0.8);
  const empty = summarizeAnchors([]).all;
  assert.deepEqual([empty.issues, empty.rate, empty.meetsTarget, empty.belowFloor, empty.label], [0, null, null, null, "indicative"]);
  const good = summarizeAnchors([{ mode: "cards", issues: 18, anchored: 17 }, { mode: "delta", issues: 4, anchored: 4 }]);
  assert.deepEqual(good.cards, { issues: 18, anchored: 17, rate: 0.944 });
  assert.deepEqual(good.all, { issues: 22, anchored: 21, rate: 0.955, label: "measured", meetsTarget: true, belowFloor: false });
  const low = summarizeAnchors([{ mode: "cards", issues: 10, anchored: 7 }]).all;
  assert.deepEqual([low.rate, low.meetsTarget, low.belowFloor, low.label], [0.7, false, true, "indicative"]);
  // Impossible rows (anchored > issues, negatives, NaN) are dropped, never counted.
  const bad = summarizeAnchors([{ mode: "cards", issues: 2, anchored: 3 }, { mode: "cards", issues: -1, anchored: 0 }, { mode: "x", issues: "n/a", anchored: 1 }]);
  assert.equal(bad.all.issues, 0);
});

test("writing anchor hit rate: ANCHOR_SQL counts only v1 writing cards/delta inside the window", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { readFileSync, readdirSync } = await import("node:fs");
  const { ANCHOR_SQL, summarizeAnchors } = await import("../scripts/review-latency-report.mjs");
  const db = new DatabaseSync(":memory:");
  for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) db.exec(readFileSync("drizzle/" + file, "utf8"));
  const insert = db.prepare(`INSERT INTO teacher_feedback (id,user_id,day,stage,attempt,evidence,feedback,created_at,analysis_json)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const recent = "2026-11-22T10:00:00.000Z", old = "2026-11-01T10:00:00.000Z";
  const span = { start: 0, end: 4 };
  const card = (mode, anchors) => JSON.stringify({ schema: "bandroom-writing-feedback-v1", mode,
    issues: anchors.map((anchor, i) => ({ id: "i" + i, anchor, quote: "q", category: "GRA", priority: "must" })) });
  let n = 0;
  const add = (createdAt, json) => insert.run("f" + ++n, "u1", 12, "write", "a" + n, "e", "f", createdAt, json);
  add(recent, card("cards", [span, span, null]));            // 3 issues, 2 anchored
  add(recent, card("cards", [span]));                        // 1 / 1
  add(recent, card("delta", [null]));                        // 1 / 0
  add(old, card("cards", [null, null, null, null]));         // outside the window
  add(recent, card("recheck", [span]));                      // wrong mode: not an issue list
  add(recent, null);                                         // legacy prose feedback
  add(recent, JSON.stringify({ items: [{ candidateId: "c1" }] })); // speaking analysis, no schema
  add(recent, "not json at all");                            // json_valid must guard this row
  add(recent, JSON.stringify({ schema: "other-schema", mode: "cards", issues: [{ anchor: null }] }));
  const sql = ANCHOR_SQL.replace("?SINCE_ISO?", "2026-11-20T00:00:00.000Z");
  const rows = db.prepare(sql).all().map(row => ({ ...row }));
  const report = summarizeAnchors(rows);
  assert.deepEqual(report.cards, { issues: 4, anchored: 3, rate: 0.75 });
  assert.deepEqual(report.delta, { issues: 1, anchored: 0, rate: 0 });
  assert.deepEqual([report.all.issues, report.all.anchored, report.all.rate], [5, 3, 0.6]);
  assert.equal(report.all.belowFloor, true);
  assert.equal(report.all.label, "indicative");
});
