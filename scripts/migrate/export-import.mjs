#!/usr/bin/env node
// Runtime/evidence migration for the six tables that backup v3 does not carry.
//
//   node scripts/migrate/export-import.mjs export \
//     --snapshot bandroom-migration.json --out bandroom-runtime-import.sql
//   node scripts/migrate/export-import.mjs import \
//     --snapshot bandroom-migration.json --out bandroom-runtime-import.sql --execute
//
// The input is the JSON produced by GET /api/migrate (BANDROOM_MIGRATION_ENABLED=1).
// The output is idempotent SQL: INSERT ... ON CONFLICT DO NOTHING plus
// teacher_feedback.review_task_id backfill UPDATEs. Pending review_jobs that
// have no feedback are rebuilt as queued review_tasks so the new site does not
// leave them permanently awaiting_coach (design MJ-12).
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const RUNTIME_TABLES = [
  {
    name: "review_tasks",
    columns: [
      "id", "review_job_id", "user_id", "kind", "attempt_id", "day",
      "attempt_revision", "recording_id", "stage", "state", "fence", "attempts",
      "claim_kind", "manual_grant_sha256", "notification_epoch", "retry_epoch",
      "claimed_client_run_id", "lease_until", "next_at", "analysis_version",
      "checkpoint_sha256", "coverage", "last_error", "receipt_id", "claimed_by",
      "created_at", "updated_at",
    ],
  },
  {
    name: "review_receipts",
    columns: [
      "id", "task_id", "user_id", "attempt_id", "attempt_revision",
      "recording_sha256", "analysis_version", "fence", "feedback_id",
      "output_sha256", "output_sha256_v2", "payload_json", "created_at",
    ],
  },
  {
    name: "analysis_artifacts",
    columns: [
      "task_id", "stage", "chunk_index", "analyzer_version", "input_sha256",
      "artifact_sha256", "bytes", "object_ref", "payload_json", "created_at",
    ],
  },
  {
    name: "analysis_events",
    columns: [
      "id", "at", "task_id", "fence", "event", "stage", "outcome",
      "client_run_id", "request_id", "metadata_json", "user_id",
    ],
  },
  {
    name: "scheduler_heartbeats",
    columns: [
      "automation_id", "owner_user_id", "generation", "client_run_id",
      "started_at", "finished_at", "last_success_at", "next_expected_at",
      "status", "detail",
    ],
  },
  {
    name: "automation_heartbeats",
    columns: [
      "user_id", "automation_id", "generation", "client_run_id", "started_at",
      "finished_at", "last_success_at", "next_expected_at", "status", "detail",
    ],
  },
];

export function tableRows(snapshot, name) {
  const table = snapshot?.tables?.[name];
  if (Array.isArray(table)) return table;
  return Array.isArray(table?.rows) ? table.rows : [];
}

function parseJson(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function links(snapshot) {
  const jobs = tableRows(snapshot, "review_jobs");
  const tasks = tableRows(snapshot, "review_tasks");
  const feedback = tableRows(snapshot, "teacher_feedback");
  const receipts = tableRows(snapshot, "review_receipts");
  return {
    jobs,
    tasks,
    feedback,
    receipts,
    taskJobIds: new Set(tasks.map((task) => String(task.review_job_id))),
    feedbackAttempts: new Set(feedback.map((row) => String(row.attempt))),
    receiptAttempts: new Set(receipts.map((row) => String(row.attempt_id))),
  };
}

/**
 * Jobs still awaiting a result: no feedback row and no receipt. This definition
 * deliberately ignores whether a review_tasks row exists, so it can be compared
 * before and after the task rebuild.
 */
export function awaitingFeedbackJobs(snapshot) {
  const { jobs, feedbackAttempts, receiptAttempts } = links(snapshot);
  return jobs.filter(
    (job) => !feedbackAttempts.has(String(job.id)) && !receiptAttempts.has(String(job.id)),
  );
}

/** Awaiting jobs that also have no review_tasks row yet (rebuild candidates). */
export function rebuildableJobs(snapshot) {
  const { taskJobIds } = links(snapshot);
  return awaitingFeedbackJobs(snapshot).filter((job) => !taskJobIds.has(String(job.id)));
}

export function deterministicUuid(input) {
  const bytes = createHash("sha256").update(input).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5-style namespace UUID
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function literal(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof Uint8Array) {
    return `X'${Buffer.from(value).toString("hex")}'`;
  }
  if (typeof value === "object") return quote(JSON.stringify(value));
  return quote(value);
}

function insertStatements(table, rows, chunkSize = 50) {
  if (!rows.length) return [];
  const statements = [];
  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const values = chunk
      .map((row) => `(${table.columns.map((column) => literal(row[column])).join(",")})`)
      .join(",\n  ");
    statements.push(
      `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES\n  ${values}\nON CONFLICT DO NOTHING;`,
    );
  }
  return statements;
}

