import { env } from "cloudflare:workers";
import { z } from "zod/v4";
import {
  acousticChunkIndex, acousticChunkLimit, acousticChunkManifest, acousticFeatureBytes,
  binaryManifestLimit, sha256Schema as sha,
} from "./acoustic-chunk";
import { signAnalysisGrant, verifyAnalysisGrant } from "./analysis-bundle";
import { clipLimit, hash } from "./backup-format";
import {
  getReviewTask, readReviewCheckpoint, ReviewTaskError, saveReviewCheckpoint, type ReviewTaskDb,
} from "./review-tasks";

const scope = "bandroom-review-transfer:";
const grantLifetime = 120_000;
const pcmLimit = 12 * 1024 * 1024;
export const decodeCheckpointLimit = 4 + binaryManifestLimit + pcmLimit;
export const decodeFormat = "bandroom-decode-v1";
const version = z.string().regex(/^[A-Za-z0-9._-]{1,120}$/);
const bytes = z.number().int().min(1);
const original = z.strictObject({ sha256: sha, bytes: bytes.max(clipLimit) });
const artifact = z.strictObject({ sha256: sha, bytes: bytes.max(decodeCheckpointLimit) });
const acousticArtifact = z.strictObject({ sha256: sha, bytes: bytes.max(acousticChunkLimit) });
const grantBase = {
  userId: z.string().min(1), taskId: z.string().min(1), fence: z.number().int().positive(),
  expiresAt: z.number().int(), input: original,
};
const grantSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...grantBase, action: z.literal("read_recording") }),
  z.strictObject({ ...grantBase, action: z.literal("read_decode"), artifact, analysisVersion: version }),
  z.strictObject({
    ...grantBase, action: z.literal("save_decode"), artifact, analysisVersion: version,
    expectedPointer: sha.nullable(),
  }),
  z.strictObject({
    ...grantBase, action: z.literal("read_acoustic"), artifact: acousticArtifact, analysisVersion: version,
    chunkIndex: acousticChunkIndex,
  }),
  z.strictObject({
    ...grantBase, action: z.literal("save_acoustic"), artifact: acousticArtifact, analysisVersion: version,
    chunkIndex: acousticChunkIndex, decodeSha256: sha, bundleSha256: sha, featureBytes: bytes.max(acousticChunkLimit),
    expectedPointer: sha, previousConfigSha256: sha.nullable(),
  }),
]);
export type ReviewTransferGrant = z.infer<typeof grantSchema>;
type DecodeUploadGrant = Extract<ReviewTransferGrant, { action: "save_decode" }>;
type AcousticUploadGrant = Extract<ReviewTransferGrant, { action: "save_acoustic" }>;
type UploadGrant = DecodeUploadGrant | AcousticUploadGrant;
type TransferAction = { action: "read_recording" } | { action: "read_decode" } |
  { action: "save_decode"; artifactSha256: string; bytes: number } |
  { action: "read_acoustic"; chunkIndex: number } |
  { action: "save_acoustic"; chunkIndex: number; artifactSha256: string; bytes: number };

export function isReviewUpload(grant: ReviewTransferGrant): grant is UploadGrant {
  return grant.action === "save_decode" || grant.action === "save_acoustic";
}

const manifestSchema = z.strictObject({
  format: z.literal(decodeFormat),
  analysisVersion: version,
  inputSha256: sha,
  inputBytes: bytes.max(clipLimit),
  container: z.string().min(1).max(80),
  codec: z.string().min(1).max(80).nullable(),
  sourceRateHz: bytes.nullable(),
  sourceChannels: bytes.nullable(),
  containerDurationMs: z.number().nonnegative().nullable(),
  primingMs: z.number().nonnegative().nullable(),
  pcm: z.strictObject({
    encoding: z.literal("s16le"), rateHz: z.literal(16_000), channels: z.literal(1),
    sampleCount: bytes.max(pcmLimit / 2), sha256: sha,
  }),
  mediaTime: z.strictObject({ originMs: z.literal(0), samplesPerSecond: z.literal(16_000) }),
});

