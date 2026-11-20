// MT-4 D1 cost ledger: atomic reserve/cap, refund floor, pause, UTC day.
// Uses real SQLite (node:sqlite) behind the D1 prepared-statement shape, plus a
// Drizzle instance to prove the module accepts both entry points.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) {
      return { url: new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
  sql.exec(readFileSync("drizzle/" + file, "utf8"));
}

function statement(query, args = []) {
  return {
    bind: (...values) => statement(query, [...args, ...values]),
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async raw() { return sql.prepare(query).all(...args).map(row => Object.values(row)); },
    async run() {
      const result = sql.prepare(query).run(...args);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}
const d1 = {
  prepare: query => statement(query),
  async batch(statements) {
    const results = [];
    for (const entry of statements) results.push(await entry.run());
    return results;
  },
};

const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const db = drizzle(d1, { schema });
const ledger = await import("../lib/cost-ledger.ts");

const MICRO = 1_000_000;
const day = "2026-11-20";

function clear() {
  sql.exec("DELETE FROM user_cost_ledger");
}

test("utcDay partitions by UTC calendar day", () => {
  assert.equal(ledger.utcDay(new Date("2026-11-20T23:59:59.999Z")), "2026-11-20");
  assert.equal(ledger.utcDay(new Date("2026-11-21T00:00:00.000Z")), "2026-11-21");
  assert.equal(ledger.utcDay(Date.parse("2026-11-20T12:00:00Z")), "2026-11-20");
  assert.equal(ledger.cnyToMicroCny(0.05), 50_000);
});

test("reserveCost accumulates spend and reports the balance", async () => {
  clear();
  const first = await ledger.reserveCost(d1, "u1", day, 50_000, 1 * MICRO, 1_700_000_000_000);
  assert.deepEqual(first, { reserved: true, paused: false, spentMicroCny: 50_000 });
  const second = await ledger.reserveCost(d1, "u1", day, 20_000, 1 * MICRO, 1_700_000_000_001);
  assert.deepEqual(second, { reserved: true, paused: false, spentMicroCny: 70_000 });
  assert.deepEqual(await ledger.getLedger(d1, "u1", day), {
    userId: "u1", utcDay: day, spentMicroCny: 70_000, paused: false, updatedAt: 1_700_000_000_001,
  });
});

test("reserveCost fails atomically at the cap and marks the row paused", async () => {
  clear();
  assert.equal((await ledger.reserveCost(d1, "u2", day, 90_000, 100_000)).reserved, true);
  const rejected = await ledger.reserveCost(d1, "u2", day, 20_000, 100_000);
  assert.deepEqual(rejected, { reserved: false, paused: true, spentMicroCny: null });
  const row = await ledger.getLedger(d1, "u2", day);
  assert.equal(row.spentMicroCny, 90_000, "rejected reserve must not mutate spent");
  assert.equal(row.paused, true);
  // Other tenants are unaffected.
  assert.equal((await ledger.reserveCost(d1, "u3", day, 100_000, 100_000)).reserved, true);
});

test("concurrent reservations cannot overshoot the cap", async () => {
  clear();
  const results = await Promise.all(
    Array.from({ length: 8 }, () => ledger.reserveCost(d1, "race", day, 30_000, 100_000)),
  );
  const reserved = results.filter(r => r.reserved).length;
  assert.equal(reserved, 3, "only 3 x 30k fit under a 100k cap");
  const row = await ledger.getLedger(d1, "race", day);
  assert.equal(row.spentMicroCny, 90_000);
  assert.equal(row.paused, true);
  // A subsequent reservation that cannot fit is rejected without changing spend.
  assert.equal((await ledger.reserveCost(d1, "race", day, 20_000, 100_000)).reserved, false);
  assert.equal((await ledger.getLedger(d1, "race", day)).spentMicroCny, 90_000);
});

test("refundCost floors at zero and never makes spend negative", async () => {
  clear();
  await ledger.reserveCost(d1, "u4", day, 40_000, 1 * MICRO);
  assert.deepEqual(await ledger.refundCost(d1, "u4", day, 15_000), { spentMicroCny: 25_000 });
  assert.deepEqual(await ledger.refundCost(d1, "u4", day, 100_000), { spentMicroCny: 0 });
  const row = await ledger.getLedger(d1, "u4", day);
  assert.equal(row.spentMicroCny, 0);
  // Refunding a day with no row is a no-op.
  assert.deepEqual(await ledger.refundCost(d1, "never", day, 10_000), { spentMicroCny: 0 });
  // Spend can resume after a refund (reserve clears paused).
  await ledger.reserveCost(d1, "u4", day, 10_000, 1 * MICRO);
  assert.equal((await ledger.getLedger(d1, "u4", day)).spentMicroCny, 10_000);
});

test("getLedger returns null for an untouched day", async () => {
  clear();
  assert.equal(await ledger.getLedger(d1, "u5", day), null);
});

test("the module accepts a Drizzle D1 instance via $client", async () => {
  clear();
  const result = await ledger.reserveCost(db, "u6", day, 10_000, 100_000);
  assert.equal(result.reserved, true);
  assert.equal((await ledger.getLedger(db, "u6", day)).spentMicroCny, 10_000);
  assert.deepEqual(await ledger.refundCost(db, "u6", day, 10_000), { spentMicroCny: 0 });
});

test("invalid amounts fail closed", async () => {
  clear();
  await assert.rejects(() => ledger.reserveCost(d1, "u7", day, 1.5, 100_000));
  await assert.rejects(() => ledger.reserveCost(d1, "u7", day, -1, 100_000));
  await assert.rejects(() => ledger.reserveCost(d1, "", day, 1, 100_000));
  await assert.rejects(() => ledger.reserveCost(d1, "u7", day, 1, -100));
});