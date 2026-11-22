// P0-6: durable upload queue for recorded takes.
//
// A take is keyed by (account, day, phase, content hash) so the same bytes are
// never uploaded twice, even after a refresh or a second submit. The upload id
// returned by the server is written to the `done` store BEFORE the pending task
// is removed, so a crash cannot lose the mapping. Tasks are account-scoped;
// account switching clears the queue through clearUploadQueue().
import type { AudioPhase, RecordingDraft } from './speaking-draft';

export type UploadFn = (draft: RecordingDraft, account: string, day: number, phase: AudioPhase) => Promise<string>;
export type QueueState = 'pending' | 'uploading' | 'failed';

type Task = {
  key: string;
  account: string;
  day: number;
  phase: AudioPhase;
  attemptId: string;
  hash: string;
  at: string;
  status: QueueState;
  attempts: number;
  nextAt: number;
  blob: Blob;
};
type Done = { audioId: string; at: string };

const DB_NAME = 'ielts-speaking-uploads';
const TASKS = 'tasks';
const DONE = 'done';
const inflight = new Map<string, Promise<string>>();

// Storage failures must be distinguishable from upload failures: callers can
// fall back to a direct upload when the queue itself is unavailable, but must
// not blindly re-upload when the server already rejected the request.
function storageError(message: string) {
  const error = Error(message);
  error.name = 'QueueStorageError';
  return error;
}
export function isQueueStorageError(error: unknown) {
  return error instanceof Error && error.name === 'QueueStorageError';
}

export function queueKey(account: string, day: number, phase: AudioPhase, hash: string) {
  return `${account}\u0000${day}\u0000${phase}\u0000${hash}`;
}
export function backoffMs(attempts: number) {
  return Math.min(300_000, 2_000 * 2 ** Math.max(0, attempts - 1));
}

export async function hashBlob(blob: Blob): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle is unavailable on some non-secure origins. This fallback is
    // only a dedupe key, never a security boundary.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let hash = 0x811c9dc5;
    for (const byte of bytes) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
    return `fnv-${(hash >>> 0).toString(16)}-${bytes.length}`;
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, db?: IDBDatabase) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { db?.close(); reject(storageError(error instanceof Error ? error.message : '上传队列存储不可用')); } else resolve(db as IDBDatabase);
    };
    const timer = setTimeout(() => finish(storageError('上传队列存储超时')), 2500);
    try {
      if (typeof indexedDB === 'undefined') { finish(storageError('上传队列在本浏览器不可用')); return; }
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains(TASKS)) db.createObjectStore(TASKS);
        if (!db.objectStoreNames.contains(DONE)) db.createObjectStore(DONE);
      };
      open.onerror = () => finish(open.error || storageError('上传队列存储不可用'));
      open.onblocked = () => finish(storageError('上传队列存储被阻塞'));
      open.onsuccess = () => finish(undefined, open.result);
    } catch (error) { finish(error); }
  });
}

function transaction<T>(mode: IDBTransactionMode, work: (stores: { tasks: IDBObjectStore; done: IDBObjectStore }) => IDBRequest<T> | void): Promise<T | undefined> {
  return openDb().then(db => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: T) => {
      if (settled) return;
      settled = true; clearTimeout(timer); db.close();
      if (error) reject(storageError(error instanceof Error ? error.message : '上传队列操作失败')); else resolve(value);
    };
    const timer = setTimeout(() => finish(storageError('上传队列操作超时')), 2500);
    try {
      const tx = db.transaction([TASKS, DONE], mode);
      const result = work({ tasks: tx.objectStore(TASKS), done: tx.objectStore(DONE) });
      let value: T | undefined;
      if (result) result.onsuccess = () => { value = result.result as T; };
      tx.oncomplete = () => finish(undefined, value);
      tx.onabort = tx.onerror = () => finish(tx.error || storageError('上传队列操作失败'));
    } catch (error) { finish(error); }
  }));
}

async function readDone(key: string) {
  return await transaction<Done>('readonly', ({ done }) => done.get(key) as IDBRequest<Done>);
}
async function putTask(task: Task) {
  await transaction('readwrite', ({ tasks }) => { tasks.put(task, task.key); });
}

