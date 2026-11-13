export const maxHostedRecordingBytes = 12 * 1024 * 1024;

export const createRecordingObjectTable = `CREATE TABLE IF NOT EXISTS qa_recording_objects (
  job_id TEXT PRIMARY KEY, object_key TEXT NOT NULL, mime TEXT NOT NULL, byte_length INTEGER NOT NULL
)`;

export const recordingFields = "o.object_key AS objectKey, o.byte_length AS byteLength, COALESCE(o.mime, r.mime) AS mime, r.audio";

export async function saveHostedRecording(bucket, jobId, digest, mime, bytes) {
  const key = `qa-recordings/${jobId}/${digest}`;
  await bucket.put(key, bytes, {
    onlyIf: {etagDoesNotMatch: "*"},
    httpMetadata: {contentType: mime},
    sha256: digest,
  });
  return key;
}

export function openRecording(row) {
  if (!row?.mime) return null;
  if (row.objectKey) return {key: row.objectKey, length: row.byteLength, mime: row.mime};
  const bytes = Uint8Array.from(atob(row.audio), char => char.charCodeAt(0));
  return {bytes, length: bytes.length, mime: row.mime};
}

export async function readRecordingBody(bucket, recording, range) {
  if (!recording.key) {
    return range ? recording.bytes.subarray(range.offset, range.offset + range.length) : recording.bytes;
  }
  const object = await bucket.get(recording.key, range ? {range} : undefined);
  if (!object) return null;
  if (object.size !== recording.length) {
    await object.body.cancel();
    throw new Error("Recording size does not match its binding");
  }
  return object.body;
}