function rebuildTaskRow(job, options) {
  const frozen = parseJson(job.snapshot) ?? {};
  const attempt = frozen?.attempt ?? {};
  const recordingId = attempt.recordingId ?? null;
  return {
    id: options.taskIdFor
      ? options.taskIdFor(job)
      : deterministicUuid(`bandroom:migrate:review_task:${job.id}`),
    review_job_id: String(job.id),
    user_id: String(job.user_id),
    kind: attempt.stage === "speak" && recordingId ? "speaking" : "text",
    attempt_id: String(attempt.id ?? job.id),
    day: Number(job.day ?? attempt.day ?? 0),
    attempt_revision: Number(job.revision ?? 0),
    recording_id: recordingId,
    stage: "read_input",
    state: "queued",
    fence: 0,
    attempts: 0,
    claim_kind: "auto",
    manual_grant_sha256: null,
    notification_epoch: 0,
    retry_epoch: 0,
    claimed_client_run_id: null,
    lease_until: null,
    next_at: options.now,
    analysis_version: options.analysisVersion ?? frozen.analysisVersion ?? null,
    checkpoint_sha256: null,
    coverage: null,
    last_error: null,
    receipt_id: null,
    claimed_by: null,
    created_at: options.now,
    updated_at: options.now,
  };
}

function backfillStatements(snapshot, rebuiltRows) {
  const { tasks, feedback, receipts } = links(snapshot);
  const taskIds = new Set([...tasks, ...rebuiltRows].map((task) => String(task.id)));
  const receiptTask = new Map();
  for (const receipt of receipts) {
    if (receipt.feedback_id && receipt.task_id) {
      receiptTask.set(String(receipt.feedback_id), String(receipt.task_id));
    }
  }
  const taskByAttempt = new Map();
  for (const task of [...tasks, ...rebuiltRows]) {
    taskByAttempt.set(`${task.user_id}\u0000${task.attempt_id}`, String(task.id));
  }
  const used = new Set(
    feedback
      .filter((row) => row.review_task_id)
      .map((row) => String(row.review_task_id)),
  );
  const statements = [];
  let count = 0;
  for (const row of [...feedback].sort((a, b) => String(a.id).localeCompare(String(b.id)))) {
    if (row.review_task_id) continue;
    const byReceipt = receiptTask.get(String(row.id));
    const byAttempt = taskByAttempt.get(`${row.user_id}\u0000${row.attempt}`);
    const candidate = byReceipt ?? byAttempt;
    if (!candidate || !taskIds.has(candidate) || used.has(candidate)) continue;
    if (row.id === undefined || row.id === null) continue;
    statements.push(
      `UPDATE teacher_feedback SET review_task_id=${literal(candidate)} WHERE id=${literal(row.id)} AND review_task_id IS NULL;`,
    );
    used.add(candidate);
    count += 1;
  }
  return { statements, count };
}

/**
 * Build the migration SQL and a summary. Pure function: no file or process I/O.
 */
