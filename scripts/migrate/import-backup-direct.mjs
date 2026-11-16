#!/usr/bin/env node
// Direct backup import (formats 1-4) for the owner-authorized one-time migration.
//
//   node scripts/migrate/import-backup-direct.mjs --backup <file.bandroom> \
//     --user-id <originalUserId> [--out <dir>] \
//     [--execute --database <d1name> --bucket <r2name>]
//
// The archive is the owner's own export, so provenance is checked with
// manifest.owner == sha256(userId) instead of the old BANDROOM_BACKUP_KEY HMAC.
// Dry-run writes import.sql, audio/, r2-upload.sh and report.json. --execute
// applies the SQL through `wrangler d1 execute` and uploads each recording with
// `wrangler r2 object put` (credentials are external to this tool).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  buildImportSql,
  deterministicUuid,
  rebuildableJobs,
} from "./export-import.mjs";

export const MAGIC = Buffer.from("BANDROOM1\n");
export const METADATA_LIMIT = 8 * 1024 * 1024;
export const CLIP_LIMIT = 12 * 1024 * 1024;

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const AUDIO_TYPE = /^audio\/[\w.+-]+$/;
const SHA256 = /^[a-f\d]{64}$/i;

const TABLES = {
  learner_states: ["user_id", "revision", "state"],
  teacher_feedback: [
    "user_id", "id", "day", "stage", "attempt", "evidence", "feedback",
    "created_at", "review_task_id", "pronunciation", "analysis_json",
  ],
  teacher_lessons: ["user_id", "day", "lesson"],
  review_jobs: [
    "user_id", "id", "day", "submission_key", "request_hash", "revision",
    "snapshot", "created_at",
  ],
  // Format 4 (design rev2 §8/FIX-16). calibration_events.id is intentionally
  // omitted so the import cannot collide with an existing event id; the stable
  // identity is (user_id, attempt_id, candidate_id).
  personal_calibration: [
    "user_id", "expected", "actual", "n_confirmed", "n_rejected", "n_unsure",
    "n_shown", "state", "rule_version", "detector_version", "inventory_version",
    "updated_at",
  ],
  calibration_candidates: [
    "candidate_id", "user_id", "attempt_id", "recording_id", "word", "expected",
    "actual", "at_ms", "detector_confidence", "shown_at", "answered_at",
  ],
  calibration_events: [
    "user_id", "attempt_id", "candidate_id", "expected", "actual", "verdict",
    "is_catch_trial", "created_at",
  ],
};

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function ownerTag(userId) {
  return sha256Hex(Buffer.from(userId, "utf8"));
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Cannot serialize non-finite number ${value}.`);
    }
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) return `X'${Buffer.from(value).toString("hex")}'`;
  if (typeof value === "object") return quote(JSON.stringify(value));
  return quote(value);
}

function insertStatements(name, rows, chunkSize = 50) {
  if (!rows.length) return [];
  const columns = TABLES[name];
  const statements = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values = chunk
      .map((row) => `(${columns.map((column) => literal(row[column])).join(",")})`)
      .join(",\n  ");
    statements.push(
      `INSERT INTO ${name} (${columns.join(", ")}) VALUES\n  ${values}\nON CONFLICT DO NOTHING;`,
    );
  }
  return statements;
}

/** Parse the BANDROOM1 header exactly like lib/backup-format.ts unpack(). */
export function parseBackup(bytes) {
  const file = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const start = MAGIC.length + 4;
  if (file.length < start || !file.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("文件不是 Bandroom 备份。");
  }
  const length = file.readUInt32BE(MAGIC.length);
  if (!length || length > METADATA_LIMIT || start + length > file.length) {
    throw new Error("备份头部损坏。");
  }
  let header;
  try {
    header = JSON.parse(file.subarray(start, start + length).toString("utf8"));
  } catch {
    throw new Error("备份头部损坏。");
  }
  return { header, start, length };
}

/** Validate the manifest envelope and the media/device index pairing. */
export function validateManifest(header) {
  const manifest = header?.signed?.manifest;
  if (
    !manifest ||
    ![1, 2, 3, 4].includes(manifest.format) ||
    (manifest.format >= 2 && !Array.isArray(manifest.reviewJobs)) ||
    (manifest.format >= 4 && (
      !Array.isArray(manifest.personalCalibration) ||
      !Array.isArray(manifest.calibrationCandidates) ||
      !Array.isArray(manifest.calibrationEvents)
    )) ||
    !Array.isArray(manifest.audio) ||
    !Array.isArray(manifest.feedback) ||
    !Array.isArray(manifest.lessons) ||
    !Array.isArray(manifest.local) ||
    !Array.isArray(header.device) ||
    header.device.length !== manifest.local.length ||
    header.device.some((clip, index) => clip?.id !== manifest.local[index])
  ) {
    throw new Error("备份格式无效。");
  }
  return manifest;
}

function checkClip(clip) {
  if (
    !clip ||
    !UUID.test(clip.id) ||
    !Number.isSafeInteger(clip.size) ||
    clip.size <= 0 ||
    clip.size > CLIP_LIMIT ||
    !AUDIO_TYPE.test(clip.type) ||
    !SHA256.test(clip.hash)
  ) {
    throw new Error("备份录音信息无效。");
  }
}

function audioFileName(index, clip) {
  const subtype = String(clip.type).split("/")[1] ?? "bin";
  const extension = subtype.split(";")[0].replace(/[^a-z0-9.+-]/gi, "") || "bin";
  return `${String(index).padStart(3, "0")}-${clip.id}.${extension}`;
}

function recordingKey(userId, id) {
  return `speaking/${encodeURIComponent(userId)}/${id}`;
}

/**
 * Parse the archive, verify owner provenance and every recording SHA-256.
 * Blob order is media first, then device, matching unpack().
 */
export function inspectBackup(bytes, options = {}) {
  const file = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const { header, start, length } = parseBackup(file);
  const manifest = validateManifest(header);
  if (typeof options.userId !== "string" || !options.userId) {
    throw new Error("--user-id is required.");
  }
  const expected = ownerTag(options.userId);
  const actual = manifest.owner;
  if (typeof actual !== "string" || actual.toLowerCase() !== expected) {
    throw new Error(
      `备份 owner 校验失败：该备份不属于 userId ${options.userId}（owner ${actual ?? "missing"}）。`,
    );
  }

  const clips = [
    ...manifest.audio.map((clip) => ({ clip, kind: "cloud" })),
    ...header.device.map((clip) => ({ clip, kind: "device" })),
  ];
  let offset = start + length;
  const audio = [];
  for (const [index, { clip, kind }] of clips.entries()) {
    checkClip(clip);
    if (offset + clip.size > file.length) {
      throw new Error("备份文件不完整或含有多余内容。");
    }
    const data = file.subarray(offset, offset + clip.size);
    offset += clip.size;
    const actualHash = sha256Hex(data);
    if (actualHash.toLowerCase() !== clip.hash.toLowerCase()) {
      throw new Error(`录音校验失败：${clip.id} 的 SHA-256 与 manifest 不符。`);
    }
    audio.push({
      kind,
      id: clip.id,
      type: clip.type,
      size: clip.size,
      declaredHash: clip.hash,
      actualHash,
      key: recordingKey(options.userId, clip.id),
      file: audioFileName(index, clip),
      bytes: data,
    });
  }
  if (offset !== file.length) {
    throw new Error("备份文件不完整或含有多余内容。");
  }
  return { header, manifest, audio };
}

function rebuildTasks(manifest, options) {
  // Reuse export-import.mjs's rebuild semantics by feeding it a snapshot with
  // the backup's jobs/feedback and no runtime rows. It returns exactly the
  // queued review_tasks rows for jobs that have no feedback.
  const snapshot = {
    tables: {
      review_jobs: {
        rows: (manifest.reviewJobs ?? []).map((job) => ({
          id: job.id,
          user_id: options.userId,
          day: job.day,
          revision: job.revision,
          snapshot: job.snapshot,
        })),
      },
      teacher_feedback: {
        rows: (manifest.feedback ?? []).map((row) => ({
          id: row.id,
          user_id: options.userId,
          attempt: row.attempt,
        })),
      },
      review_tasks: { rows: [] },
      review_receipts: { rows: [] },
    },
  };
  const built = buildImportSql(snapshot, { now: options.now });
  const statements = built.statements.filter((statement) =>
    statement.startsWith("INSERT INTO review_tasks"),
  );
  const jobs = rebuildableJobs(snapshot);
  const ids = jobs.map((job) =>
    deterministicUuid(`bandroom:migrate:review_task:${job.id}`),
  );
  if (ids.length !== built.summary.rebuiltTasks) {
    throw new Error("review_tasks rebuild count mismatch.");
  }
  return { statements, jobs, ids };
}

/** Build the idempotent learner-table SQL and the pending-task rebuild. */
export function buildDirectImportSql(manifest, options = {}) {
  const userId = options.userId;
  const now = options.now ?? Date.now();
  if (typeof userId !== "string" || !userId) throw new Error("--user-id is required.");

  const revision = Number(manifest.revision ?? 0);
  const stateRows = manifest.state == null
    ? []
    : [{ user_id: userId, revision: revision + 1, state: manifest.state }];
  const feedbackRows = (manifest.feedback ?? []).map((row) => ({
    user_id: userId,
    id: row.id,
    day: Number(row.day ?? 0),
    stage: row.stage,
    attempt: row.attempt,
    evidence: row.evidence,
    feedback: row.feedback,
    created_at: row.createdAt,
    review_task_id: null,
    pronunciation: row.pronunciation ?? null,
    analysis_json: row.analysis ?? null,
  }));
  const lessonRows = (manifest.lessons ?? []).map((row) => ({
    user_id: userId,
    day: Number(row.day ?? 0),
    lesson: row.lesson ?? null,
  }));
  const jobRows = (manifest.reviewJobs ?? []).map((row) => ({
    user_id: userId,
    id: row.id,
    day: Number(row.day ?? 0),
    submission_key: row.submissionKey,
    request_hash: row.requestHash,
    revision: Number(row.revision ?? 0),
    snapshot: row.snapshot ?? null,
    created_at: row.createdAt,
  }));
  // Formats 1-3 predate calibration; absent arrays import as empty, which is a
  // valid no-op against an empty/new target and fails closed against existing
  // calibration rows at the restore layer.
  const profileRows = (manifest.personalCalibration ?? []).map((row) => ({
    user_id: userId,
    expected: row.expected,
    actual: row.actual,
    n_confirmed: Number(row.nConfirmed ?? 0),
    n_rejected: Number(row.nRejected ?? 0),
    n_unsure: Number(row.nUnsure ?? 0),
    n_shown: Number(row.nShown ?? 0),
    state: row.state ?? "CANDIDATE",
    rule_version: row.ruleVersion,
    detector_version: row.detectorVersion,
    inventory_version: row.inventoryVersion,
    updated_at: Number(row.updatedAt ?? 0),
  }));
  const candidateRows = (manifest.calibrationCandidates ?? []).map((row) => ({
    candidate_id: row.candidateId,
    user_id: userId,
    attempt_id: row.attemptId,
    recording_id: row.recordingId,
    word: row.word,
    expected: row.expected,
    actual: row.actual,
    at_ms: Number(row.atMs ?? 0),
    detector_confidence: Number(row.detectorConfidence ?? 0),
    shown_at: Number(row.shownAt ?? 0),
    answered_at: row.answeredAt == null ? null : Number(row.answeredAt),
  }));
  const eventRows = (manifest.calibrationEvents ?? []).map((row) => ({
    user_id: userId,
    attempt_id: row.attemptId,
    candidate_id: row.candidateId,
    expected: row.expected,
    actual: row.actual,
    verdict: row.verdict,
    is_catch_trial: row.isCatchTrial ? 1 : 0,
    created_at: Number(row.createdAt ?? 0),
  }));

  const statements = [
    ...insertStatements("learner_states", stateRows),
    ...insertStatements("teacher_feedback", feedbackRows),
    ...insertStatements("teacher_lessons", lessonRows),
    ...insertStatements("review_jobs", jobRows),
    ...insertStatements("personal_calibration", profileRows),
    ...insertStatements("calibration_candidates", candidateRows),
    ...insertStatements("calibration_events", eventRows),
  ];
  const rebuilt = rebuildTasks(manifest, { userId, now });
  statements.push(...rebuilt.statements);

  const tables = {
    learner_states: stateRows.length,
    teacher_feedback: feedbackRows.length,
    teacher_lessons: lessonRows.length,
    review_jobs: jobRows.length,
    personal_calibration: profileRows.length,
    calibration_candidates: candidateRows.length,
    calibration_events: eventRows.length,
    review_tasks: rebuilt.ids.length,
  };
  const sql = [
    "-- Bandroom backup direct import (owner-authorized one-time migration; formats 1-4).",
    `-- Generated: ${new Date(now).toISOString()}`,
    "-- Apply with: wrangler d1 execute <database> --remote --file <this file>",
    "-- Statements are idempotent (INSERT ... ON CONFLICT DO NOTHING).",
    "",
    ...statements,
    "",
  ].join("\n");

  return {
    sql,
    statements,
    summary: {
      tables,
      rebuiltTasks: rebuilt.ids.length,
      rebuiltTaskIds: rebuilt.ids,
      statements: statements.length,
    },
    revision: {
      backup: revision,
      imported: manifest.state == null ? null : revision + 1,
    },
  };
}

/** Pure plan used by the CLI and tests (no file or process I/O). */
export function planDirectImport(bytes, options = {}) {
  const inspected = inspectBackup(bytes, options);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("--now must be an epoch millisecond number.");
  const built = buildDirectImportSql(inspected.manifest, { userId: options.userId, now });
  const owner = ownerTag(options.userId);
  const report = {
    tool: "import-backup-direct",
    generatedAt: new Date(now).toISOString(),
    backup: {
      format: inspected.manifest.format,
      created: inspected.manifest.created ?? null,
      userId: options.userId,
      owner: { expected: owner, actual: inspected.manifest.owner, ok: true },
    },
    revision: built.revision,
    tables: built.summary.tables,
    audio: inspected.audio.map((item) => ({
      kind: item.kind,
      id: item.id,
      type: item.type,
      size: item.size,
      declaredHash: item.declaredHash,
      actualHash: item.actualHash,
      key: item.key,
      file: item.file,
    })),
    rebuiltTasks: {
      count: built.summary.rebuiltTasks,
      ids: built.summary.rebuiltTaskIds,
    },
    statements: built.statements.length,
  };
  return { ...inspected, now, ...built, report };
}

function uploadScript(plan, bucket) {
  const bucketDefault = bucket ?? "bandroom-recordings";
  const lines = [
    "#!/bin/sh",
    "set -eu",
    'cd "$(dirname "$0")"',
    `BUCKET="\${R2_BUCKET:-${bucketDefault}}"`,
  ];
  for (const item of plan.audio) {
    lines.push(
      `npx wrangler r2 object put "$BUCKET/${item.key}" --remote --force --file "audio/${item.file}" --content-type "${item.type}"`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Write import.sql, audio/, r2-upload.sh and report.json. */
export function writeArtifacts(plan, outDir, options = {}) {
  const dir = resolve(outDir);
  const audioDir = join(dir, "audio");
  mkdirSync(audioDir, { recursive: true });
  const sqlPath = join(dir, "import.sql");
  writeFileSync(sqlPath, plan.sql);
  for (const item of plan.audio) {
    writeFileSync(join(audioDir, item.file), item.bytes);
  }
  const scriptPath = join(dir, "r2-upload.sh");
  writeFileSync(scriptPath, uploadScript(plan, options.bucket), { mode: 0o755 });
  const files = {
    sql: "import.sql",
    audioDir: "audio",
    r2Script: "r2-upload.sh",
    report: "report.json",
  };
  const reportValue = { ...plan.report, files };
  const reportPath = join(dir, "report.json");
  writeFileSync(reportPath, `${JSON.stringify(reportValue, null, 2)}\n`);
  return { dir, sql: sqlPath, audioDir, r2Script: scriptPath, report: reportPath, reportValue };
}

/** Apply a written plan with wrangler (spawnSync is injectable for tests). */
export function executeImport(plan, options = {}) {
  const { database, bucket, artifacts, spawn = spawnSync } = options;
  if (!database) throw new Error("--database is required with --execute.");
  if (!bucket) throw new Error("--bucket is required with --execute.");
  if (!artifacts?.sql) throw new Error("Write the dry-run artifacts before --execute.");
  const wranglerBin = fileURLToPath(
    new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
  const commands = [];
  const run = (args, label) => {
    const result = spawn(process.execPath, [wranglerBin, ...args], {
      cwd: artifacts.dir,
      stdio: "inherit",
    });
    if (result?.error) throw result.error;
    if (result?.status !== 0) {
      throw new Error(`${label} failed with exit code ${result?.status}.`);
    }
    commands.push([wranglerBin, ...args]);
  };

  run(
    ["d1", "execute", database, "--remote", "--yes", "--file", artifacts.sql],
    "wrangler d1 execute",
  );
  for (const item of plan.audio) {
    run(
      [
        "r2", "object", "put", `${bucket}/${item.key}`, "--remote", "--force",
        "--file", join(artifacts.audioDir, item.file), "--content-type", item.type,
      ],
      `wrangler r2 object put ${item.key}`,
    );
  }
  return { database, bucket, commands };
}

export function parseArgs(argv) {
  const args = {};
  const flags = new Map([
    ["--backup", "backup"],
    ["--user-id", "userId"],
    ["--out", "out"],
    ["--database", "database"],
    ["--bucket", "bucket"],
    ["--now", "now"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--execute") args.execute = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (flags.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value.`);
      args[flags.get(flag)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (args.now !== undefined) {
    args.now = Number(args.now);
    if (!Number.isFinite(args.now)) throw new Error("--now must be an epoch millisecond number.");
  }
  return args;
}

