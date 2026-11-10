import { z } from "zod/v4";
import { env } from "cloudflare:workers";
import { getDb } from "@/db";
import {
  claimReviewTasks, completeReviewTask, failReviewTask, getReviewTask, readReviewReceipt,
  recordAnalysisEvent, renewReviewLease, reportSchedulerHeartbeat, saveReviewCheckpoint,
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
const renewSpec = z.strictObject({
  taskId, fence,
  extendMs: z.number().int().min(30_000).max(15 * 60_000).optional(),
});
const checkpointSpec = z.strictObject({
  taskId, fence,
  analysisVersion: z.string().trim().min(1).max(120),
  stage: z.enum(["read_input", "decode", "vad", "chunk", "acoustic", "align", "detect", "validate", "explain"]),
  chunkIndex: z.number().int().min(0).max(100_000),
  inputSha256: hex64,
  artifactSha256: hex64,
  bytes: z.number().int().min(0).max(64 * 1024 * 1024),
  coverage: z.number().min(0).max(1).optional(),
  objectRef: z.string().trim().max(500).nullable().optional(),
  payload: z.record(z.string(), z.unknown()).optional(),
});
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
const recordingSpec = z.strictObject({
  taskId, fence,
  offset: z.number().int().min(0).max(12 * 1024 * 1024),
  length: z.number().int().min(1).max(256 * 1024).optional(),
});
const receiptSpec = z.strictObject({ taskId });
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
    name: "renew_review_lease", description: "Extend the current processing lease for one claimed task. A stale fence or expired lease is rejected; stop writing when this fails.", schema: renewSpec, readOnly: false,
  },
  {
    name: "save_review_checkpoint", description: "Persist one analyzer-versioned checkpoint artifact for a claimed task. The same chunk and version are idempotent; a different digest is rejected.", schema: checkpointSpec, readOnly: false,
  },
  {
    name: "fail_review_task", description: "Record a classified failure. retryable=true moves the task to retry_wait with a persisted next time; false moves it to blocked. Never use this to hide missing acoustic evidence.", schema: failSpec, readOnly: false,
  },
  {
    name: "complete_review_task", description: "Complete one claimed task and write the feedback plus an immutable receipt. Bind to the task's exact attempt and current fence. Replaying the same output returns the original receipt; different output is rejected.", schema: completeSpec, readOnly: false,
  },
  {
    name: "read_review_recording", description: "Read one bounded byte range of the original recording bound to a claimed speaking task. Verifies owner, fence, lease and R2 digest; never returns a public URL.", schema: recordingSpec, readOnly: true,
  },
  {
    name: "read_review_receipt", description: "Read the immutable completion receipt for one owner task, if it exists.", schema: receiptSpec, readOnly: true,
  },
  {
    name: "report_scheduler_heartbeat", description: "Record an official Work schedule run heartbeat so the page can show actual cadence and disconnection instead of a fabricated healthy state.", schema: heartbeatSpec, readOnly: false,
  },
].map(({ schema, readOnly, ...tool }) => ({
  ...tool,
  inputSchema: z.toJSONSchema(schema),
  annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: true },
}));

function reviewDb(): ReviewTaskDb {
  return getDb().$client as unknown as ReviewTaskDb;
}

async function snapshotFor(db: ReviewTaskDb, userId: string, task: ReviewTask) {
  const row = await db.prepare("SELECT snapshot FROM review_jobs WHERE id=? AND user_id=?")
    .bind(task.reviewJobId, userId).first<{ snapshot: string }>();
  if (!row) throw new ReviewTaskError("snapshot_missing", "The immutable submission snapshot is unavailable.");
  return JSON.parse(row.snapshot) as Record<string, unknown>;
}

function toolError(error: unknown) {
  if (error instanceof ReviewTaskError)
    return { content: [{ type: "text", text: JSON.stringify({ error: error.code }) }], isError: true };
  throw error;
}

