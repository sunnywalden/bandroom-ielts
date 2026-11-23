// tools/list snapshot. rev3.1 MT-2 contract: 21 tools. Adds add_learner_note
// (S3.1 learner self-note) and claim_next_review_task (rev2 §7 cross-tenant
// claim) to the rev2 19-tool set; the three calibration tools stay last and the
// heartbeat description/schema are unchanged. Any further change updates these
// digests and must be treated as a contract version change.
// Realtime upgrade Phase 1 (doc §4.7) is such a change: complete_review_task
// gains the optional `writing` input (bandroom-writing-feedback-v1).
// Provenance of the current digest, so it can be re-derived rather than trusted:
//  - 973c7f99… was the frozen value up to Phase 0.
//  - main @ 557e440 (after #55, which reworded the scorecard description in
//    add_coach_feedback without refreshing this file) already evaluates to
//    a64ae6c5…, i.e. this test was red on main before Phase 1.
//  - Stripping `writing` from complete_review_task on top of that reproduces
//    a64ae6c5…, so `writing` is the only contract change Phase 1 adds.
import test from "node:test";
import assert from "node:assert/strict";
import {registerHooks} from "node:module";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";

const root = pathToFileURL(process.cwd() + "/");
globalThis.__snapshotEnv = {};
globalThis.__snapshotDb = {};
const mock = source => ({url: "data:text/javascript," + encodeURIComponent(source), shortCircuit: true});
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "cloudflare:workers") return mock("export const env=globalThis.__snapshotEnv");
    if (specifier === "@/db") return mock("export function getDb(){return globalThis.__snapshotDb};export function getTenantDb(){return globalThis.__snapshotDb};export function drizzleFromBinding(){return globalThis.__snapshotDb}");
    if (specifier.startsWith("@/")) return {url: new URL(specifier.slice(2) + ".ts", root).href, shortCircuit: true};
    if ((specifier.startsWith("./") || specifier.startsWith("../"))
      && !specifier.endsWith(".ts") && context.parentURL?.startsWith(root.href)
      && !context.parentURL.includes("node_modules")) {
      return {url: new URL(specifier + ".ts", context.parentURL).href, shortCircuit: true};
    }
    return next(specifier, context);
  },
});

const {coachTools} = await import("../lib/coach.ts");
const {MCP_TOOL_SCOPES} = await import("../lib/mcp-scope.ts");

const EXPECTED_NAMES = [
  "read_study_session", "add_coach_feedback", "add_learner_note", "publish_lesson",
  "read_recording_bytes", "read_speaking_recording",
  "claim_review_tasks", "claim_next_review_task", "renew_review_lease", "save_review_checkpoint",
  "read_review_checkpoint", "fail_review_task", "complete_review_task",
  "get_analysis_bundle", "get_review_transfer", "read_review_recording",
  "read_review_receipt", "report_scheduler_heartbeat",
  "record_pronunciation_verdict", "read_pronunciation_profile", "reset_pronunciation_profile",
];
const ALL_SHA256 = "1af896a8da7bbf5c5f5210b1cb3cd5e144855d6354035f6c89ace78af3904e2a";
const HEARTBEAT_SCHEMA_SHA256 = "ec4f5fd56ea44f485b2941a23436eb69a546eadd15f64e459e1792533815a530";

const payload = coachTools.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
}));
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("tools/list exposes the 21-tool contract in stable order", () => {
  assert.deepEqual(payload.map(tool => tool.name), EXPECTED_NAMES);
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPES), EXPECTED_NAMES);
  for (const tool of payload) {
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.inputSchema, "object");
    assert.equal(typeof tool.actions, "undefined");
    // Only the calibration reset is destructive; every other tool is additive.
    assert.equal(tool.annotations.destructiveHint, tool.name === "reset_pronunciation_profile", tool.name);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    if ("idempotentHint" in tool.annotations) assert.equal(tool.annotations.idempotentHint, true);
  }
  // The three calibration tools stay last; the learner note follows coach feedback.
  assert.deepEqual(payload.slice(-3).map(tool => tool.name), EXPECTED_NAMES.slice(-3));
  assert.equal(payload[2].name, "add_learner_note");
});

test("the original heartbeat tool keeps its reviewed contract", () => {
  const heartbeat = payload.find(tool => tool.name === "report_scheduler_heartbeat");
  assert.match(heartbeat.description, /official runner schedule/);
  assert.doesNotMatch(heartbeat.description, /official Work/);
  // inputSchema unchanged from the Work-era contract.
  assert.equal(sha256(heartbeat.inputSchema), HEARTBEAT_SCHEMA_SHA256);
  assert.deepEqual(Object.keys(heartbeat.inputSchema.properties).sort(),
    ["automationId", "clientRunId", "detail", "finishedAt", "generation", "nextExpectedAt", "startedAt", "status"]);
});

test("full tools/list snapshot digest matches the frozen expectation", () => {
  assert.equal(sha256(payload), ALL_SHA256);
});