function failure(code: string, message: string): never {
  throw new ReviewTaskError(code, message);
}

function runtimeBundleSha256(): string {
  const digest = env.ANALYSIS_RUNTIME_BUNDLE_SHA256;
  if (!digest || !sha.safeParse(digest).success)
    return failure("transfer_unconfigured", "The pinned runtime bundle digest is not configured.");
  return digest;
}

export async function liveSpeakingLease(db: ReviewTaskDb, userId: string, taskId: string, fence: number) {
  const task = await getReviewTask(db, userId, taskId);
  if (!task) return failure("task_not_found", "The task is not available to this account.");
  if (task.kind !== "speaking" || !task.recordingId)
    return failure("not_speaking", "Only speaking tasks with a recording can transfer audio.");
  if (task.state !== "running" || task.fence !== fence || (task.leaseUntil ?? 0) <= Date.now())
    return failure("stale_lease", "The task lease is no longer current.");
  return { ...task, leaseUntil: task.leaseUntil!, recordingId: task.recordingId };
}

function recordingKey(userId: string, recordingId: string) {
  return `speaking/${encodeURIComponent(userId)}/${recordingId}`;
}

function checkpointKey(grant: Pick<ReviewTransferGrant, "userId" | "taskId">, digest: string) {
  return `review-checkpoints/${encodeURIComponent(grant.userId)}/${encodeURIComponent(grant.taskId)}/${digest}`;
}

async function storage<T>(operation: () => Promise<T>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ReviewTaskError) throw error;
    return failure("transfer_storage_unavailable", "Private storage is temporarily unavailable.");
  }
}

function bucket() {
  return env.BUCKET ?? failure("transfer_storage_unavailable", "Private storage is unavailable.");
}

function sourceIdentity(file: R2Object) {
  const value = original.safeParse({ sha256: file.customMetadata?.digest, bytes: file.size });
  if (!value.success)
    return failure("recording_integrity_unavailable", "The original recording has no valid stored identity.");
  return value.data;
}

function assertSameInput(current: z.infer<typeof original>, expected: z.infer<typeof original>) {
  if (current.sha256 !== expected.sha256 || current.bytes !== expected.bytes)
    return failure("recording_changed", "The original recording differs from the bound input.");
}

async function assertBoundRecording(
  db: ReviewTaskDb, userId: string, reviewJobId: string, current: z.infer<typeof original>,
) {
  const row = await db.prepare("SELECT snapshot FROM review_jobs WHERE id=? AND user_id=?")
    .bind(reviewJobId, userId).first<{ snapshot: string }>();
  if (!row) return failure("snapshot_invalid", "The immutable submission snapshot is unavailable.");
  const identity = JSON.parse(row.snapshot).recording;
  if (identity === undefined) return;
  const bound = original.safeParse(identity);
  if (!bound.success) return failure("snapshot_invalid", "The submission has an invalid recording identity.");
  assertSameInput(current, bound.data);
}

async function committedDecode(db: ReviewTaskDb, userId: string, taskId: string, fence: number) {
  const saved = await readReviewCheckpoint(db, userId, { taskId, fence, stage: "decode", chunkIndex: 0 });
  const manifest = manifestSchema.safeParse(saved?.payload);
  if (!saved || !manifest.success || saved.objectRef !== checkpointKey({ userId, taskId }, saved.artifactSha256))
    return failure("checkpoint_missing", "No verified decoded audio is available to resume.");
  if (saved.inputSha256 !== manifest.data.inputSha256 || saved.analysisVersion !== manifest.data.analysisVersion)
    return failure("invalid_decode_checkpoint", "The stored manifest differs from its committed identity.");
  return { ...saved, input: { sha256: saved.inputSha256, bytes: manifest.data.inputBytes },
    sampleCount: manifest.data.pcm.sampleCount };
}

