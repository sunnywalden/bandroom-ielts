// analysis_artifacts has no user_id column (design rev2 FIX-22 / MJ-19).
// Isolation is indirect: analysis_artifacts.task_id -> review_tasks.id and
// review_tasks.user_id. Every read of artifacts must therefore join through
// review_tasks and constrain the authenticated user. Do not query
// analysis_artifacts by task_id alone on a request path.
type Prepared = {
  bind(...values: unknown[]): Prepared;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results?: T[] }>;
};

export type ArtifactScopeDb = { prepare(query: string): Prepared };

export type ScopedAnalysisArtifact = {
  taskId: string;
  stage: string;
  chunkIndex: number;
  analyzerVersion: string;
  inputSha256: string;
  artifactSha256: string;
  bytes: number;
  objectRef: string | null;
  payload: Record<string, unknown>;
  createdAt: number;
};

const scopedArtifactQuery = `SELECT a.task_id AS taskId, a.stage, a.chunk_index AS chunkIndex,
  a.analyzer_version AS analyzerVersion, a.input_sha256 AS inputSha256,
  a.artifact_sha256 AS artifactSha256, a.bytes, a.object_ref AS objectRef,
  a.payload_json AS payload, a.created_at AS createdAt
  FROM analysis_artifacts a
  JOIN review_tasks t ON t.id = a.task_id
  WHERE a.task_id = ? AND t.user_id = ?`;

/**
 * Read artifacts for one task only when that task belongs to the authenticated
 * user. Another user's taskId returns an empty list rather than leaking whether
 * the artifact exists.
 */
export async function readAnalysisArtifactsForUser(
  db: ArtifactScopeDb, userId: string, taskId: string,
): Promise<ScopedAnalysisArtifact[]> {
  if (typeof userId !== "string" || !userId) return [];
  const result = await db.prepare(`${scopedArtifactQuery} ORDER BY a.stage, a.chunk_index, a.analyzer_version`)
    .bind(taskId, userId).all();
  return (result.results ?? []).map(row => ({
    taskId: String(row.taskId),
    stage: String(row.stage),
    chunkIndex: Number(row.chunkIndex),
    analyzerVersion: String(row.analyzerVersion),
    inputSha256: String(row.inputSha256),
    artifactSha256: String(row.artifactSha256),
    bytes: Number(row.bytes),
    objectRef: row.objectRef == null ? null : String(row.objectRef),
    payload: typeof row.payload === "string"
      ? JSON.parse(row.payload) as Record<string, unknown>
      : (row.payload ?? {}) as Record<string, unknown>,
    createdAt: Number(row.createdAt),
  }));
}

/** True only when the task row belongs to this user; used before writing artifacts. */
export async function taskBelongsToUser(
  db: ArtifactScopeDb, userId: string, taskId: string,
): Promise<boolean> {
  if (typeof userId !== "string" || !userId) return false;
  const row = await db.prepare("SELECT 1 AS ok FROM review_tasks WHERE id=? AND user_id=?")
    .bind(taskId, userId).first();
  return Boolean(row);
}