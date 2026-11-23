// frozenReviews must be deterministic: the writing loop takes the LAST quick
// check as the latest one, and SQLite guarantees no order without ORDER BY.
// Runs the real drizzle query against a real SQLite database (via sqlite-proxy
// over node:sqlite), so the ordering is verified rather than mocked.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const root = pathToFileURL(process.cwd() + "/");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE review_jobs (
  id text PRIMARY KEY, user_id text NOT NULL, day integer NOT NULL,
  submission_key text NOT NULL, request_hash text NOT NULL, revision integer NOT NULL,
  snapshot text NOT NULL, created_at text NOT NULL)`);

globalThis.__orderDb = null;
const mock = source => ({ url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true });
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env={}");
    if (specifier === "@/db") return mock("export function getTenantDb(){return globalThis.__orderDb};export function getDb(){return globalThis.__orderDb}");
    if (specifier.startsWith("@/")) return { url: new URL(specifier.slice(2) + ".ts", root).href, shortCircuit: true };
    if ((specifier.startsWith("./") || specifier.startsWith("../"))
      && !specifier.endsWith(".ts") && context.parentURL?.startsWith(root.href)
      && !context.parentURL.includes("node_modules")) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { drizzle } = await import("drizzle-orm/sqlite-proxy");
globalThis.__orderDb = drizzle(async (query, params, method) => {
  const statement = sqlite.prepare(query);
  if (method === "run") { statement.run(...params); return { rows: [] }; }
  return { rows: statement.all(...params).map(row => Object.values(row)) };
});

const { frozenReviews } = await import("../lib/review-jobs.ts");

const insert = sqlite.prepare(`INSERT INTO review_jobs
  (id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)`);
const job = (id, createdAt, user = "u1") =>
  insert.run(id, user, 12, "k" + id, "h", 1, JSON.stringify({ sourceId: id }), createdAt);

test("frozenReviews returns jobs oldest to newest regardless of insert order", async () => {
  // Inserted deliberately out of chronological order.
  job("j-third", "2026-11-22T10:02:00.000Z");
  job("j-first", "2026-11-22T10:00:00.000Z");
  job("j-second", "2026-11-22T10:01:00.000Z");
  const rows = await frozenReviews("u1", 12);
  assert.deepEqual(rows.map(row => row.id), ["j-first", "j-second", "j-third"]);
  assert.equal(rows.at(-1).id, "j-third", "the last entry really is the latest quick check");
});

test("frozenReviews breaks created_at ties by id and stays tenant scoped", async () => {
  job("j-same-b", "2026-11-22T10:03:00.000Z");
  job("j-same-a", "2026-11-22T10:03:00.000Z");
  job("j-other-tenant", "2026-11-22T09:00:00.000Z", "u2");
  const rows = await frozenReviews("u1", 12);
  assert.deepEqual(rows.slice(-2).map(row => row.id), ["j-same-a", "j-same-b"]);
  assert.ok(rows.every(row => row.id !== "j-other-tenant"), "another tenant's jobs are never returned");
  assert.equal((await frozenReviews("u2", 12)).length, 1);
});

test("frozenReviews parses the snapshot JSON for readers", async () => {
  const rows = await frozenReviews("u1", 12);
  assert.equal(typeof rows[0].snapshot, "object");
  assert.equal(rows[0].snapshot.sourceId, "j-first");
});