async function committedAcoustic(db: ReviewTaskDb, base: Pick<ReviewTransferGrant, "userId" | "taskId" | "fence">,
  decode: Awaited<ReturnType<typeof committedDecode>>, index: number) {
  const saved = await readReviewCheckpoint(db, base.userId, { ...base, stage: "acoustic", chunkIndex: index });
  if (!saved) return null;
  const manifest = acousticChunkManifest.safeParse(saved.payload);
  if (!manifest.success || manifest.data.chunkIndex !== index || manifest.data.decodeSha256 !== decode.artifactSha256
    || saved.inputSha256 !== decode.inputSha256 || saved.analysisVersion !== decode.analysisVersion
    || saved.objectRef !== checkpointKey(base, saved.artifactSha256))
    return failure("invalid_acoustic_checkpoint", "The committed acoustic chunk does not match the decoded input.");
  return { ...saved, manifest: manifest.data };
}

async function issueAcousticGrant(db: ReviewTaskDb, base: Pick<ReviewTransferGrant, "userId" | "taskId" | "fence" | "expiresAt">,
  task: Awaited<ReturnType<typeof liveSpeakingLease>>,
  request: Extract<TransferAction, { action: "read_acoustic" | "save_acoustic" }>): Promise<ReviewTransferGrant> {
  const { userId, taskId, fence } = base;
  const decode = await committedDecode(db, userId, taskId, fence);
  await assertBoundRecording(db, userId, task.reviewJobId, decode.input);
  const { chunkIndex } = request;
  const featureBytes = acousticFeatureBytes(decode.sampleCount, chunkIndex);
  if (!featureBytes) return failure("invalid_acoustic_checkpoint", "The acoustic chunk is outside the decoded timeline.");
  const saved = await committedAcoustic(db, base, decode, chunkIndex);
  const binding = { ...base, input: decode.input, analysisVersion: decode.analysisVersion, chunkIndex };
  if (request.action === "read_acoustic") {
    if (!saved) return failure("checkpoint_missing", "The requested acoustic chunk has not been committed.");
    return { ...binding, action: request.action, artifact: { sha256: saved.artifactSha256, bytes: saved.bytes } };
  }
  if (saved && (saved.artifactSha256 !== request.artifactSha256 || saved.bytes !== request.bytes))
    return failure("artifact_conflict", "A different acoustic chunk was already committed.");
  const previous = chunkIndex === 0 ? null : await committedAcoustic(db, base, decode, chunkIndex - 1);
  if (chunkIndex !== 0 && !previous)
    return failure("checkpoint_missing", "Commit the preceding acoustic chunk before advancing.");
  const expectedPointer = previous?.artifactSha256 ?? decode.artifactSha256;
  if (!saved && (task.stage !== (previous ? "acoustic" : "decode") || task.checkpointSha256 !== expectedPointer))
    return failure("checkpoint_advanced", "The task pointer no longer matches the preceding checkpoint.");
  const bundleSha256 = saved?.manifest.bundleSha256 ?? previous?.manifest.bundleSha256 ?? runtimeBundleSha256();
  return {
    ...binding, action: request.action, artifact: { sha256: request.artifactSha256, bytes: request.bytes },
    decodeSha256: decode.artifactSha256, bundleSha256, featureBytes, expectedPointer,
    previousConfigSha256: saved?.manifest.configSha256 ?? previous?.manifest.configSha256 ?? null,
  };
}