export async function callReviewTool(userId: string, name: string, args: unknown) {
  const db = reviewDb();
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
      case "renew_review_lease": {
        const input = renewSpec.parse(args);
        const lease = await renewReviewLease(db, userId, input.taskId, input.fence, { extendMs: input.extendMs });
        return { content: [{ type: "text", text: JSON.stringify(lease) }] };
      }
      case "save_review_checkpoint": {
        const input = checkpointSpec.parse(args);
        const saved = await saveReviewCheckpoint(db, userId, {
          ...input, coverage: input.coverage, objectRef: input.objectRef ?? null, payload: input.payload,
        });
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "save_review_checkpoint",
          stage: input.stage, outcome: "ok", metadata: { chunkIndex: input.chunkIndex, analysisVersion: input.analysisVersion },
        });
        return { content: [{ type: "text", text: JSON.stringify(saved) }] };
      }
      case "fail_review_task": {
        const input = failSpec.parse(args);
        const task = await failReviewTask(db, userId, input);
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "fail_review_task", stage: task.stage,
          outcome: input.retryable ? "retry_wait" : "blocked", metadata: { code: input.code },
        });
        return { content: [{ type: "text", text: JSON.stringify(task) }] };
      }
      case "complete_review_task": {
        const input = completeSpec.parse(args);
        const task = await getReviewTask(db, userId, input.taskId);
        if (!task) throw new ReviewTaskError("task_not_found", "The task is not available to this account.");
        if (task.kind === "speaking" && (!input.analysis || !input.recordingSha256))
          throw new ReviewTaskError("analysis_required", "A speaking task needs structured acoustic evidence and the original recording SHA-256.");
        if (task.kind === "text" && input.analysis)
          throw new ReviewTaskError("analysis_not_allowed", "Text-only tasks cannot claim acoustic evidence.");
        const snapshot = await snapshotFor(db, userId, task);
        const attempt = snapshot.attempt as Record<string, unknown> | undefined;
        if (!attempt || typeof attempt.stage !== "string")
          throw new ReviewTaskError("snapshot_invalid", "The immutable submission snapshot has no attempt stage.");
        const completed = await completeReviewTask(db, userId, {
          taskId: input.taskId, fence: input.fence,
          output: { feedback: input.feedback, evidence: input.evidence, analysis: input.analysis ?? null },
          feedback: {
            id: `rt:${input.taskId}`, day: task.day, stage: attempt.stage, attempt: task.attemptId,
            evidence: input.evidence, feedback: input.feedback,
            pronunciation: input.pronunciation, analysis: input.analysis,
          },
          receipt: {
            recordingSha256: input.recordingSha256 ?? null,
            analysisVersion: input.analysisVersion ?? task.analysisVersion,
            payload: { ...input.payload, taskId: task.id, fence: input.fence },
          },
        });
        await recordAnalysisEvent(db, {
          taskId: input.taskId, fence: input.fence, event: "complete_review_task", stage: "finalize",
          outcome: completed.duplicate ? "duplicate" : "completed",
          metadata: { receiptId: completed.receipt.id, feedbackId: completed.receipt.feedbackId },
        });
        return { content: [{ type: "text", text: JSON.stringify({
          receiptId: completed.receipt.id, feedbackId: completed.receipt.feedbackId,
          createdAt: completed.receipt.createdAt, duplicate: completed.duplicate,
        }) }] };
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
        const metadata = await bucket.head(key);
        if (!metadata) throw new ReviewTaskError("recording_missing", "The original recording is unavailable.");
        if (input.offset >= metadata.size) throw new ReviewTaskError("range_invalid", "The byte offset exceeds the recording.");
        const length = Math.min(input.length ?? 128 * 1024, metadata.size - input.offset);
        const file = await bucket.get(key, { range: { offset: input.offset, length } });
        if (!file) throw new ReviewTaskError("recording_missing", "The original recording is unavailable.");
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (let index = 0; index < bytes.length; index += 8192)
          binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
        return { content: [{ type: "text", text: JSON.stringify({
          taskId: task.id, recordingId: task.recordingId, offset: input.offset, length: bytes.length,
          total: metadata.size, nextOffset: input.offset + bytes.length < metadata.size ? input.offset + bytes.length : null,
          sha256: metadata.customMetadata?.digest ?? null,
          mimeType: metadata.httpMetadata?.contentType ?? "application/octet-stream",
          base64: btoa(binary),
        }) }] };
      }
      case "read_review_receipt": {
        const input = receiptSpec.parse(args);
        const receipt = await readReviewReceipt(db, userId, input.taskId);
        return { content: [{ type: "text", text: JSON.stringify(receipt) }] };
      }
      case "report_scheduler_heartbeat": {
        const input = heartbeatSpec.parse(args);
        await reportSchedulerHeartbeat(db, input);
        return { content: [{ type: "text", text: JSON.stringify({ ok: true }) }] };
      }
      default:
        return { content: [{ type: "text", text: JSON.stringify({ error: "unknown_review_tool" }) }], isError: true };
    }
  } catch (error) {
    return toolError(error);
  }
}
