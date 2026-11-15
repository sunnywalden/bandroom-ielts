// tools/list snapshot (MJ-17). The only intentional contract delta from the
// pre-refactor list is the heartbeat description "official Work" ->
// "official runner"; its inputSchema is byte-identical. Any other change
// updates these digests and must be treated as a contract version change.
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
    if (specifier === "@/db") return mock("export function getDb(){return globalThis.__snapshotDb}");
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
  "read_study_session", "add_coach_feedback", "publish_lesson",
  "read_recording_bytes", "read_speaking_recording",
  "claim_review_tasks", "renew_review_lease", "save_review_checkpoint",
  "read_review_checkpoint", "fail_review_task", "complete_review_task",
  "get_analysis_bundle", "get_review_transfer", "read_review_recording",
  "read_review_receipt", "report_scheduler_heartbeat",
];
const ALL_SHA256 = "d541cada75c3e9f34da56a02e30942d05e0de6148592eeeac0f7f1957a916787";
const HEARTBEAT_SCHEMA_SHA256 = "ec4f5fd56ea44f485b2941a23436eb69a546eadd15f64e459e1792533815a530";

const payload = coachTools.map(tool => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: tool.annotations,
}));
const sha256 = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

test("tools/list exposes the 16-tool contract in stable order", () => {
  assert.deepEqual(payload.map(tool => tool.name), EXPECTED_NAMES);
  assert.deepEqual(Object.keys(MCP_TOOL_SCOPES), EXPECTED_NAMES);
  for (const tool of payload) {
    assert.equal(typeof tool.description, "string");
    assert.equal(typeof tool.inputSchema, "object");
    assert.equal(typeof tool.actions, "undefined");
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    if ("idempotentHint" in tool.annotations) assert.equal(tool.annotations.idempotentHint, true);
  }
});

test("heartbeat description is the sole documented description change", () => {
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