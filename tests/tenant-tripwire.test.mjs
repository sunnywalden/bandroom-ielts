// MT-5 golden tests for the tenant tripwire (design rev3.1 S4/G1).
//
// These tests pin the heuristic guards against the four bypass shapes a
// security review proved passed the original tripwire. Passing them does NOT
// make the tripwire a security proof: it is defence-in-depth, and the
// write-side cross-tenant matrix (tests/tenant-isolation) plus review remain
// the authoritative control.
import test from "node:test";
import assert from "node:assert/strict";

const { asTenantId, assertTenantPredicate } = await import("../lib/tenant-db.ts");
const { scopedTenantDb, tenantPrepare } = await import("../lib/tenant-repository.ts");

test("bypass: user_id compared to itself is rejected", () => {
  const cases = [
    "SELECT * FROM teacher_feedback WHERE user_id=user_id",
    "SELECT * FROM teacher_feedback WHERE user_id = user_id",
    "SELECT * FROM review_tasks t WHERE t.user_id = t.user_id",
    "UPDATE review_tasks SET state='blocked' WHERE user_id = user_id",
    "DELETE FROM learner_states WHERE learner_states.user_id=learner_states.user_id",
  ];
  for (const sql of cases) {
    assert.throws(() => assertTenantPredicate(sql), /tenant_query_tautology/, sql);
  }
});

test("bypass: always-true OR disjunction is rejected", () => {
  const cases = [
    "SELECT * FROM teacher_feedback WHERE user_id=? OR 1=1",
    "SELECT * FROM teacher_feedback WHERE user_id=? OR TRUE",
    "SELECT * FROM teacher_feedback WHERE user_id=? OR true",
    "SELECT * FROM teacher_feedback WHERE user_id=? OR '1'='1'",
    "SELECT * FROM review_tasks WHERE id=? AND user_id=? OR (1 = 1)",
    "SELECT * FROM learner_states WHERE user_id=? OR NULL IS NULL",
  ];
  for (const sql of cases) {
    assert.throws(() => assertTenantPredicate(sql), /tenant_query_always_true/, sql);
  }
});

test("bypass: unrestricted cross join ON 1=1 / ON true is rejected", () => {
  const cases = [
    "SELECT * FROM review_tasks t JOIN review_jobs j ON 1=1 WHERE t.user_id=?",
    "SELECT * FROM review_tasks t LEFT JOIN review_jobs j ON true WHERE t.user_id=?",
    "SELECT * FROM learner_states s JOIN users u ON (1 = 1) WHERE s.user_id=?",
  ];
  for (const sql of cases) {
    assert.throws(() => assertTenantPredicate(sql), /tenant_query_cross_join/, sql);
  }
});

test("bypass: UNION / INTERSECT / EXCEPT over tenant tables is rejected", () => {
  const cases = [
    "SELECT * FROM review_tasks WHERE user_id=? UNION ALL SELECT * FROM review_tasks",
    "SELECT * FROM teacher_feedback WHERE user_id=? UNION SELECT * FROM teacher_feedback",
    "SELECT * FROM learner_states WHERE user_id=? INTERSECT SELECT * FROM learner_states",
    "SELECT * FROM calibration_events WHERE user_id=? EXCEPT SELECT * FROM calibration_events",
    // analysis_artifacts is indirect; the second branch still escapes scoping.
    "SELECT * FROM analysis_artifacts a JOIN review_tasks t ON t.id=a.task_id WHERE t.user_id=? UNION ALL SELECT * FROM analysis_artifacts",
  ];
  for (const sql of cases) {
    assert.throws(() => assertTenantPredicate(sql), /tenant_query_set_operation/, sql);
  }
});

test("legitimate scoped queries still pass", () => {
  const cases = [
    "SELECT * FROM learner_states WHERE user_id=?",
    "UPDATE review_tasks SET state=? WHERE id=? AND user_id=? AND fence=?",
    "DELETE FROM calibration_events WHERE user_id=?",
    "INSERT INTO analysis_events (task_id, user_id) VALUES (?, (SELECT user_id FROM review_tasks WHERE id=?))",
    "SELECT 1 FROM review_tasks t JOIN review_jobs j ON j.id=t.review_job_id AND j.user_id=? WHERE t.user_id=?",
    // Indirect artifact access must join review_tasks and constrain the user.
    "SELECT a.* FROM analysis_artifacts a JOIN review_tasks t ON t.id=a.task_id WHERE a.task_id=? AND t.user_id=?",
    // Cross-alias joins are not self-comparisons and must not be misread.
    "SELECT 1 FROM review_tasks t JOIN user_cost_ledger l ON l.user_id=t.user_id WHERE t.user_id=?",
    "SELECT 1 FROM review_tasks t JOIN users u ON u.user_id=t.user_id WHERE t.user_id=? AND u.status='active'",
  ];
  for (const sql of cases) {
    assert.doesNotThrow(() => assertTenantPredicate(sql), sql);
  }
});

test("non-tenant statements are untouched", () => {
  assert.doesNotThrow(() => assertTenantPredicate("SELECT sqlite_master WHERE type='table'"));
  assert.doesNotThrow(() => assertTenantPredicate("SELECT * FROM retention_policy WHERE data_class=?"));
  // A set operation or tautology on non-tenant tables is outside this boundary.
  assert.doesNotThrow(() => assertTenantPredicate("SELECT 1 UNION SELECT 2"));
});

test("scopedTenantDb asserts before reaching the raw db", () => {
  let calls = 0;
  const db = {
    prepare(sql) {
      calls++;
      return { bind() { return this; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    },
  };
  const scoped = scopedTenantDb(db, asTenantId("u-1"));
  assert.equal(scoped.tenant, "u-1");
  scoped.prepare("SELECT * FROM learner_states WHERE user_id=?");
  assert.equal(calls, 1);
  assert.throws(() => scoped.prepare("SELECT * FROM learner_states"), /tenant_query_missing_user_id/);
  assert.throws(() => scoped.prepare("SELECT * FROM learner_states WHERE user_id=user_id"), /tenant_query_tautology/);
  assert.equal(calls, 1, "raw db never reached for unsafe queries");
});

test("scopedTenantDb requires a non-empty branded tenant id", () => {
  const db = { prepare() { return {}; } };
  assert.throws(() => scopedTenantDb(db, ""), /invalid_tenant_id/);
  assert.throws(() => scopedTenantDb(db, undefined), /invalid_tenant_id/);
});

test("tenantPrepare asserts the statement and validates the tenant", () => {
  let calls = 0;
  const db = {
    prepare(sql) {
      calls++;
      return { bind() { return this; }, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
    },
  };
  tenantPrepare(db, asTenantId("u-1"), "SELECT * FROM learner_states WHERE user_id=?");
  assert.equal(calls, 1);
  assert.throws(
    () => tenantPrepare(db, asTenantId("u-1"), "SELECT * FROM learner_states"),
    /tenant_query_missing_user_id/,
  );
  assert.throws(
    () => tenantPrepare(db, asTenantId(""), "SELECT * FROM learner_states WHERE user_id=?"),
    /invalid_tenant_id/,
  );
  assert.equal(calls, 1, "raw db never reached for unsafe inputs");
});