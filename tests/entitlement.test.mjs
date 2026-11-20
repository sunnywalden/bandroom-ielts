// MT-5 per-tenant model entitlements (design rev3.1 G4 / license gate).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";

const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(f => f.endsWith(".sql")).sort()) {
  const body = readFileSync("drizzle/" + file, "utf8");
  const text = body.split("\n").map(l => { const at = l.indexOf("--"); return at < 0 ? l : l.slice(0, at); }).join("\n");
  for (const q of text.split(";").map(s => s.trim()).filter(Boolean)) sql.exec(q);
}
function statement(query, args = []) {
  return {
    bind: (...v) => statement(query, [...args, ...v]),
    async first() { return sql.prepare(query).get(...args) ?? null; },
    async all() { return { results: sql.prepare(query).all(...args) }; },
    async raw() { return sql.prepare(query).all(...args).map(r => Object.values(r)); },
    async run() { const r = sql.prepare(query).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  };
}
const d1 = { prepare: q => statement(q), async batch(s) { sql.exec("BEGIN"); try { const o = []; for (const x of s) o.push(await x.run()); sql.exec("COMMIT"); return o; } catch (e) { sql.exec("ROLLBACK"); throw e; } } };
globalThis.__entEnv = { DB: d1, BANDROOM_OWNER_USER_ID: "owner-1" };
registerHooks({
  resolve(spec, ctx, next) {
    if (spec === "cloudflare:workers") return { url: "data:text/javascript,export const env=globalThis.__entEnv", shortCircuit: true };
    if (spec.startsWith("@/")) return { url: new URL("../" + spec.slice(2) + ".ts", import.meta.url).href, shortCircuit: true };
    if ((spec.startsWith("./") || spec.startsWith("../")) && !/\.[a-z]+$/i.test(spec) && ctx.parentURL?.endsWith(".ts"))
      return { url: new URL(spec + ".ts", ctx.parentURL).href, shortCircuit: true };
    return next(spec, ctx);
  },
});
const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");
const db = drizzle(d1, { schema });
const ent = await import("../lib/entitlement.ts");

test("default deny: a tenant without a grant is not entitled", async () => {
  assert.equal(await ent.hasEntitlement(db, "learner-a", "detector_self_listen"), false);
  assert.equal(await ent.hasEntitlement(db, "learner-a", "contrast_tts"), false);
});

test("owner is entitled by deployment posture", async () => {
  assert.equal(await ent.hasEntitlement(db, "owner-1", "detector_self_listen"), true);
  assert.equal(await ent.hasEntitlement(db, "owner-1", "contrast_tts"), true);
});

test("explicit revocation overrides even the owner default (security review)", async () => {
  // Owner has no row → entitled by posture.
  assert.equal(await ent.hasEntitlement(db, "owner-1", "contrast_tts"), true);
  // Grant then revoke the owner: the revocation row must win over the default.
  await ent.grantEntitlement(db, "owner-1", "contrast_tts", "admin-1");
  await ent.revokeEntitlement(db, "owner-1", "contrast_tts");
  assert.equal(await ent.hasEntitlement(db, "owner-1", "contrast_tts"), false);
  // Re-grant restores.
  await ent.grantEntitlement(db, "owner-1", "contrast_tts", "admin-1");
  assert.equal(await ent.hasEntitlement(db, "owner-1", "contrast_tts"), true);
});

test("grant enables; revoke disables; re-grant re-enables", async () => {
  assert.deepEqual(await ent.grantEntitlement(db, "learner-b", "detector_self_listen", "admin-1"), { granted: true });
  assert.equal(await ent.hasEntitlement(db, "learner-b", "detector_self_listen"), true);
  // Other feature still denied.
  assert.equal(await ent.hasEntitlement(db, "learner-b", "contrast_tts"), false);
  assert.deepEqual(await ent.revokeEntitlement(db, "learner-b", "detector_self_listen"), { revoked: true });
  assert.equal(await ent.hasEntitlement(db, "learner-b", "detector_self_listen"), false);
  await ent.grantEntitlement(db, "learner-b", "detector_self_listen", "admin-1");
  assert.equal(await ent.hasEntitlement(db, "learner-b", "detector_self_listen"), true);
});

test("invalid feature is rejected", async () => {
  assert.deepEqual(await ent.grantEntitlement(db, "learner-c", "bogus", "admin-1"), { granted: false });
  assert.equal(ent.isFeature("detector_self_listen"), true);
  assert.equal(ent.isFeature("bogus"), false);
});

test("entitlements are tenant-scoped", async () => {
  await ent.grantEntitlement(db, "learner-d", "contrast_tts", "admin-1");
  assert.equal(await ent.hasEntitlement(db, "learner-d", "contrast_tts"), true);
  assert.equal(await ent.hasEntitlement(db, "learner-e", "contrast_tts"), false);
  const listed = await ent.listEntitlements(db, "learner-d");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].feature, "contrast_tts");
});

console.log("PASS entitlement tests");