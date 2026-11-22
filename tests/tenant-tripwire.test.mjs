// MT-5 golden tests for the tenant tripwire (design rev3.1 S4/G1).
//
// These tests pin the heuristic guards against the four bypass shapes a
// security review proved passed the original tripwire. Passing them does NOT
// make the tripwire a security proof: it is defence-in-depth, and the
// write-side cross-tenant matrix (tests/tenant-isolation) plus review remain
// the authoritative control.
import test from "node:test";
import assert from "node:assert/strict";

const { asTenantId, assertTenantPredicate, tenantD1 } = await import("../lib/tenant-db.ts");
const { scopedTenantDb, tenantPrepare } = await import("../lib/tenant-repository.ts");
const { eq } = await import("drizzle-orm");
const { drizzle } = await import("drizzle-orm/d1");
const schema = await import("../db/schema.ts");

/** A D1-shaped binding that records the SQL it is asked to prepare. */
function recordingD1() {
  const prepared = [];
  return {
    prepared,
    prepare(sql) {
      prepared.push(sql);
      return {
        bind() { return this; },
        async first() { return null; },
        async all() { return { results: [] }; },
        async raw() { return []; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
    async batch(statements) {
      return statements.map(() => ({ results: [] }));
    },
  };
}

test("bypass: user_id compared to itself is rejected", () => {
  const cases = [
    "SELECT * FROM teacher_feedback WHERE user_id=user_id",
    "SELECT * FROM teacher_feedback WHERE user_id = user_id",
    "SELECT * FROM review_tasks t WHERE t.user_id = t.user_id",
    "UPDATE review_tasks SET state='blocked' WHERE user_id = user_id",
    "DELETE FROM learner_states WHERE learner_states.user_id=learner_states.user_id",
    // Drizzle emits quoted, schema-qualified identifiers; the guard must still
    // normalise them before comparing.
    'SELECT * FROM "review_tasks" WHERE "review_tasks"."user_id" = "review_tasks"."user_id"',
    'UPDATE "learner_states" SET "state"=? WHERE "learner_states"."user_id" = "learner_states"."user_id"',
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
    // Actual Drizzle query-builder shapes (quoted, schema-qualified columns).
    'select "user_id", "revision" from "learner_states" where "learner_states"."user_id" = ?',
    'update "review_tasks" set "state" = ? where ("review_tasks"."id" = ? and "review_tasks"."user_id" = ?)',
    'delete from "consent_events" where "consent_events"."user_id" = ?',
    // Attribution by INSERT target column list is accepted at runtime too.
    'insert into "teacher_feedback" ("id", "user_id", "day") values (?, ?, ?)',
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

// --- Runtime wiring: Drizzle over tenantD1 (db/index.ts getTenantDb) --------
// These pin the S4 closure: the tripwire must see the SQL the Drizzle query
// builder actually prepares, not just hand-written raw SQL in tests.

test("tenantD1 guards the SQL Drizzle prepares for a scoped query", async () => {
  const binding = recordingD1();
  const db = drizzle(tenantD1(binding, asTenantId("u-1")), { schema });
  await db
    .select({ userId: schema.learnerStates.userId })
    .from(schema.learnerStates)
    .where(eq(schema.learnerStates.userId, "u-1"))
    .all();
  assert.equal(binding.prepared.length, 1);
  assert.match(binding.prepared[0], /from "learner_states"/);
  assert.match(binding.prepared[0], /"learner_states"\."user_id" = \?/);
});

test("tenantD1 rejects an unscoped Drizzle query before SQLite is reached", async () => {
  const binding = recordingD1();
  const db = drizzle(tenantD1(binding, asTenantId("u-1")), { schema });
  // Drizzle prepares synchronously, so the tripwire throws from `.all()`.
  assert.throws(
    () => db.select().from(schema.learnerStates).all(),
    /tenant_query_missing_user_id/,
  );
  assert.deepEqual(binding.prepared, [], "no statement may reach the raw binding");
});

test("tenantD1 rejects a tautological Drizzle predicate", async () => {
  const binding = recordingD1();
  const db = drizzle(tenantD1(binding, asTenantId("u-1")), { schema });
  const column = schema.reviewTasks.userId;
  assert.throws(
    () => db.select().from(schema.reviewTasks).where(eq(column, column)).all(),
    /tenant_query_tautology/,
  );
  assert.deepEqual(binding.prepared, []);
});

test("tenantD1 guards every statement in a D1 batch", async () => {
  const binding = recordingD1();
  const db = drizzle(tenantD1(binding, asTenantId("u-1")), { schema });
  const scoped = db
    .select()
    .from(schema.learnerStates)
    .where(eq(schema.learnerStates.userId, "u-1"));
  const unscoped = db.select().from(schema.learnerStates);
  await assert.rejects(db.batch([scoped, unscoped]), /tenant_query_missing_user_id/);
});

test("tenantD1 forwards non-prepare members bound to the original binding", () => {
  const binding = {
    marker: "raw",
    prepare(sql) { return { sql }; },
    async batch(statements) { return statements; },
    whoami() { return this.marker; },
  };
  const guarded = tenantD1(binding, asTenantId("u-1"));
  assert.equal(guarded.marker, "raw");
  assert.equal(guarded.whoami(), "raw");
  return guarded.batch([1]).then(result => assert.deepEqual(result, [1]));
});