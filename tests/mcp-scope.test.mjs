// MCP scope matrix (design rev2 §4.3/§9): 20 tools.
// owner may use every tool; coach may use every tool except the owner-only
// calibration verdict/reset writes; coach-runner additionally cannot publish
// lessons or answer/reset the learner's calibration. Unknown scopes/tools are
// denied because MCP_TOOL_SCOPES is a closed whitelist.
import test from "node:test";
import assert from "node:assert/strict";
import {MCP_TOOL_SCOPES, mcpToolAllowed, mcpToolsForScope} from "../lib/mcp-scope.ts";

const tools = [
  "read_study_session", "add_coach_feedback", "publish_lesson",
  "read_recording_bytes", "read_speaking_recording",
  "claim_review_tasks", "claim_next_review_task", "renew_review_lease", "save_review_checkpoint",
  "read_review_checkpoint", "fail_review_task", "complete_review_task",
  "get_analysis_bundle", "get_review_transfer", "read_review_recording",
  "read_review_receipt", "report_scheduler_heartbeat",
  "record_pronunciation_verdict", "read_pronunciation_profile",
  "reset_pronunciation_profile",
];
const ownerOnly = new Set(["record_pronunciation_verdict", "reset_pronunciation_profile"]);
const runnerOnly = new Set(["claim_next_review_task"]);

test("matrix covers exactly the 20 coach tools", () => {
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPES).sort(), [...tools].sort());
  assert.equal(tools.length, 20);
});

test("owner may use every tool except the runner-only cross-tenant claim", () => {
  const allowed = tools.filter(tool => !runnerOnly.has(tool));
  assert.deepEqual(mcpToolsForScope("owner").sort(), [...allowed].sort());
  for (const tool of tools) assert.equal(mcpToolAllowed("owner", tool), !runnerOnly.has(tool), tool);
});

test("coach may read the profile but cannot write owner calibration answers or claim across tenants", () => {
  const allowed = tools.filter(tool => !ownerOnly.has(tool) && !runnerOnly.has(tool));
  assert.deepEqual(mcpToolsForScope("coach").sort(), [...allowed].sort());
  for (const tool of tools) assert.equal(mcpToolAllowed("coach", tool), !ownerOnly.has(tool) && !runnerOnly.has(tool), tool);
});

test("coach-runner may use every tool except publish_lesson and owner calibration writes", () => {
  const denied = new Set(["publish_lesson", ...ownerOnly]);
  for (const tool of tools) assert.equal(mcpToolAllowed("coach-runner", tool), !denied.has(tool), tool);
  assert.deepEqual(mcpToolsForScope("coach-runner").sort(),
    tools.filter(tool => !denied.has(tool)).sort());
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