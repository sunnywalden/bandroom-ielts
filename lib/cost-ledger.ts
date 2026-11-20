/**
 * MT-4 (G3/S12): shared per-user daily cost ledger backed by D1.
 *
 * The runner also keeps a host-local `UserBudget` JSON ledger
 * (`runner/tenant_queue.py`) so a single runner can run without a Worker
 * round-trip. That ledger is process-local and therefore wrong as soon as a
 * second runner instance serves the same tenant. This D1 ledger is the shared
 * source of truth:
 *
 *  - `reserveCost` inserts the day's row if needed and then performs a single
 *    atomic `UPDATE ... WHERE spent + ? <= cap ... RETURNING`. The cap check is
 *    inside the UPDATE predicate, so concurrent reservations cannot overshoot.
 *    On rejection the row is marked `paused` and the caller must skip the user
 *    for the rest of the UTC day.
 *  - `refundCost` floors the ledger at zero. Use it for failed/cancelled tasks
 *    so a retryable failure does not permanently spend budget.
 *
 * All amounts are integer micro-CNY (1 CNY = 1_000_000 micro-CNY) to avoid
 * floating-point drift in SQL.
 *
 * D1 supports both `ON CONFLICT ... DO NOTHING` and `RETURNING`, so this module
 * deliberately uses raw prepared statements instead of Drizzle's query builder:
 * the conditional-update + RETURNING pair is the atomic primitive we need.
 */

export const MICRO_CNY_PER_CNY = 1_000_000;

type LedgerRow = {
  user_id: unknown;
  utc_day: unknown;
  spent_micro_cny: unknown;
  paused: unknown;
  updated_at: unknown;
};

type PreparedStatement = {
  bind(...values: unknown[]): PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
  run(): Promise<unknown>;
};

/** Raw D1 database surface used by this module. */
export type CostLedgerDb = {
  prepare(sql: string): PreparedStatement;
};

/** Drizzle's D1 database exposes the underlying binding as `$client`. */
type DrizzleLike = {
  $client?: CostLedgerDb;
  session?: { client?: CostLedgerDb };
};

export type CostLedgerEntry = {
  userId: string;
  utcDay: string;
  spentMicroCny: number;
  paused: boolean;
  updatedAt: number;
};

export type ReserveResult =
  | { reserved: true; paused: false; spentMicroCny: number }
  | { reserved: false; paused: true; spentMicroCny: null };

function rawD1(db: CostLedgerDb | DrizzleLike): CostLedgerDb {
  const candidate = db as DrizzleLike & CostLedgerDb;
  if (typeof candidate.prepare === "function") return candidate;
  const client = candidate.$client ?? candidate.session?.client;
  if (client && typeof client.prepare === "function") return client;
  throw new Error("cost_ledger_requires_d1");
}

function requireIdentifier(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`cost_ledger_invalid_${name}`);
  }
  return value;
}

function requireMicroCny(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`cost_ledger_invalid_${name}`);
  }
  return value;
}

function requireCapMicroCny(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error("cost_ledger_invalid_cap");
  }
  return value;
}

/** UTC calendar day as `YYYY-MM-DD`; the ledger's partitioning key. */
export function utcDay(now: Date | number = Date.now()): string {
  const millis = now instanceof Date ? now.getTime() : now;
  if (!Number.isFinite(millis)) throw new Error("cost_ledger_invalid_now");
  return new Date(millis).toISOString().slice(0, 10);
}

/** Convert a CNY amount to integer micro-CNY (rounded to the nearest micro). */
export function cnyToMicroCny(cny: number): number {
  if (!Number.isFinite(cny) || cny < 0) throw new Error("cost_ledger_invalid_cny");
  return Math.round(cny * MICRO_CNY_PER_CNY);
}

/**
 * Atomically reserve `microCny` for (user, day) if it still fits under
 * `capMicroCny`. Returns the post-reservation spend, or `paused: true` when the
 * cap would be exceeded (and marks the row paused for downstream readers).
 */