export async function issueReviewTransfer(db: ReviewTaskDb, userId: string, taskId: string, fence: number, request: TransferAction) {
  const task = await liveSpeakingLease(db, userId, taskId, fence);
  const secret = env.ANALYSIS_SIGNING_KEY;
  const origin = env.BANDROOM_PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (!secret || secret.length < 32 || !origin || !/^https:\/\/[^/?#@]+$/.test(origin))
    return failure("transfer_unconfigured", "The private binary transfer endpoint is not configured.");
  const base = { userId, taskId, fence, expiresAt: Math.min(task.leaseUntil, Date.now() + grantLifetime) };
  let grant: ReviewTransferGrant;
  if (request.action === "read_acoustic" || request.action === "save_acoustic") {
    grant = await issueAcousticGrant(db, base, task, request);
  } else if (request.action === "read_decode") {
    const saved = await committedDecode(db, userId, taskId, fence);
    grant = {
      ...base, action: request.action, analysisVersion: saved.analysisVersion,
      input: saved.input,
      artifact: { sha256: saved.artifactSha256, bytes: saved.bytes },
    };
  } else {
    const file = await storage(() => bucket().head(recordingKey(userId, task.recordingId)));
    if (!file) return failure("recording_missing", "The original recording is unavailable.");
    const input = sourceIdentity(file);
    await assertBoundRecording(db, userId, task.reviewJobId, input);
    if (request.action === "read_recording") {
      grant = { ...base, action: request.action, input };
    } else {
      const analysisVersion = version.safeParse(task.analysisVersion ?? env.ANALYSIS_BUNDLE_VERSION);
      if (!analysisVersion.success)
        return failure("bundle_version_missing", "No valid analysis version is configured for this task.");
      if (task.stage !== "read_input" && task.stage !== "decode")
        return failure("checkpoint_advanced", "The task has moved beyond decoding.");
      grant = {
        ...base, action: request.action, input, analysisVersion: analysisVersion.data,
        expectedPointer: task.checkpointSha256, artifact: { sha256: request.artifactSha256, bytes: request.bytes },
      };
    }
  }
  await liveSpeakingLease(db, userId, taskId, fence);
  return {
    url: `${origin}/api/review-transfer`,
    method: isReviewUpload(grant) ? "PUT" : "GET",
    authorization: `Bearer ${await signAnalysisGrant(secret, grantSchema.parse(grant), scope)}`,
    expiresAt: grant.expiresAt,
    input: grant.input,
    ...(grant.action !== "read_recording" && { artifact: grant.artifact, analysisVersion: grant.analysisVersion }),
    ...("chunkIndex" in grant && { chunkIndex: grant.chunkIndex }),
  };
}

export async function authenticateReviewTransfer(request: Request) {
  const authorization = request.headers.get("Authorization");
  const secret = env.ANALYSIS_SIGNING_KEY;
  const origin = env.BANDROOM_PUBLIC_ORIGIN?.replace(/\/$/, "");
  if (!secret || secret.length < 32 || request.headers.has("Origin")
    || new URL(request.url).origin !== origin || !authorization?.startsWith("Bearer ")) return null;
  const parsed = grantSchema.safeParse(await verifyAnalysisGrant(secret, authorization.slice(7), scope));
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
  const expectedMethod = isReviewUpload(parsed.data) ? "PUT" : "GET";
  return request.method === expectedMethod ? parsed.data : null;
}

function checkGrantExpiry(grant: ReviewTransferGrant) {
  if (grant.expiresAt <= Date.now()) failure("transfer_expired", "The transfer grant has expired.");
}

export async function downloadReviewTransfer(db: ReviewTaskDb, grant: Exclude<ReviewTransferGrant, UploadGrant>) {
  const task = await liveSpeakingLease(db, grant.userId, grant.taskId, grant.fence);
  const isOriginal = grant.action === "read_recording";
  const expected = isOriginal ? grant.input : grant.artifact;
  const key = isOriginal ? recordingKey(grant.userId, task.recordingId) : checkpointKey(grant, expected.sha256);
  const file = await storage(() => bucket().get(key));
  if (!file) return failure(isOriginal ? "recording_missing" : "checkpoint_object_missing", "The private object is unavailable.");
  if (isOriginal) assertSameInput(sourceIdentity(file), expected);
  if (file.size !== expected.bytes)
    return failure("transfer_integrity_failed", "The object size differs from its committed size.");
  const data = await storage(() => file.arrayBuffer());
  if (data.byteLength !== expected.bytes || await hash(data) !== expected.sha256)
    return failure("transfer_integrity_failed", "The object bytes differ from the committed digest.");
  await liveSpeakingLease(db, grant.userId, grant.taskId, grant.fence);
  checkGrantExpiry(grant);
  return { data, recordingId: task.recordingId, mimeType: isOriginal ? file.httpMetadata?.contentType : undefined };
}

async function parseCheckpointBody(body: Uint8Array<ArrayBuffer>, grant: UploadGrant) {
  if (body.length !== grant.artifact.bytes || await hash(body) !== grant.artifact.sha256)
    return failure("transfer_integrity_failed", "The uploaded bytes differ from the authorized digest.");
  const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const manifestBytes = body.length > 4 ? view.getUint32(0) : 0;
  const code = grant.action === "save_decode" ? "invalid_decode_checkpoint" : "invalid_acoustic_checkpoint";
  if (manifestBytes === 0 || manifestBytes > binaryManifestLimit || 4 + manifestBytes >= body.length)
    return failure(code, "The checkpoint manifest length is invalid.");
  let raw: unknown;
  let manifestJson: string;
  try {
    manifestJson = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(4, 4 + manifestBytes));
    raw = JSON.parse(manifestJson);
  } catch {
    return failure(code, "The checkpoint manifest is unreadable.");
  }
  return { raw, manifestJson, manifestBytes, data: body.subarray(4 + manifestBytes) };
}

async function parseDecodeCheckpoint(body: Uint8Array<ArrayBuffer>, grant: DecodeUploadGrant) {
  const { raw, data: pcm } = await parseCheckpointBody(body, grant);
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.analysisVersion !== grant.analysisVersion
    || parsed.data.inputSha256 !== grant.input.sha256 || parsed.data.inputBytes !== grant.input.bytes
    || pcm.length !== parsed.data.pcm.sampleCount * 2 || await hash(pcm) !== parsed.data.pcm.sha256)
    return failure("invalid_decode_checkpoint", "The manifest and PCM do not match the authorized input and timeline.");
  return parsed.data;
}

