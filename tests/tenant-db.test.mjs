// Typed tenant boundary (rev2 S11): branded TenantId + SQL tripwire.
import test from "node:test";
import assert from "node:assert/strict";

const {asTenantId, assertTenantPredicate, referencedTenantTables, tenantScoped} = await import("../lib/tenant-db.ts");

test("asTenantId rejects empty/non-string", () => {
  assert.equal(asTenantId("u-1"), "u-1");
  assert.throws(() => asTenantId(""), /invalid_tenant_id/);
  assert.throws(() => asTenantId(5), /invalid_tenant_id/);
});

test("referencedTenantTables finds direct and indirect tables", () => {
  assert.deepEqual(referencedTenantTables("SELECT * FROM learner_states WHERE user_id=?").direct, ["learner_states"]);
  const r = referencedTenantTables("SELECT 1 FROM analysis_artifacts a JOIN review_tasks t ON t.id=a.task_id");
  assert.deepEqual(r.indirect, ["analysis_artifacts"]);
  assert.ok(r.direct.includes("review_tasks"));
});

test("scoped statements pass; unscoped tenant queries trip", () => {
  assert.doesNotThrow(() => assertTenantPredicate("SELECT * FROM learner_states WHERE user_id=?"));
  assert.doesNotThrow(() => assertTenantPredicate("UPDATE review_tasks SET state=? WHERE id=? AND user_id=? AND fence=?"));
  assert.doesNotThrow(() => assertTenantPredicate(
    "INSERT INTO analysis_events (task_id, user_id) VALUES (?, (SELECT user_id FROM review_tasks WHERE id=?))"));
  assert.doesNotThrow(() => assertTenantPredicate(
    "SELECT 1 FROM analysis_events e JOIN review_tasks t ON t.id=e.task_id AND t.user_id=? WHERE e.task_id=?"));
  assert.doesNotThrow(() => assertTenantPredicate("SELECT * FROM review_jobs WHERE id=? AND user_id=?"));

  assert.throws(() => assertTenantPredicate("SELECT * FROM teacher_feedback WHERE id=?"), /missing_user_id/);
  assert.throws(() => assertTenantPredicate("UPDATE review_tasks SET state='queued' WHERE id=?"), /missing_user_id/);
  assert.throws(() => assertTenantPredicate("DELETE FROM calibration_events"), /missing_user_id/);
  assert.throws(() => assertTenantPredicate("SELECT * FROM analysis_artifacts WHERE task_id=?"), /unscoped_artifact/);
});

test("comment/string/projection-only user_id tokens do not satisfy the predicate", () => {
  // bare token in a comment
  assert.throws(() => assertTenantPredicate("SELECT * FROM teacher_feedback -- user_id"), /missing_user_id/);
  // bare token inside a string literal
  assert.throws(() => assertTenantPredicate("SELECT * FROM teacher_feedback WHERE feedback='user_id'"), /missing_user_id/);
  // projection-only mention
  assert.throws(() => assertTenantPredicate("SELECT user_id FROM teacher_feedback"), /missing_user_id/);
  // schema-qualified identifier is recognised and must still be scoped
  assert.doesNotThrow(() => assertTenantPredicate("SELECT * FROM main.teacher_feedback WHERE user_id=?"));
  // comma-separated FROM list: one unscoped tenant table trips
  assert.throws(() => assertTenantPredicate("SELECT * FROM teacher_feedback, learner_states WHERE teacher_feedback.id=?"), /missing_user_id/);
  // comma list with user_id passes
  assert.doesNotThrow(() => assertTenantPredicate("SELECT * FROM review_tasks, analysis_artifacts WHERE review_tasks.user_id=?"));
  // comment markers inside string literals must NOT swallow the table reference
  assert.throws(() => assertTenantPredicate("SELECT '--' AS note, id FROM teacher_feedback"), /missing_user_id/);
  assert.throws(() => assertTenantPredicate("SELECT '/*', id FROM teacher_feedback WHERE note='*/'"), /missing_user_id/);
});

test("non-tenant statements are untouched", () => {
  assert.doesNotThrow(() => assertTenantPredicate("SELECT sqlite_master"));
});

test("tenantScoped wraps prepare and enforces the tripwire", () => {
  let calls = 0;
  const db = { prepare(sql) { calls++; return { bind(){return this;}, first:async()=>null, all:async()=>({results:[]}), run:async()=>({}) }; } };
  const scoped = tenantScoped(db, asTenantId("u-1"));
  scoped.prepare("SELECT * FROM learner_states WHERE user_id=?");
  assert.equal(calls, 1);
  assert.throws(() => scoped.prepare("SELECT * FROM learner_states"), /missing_user_id/);
  assert.equal(calls, 1); // raw db never reached for the unsafe query
});