export async function reserveCost(
  db: CostLedgerDb | DrizzleLike,
  userId: string,
  day: string,
  microCny: number,
  capMicroCny: number,
  now: number = Date.now(),
): Promise<ReserveResult> {
  const user = requireIdentifier(userId, "user_id");
  const utc = requireIdentifier(day, "utc_day");
  const micro = requireMicroCny(microCny, "micro_cny");
  const cap = requireCapMicroCny(capMicroCny);
  const d1 = rawD1(db);

  // Pre-create the row. Safe under concurrency: the primary key wins and the
  // atomic UPDATE below is the authority for the cap decision.
  await d1
    .prepare(
      `INSERT INTO user_cost_ledger
         (user_id, utc_day, spent_micro_cny, paused, updated_at)
       VALUES (?, ?, 0, 0, ?)
       ON CONFLICT (user_id, utc_day) DO NOTHING`,
    )
    .bind(user, utc, now)
    .run();

  const updated = await d1
    .prepare(
      `UPDATE user_cost_ledger
          SET spent_micro_cny = spent_micro_cny + ?,
              paused = 0,
              updated_at = ?
        WHERE user_id = ? AND utc_day = ?
          AND spent_micro_cny + ? <= ?
        RETURNING spent_micro_cny`,
    )
    .bind(micro, now, user, utc, micro, cap)
    .first<{ spent_micro_cny: unknown }>();

  if (!updated) {
    await d1
      .prepare(
        `UPDATE user_cost_ledger
            SET paused = 1, updated_at = ?
          WHERE user_id = ? AND utc_day = ?`,
      )
      .bind(now, user, utc)
      .run();
    return { reserved: false, paused: true, spentMicroCny: null };
  }

  const spent = Number(updated.spent_micro_cny);
  if (!Number.isFinite(spent)) throw new Error("cost_ledger_bad_row");
  return { reserved: true, paused: false, spentMicroCny: spent };
}

/**
 * Refund `microCny` (floor at zero). The returned `spentMicroCny` is the
 * post-refund balance; a refund larger than the balance simply empties it.
 */
export async function refundCost(
  db: CostLedgerDb | DrizzleLike,
  userId: string,
  day: string,
  microCny: number,
  now: number = Date.now(),
): Promise<{ spentMicroCny: number }> {
  const user = requireIdentifier(userId, "user_id");
  const utc = requireIdentifier(day, "utc_day");
  const micro = requireMicroCny(microCny, "micro_cny");
  const d1 = rawD1(db);

  const row = await d1
    .prepare(
      `UPDATE user_cost_ledger
          SET spent_micro_cny = MAX(0, spent_micro_cny - ?),
              updated_at = ?
        WHERE user_id = ? AND utc_day = ?
        RETURNING spent_micro_cny`,
    )
    .bind(micro, now, user, utc)
    .first<{ spent_micro_cny: unknown }>();

  if (!row) {
    // No row yet: nothing was ever spent today.
    return { spentMicroCny: 0 };
  }
  const spent = Number(row.spent_micro_cny);
  if (!Number.isFinite(spent)) throw new Error("cost_ledger_bad_row");
  return { spentMicroCny: spent };
}

/** Read one (user, day) ledger row, or null when the day has no activity. */
export async function getLedger(
  db: CostLedgerDb | DrizzleLike,
  userId: string,
  day: string,
): Promise<CostLedgerEntry | null> {
  const user = requireIdentifier(userId, "user_id");
  const utc = requireIdentifier(day, "utc_day");
  const row = await rawD1(db)
    .prepare(
      `SELECT user_id, utc_day, spent_micro_cny, paused, updated_at
         FROM user_cost_ledger
        WHERE user_id = ? AND utc_day = ?`,
    )
    .bind(user, utc)
    .first<LedgerRow>();
  if (!row) return null;
  return {
    userId: String(row.user_id),
    utcDay: String(row.utc_day),
    spentMicroCny: Number(row.spent_micro_cny),
    paused: Boolean(row.paused),
    updatedAt: Number(row.updated_at),
  };
}