function usage() {
  return `Usage: node scripts/migrate/import-backup-direct.mjs --backup <file.bandroom> --user-id <originalUserId> [options]

Options:
  --out <dir>            Artifact directory (default bandroom-direct-import).
  --now <epoch-ms>       next_at/timestamps for rebuilt review_tasks (default Date.now()).
  --execute              Apply import.sql and upload audio with wrangler.
  --database <name>      D1 database name or binding for --execute.
  --bucket <name>        R2 bucket name for --execute (also the r2-upload.sh default).
`;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return null;
  }
  if (!args.backup) throw new Error("--backup is required.");
  if (!args.userId) throw new Error("--user-id is required.");
  if (args.execute && (!args.database || !args.bucket)) {
    throw new Error("--execute requires --database and --bucket.");
  }

  const bytes = readFileSync(resolve(process.cwd(), args.backup));
  const plan = planDirectImport(bytes, { userId: args.userId, now: args.now });
  const artifacts = writeArtifacts(plan, resolve(process.cwd(), args.out ?? "bandroom-direct-import"), {
    bucket: args.bucket,
  });
  let execution = null;
  if (args.execute) {
    execution = executeImport(plan, {
      database: args.database,
      bucket: args.bucket,
      artifacts,
    });
  }
  const output = {
    ...artifacts.reportValue,
    out: artifacts.dir,
    execute: execution ? execution.commands.length : false,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return { plan, artifacts, execution };
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[migrate] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}