// MCP tool/scope matrix (design rev3.1 §4.2, MT-2). Unknown tools and unknown
// scopes are denied. CLOSED whitelist: a tool not listed here is denied even if
// present in coachTools.
//
// MT-2 scopes:
// - learner: self-read + add_learner_note + own verdict/reset. NO add_coach_feedback,
//   NO claim/complete/publish (S3.1: a learner cannot forge coach/detector output).
// - admin: own-read + publish_lesson(own). Management is via HTTP /api/admin/*,
//   not MCP. Content-blind by default.
// - breakglass: target-bound READ-ONLY (grant validated in lib/breakglass.ts).
// - owner/coach/coach-runner: retain legacy access for backward compat; the
//   runner queue path uses lease-bound tools. Stricter runner cleanup is follow-up.
import type { AuthScope } from "./auth-adapter";

export const MCP_TOOL_SCOPES: Readonly<Record<string, readonly AuthScope[]>> = {
  read_study_session: ["owner", "learner", "admin", "breakglass", "coach", "coach-runner"],
  // S3.1: coach/runner only. Learner uses add_learner_note (no band/analysis/candidates).
  add_coach_feedback: ["owner", "coach", "coach-runner"],
  // MT-2 new: learner self-note. Cannot write pronunciation/analysis_json/candidates.
  add_learner_note: ["owner", "learner", "admin"],
  publish_lesson: ["owner", "admin", "coach"],
  read_recording_bytes: ["owner", "learner", "admin", "breakglass", "coach", "coach-runner"],
  read_speaking_recording: ["owner", "learner", "admin", "breakglass", "coach", "coach-runner"],
  claim_review_tasks: ["owner", "coach", "coach-runner"],
  // Runner-only cross-tenant claim (rev2 §7): server selects the task and derives
  // the target userId from the task row.
  claim_next_review_task: ["coach-runner"],
  renew_review_lease: ["owner", "coach", "coach-runner"],
  save_review_checkpoint: ["owner", "coach", "coach-runner"],
  read_review_checkpoint: ["owner", "coach", "coach-runner"],
  fail_review_task: ["owner", "coach", "coach-runner"],
  complete_review_task: ["owner", "coach", "coach-runner"],
  get_analysis_bundle: ["owner", "coach", "coach-runner"],
  get_review_transfer: ["owner", "coach", "coach-runner"],
  read_review_recording: ["owner", "coach", "coach-runner"],
  read_review_receipt: ["owner", "coach", "coach-runner"],
  report_scheduler_heartbeat: ["owner", "coach", "coach-runner"],
  // Self-report verdicts: learner/admin own only (server-issued candidateId).
  record_pronunciation_verdict: ["owner", "learner", "admin"],
  read_pronunciation_profile: ["owner", "learner", "admin", "breakglass", "coach", "coach-runner"],
  reset_pronunciation_profile: ["owner", "learner", "admin"],
};

export function mcpToolAllowed(scope: AuthScope | null | undefined, name: string): boolean {
  if (!scope) return false;
  const allowed = MCP_TOOL_SCOPES[name];
  return Boolean(allowed?.includes(scope));
}

export function mcpToolsForScope(scope: AuthScope | null | undefined): string[] {
  if (!scope) return [];
  return Object.keys(MCP_TOOL_SCOPES).filter(name => mcpToolAllowed(scope, name));
}