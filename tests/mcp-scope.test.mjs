// MCP scope matrix (design rev2 §4.3): 16 tools, owner/coach full access,
// coach-runner denied only publish_lesson, unknown scopes/tools denied.
import test from "node:test";
import assert from "node:assert/strict";
import {MCP_TOOL_SCOPES, mcpToolAllowed, mcpToolsForScope} from "../lib/mcp-scope.ts";

const tools = [
  "read_study_session", "add_coach_feedback", "publish_lesson",
  "read_recording_bytes", "read_speaking_recording",
  "claim_review_tasks", "renew_review_lease", "save_review_checkpoint",
  "read_review_checkpoint", "fail_review_task", "complete_review_task",
  "get_analysis_bundle", "get_review_transfer", "read_review_recording",
  "read_review_receipt", "report_scheduler_heartbeat",
];

test("matrix covers exactly the 16 coach tools", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPES).sort(), [...tools].sort());
  assert.equal(tools.length, 16);
});

test("owner and coach may use every tool", () => {
  for (const scope of ["owner", "coach"]) {
    assert.deepEqual(mcpToolsForScope(scope).sort(), [...tools].sort(), scope);
    for (const tool of tools) assert.equal(mcpToolAllowed(scope, tool), true, `${scope}/${tool}`);
  }
});

test("coach-runner may use every tool except publish_lesson", () => {
  for (const tool of tools) {
    assert.equal(mcpToolAllowed("coach-runner", tool), tool !== "publish_lesson", tool);
  }
  assert.deepEqual(mcpToolsForScope("coach-runner").sort(),
    tools.filter(tool => tool !== "publish_lesson").sort());
});

test("missing or unknown identity scope is denied", () => {
  for (const scope of [null, undefined, "learner", "admin"]) {
    for (const tool of tools) assert.equal(mcpToolAllowed(scope, tool), false, String(scope));
  }
});

test("unknown tools are denied for every scope", () => {
  for (const scope of ["owner", "coach", "coach-runner"]) {
    assert.equal(mcpToolAllowed(scope, "not_a_tool"), false, scope);
  }
});