async function storeCheckpoint(grant: UploadGrant, body: Uint8Array<ArrayBuffer>) {
  const store = bucket();
  const { artifact } = grant;
  const key = checkpointKey(grant, artifact.sha256);
  checkGrantExpiry(grant);
  const stored = await storage(() => store.put(key, body, {
    onlyIf: { etagDoesNotMatch: "*" }, sha256: artifact.sha256,
    customMetadata: { digest: artifact.sha256 }, httpMetadata: { contentType: "application/octet-stream" },
  }));
  const verified = stored ?? await storage(() => store.head(key));
  if (verified?.size !== artifact.bytes || verified.customMetadata?.digest !== artifact.sha256)
    return failure("transfer_integrity_failed", "Private storage could not verify the checkpoint artifact.");
  checkGrantExpiry(grant);
  return key;
}

export async function uploadDecodeCheckpoint(db: ReviewTaskDb, grant: DecodeUploadGrant, body: Uint8Array<ArrayBuffer>) {
  const { userId, taskId, fence, analysisVersion, expectedPointer, artifact } = grant;
  const manifest = await parseDecodeCheckpoint(body, grant);
  const task = await liveSpeakingLease(db, userId, taskId, fence);
  const store = bucket();
  const file = await storage(() => store.head(recordingKey(userId, task.recordingId)));
  if (!file) return failure("recording_missing", "The original recording is unavailable.");
  assertSameInput(sourceIdentity(file), grant.input);
  await assertBoundRecording(db, userId, task.reviewJobId, grant.input);
  const existing = await readReviewCheckpoint(db, userId, { taskId, fence, stage: "decode", chunkIndex: 0 });
  const key = checkpointKey(grant, artifact.sha256);
  if (existing?.payload.format === decodeFormat && existing.objectRef !== key)
    return failure("artifact_conflict", "A different decoded artifact was already committed.");
  if (task.checkpointSha256 !== expectedPointer && existing?.objectRef !== key)
    return failure("checkpoint_advanced", "The checkpoint changed before this write committed.");
  await storeCheckpoint(grant, body);
  return saveReviewCheckpoint(db, userId, {
    taskId, fence, analysisVersion, stage: "decode", chunkIndex: 0,
    inputSha256: grant.input.sha256, artifactSha256: artifact.sha256, bytes: artifact.bytes,
    objectRef: key, payload: manifest, expectedDecodePointer: expectedPointer,
  });
}