async function flush(key: string, upload: UploadFn): Promise<string> {
  const task = await transaction<Task>('readonly', ({ tasks }) => tasks.get(key) as IDBRequest<Task>);
  if (!task) {
    const done = await readDone(key);
    if (done?.audioId) return done.audioId;
    throw Error('上传任务已不存在，请重新提交录音。');
  }
  await putTask({ ...task, status: 'uploading' });
  try {
    const audioId = await upload({ id: task.attemptId, at: task.at, blob: task.blob }, task.account, task.day, task.phase);
    if (!audioId) throw Error('上传结果尚未确认。请再次提交同一份录音。');
    await transaction('readwrite', ({ tasks, done }) => {
      done.put({ audioId, at: new Date().toISOString() } satisfies Done, key);
      tasks.delete(key);
    });
    return audioId;
  } catch (error) {
    const attempts = task.attempts + 1;
    await putTask({ ...task, status: 'failed', attempts, nextAt: Date.now() + backoffMs(attempts) }).catch(() => {});
    throw error;
  }
}

export async function queueRecording(draft: RecordingDraft, account: string, day: number, phase: AudioPhase, upload: UploadFn): Promise<string> {
  if (!draft.blob) {
    if (draft.audio) return draft.audio;
    throw Error('找不到可提交的录音，请重新打开本题草稿。');
  }
  const hash = await hashBlob(draft.blob);
  const key = queueKey(account, day, phase, hash);
  const done = await readDone(key);
  if (done?.audioId) return done.audioId;
  const running = inflight.get(key);
  if (running) return running;
  const promise = (async () => {
    const existing = await transaction<Task>('readonly', ({ tasks }) => tasks.get(key) as IDBRequest<Task>);
    await putTask({
      key, account, day, phase, attemptId: draft.id, hash, at: draft.at,
      status: 'pending', attempts: existing?.attempts ?? 0,
      nextAt: existing?.nextAt ?? 0, blob: draft.blob as Blob,
    });
    return flush(key, upload);
  })().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// Called on mount, `online`, and `visibilitychange`. Stale `uploading` tasks
// are retried because no upload can outlive the page that started it.
export async function retryPending(account: string, upload: UploadFn, options: { force?: boolean } = {}) {
  const tasks = await transaction<Task[]>('readonly', ({ tasks }) => tasks.getAll() as IDBRequest<Task[]>);
  const now = Date.now();
  const due = (tasks ?? []).filter(task => task.account === account
    && (options.force || task.status === 'uploading' || task.nextAt <= now));
  await Promise.all(due.map(task => inflight.get(task.key) ?? (async () => {
    const promise = flush(task.key, upload).finally(() => inflight.delete(task.key));
    inflight.set(task.key, promise);
    return promise;
  })().catch(() => '')));
  return due.length;
}

export async function pendingCount(account?: string) {
  const tasks = await transaction<Task[]>('readonly', ({ tasks }) => tasks.getAll() as IDBRequest<Task[]>);
  return (tasks ?? []).filter(task => !account || task.account === account).length;
}

/** Returns the server audio id already confirmed for these exact bytes, if any. */
export async function queuedAudio(account: string, day: number, phase: AudioPhase, blob: Blob): Promise<string | undefined> {
  try {
    const done = await readDone(queueKey(account, day, phase, await hashBlob(blob)));
    return done?.audioId;
  } catch { return undefined; }
}

/**
 * Drops staged bytes for a take the learner removed. An in-flight upload is
 * left alone so a concurrent submit cannot be cancelled half-way; its `done`
 * mapping is harmless.
 */
export async function discardQueued(account: string, day: number, phase: AudioPhase, blob: Blob): Promise<boolean> {
  try {
    const key = queueKey(account, day, phase, await hashBlob(blob));
    if (inflight.has(key)) return false;
    await transaction('readwrite', ({ tasks }) => { tasks.delete(key); });
    return true;
  } catch { return false; }
}

export async function clearUploadQueue(): Promise<boolean> {
  try {
    await transaction('readwrite', ({ tasks, done }) => { tasks.clear(); done.clear(); });
    return true;
  } catch { return false; }
}
