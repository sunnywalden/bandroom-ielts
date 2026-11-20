// Shared content rules (MJ-3): the add_coach_feedback rules are also enforced
// on complete_review_task. Regex behavior is covered directly, then the real
// tool path is exercised against in-memory SQLite.
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {pathToFileURL} from "node:url";
import {readFileSync, readdirSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
import {randomUUID} from "node:crypto";

const root = pathToFileURL(process.cwd() + "/");
const sql = new DatabaseSync(":memory:");
for (const file of readdirSync("drizzle").filter(name => name.endsWith(".sql")).sort()) {
  sql.exec(readFileSync("drizzle/" + file, "utf8"));
}

function statement(query, args = []) {
  return {
    bind: (...values) => statement(query, [...args, ...values]),
    async first() { const row = sql.prepare(query).all(...args)[0]; return row ? {...row} : null; },
    async all() { return {results: sql.prepare(query).all(...args).map(row => ({...row}))}; },
    async run() {
      const results = sql.prepare(query).all(...args);
      return {results, meta: {changes: Number(sql.prepare("SELECT changes() AS n").get().n)}};
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

globalThis.__contentEnv = {BANDROOM_CONSENT_GATE: "off"}; // fixture: consent tested separately
globalThis.__contentDb = {$client: d1};
const mock = source => ({url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env=globalThis.__contentEnv");
    if (specifier === "@/db") return mock("export function getDb(){return globalThis.__contentDb}");
    if (specifier.startsWith("@/")) return {url: new URL(specifier.slice(2) + ".ts", root).href, shortCircuit: true};
    if ((specifier.startsWith("./") || specifier.startsWith("../"))
      && !specifier.endsWith(".ts") && context.parentURL?.startsWith(root.href)
      && !context.parentURL.includes("node_modules")) {
      return {url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
});

const {coachingContentViolation} = await import("../lib/content-rules.ts");
const {callReviewTool} = await import("../lib/review-tools.ts");

test("overall Speaking band claims are rejected", () => {
  for (const text of [
    "Overall speaking: 7.0",
    "Speaking band is 6.5",
    "口语总分 7",
    "口语综合分约为 8.0",
    "speaking band score = 9",
  ]) {
    const violation = coachingContentViolation({feedback: text, evidence: "quoted answer"});
    assert.equal(violation?.code, "overall_speaking_band", text);
  }
});

test("pronunciation band claims are rejected without structured pronunciation", () => {
  for (const text of ["Pronunciation: 7.0", "发音得分 6.5", "pronunciation estimated at 8"]) {
    const violation = coachingContentViolation({feedback: text, evidence: "quoted answer"});
    assert.equal(violation?.code, "unstructured_pronunciation", text);
  }
});

test("structured pronunciation and ordinary feedback are allowed", () => {
  assert.equal(coachingContentViolation({
    feedback: "Pronunciation: 7.0", evidence: "heard the whole clip",
    hasStructuredPronunciation: true,
  }), null);
  assert.equal(coachingContentViolation({
    feedback: "Your answer was clear; stress the final syllable in 'photograph'.",
    evidence: "0:04-0:12 answer to the Part 2 cue",
  }), null);
});

test("out-of-range numbers and bare mentions do not trigger the band rule", () => {
  assert.equal(coachingContentViolation({feedback: "Speaking band 10 is impossible", evidence: "x"}), null);
  assert.equal(coachingContentViolation({feedback: "We discussed the pronunciation of 'thorough'", evidence: "x"}), null);
});

function insertSpeakingTask() {
  const jobId = "v2:" + randomUUID();
  const snapshot = {
    sourceId: "v1:fixture",
    attempt: {
      id: jobId, day: 12, field: "speakingPart2", index: 0, stage: "speak",
      title: "Fixture", kind: "subjective", response: "Fixture answer", conditions: "", evidence: "",
    },
    context: {prompt: "Fixture prompt"},
  };
  const now = Date.now();
  sql.prepare("INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(jobId, "content-owner", 12, randomUUID(), "a".repeat(64), 22,
      JSON.stringify(snapshot), new Date(now).toISOString());
  const taskId = randomUUID();
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,analysis_version,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId, jobId, "content-owner", "speaking", jobId, 12, 22, randomUUID(), null, now, now, now);
  return taskId;
}

test("complete_review_task applies the same rules before writing", async () => {
  const taskId = insertSpeakingTask();
  const blocked = await callReviewTool("content-owner", "complete_review_task", {
    taskId, fence: 1,
    feedback: "Overall speaking band 7.0 for this answer.",
    evidence: "Fixture evidence",
  });
  assert.equal(blocked.isError, true);
  const payload = JSON.parse(blocked.content[0].text);
  assert.equal(payload.error, "content_rule_violation");
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM teacher_feedback").get().n, 0);
});

test("complete_review_task still rejects pronunciation claims without structured evidence", async () => {
  const taskId = insertSpeakingTask();
  const blocked = await callReviewTool("content-owner", "complete_review_task", {
    taskId, fence: 1,
    feedback: "Pronunciation is 7.0 in this clip.",
    evidence: "Fixture evidence",
  });
  assert.equal(JSON.parse(blocked.content[0].text).error, "content_rule_violation");
});

test("safe feedback passes the content rule and reaches the next gate", async () => {
  const taskId = insertSpeakingTask();
  const allowed = await callReviewTool("content-owner", "complete_review_task", {
    taskId, fence: 1,
    feedback: "Stress the final syllable more clearly.",
    evidence: "Heard the whole clip at 0:04-0:12.",
  });
  assert.equal(allowed.isError, true);
  assert.equal(JSON.parse(allowed.content[0].text).error, "analysis_required");
});