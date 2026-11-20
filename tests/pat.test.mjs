// MT-2 personal access tokens: creation, one-time plaintext, hashed storage,
// binding to one tenant, revocation/list behaviour, and auth-adapter wiring.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";

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
    sql.exec("BEGIN");
    try {
      const results = [];
      for (const entry of statements) results.push(await entry.run());
      sql.exec("COMMIT");
      return results;
    } catch (error) {
      sql.exec("ROLLBACK");
      throw error;
    }
  },
};
globalThis.__patEnv = { DB: d1 };

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export const env=globalThis.__patEnv??{}", shortCircuit: true };
    }
    if (specifier === "next/headers") {
      return { url: "data:text/javascript,export async function headers(){return new Headers()}", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      return { url: new URL("../" + specifier.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    }
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/i.test(specifier)
      && context.parentURL?.endsWith(".ts")) {
      return { url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const db = drizzle(d1, { schema });
const { createPat, resolvePat, revokePat, listPats } = await import("../lib/pat.ts");
const { resolveAuthContext } = await import("../lib/auth-adapter.ts");

const sha256 = value => createHash("sha256").update(value).digest("hex");
const tokenRows = () => sql.prepare("SELECT * FROM user_tokens ORDER BY created_at").all().map(row => ({ ...row }));

test("createPat returns plaintext once and stores only its SHA-256 hash", async () => {
  const created = await createPat(db, "tenant-a", "MacBook connector");
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.ok(created.token.startsWith("brpat_"));
  assert.match(created.token.slice("brpat_".length), /^[0-9a-f]{64}$/);
  const stored = tokenRows().find(row => row.id === created.id);
  assert.equal(stored.token_hash, sha256(created.token));
  assert.notEqual(stored.token_hash, created.token);
  assert.equal(stored.user_id, "tenant-a");
  assert.equal(stored.label, "MacBook connector");
  assert.equal(stored.revoked_at, null);
});

test("resolvePat binds the token to its tenant and refreshes last_used_at", async () => {
  const created = await createPat(db, "tenant-b");
  const before = tokenRows().find(row => row.id === created.id);
  assert.equal(before.last_used_at, null);
  assert.deepEqual(await resolvePat(db, created.token), { userId: "tenant-b" });
  assert.ok(tokenRows().find(row => row.id === created.id).last_used_at > 0);
  // A token minted for A never resolves to B.
  const other = await createPat(db, "tenant-c");
  assert.deepEqual(await resolvePat(db, other.token), { userId: "tenant-c" });
});

test("wrong, malformed and foreign tokens are rejected", async () => {
  const created = await createPat(db, "tenant-d");
  assert.equal(await resolvePat(db, created.token + "0"), null);
  assert.equal(await resolvePat(db, "not-a-token"), null);
  assert.equal(await resolvePat(db, "brpat_" + "0".repeat(64)), null);
  assert.equal(await resolvePat(db, ""), null);
});

test("revokePat is tenant-scoped and revoked tokens stop resolving", async () => {
  const created = await createPat(db, "tenant-e", "old laptop");
  assert.deepEqual(await revokePat(db, "tenant-other", created.id), { revoked: false },
    "another tenant cannot revoke the token");
  assert.deepEqual(await resolvePat(db, created.token), { userId: "tenant-e" });
  assert.deepEqual(await revokePat(db, "tenant-e", created.id), { revoked: true });
  assert.ok(tokenRows().find(row => row.id === created.id).revoked_at > 0);
  assert.equal(await resolvePat(db, created.token), null, "revoked token rejected");
  assert.deepEqual(await revokePat(db, "tenant-e", "missing-id"), { revoked: false });
});

test("listPats projects metadata only, never token_hash", async () => {
  const created = await createPat(db, "tenant-f", "phone");
  await resolvePat(db, created.token);
  const listed = await listPats(db, "tenant-f");
  assert.equal(listed.length, 1);
  assert.deepEqual(Object.keys(listed[0]).sort(),
    ["createdAt", "id", "label", "lastUsedAt", "revokedAt"]);
  assert.equal(listed[0].id, created.id);
  assert.equal(listed[0].label, "phone");
  assert.ok(!JSON.stringify(listed).includes(sha256(created.token)), "hash never projected");
  assert.deepEqual(await listPats(db, "tenant-g"), [], "no cross-tenant listing");
});

test("auth adapter resolves Authorization: Bearer brpat_ to a learner PAT identity", async () => {
  const created = await createPat(db, "tenant-pat");
  const context = await resolveAuthContext(
    new Headers({ host: "study.example", authorization: `Bearer ${created.token}` }),
    { DB: d1 },
    { production: true },
  );
  assert.deepEqual(context, {
    user: { userId: "tenant-pat", displayName: "PAT", email: "", fullName: null },
    scope: "learner",
    identityType: "pat",
  });

  const invalid = await resolveAuthContext(
    new Headers({ host: "study.example", authorization: "Bearer brpat_" + "f".repeat(64) }),
    { DB: d1 },
    { production: true },
  );
  assert.deepEqual(invalid, { user: null, scope: null, identityType: null }, "invalid PAT fails closed");

  const noDb = await resolveAuthContext(
    new Headers({ host: "study.example", authorization: `Bearer ${created.token}` }),
    {},
    { production: true },
  );
  assert.deepEqual(noDb, { user: null, scope: null, identityType: null }, "absent DB fails closed");
});

test("a revoked PAT no longer authenticates through the adapter", async () => {
  const created = await createPat(db, "tenant-revoked");
  await revokePat(db, "tenant-revoked", created.id);
  const context = await resolveAuthContext(
    new Headers({ host: "study.example", authorization: `Bearer ${created.token}` }),
    { DB: d1 },
    { production: true },
  );
  assert.deepEqual(context, { user: null, scope: null, identityType: null });
});