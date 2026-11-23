// Phase 0 (doc §4.2-④): review polling cadence, kept pure so it is testable.
// While a review is queued/running and the runner is connected, check every
// 2 s for up to 3 minutes (the always-on runner claims within seconds). After
// that, back off gradually — no more 111 s → 411 s cliff — and degrade to a
// visible 5-minute check after 30 minutes. A disconnected runner is floored
// at 60 s.
export const FAST_POLL_MS = 2_000;
export const FAST_POLL_WINDOW_MS = 3 * 60_000;
export const POLL_BACKOFF = [3_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000] as const;
export const DEGRADE_AFTER_MS = 30 * 60_000;

export type PollInput = {
  /** ms since the current waiting episode started */
  elapsedMs: number;
  /** backoff step index (incremented by the caller after each slow tick) */
  step: number;
  /** a task is queued or running (not merely completed-unfetched) */
  inFlight: boolean;
  /** automation.connected === true */
  connected: boolean;
  /** automation.connected === false */
  disconnected: boolean;
};

export function nextPollDelay(input: PollInput): { delay: number; fast: boolean; degraded: boolean } {
  const degraded = input.elapsedMs >= DEGRADE_AFTER_MS;
  if (input.inFlight && input.connected && input.elapsedMs < FAST_POLL_WINDOW_MS)
    return { delay: FAST_POLL_MS, fast: true, degraded: false };
  const base = degraded ? 300_000 : POLL_BACKOFF[Math.min(Math.max(0, input.step), POLL_BACKOFF.length - 1)];
  return { delay: input.disconnected ? Math.max(base, 60_000) : base, fast: false, degraded };
}

// D8 / R11: text tasks never read a recording. Their server stage stays at the
// default `read_input`, so the label must come from the task kind, not the stage.
export function runningLabel(kind: string, stage: string, speakingLabels: Record<string, string>): string {
  if (kind !== "speaking") return stage === "validate" ? "正在校验批改" : "正在生成批改";
  return speakingLabels[stage] ?? stage;
}

// Honest ETA: an always-on runner announces a heartbeat cadence of about a
// minute; in that case the claim happens within seconds, so no clock time is
// shown. Otherwise the announced next check time is shown as before.
export function etaText(automation: { connected?: boolean; nextExpectedAt?: number | null } | undefined, now: number,
  clock: (ms: number) => string): string {
  if (!automation?.connected || !automation.nextExpectedAt) return "";
  if (automation.nextExpectedAt - now <= 120_000) return "批改服务在线，通常几秒内领取。";
  return `预计下次检查约 ${clock(automation.nextExpectedAt)}。`;
}
