// MCP scope matrix (design rev3.1 §4.2, MT-2): 21 tools × 6 scopes.
// CLOSED whitelist. learner gets self-read + add_learner_note + own verdict/reset
// but NOT add_coach_feedback/claim/complete/publish (S3.1). admin gets own-read +
// publish_lesson. breakglass is target-bound read-only. owner/coach/coach-runner
// retain legacy access for backward compat.
import test from "node:test";
import assert from "node:assert/strict";
import {MCP_TOOL_SCOPES, mcpToolAllowed, mcpToolsForScope} from "../lib/mcp-scope.ts";

const tools = [
  "read_study_session", "add_coach_feedback", "add_learner_note", "publish_lesson",
  "read_recording_bytes", "read_speaking_recording",
  "claim_review_tasks", "claim_next_review_task", "renew_review_lease", "save_review_checkpoint",
  "read_review_checkpoint", "fail_review_task", "complete_review_task",
  "get_analysis_bundle", "get_review_transfer", "read_review_recording",
  "read_review_receipt", "report_scheduler_heartbeat",
  "record_pronunciation_verdict", "read_pronunciation_profile",
  "reset_pronunciation_profile",
];
const runnerOnly = new Set(["claim_next_review_task"]);
// Tools a learner must NEVER access (S3.1: cannot forge coach output or drive queue).
const learnerDenied = new Set([
  "add_coach_feedback", "publish_lesson", "claim_review_tasks", "claim_next_review_task",
  "renew_review_lease", "save_review_checkpoint", "read_review_checkpoint",
  "fail_review_task", "complete_review_task", "get_analysis_bundle", "get_review_transfer",
  "read_review_recording", "read_review_receipt", "report_scheduler_heartbeat",
]);
// Self-read + own verdict/reset + self-note that a learner MAY access.
const learnerAllowed = new Set([
  "read_study_session", "add_learner_note", "read_recording_bytes", "read_speaking_recording",
  "record_pronunciation_verdict", "read_pronunciation_profile", "reset_pronunciation_profile",
]);

test("matrix covers exactly the 21 coach tools", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPES).sort(), [...tools].sort());
  assert.equal(tools.length, 21);
});

test("owner may use every tool except the runner-only cross-tenant claim", () => {
  const allowed = tools.filter(tool => !runnerOnly.has(tool));
  assert.deepEqual(mcpToolsForScope("owner").sort(), [...allowed].sort());
  for (const tool of tools) assert.equal(mcpToolAllowed("owner", tool), !runnerOnly.has(tool), tool);
});

test("learner gets self tools only — no coach feedback, queue, or publish (S3.1)", () => {
  assert.deepEqual(mcpToolsForScope("learner").sort(), [...learnerAllowed].sort());
  for (const tool of tools) {
    assert.equal(mcpToolAllowed("learner", tool), learnerAllowed.has(tool), tool);
  }
  // Explicit: learner cannot forge coach/detector output.
  assert.equal(mcpToolAllowed("learner", "add_coach_feedback"), false);
  assert.equal(mcpToolAllowed("learner", "complete_review_task"), false);
  assert.equal(mcpToolAllowed("learner", "publish_lesson"), false);
});

test("admin gets own-read + publish + verdict, but no queue or coach feedback", () => {
  const adminAllowed = new Set([...learnerAllowed, "publish_lesson"]);
  assert.deepEqual(mcpToolsForScope("admin").sort(), [...adminAllowed].sort());
  assert.equal(mcpToolAllowed("admin", "add_coach_feedback"), false);
  assert.equal(mcpToolAllowed("admin", "claim_next_review_task"), false);
  assert.equal(mcpToolAllowed("admin", "publish_lesson"), true);
});

test("breakglass is read-only: no writes, no queue, no verdict/reset", () => {
  const bgAllowed = new Set(["read_study_session", "read_recording_bytes", "read_speaking_recording", "read_pronunciation_profile"]);
  assert.deepEqual(mcpToolsForScope("breakglass").sort(), [...bgAllowed].sort());
  for (const tool of ["add_coach_feedback", "add_learner_note", "publish_lesson", "complete_review_task",
    "record_pronunciation_verdict", "reset_pronunciation_profile", "claim_next_review_task"]) {
    assert.equal(mcpToolAllowed("breakglass", tool), false, tool);
  }
});

test("coach cannot write calibration answers or claim across tenants", () => {
  const denied = new Set(["record_pronunciation_verdict", "reset_pronunciation_profile", "claim_next_review_task", "add_learner_note"]);
  for (const tool of tools) assert.equal(mcpToolAllowed("coach", tool), !denied.has(tool), tool);
});

test("coach-runner cannot publish or write calibration answers", () => {
  const denied = new Set(["publish_lesson", "record_pronunciation_verdict", "reset_pronunciation_profile", "add_learner_note"]);
  for (const tool of tools) assert.equal(mcpToolAllowed("coach-runner", tool), !denied.has(tool), tool);
  assert.equal(mcpToolAllowed("coach-runner", "claim_next_review_task"), true);
});

test("missing or unknown identity scope is denied", () => {
  for (const scope of [null, undefined, "nobody"]) {
    for (const tool of tools) assert.equal(mcpToolAllowed(scope, tool), false, String(scope));
  }
});

test("unknown tools are denied for every scope", () => {
  for (const scope of ["owner", "learner", "admin", "breakglass", "coach", "coach-runner"]) {
    assert.equal(mcpToolAllowed(scope, "not_a_tool"), false, scope);
  }
});