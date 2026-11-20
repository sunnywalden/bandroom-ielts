import { z } from "zod/v4";
import { acousticChunkIndex, acousticChunkLimit } from "./acoustic-chunk";
import { coachingContentViolation } from "./content-rules";
import { env } from "cloudflare:workers";
import { createAnalysisBundleGrant } from "./analysis-bundle";
import { decodeCheckpointLimit, issueReviewTransfer, requireDecodedInput } from "./review-transfer";
import { validateSpeakingAnalysis } from "./speaking-analysis";
import {
  isGroundedAnalysis, validateGroundedAnalysis, toIssueInput, enrichCandidateIds, toStoredProsodyOnly,
} from "./grounded-analysis";
import { issueCalibrationCandidatesIdempotent, CalibrationError } from "./calibration";
import {
  claimReviewTasks, claimNextReviewTask, completeReviewTask, failReviewTask, getReviewTask, readReviewCheckpoint, readReviewReceipt,
  recordAnalysisEvent, renewReviewLease, reportSchedulerHeartbeat, reviewTaskDb, saveReviewCheckpoint,
  ReviewTaskError, type ReviewTask, type ReviewTaskDb,
} from "./review-tasks";

const taskId = z.string().trim().min(1).max(200).describe("Exact review task ID returned by claim_review_tasks.");
const fence = z.number().int().min(1).describe("Current task fence; stale fences are rejected.");
const clientRunId = z.string().trim().min(1).max(200).describe("Client-generated run identifier used to correlate evidence.");
const hex64 = z.string().regex(/^[0-9a-f]{64}$/).describe("Lowercase SHA-256.");