export function buildImportSql(snapshot, options = {}) {
  const now = options.now ?? Date.now();
  const analysisVersion = options.analysisVersion ?? null;
  const rebuiltRows = rebuildableJobs(snapshot).map((job) =>
    rebuildTaskRow(job, { now, analysisVersion, taskIdFor: options.taskIdFor }),
  );
  const statements = [];
  const tableCounts = {};
  for (const table of RUNTIME_TABLES) {
    const rows = tableRows(snapshot, table.name);
    tableCounts[table.name] = rows.length;
    statements.push(...insertStatements(table, rows));
  }
  // Rebuilt tasks go after the copied rows so an existing task always wins.
  if (rebuiltRows.length) {
    const taskTable = RUNTIME_TABLES.find((table) => table.name === "review_tasks");
    statements.push(...insertStatements(taskTable, rebuiltRows));
  }
  const backfill = backfillStatements(snapshot, rebuiltRows);
  statements.push(...backfill.statements);

  const sql = [
    "-- Bandroom runtime/evidence migration (six tables not covered by backup v3).",
    `-- Generated: ${new Date(now).toISOString()}`,
    "-- Apply with: wrangler d1 execute DB --remote --config dist/server/wrangler.own.json --file <this file>",
    "-- Statements are idempotent (ON CONFLICT DO NOTHING / review_task_id IS NULL).",
    "",
    ...statements,
    "",
  ].join("\n");

  return {
    sql,
    statements,
    summary: {
      tables: tableCounts,
      rebuiltTasks: rebuiltRows.length,
      backfilledFeedback: backfill.count,
      statements: statements.length,
    },
  };
}

async function readSnapshot(path) {
  if (path === "-") {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!["export", "import", "--help", "-h", undefined].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }
  const args = { command: command === "import" ? "import" : "export" };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--execute") args.execute = true;
    else if (flag === "--local") args.local = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (["--snapshot", "--out", "--now", "--analysis-version", "--config"].includes(flag)) {
      const value = rest[index + 1];
      if (value === undefined) throw new Error(`${flag} requires a value.`);
      args[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
      index += 1;
    } else if (flag.startsWith("--")) {
      throw new Error(`Unknown argument: ${flag}`);
    } else {
      throw new Error(`Unexpected argument: ${flag}`);
    }
  }
  return args;
}

function usage() {
  return `Usage: node scripts/migrate/export-import.mjs <export|import> --snapshot <json> [options]

Options:
  --out <path>              SQL output (default bandroom-runtime-import.sql).
  --now <epoch-ms>          next_at/timestamps for rebuilt tasks (default Date.now()).
  --analysis-version <v>    analysis_version for rebuilt tasks (default null).
  --config <path>           Wrangler config for --execute (default dist/server/wrangler.own.json).
  --execute                 import only: run wrangler d1 execute --file.
  --local                   Use --local instead of --remote for --execute.
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === undefined) {
    process.stdout.write(usage());
    return;
  }
  if (!args.snapshot) throw new Error("--snapshot is required.");
  const outPath = resolve(process.cwd(), args.out ?? "bandroom-runtime-import.sql");
  const now = args.now === undefined ? Date.now() : Number(args.now);
  if (!Number.isFinite(now)) throw new Error("--now must be an epoch millisecond number.");

  const snapshot = await readSnapshot(args.snapshot);
  const { sql, summary } = buildImportSql(snapshot, {
    now,
    analysisVersion: args.analysisVersion ?? null,
  });
  writeFileSync(outPath, sql);

  process.stdout.write(`${JSON.stringify({ out: outPath, ...summary }, null, 2)}\n`);

  if (args.command === "import" && args.execute) {
    const config = resolve(
      process.cwd(),
      args.config ?? "dist/server/wrangler.own.json",
    );
    if (!existsSync(config)) throw new Error(`Missing wrangler config ${config}.`);
    const wranglerBin = fileURLToPath(
      new URL("../../node_modules/wrangler/bin/wrangler.js", import.meta.url),
    );
    const result = spawnSync(
      process.execPath,
      [
        wranglerBin, "d1", "execute", "DB", args.local ? "--local" : "--remote",
        "--config", config, "--file", outPath,
      ],
      { cwd: process.cwd(), stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`wrangler d1 execute failed with exit code ${result.status}.`);
    }
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `[migrate] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}