export async function uploadAcousticCheckpoint(db: ReviewTaskDb, grant: AcousticUploadGrant, body: Uint8Array<ArrayBuffer>) {
  const { userId, taskId, fence, analysisVersion, chunkIndex, artifact } = grant;
  const { raw, manifestJson, manifestBytes, data: features } = await parseCheckpointBody(body, grant);
  const manifest = acousticChunkManifest.safeParse(raw);
  if (!manifest.success || manifest.data.chunkIndex !== chunkIndex
    || manifest.data.decodeSha256 !== grant.decodeSha256 || manifest.data.previousSha256 !== grant.expectedPointer
    || manifest.data.bundleSha256 !== grant.bundleSha256
    || (grant.previousConfigSha256 !== null && manifest.data.configSha256 !== grant.previousConfigSha256)
    || features.length !== grant.featureBytes || await hash(features) !== manifest.data.featuresSha256)
    return failure("invalid_acoustic_checkpoint", "The features do not match the authorized chunk, input or predecessor.");
  const canonical = JSON.stringify(manifest.data, Object.keys(manifest.data).sort());
  if (manifestJson !== canonical || manifestBytes !== canonical.length)
    return failure("invalid_acoustic_checkpoint", "The acoustic chunk manifest is not canonical.");
  await liveSpeakingLease(db, userId, taskId, fence);
  const key = await storeCheckpoint(grant, body);
  return saveReviewCheckpoint(db, userId, {
    taskId, fence, analysisVersion, stage: "acoustic", chunkIndex, inputSha256: grant.input.sha256,
    artifactSha256: artifact.sha256, bytes: artifact.bytes, objectRef: key, payload: manifest.data,
    expectedAcousticPointer: { stage: chunkIndex === 0 ? "decode" : "acoustic", sha256: grant.expectedPointer },
  });
}

export async function requireDecodedInput(
  db: ReviewTaskDb, userId: string, taskId: string, fence: number,
  input: z.infer<typeof original>, analysisVersion: string,
) {
  const saved = await readReviewCheckpoint(db, userId, { taskId, fence, stage: "decode", chunkIndex: 0 });
  const manifest = manifestSchema.safeParse(saved?.payload);
  if (!saved || !manifest.success || saved.objectRef !== checkpointKey({ userId, taskId }, saved.artifactSha256))
    return failure("checkpoint_missing", "Speaking feedback requires a committed decoded audio object.");
  if (saved.analysisVersion !== analysisVersion || manifest.data.analysisVersion !== analysisVersion)
    return failure("analysis_version_mismatch", "The result and decoded audio use different analysis versions.");
  if (saved.inputSha256 !== input.sha256 || manifest.data.inputSha256 !== input.sha256 || manifest.data.inputBytes !== input.bytes)
    return failure("recording_mismatch", "The result and decoded audio refer to different recordings.");
  const used = await db.prepare(`SELECT 1 FROM analysis_events
    WHERE task_id=? AND fence=? AND event IN ('save_review_checkpoint','read_review_checkpoint')
    AND outcome IN ('ok','duplicate') AND json_extract(metadata_json,'$.transport')='binary-v1'
    AND json_extract(metadata_json,'$.artifactSha256')=? LIMIT 1`)
    .bind(taskId, fence, saved.artifactSha256).first();
  if (!used) return failure("checkpoint_not_read", "Restore the committed decoded audio under the current lease before completing.");
  return manifest.data.pcm.sampleCount;
}
