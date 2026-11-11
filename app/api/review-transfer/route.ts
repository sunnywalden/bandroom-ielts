import { reviewTaskDb, ReviewTaskError, recordAnalysisEvent } from "@/lib/review-tasks";
import {
  authenticateReviewTransfer, downloadReviewTransfer, liveSpeakingLease, uploadDecodeCheckpoint,
} from "@/lib/review-transfer";
import { json, limitedBody } from "../shared";

export const dynamic = "force-dynamic";

const statuses: Record<string, number> = {
  task_not_found: 404,
  not_speaking: 404,
  stale_lease: 409,
  transfer_expired: 403,
  recording_missing: 404,
  checkpoint_object_missing: 404,
  recording_changed: 409,
  recording_integrity_unavailable: 409,
  transfer_integrity_failed: 422,
  recording_read_failed: 503,
  invalid_decode_checkpoint: 422,
  analysis_version_mismatch: 409,
  checkpoint_advanced: 409,
  artifact_conflict: 409,
  transfer_storage_unavailable: 503,
};

async function transfer(request: Request) {
  const grant = await authenticateReviewTransfer(request);
  if (!grant) return json({ error: "transfer_access_denied" }, 403);
  const db = reviewTaskDb();
  const audit = {
    taskId: grant.taskId,
    fence: grant.fence,
    stage: grant.action === "read_recording" ? "read_input" : "decode",
    event: {
      read_recording: "read_review_recording",
      read_decode: "read_review_checkpoint",
      save_decode: "save_review_checkpoint",
    }[grant.action],
    requestId: crypto.randomUUID(),
  };
  const checkpointMetadata = grant.action === "read_recording" ? null : {
    inputSha256: grant.input.sha256, inputBytes: grant.input.bytes, artifactSha256: grant.artifact.sha256,
    bytes: grant.artifact.bytes, analysisVersion: grant.analysisVersion, chunkIndex: 0, transport: "binary-v1",
  };
  try {
    if (grant.action === "save_decode") {
      await liveSpeakingLease(db, grant.userId, grant.taskId, grant.fence);
      const body = await limitedBody(request, grant.artifact.bytes);
      if (body instanceof Response) return body;
      const result = await uploadDecodeCheckpoint(db, grant, body);
      await recordAnalysisEvent(db, {
        ...audit, outcome: result.duplicate ? "duplicate" : "ok",
        metadata: checkpointMetadata!,
      });
      return json(result, result.duplicate ? 200 : 201);
    }
    const downloaded = await downloadReviewTransfer(db, grant);
    const expected = grant.action === "read_recording" ? grant.input : grant.artifact;
    await recordAnalysisEvent(db, {
      ...audit, outcome: "ok",
      metadata: grant.action === "read_recording"
        ? { recordingId: downloaded.recordingId, offset: 0, length: expected.bytes, total: expected.bytes,
          sha256: expected.sha256, transport: "binary-v1" }
        : checkpointMetadata!,
    });
    return new Response(downloaded.data, { headers: {
      "Cache-Control": "private, no-store",
      "Content-Type": downloaded.mimeType ?? "application/octet-stream",
      "Content-Length": String(expected.bytes),
      "Content-Disposition": "attachment",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Bandroom-SHA256": expected.sha256,
    } });
  } catch (error) {
    let code = error instanceof ReviewTaskError ? error.code : "transfer_failed";
    if (grant.action === "read_recording" && code === "transfer_storage_unavailable") code = "recording_read_failed";
    const status = statuses[code] ?? 503;
    await recordAnalysisEvent(db, { ...audit, outcome: "error", metadata: { code } });
    return json({ error: code, retryable: status === 503 }, status);
  }
}

export const GET = transfer;
export const PUT = transfer;
