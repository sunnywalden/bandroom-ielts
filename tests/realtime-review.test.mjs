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