const claimSpec = z.strictObject({
  limit: z.number().int().min(1).max(3).optional().describe("Maximum tasks to claim in this call, default 1."),
  clientRunId: clientRunId.optional(),
});
const claimNextSpec = z.strictObject({
  clientRunId: clientRunId.optional(),
});
const renewSpec = z.strictObject({
  taskId, fence,
  extendMs: z.number().int().min(30_000).max(15 * 60_000).optional(),
});
const checkpointStage = z.enum(["read_input", "decode", "vad", "chunk", "acoustic", "align", "detect", "validate", "explain"]);
const checkpointChunkIndex = z.number().int().min(0).max(100_000);
const checkpointSpec = z.strictObject({
  taskId, fence,
  analysisVersion: z.string().trim().min(1).max(120),
  stage: checkpointStage,
  chunkIndex: checkpointChunkIndex,
  inputSha256: hex64,
  artifactSha256: hex64,
  bytes: z.number().int().min(0).max(64 * 1024 * 1024),
  coverage: z.number().min(0).max(1).optional(),
  objectRef: z.string().trim().max(500).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const checkpointReadSpec = z.strictObject({
  taskId, fence,
  stage: checkpointStage.optional(),
  chunkIndex: checkpointChunkIndex.optional(),
}).refine(input => (input.stage === undefined) === (input.chunkIndex === undefined),
  "Provide both stage and chunkIndex to retrieve a specific checkpoint.");
const failSpec = z.strictObject({
  taskId, fence,
  code: z.string().trim().min(1).max(120),
  retryable: z.boolean(),
  nextAt: z.number().int().min(0).optional(),
});
const pronunciationSpec = z.strictObject({
  band: z.number().min(0).max(9).multipleOf(.5),
  reviewedWholeClip: z.literal(true),
  observation: z.string().trim().min(1).max(1000),
  recordingId: z.uuidv4(),
});
const completeSpec = z.strictObject({
  taskId, fence,
  feedback: z.string().trim().min(1).max(6000),
  evidence: z.string().trim().min(1).max(2000),
  analysisVersion: z.string().trim().min(1).max(120).optional(),
  recordingSha256: hex64.optional(),
  analysis: z.record(z.string(), z.unknown()).optional(),
  pronunciation: pronunciationSpec.optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
const bundleSpec = z.strictObject({ taskId, fence });
const transferSpec = z.discriminatedUnion("action", [
  z.strictObject({ taskId, fence, action: z.literal("read_recording") }),
  z.strictObject({ taskId, fence, action: z.literal("read_decode") }),
  z.strictObject({ taskId, fence, action: z.literal("read_acoustic"), chunkIndex: acousticChunkIndex }),
  z.strictObject({
    taskId, fence, action: z.literal("save_decode"), artifactSha256: hex64,
    bytes: z.number().int().min(1).max(decodeCheckpointLimit),
  }),
  z.strictObject({
    taskId, fence, action: z.literal("save_acoustic"), chunkIndex: acousticChunkIndex, artifactSha256: hex64,
    bytes: z.number().int().min(1).max(acousticChunkLimit),
  }),
]);
const recordingSpec = z.strictObject({
  taskId, fence,
  offset: z.number().int().min(0).max(12 * 1024 * 1024),
  length: z.number().int().min(1).max(256 * 1024).optional(),
});
const receiptSpec = z.strictObject({ taskId, clientRunId: clientRunId.optional() });
const heartbeatSpec = z.strictObject({
  automationId: z.string().trim().min(1).max(200),
  generation: z.number().int().min(0),
  clientRunId,
  status: z.enum(["started", "finished", "failed"]),
  startedAt: z.number().int().min(0).optional(),
  finishedAt: z.number().int().min(0).optional(),
  nextExpectedAt: z.number().int().min(0).optional(),
  detail: z.string().trim().max(500).nullable().optional(),
});

export const reviewTools = [
  {
    name: "claim_review_tasks", description: "Claim up to three due Bandroom review tasks for the signed-in owner. Returns the immutable submission snapshot. Creates a processing lease and increases the fence; call again only after the current tasks are completed or failed.", schema: claimSpec, readOnly: false,
  },
  {
    name: "claim_next_review_task", description: "Runner-only: claim the next due review task across ALL tenants. The server selects it and derives the target userId from the task row; pass that userId to every subsequent call. Returns the task (userId, fence, lease) plus its snapshot, or null when the queue is empty.", schema: claimNextSpec, readOnly: false,
  },
  {
    name: "renew_review_lease", description: "Extend the current processing lease for one claimed task. A stale fence or expired lease is rejected; stop writing when this fails.", schema: renewSpec, readOnly: false,
  },
  {
    name: "save_review_checkpoint", description: "Persist metadata for a claimed text task. Speaking tasks save decoded bytes using get_review_transfer.", schema: checkpointSpec, readOnly: false,
  },
  {
    name: "read_review_checkpoint", description: "Read the current durable checkpoint for a claimed task, or supply stage and chunkIndex to read a specific checkpoint. Requires the current lease and fence. Verify artifact hashes before reuse.", schema: checkpointReadSpec, readOnly: true,
  },
  {
    name: "fail_review_task", description: "Record a classified failure. retryable=true moves the task to retry_wait with a persisted next time; false moves it to blocked. Never use this to hide missing acoustic evidence.", schema: failSpec, readOnly: false,
  },
  {
    name: "complete_review_task", description: "Complete one claimed task and write the feedback plus an immutable receipt. Bind to the task's exact attempt and current fence. Replaying the same output returns the original receipt; different output is rejected.", schema: completeSpec, readOnly: false,
  },
  {
    name: "get_analysis_bundle", description: "Issue a short-lived, task/fence-bound URL for the fixed acoustic analysis bundle. The URL is private, expiring and must not be logged or shared; verify the SHA after download.", schema: bundleSpec, readOnly: true,
  },
  {
    name: "get_review_transfer", description: "Issue a task/fence-bound grant for a private binary transfer. GET original audio, decoded audio or a committed acoustic chunk. PUT an exact decoded artifact or the next acoustic chunk. Use the returned authorization only in the request header and verify the SHA after download. Private Site access is required.", schema: transferSpec, readOnly: false,
  },
  {
    name: "read_review_recording", description: "Read one bounded byte range of the original recording bound to a claimed speaking task. Verify the reassembled SHA-256 before analysis. If a transient read failure persists, call fail_review_task with its error code and retryable=true.", schema: recordingSpec, readOnly: true,
  },
  {
    name: "read_review_receipt", description: "Read the immutable completion receipt for one owner task, if it exists.", schema: receiptSpec, readOnly: true,
  },
  {
    name: "report_scheduler_heartbeat", description: "Record an official runner schedule run heartbeat so the page can show actual cadence and disconnection instead of a fabricated healthy state.", schema: heartbeatSpec, readOnly: false,
  },
].map(({ schema, readOnly, ...tool }) => ({
  ...tool,
  inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true },
}));


async function snapshotFor(db: ReviewTaskDb, userId: string, task: ReviewTask) {
  const row = await db.prepare("SELECT snapshot FROM review_jobs WHERE id=? AND user_id=?")
    .bind(task.reviewJobId, userId).first<{ snapshot: string }>();
  if (!row) throw new ReviewTaskError("snapshot_missing", "The immutable submission snapshot is unavailable.");
  return JSON.parse(row.snapshot) as Record<string, unknown>;
}

function toolError(error: unknown) {
  if (error instanceof ReviewTaskError) {
    const payload = ["recording_read_failed", "recording_range_truncated", "transfer_storage_unavailable"].includes(error.code)
      ? { error: error.code, retryable: true }
      : { error: error.code };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
  throw error;
}

export async function callReviewTool(userId: string, name: string, args: unknown) {
  const db = reviewTaskDb();
  try {
    switch (name) {
      case "claim_review_tasks": {
        const input = claimSpec.parse(args ?? {});
        const tasks = await claimReviewTasks(db, userId, {
          limit: input.limit ?? 1, clientRunId: input.clientRunId ?? "unknown",
        });
        const hydrated = await Promise.all(tasks.map(async task => ({
          ...task, snapshot: await snapshotFor(db, userId, task),
        })));
        for (const task of tasks) {
          await recordAnalysisEvent(db, {
            taskId: task.id, fence: task.fence, event: "claim_review_tasks", stage: task.stage,
            outcome: "ok", clientRunId: input.clientRunId ?? null,
          });
        }
        return { content: [{ type: "text", text: JSON.stringify({ serverNow: Date.now(), tasks: hydrated }) }] };
      }
      // INTENTIONALLY CROSS-TENANT (rev2 §7): this is the runner's system-wide
      // queue worker. Trust boundary is the coach-runner SERVICE identity —
      // app/mcp/route.ts enforces mcpToolAllowed(scope,name) BEFORE dispatch and
      // the matrix grants this tool to ["coach-runner"] only (never owner/learner/
      // coach). The snapshot is read with the CLAIMED task's own tenant
      // (task.userId), never the caller's. P2b narrows blast radius with
      // per-tenant service tokens; until then a leaked runner token can claim any
      // tenant's due task — accepted for the single trusted runner (F13/F15).
      case "claim_next_review_task": {
        const input = claimNextSpec.parse(args ?? {});
        const task = await claimNextReviewTask(db, { clientRunId: input.clientRunId ?? "unknown" });
        if (!task) {
          return { content: [{ type: "text", text: JSON.stringify({ serverNow: Date.now(), task: null }) }] };
        }
        const snapshot = await snapshotFor(db, task.userId, task);
        await recordAnalysisEvent(db, {
          taskId: task.id, fence: task.fence, event: "claim_next_review_task", stage: task.stage,
          outcome: "ok", clientRunId: input.clientRunId ?? null,
        });
        return { content: [{ type: "text", text: JSON.stringify({ serverNow: Date.now(), task: { ...task, snapshot } }) }] };
      }
      case "renew_review_lease": {
        const input = renewSpec.parse(args);
        const lease = await renewReviewLease(db, userId, input.taskId, input.fence, { extendMs: input.extendMs });
        return { content: [{ type: "text", text: JSON.stringify(lease) }] };
      }
      case "save_review_checkpoint": {
        const input = checkpointSpec.parse(args);
        const task = await getReviewTask(db, userId, input.taskId);
        if (task?.kind === "speaking")
          throw new ReviewTaskError("binary_checkpoint_required", "Speaking checkpoints must store verified decoded bytes.");
        const saved = await saveReviewCheckpoint(db, userId, {
          ...input, coverage: input.coverage, objectRef: input.objectRef ?? null, payload: input.payload,
        });
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "save_review_checkpoint",
          stage: input.stage, outcome: saved.duplicate ? "duplicate" : "ok",
          metadata: { chunkIndex: input.chunkIndex, analysisVersion: input.analysisVersion,
            inputSha256: input.inputSha256, artifactSha256: input.artifactSha256, bytes: input.bytes },
        });
        return { content: [{ type: "text", text: JSON.stringify(saved) }] };
      }
      case "read_review_checkpoint": {
        const input = checkpointReadSpec.parse(args);
        const checkpoint = await readReviewCheckpoint(db, userId, input);
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "read_review_checkpoint",
          stage: checkpoint?.stage, outcome: checkpoint ? "ok" : "missing",
          metadata: checkpoint ? { chunkIndex: checkpoint.chunkIndex, analysisVersion: checkpoint.analysisVersion,
            inputSha256: checkpoint.inputSha256, artifactSha256: checkpoint.artifactSha256, bytes: checkpoint.bytes } : null,
        });
        return { content: [{ type: "text", text: JSON.stringify({ checkpoint }) }] };
      }
      case "fail_review_task": {
        const input = failSpec.parse(args);
        const task = await failReviewTask(db, userId, input);
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "fail_review_task", stage: task.stage,
          outcome: task.state, metadata: { code: input.code, nextAt: task.nextAt },
        });
        return { content: [{ type: "text", text: JSON.stringify(task) }] };
      }
      case "complete_review_task": {
        const input = completeSpec.parse(args);
        const task = await getReviewTask(db, userId, input.taskId);
        if (!task) throw new ReviewTaskError("task_not_found", "The task is not available to this account.");
        const snapshot = await snapshotFor(db, userId, task);
        const attempt = snapshot.attempt as Record<string, unknown> | undefined;
        if (!attempt || typeof attempt.stage !== "string")
          throw new ReviewTaskError("snapshot_invalid", "The immutable submission snapshot has no attempt stage.");
        // The same content rules as add_coach_feedback (MJ-3) so a runner
        // cannot award an overall Speaking band through this path.
        if (attempt.stage === "speak") {
          const violation = coachingContentViolation({
            feedback: input.feedback, evidence: input.evidence,
            hasStructuredPronunciation: Boolean(input.pronunciation),
          });
          if (violation) throw new ReviewTaskError("content_rule_violation", violation.message);
        }
        if (task.kind === "speaking" && (!input.analysis || !input.recordingSha256))
          throw new ReviewTaskError("analysis_required", "A speaking task needs structured acoustic evidence and the original recording SHA-256.");
        if (task.kind === "text" && input.analysis)
          throw new ReviewTaskError("analysis_not_allowed", "Text-only tasks cannot claim acoustic evidence.");
        if (input.pronunciation) {
          if (task.kind !== "speaking" || !task.recordingId)
            throw new ReviewTaskError("pronunciation_not_allowed", "Pronunciation requires a speaking task with a submitted recording.");
          if (!input.recordingSha256)
            throw new ReviewTaskError("recording_required", "A pronunciation rating must bind the original recording digest.");
          if (input.pronunciation.recordingId !== task.recordingId)
            throw new ReviewTaskError("recording_mismatch", "The pronunciation rating refers to a different recording than this task.");
        }
        const analysisVersion = input.analysisVersion ?? task.analysisVersion;
        let effectiveAnalysis: Record<string, unknown> | null = input.analysis ?? null;
        if (task.kind === "speaking" && isGroundedAnalysis(input.analysis)) {
          // Grounded-prosody completion class (iteration-31 rev3).
          if (!analysisVersion) throw new ReviewTaskError("analysis_version_required", "A speaking completion needs an analysis version.");
          const released = (env.GROUNDED_RELEASED_VERSIONS ?? "").split(",").map(value => value.trim()).filter(Boolean);
          if (!released.includes(analysisVersion))
            throw new ReviewTaskError("analysis_not_released", "The grounded-prosody analysis version has not passed the contract gate.");
          const bucket = env.BUCKET;
          if (!bucket) throw new ReviewTaskError("recordings_unavailable", "Private recording storage is unavailable.");
          const metadata = await bucket.head(`speaking/${encodeURIComponent(userId)}/${task.recordingId}`);
          const digest = metadata?.customMetadata?.digest;
          if (!metadata || !digest) throw new ReviewTaskError("recording_digest_unavailable", "The original recording digest is unavailable.");
          if (digest !== input.recordingSha256)
            throw new ReviewTaskError("recording_mismatch", "The recording digest differs from the original object.");
          // Snapshot recording binding (A2 recordingSha256-only integrity). The
          // decoded-PCM checkpoint (A1) is not used here: isCanonicalOrigin
          // rejects .workers.dev, so the binary transfer endpoint is unavailable on
          // the current deployment (controlled-verification finding). Owner-only
          // scope means recordingSha256 <-> R2 digest <-> snapshot is the same
          // integrity level as the shipped owner path.
          const snapRecording = (snapshot as { recording?: { sha256?: unknown } }).recording;
          if (snapRecording?.sha256 && snapRecording.sha256 !== input.recordingSha256)
            throw new ReviewTaskError("recording_mismatch", "The recording digest differs from the submission snapshot.");
          // Replay of an already-completed task: return the stored receipt WITHOUT
          // re-issuing candidates. This prevents a rejected/altered replay from
          // mutating calibration state before completeReviewTask could reject it
          // (security review: fail-open integrity bypass). The committed receipt is
          // the source of truth; no new write occurs here.
          if (task.state === "completed") {
            const receipt = await readReviewReceipt(db, userId, task.id);
            if (receipt) {
              return { content: [{ type: "text", text: JSON.stringify({
                receiptId: receipt.id, feedbackId: receipt.feedbackId,
                createdAt: receipt.createdAt, duplicate: true,
              }) }] };
            }
          }
          try {
            const grounded = validateGroundedAnalysis(input.analysis);
            // Candidate issuance is idempotent + deterministic, so a retry after a
            // partial failure reuses the same IDs without duplicating rows or
            // inflating n_shown. (A2: no decoded-PCM checkpoint proof.)
            if (grounded.candidates.length) {
              const issued = await issueCalibrationCandidatesIdempotent(
                reviewTaskDb(), userId,
                toIssueInput(grounded, { attemptId: task.attemptId, recordingId: task.recordingId! }));
              effectiveAnalysis = enrichCandidateIds(grounded, issued);
            } else {
              effectiveAnalysis = toStoredProsodyOnly(grounded);
            }
          } catch (error) {
            if (error instanceof CalibrationError) throw new ReviewTaskError(error.code, error.message);
            throw error;
          }
        } else if (task.kind === "speaking" && task.state !== "completed") {
          // QA acoustic track (phoneme schema) — unchanged.
          if (!analysisVersion) throw new ReviewTaskError("analysis_version_required", "A speaking completion needs an analysis version.");
          const released = (env.ANALYSIS_RELEASED_VERSIONS ?? "").split(",").map(value => value.trim()).filter(Boolean);
          if (!released.includes(analysisVersion))
            throw new ReviewTaskError("analysis_not_released", "That analysis version has not passed the release gate.");
          const bucket = env.BUCKET;
          if (!bucket) throw new ReviewTaskError("recordings_unavailable", "Private recording storage is unavailable.");
          const metadata = await bucket.head(`speaking/${encodeURIComponent(userId)}/${task.recordingId}`);
          const digest = metadata?.customMetadata?.digest;
          if (!metadata || !digest) throw new ReviewTaskError("recording_digest_unavailable", "The original recording digest is unavailable.");
          if (digest !== input.recordingSha256)
            throw new ReviewTaskError("recording_mismatch", "The recording digest differs from the original object.");
          const validation = validateSpeakingAnalysis(input.analysis, {
            recordingSha256: input.recordingSha256!, analysisVersion,
          });
          if (!validation.ok) throw new ReviewTaskError("invalid_analysis", validation.errors.join("; "));
          const sampleCount = await requireDecodedInput(db, userId, task.id, input.fence,
            { sha256: digest, bytes: metadata.size }, analysisVersion);
          if ((input.analysis?.decoded as { sampleCount?: number }).sampleCount !== sampleCount)
            throw new ReviewTaskError("invalid_analysis", "The decoded sample count differs from the committed timeline.");
        }
        const completed = await completeReviewTask(db, userId, {
          taskId: input.taskId, fence: input.fence,
          output: { feedback: input.feedback, evidence: input.evidence, analysis: effectiveAnalysis },
          feedback: {
            id: `rt:${input.taskId}`, day: task.day, stage: attempt.stage, attempt: task.attemptId,
            evidence: input.evidence, feedback: input.feedback,
            pronunciation: input.pronunciation ? { ...input.pronunciation, scope: "partial" as const } : undefined,
            analysis: effectiveAnalysis ?? undefined,
          },
          receipt: {
            recordingSha256: input.recordingSha256 ?? null,
            analysisVersion,
            payload: { ...input.payload, taskId: task.id, fence: input.fence },
          },
        });
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "complete_review_task", stage: "finalize",
          outcome: completed.duplicate ? "duplicate" : "ok",
          metadata: { receiptId: completed.receipt.id, feedbackId: completed.receipt.feedbackId },
        });
        return { content: [{ type: "text", text: JSON.stringify({
          receiptId: completed.receipt.id, feedbackId: completed.receipt.feedbackId,
          createdAt: completed.receipt.createdAt, duplicate: completed.duplicate,
        }) }] };
      }
      case "get_analysis_bundle": {
        const input = bundleSpec.parse(args);
        const grant = await createAnalysisBundleGrant(db, userId, input.taskId, input.fence);
        return { content: [{ type: "text", text: JSON.stringify(grant) }] };
      }
      case "get_review_transfer": {
        const input = transferSpec.parse(args);
        const grant = await issueReviewTransfer(db, userId, input.taskId, input.fence, input);
        return { content: [{ type: "text", text: JSON.stringify(grant) }] };
      }
      case "read_review_recording": {
        const input = recordingSpec.parse(args);
        const task = await getReviewTask(db, userId, input.taskId);
        if (!task) throw new ReviewTaskError("task_not_found", "The task is not available to this account.");
        if (task.kind !== "speaking" || !task.recordingId)
          throw new ReviewTaskError("not_speaking", "Only speaking tasks with a submitted recording expose audio.");
        if (task.state !== "running" || task.fence !== input.fence || (task.leaseUntil ?? 0) <= Date.now())
          throw new ReviewTaskError("stale_lease", "The task lease is no longer current.");
        const bucket = env.BUCKET;
        if (!bucket) throw new ReviewTaskError("recordings_unavailable", "Private recording storage is unavailable.");
        const key = `speaking/${encodeURIComponent(userId)}/${task.recordingId}`;
        const read = async () => {
          const metadata = await bucket.head(key);
          if (!metadata) throw new ReviewTaskError("recording_missing", "The original recording is unavailable.");
          if (input.offset >= metadata.size) throw new ReviewTaskError("range_invalid", "The byte offset exceeds the recording.");
          const length = Math.min(input.length ?? 128 * 1024, metadata.size - input.offset);
          const file = await bucket.get(key, { range: { offset: input.offset, length } });
          if (!file) throw new ReviewTaskError("recording_missing", "The original recording is unavailable.");
          const sha256 = metadata.customMetadata?.digest ?? null;
          if (file.etag && metadata.etag && file.etag !== metadata.etag)
            throw new ReviewTaskError("recording_changed", "The original recording changed while it was being read.");
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.length !== length)
            throw new ReviewTaskError("recording_range_truncated", "The private store returned an incomplete byte range.");
          return { metadata, sha256, bytes };
        };
        const { metadata, sha256, bytes } = await read().catch(async error => {
          const failure = error instanceof ReviewTaskError ? error :
            new ReviewTaskError("recording_read_failed", "The private recording could not be read. Retry this byte range.");
          await recordAnalysisEvent(db, {
            taskId: task.id, fence: input.fence, event: "read_review_recording", stage: "read_input", outcome: "error",
            metadata: { code: failure.code, offset: input.offset },
          });
          throw failure;
        });
        const current = await getReviewTask(db, userId, input.taskId);
        if (!current || current.state !== "running" || current.fence !== input.fence || (current.leaseUntil ?? 0) <= Date.now())
          throw new ReviewTaskError("stale_lease", "The task lease expired while reading the recording.");
        await recordAnalysisEvent(db, {
          taskId: task.id, fence: input.fence, event: "read_review_recording", stage: "read_input", outcome: "ok",
          metadata: { recordingId: task.recordingId, offset: input.offset, length: bytes.length, total: metadata.size, sha256 },
        });
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192)
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return { content: [{ type: "text", text: JSON.stringify({
          taskId: task.id, recordingId: task.recordingId, offset: input.offset, length: bytes.length,
          total: metadata.size, nextOffset: input.offset + bytes.length < metadata.size ? input.offset + bytes.length : null,
          sha256,
          mimeType: metadata.httpMetadata?.contentType ?? "application/octet-stream",
          base64: btoa(binary),
        }) }] };
      }
      case "read_review_receipt": {
        const input = receiptSpec.parse(args);
        const receipt = await readReviewReceipt(db, userId, input.taskId);
        if (receipt && input.clientRunId) {
          const task = await getReviewTask(db, userId, input.taskId);
          await recordAnalysisEvent(db, {
            taskId: input.taskId, fence: task?.fence, event: "read_review_receipt", stage: "finalize",
            clientRunId: input.clientRunId, outcome: "ok", metadata: { receiptId: receipt.id, feedbackId: receipt.feedbackId },
          });
        }
        return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      }
      case "report_scheduler_heartbeat": {
        const input = heartbeatSpec.parse(args);
        const result = await reportSchedulerHeartbeat(db, {...input, ownerUserId: userId});
        return { content: [{ type: "text", text: JSON.stringify({ ok: true, updated: result.updated }) }] };
      }
      default:
        return { content: [{ type: "text", text: JSON.stringify({ error: "unknown_review_tool" }) }], isError: true };
    }
  } catch (error) {
    return toolError(error);
  }
}
