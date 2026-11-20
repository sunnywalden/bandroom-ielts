// MCP tool/scope matrix (design rev2 §4.3/§9). Unknown tools and unknown scopes
// are denied. coach-runner is the production coaching runner; it may write
// feedback and drive review tasks but cannot publish catalogue lessons.
//
// Personal calibration (FIX-22): the verdict and reset tools are owner-only
// because they record or erase the learner's own self-report. The runner may
// read the profile to condition T2 suggestions. This matrix is a CLOSED
// whitelist: a new tool that is not listed here is denied even if it is present
// in coachTools. Current authorization is single-owner (rev2 §10); adding a
// second user requires an auth-scope redesign, not just another matrix entry.
import type { AuthScope } from "./auth-adapter";

export const MCP_TOOL_SCOPES: Readonly<Record<string, readonly AuthScope[]>> = {
  read_study_session: ["owner", "coach", "coach-runner"],
  add_coach_feedback: ["owner", "coach", "coach-runner"],
  publish_lesson: ["owner", "coach"],
  read_recording_bytes: ["owner", "coach", "coach-runner"],
  read_speaking_recording: ["owner", "coach", "coach-runner"],
  claim_review_tasks: ["owner", "coach", "coach-runner"],
  // Runner-only cross-tenant claim (rev2 §7): the server selects the next due
  // task across all tenants and derives the target userId from the task row.
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
  // rev2 §9: server-issued candidate verdicts and reset are owner-only; the
  // profile is readable by the coaching runner for historical conditioning.
  record_pronunciation_verdict: ["owner"],
  read_pronunciation_profile: ["owner", "coach", "coach-runner"],
  reset_pronunciation_profile: ["owner"],
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