#!/usr/bin/env node
// Post-migration verification checklist (design rev2 §4.6 / MJ-10/11/12).
//
//   node scripts/migrate/verify-migration.mjs \
//     --backup backup-manifest.json \
//     --source old-environment-export.json \
//     --target new-environment-export.json \
//     --sha-map recording-sha256.json \
//     --frozen-manifest frozen-bundle-manifest.json \
//     --bundle-sha <actual> --runtime-sha <actual>
//
// Exit code is non-zero if any checklist item fails.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  awaitingFeedbackJobs,
  rebuildableJobs,
  tableRows,
} from "./export-import.mjs";

const LEARNER_TABLES = ["learner_states", "teacher_feedback", "teacher_lessons", "review_jobs"];
const RUNTIME_TABLES = [
  "review_tasks", "review_receipts", "analysis_artifacts", "analysis_events",
  "scheduler_heartbeats", "automation_heartbeats",
];

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value === undefined ? null : value;
}

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function tableSha(rows) {
  return sha256Hex(JSON.stringify(canonical(rows)));
}

function parseMaybe(value) {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function byKeys(keys) {
  return (left, right) => {
    for (const key of keys) {
      const a = String(left[key] ?? "");
      const b = String(right[key] ?? "");
      if (a < b) return -1;
      if (a > b) return 1;
    }
    return 0;
  };
}

function targetStates(snapshot) {
  return tableRows(snapshot, "learner_states")
    .map((row) => ({
      user_id: String(row.user_id),
      revision: Number(row.revision),
      state: parseMaybe(row.state),
    }))
    .sort(byKeys(["user_id"]));
}

function targetFeedback(snapshot) {
  return tableRows(snapshot, "teacher_feedback")
    .map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      day: Number(row.day),
      stage: row.stage ?? null,
      attempt: row.attempt ?? null,
      evidence: row.evidence ?? null,
      feedback: row.feedback ?? null,
      created_at: row.created_at ?? null,
      pronunciation: parseMaybe(row.pronunciation),
      analysis: parseMaybe(row.analysis_json),
      // review_task_id is intentionally absent from backup v3; it is backfilled
      // by the six-table import and is not part of the learner-data comparison.
    }))
    .sort(byKeys(["id"]));
}

function targetLessons(snapshot) {
  return tableRows(snapshot, "teacher_lessons")
    .map((row) => ({
      user_id: String(row.user_id),
      day: Number(row.day),
      lesson: parseMaybe(row.lesson),
    }))
    .sort(byKeys(["user_id", "day"]));
}

function targetReviewJobs(snapshot) {
  return tableRows(snapshot, "review_jobs")
    .map((row) => ({
      id: String(row.id),
      user_id: String(row.user_id),
      day: Number(row.day),
      submission_key: row.submission_key ?? null,
      request_hash: row.request_hash ?? null,
      revision: Number(row.revision),
      snapshot: parseMaybe(row.snapshot),
      created_at: row.created_at ?? null,
    }))
    .sort(byKeys(["id"]));
}

function backupRows(manifest, userId) {
  // A v3 restore increments the revision by one (lib/backup.ts:208). Fold that
  // into the expected learner_states row so the content SHA covers the state
  // and the post-restore revision; the explicit revision rule is checked below.
  const state =
    manifest.state == null
      ? []
      : [{
          user_id: userId,
          revision: Number(manifest.revision ?? 0) + 1,
          state: manifest.state,
        }];
  const feedback = (manifest.feedback ?? []).map((row) => ({
    id: String(row.id),
    user_id: userId,
    day: Number(row.day),
    stage: row.stage ?? null,
    attempt: row.attempt ?? null,
    evidence: row.evidence ?? null,
    feedback: row.feedback ?? null,
    created_at: row.createdAt ?? null,
    pronunciation: row.pronunciation ?? null,
    analysis: row.analysis ?? null,
  }));
  const lessons = (manifest.lessons ?? []).map((row) => ({
    user_id: userId,
    day: Number(row.day),
    lesson: row.lesson ?? null,
  }));
  const jobs = (manifest.reviewJobs ?? []).map((row) => ({
    id: String(row.id),
    user_id: userId,
    day: Number(row.day),
    submission_key: row.submissionKey ?? null,
    request_hash: row.requestHash ?? null,
    revision: Number(row.revision),
    snapshot: row.snapshot ?? null,
    created_at: row.createdAt ?? null,
  }));
  return {
    learner_states: state,
    teacher_feedback: feedback.sort(byKeys(["id"])),
    teacher_lessons: lessons.sort(byKeys(["user_id", "day"])),
    review_jobs: jobs.sort(byKeys(["id"])),
  };
}

function actualRows(snapshot) {
  return {
    learner_states: targetStates(snapshot),
    teacher_feedback: targetFeedback(snapshot),
    teacher_lessons: targetLessons(snapshot),
    review_jobs: targetReviewJobs(snapshot),
  };
}

function ownerUserId(manifest, source, target, explicit) {
  if (explicit) return explicit;
  const candidates = new Set();
  for (const snapshot of [source, target]) {
    for (const name of [
      "learner_states", "teacher_feedback", "teacher_lessons", "review_jobs",
      "review_tasks", "review_receipts", "automation_heartbeats",
    ]) {
      for (const row of tableRows(snapshot, name)) {
        if (row.user_id) candidates.add(String(row.user_id));
        if (row.owner_user_id) candidates.add(String(row.owner_user_id));
      }
    }
  }
  for (const candidate of candidates) {
    if (sha256Hex(candidate) === manifest.owner) return candidate;
  }
  return null;
}

function shaEvidence(object, shaByKey) {
  if (!object) return null;
  return (
    shaByKey?.[object.key] ??
    object.sha256 ??
    object.digest ??
    object.customMetadata?.digest ??
    null
  );
}

function check(name, ok, detail = "") {
  return { name, ok: Boolean(ok), detail };
}

/**
 * Run the full checklist. Pure function over parsed JSON inputs.
 */
export function verifyMigration(input) {
  const manifest = input.backup?.manifest ?? input.backup;
  const { source, target } = input;
  const checks = [];
  if (!manifest || typeof manifest !== "object") {
    return { checks: [check("backup manifest", false, "not provided or invalid")], ok: false };
  }
  const userId = ownerUserId(manifest, source, target, input.userId);
  checks.push(
    check(
      "backup owner identity",
      Boolean(userId),
      userId ? `user ${userId}` : "no environment user matches manifest.owner",
    ),
  );
  if (!userId) return { checks, ok: false };

  // 1. Four learner tables: row counts and content SHA.
  const expected = backupRows(manifest, userId);
  const actual = actualRows(target);
  for (const name of LEARNER_TABLES) {
    const expectedRows = expected[name];
    const actualRowsValue = actual[name];
    const expectedSha = tableSha(expectedRows);
    const actualSha = tableSha(actualRowsValue);
    checks.push(
      check(
        `learner table ${name}`,
        expectedRows.length === actualRowsValue.length && expectedSha === actualSha,
        `rows ${actualRowsValue.length}/${expectedRows.length}, sha ${actualSha.slice(0, 12)}/${expectedSha.slice(0, 12)}`,
      ),
    );
  }

  // 2. Restore revision rule: new.revision == backup.revision + 1.
  const stateRow = targetStates(target).find((row) => row.user_id === userId);
  if (manifest.state == null) {
    checks.push(
      check(
        "restore revision",
        (stateRow?.revision ?? 0) === 0,
        `empty backup, target revision ${stateRow?.revision ?? 0}`,
      ),
    );
  } else {
    const expectedRevision = Number(manifest.revision ?? 0) + 1;
    checks.push(
      check(
        "restore revision",
        stateRow?.revision === expectedRevision,
        `target ${stateRow?.revision ?? "missing"} expected ${expectedRevision}`,
      ),
    );
  }

  // 3. R2 recordings: per-clip size and SHA-256 against the backup manifest.
  const objects = tableRows(target, "r2_objects");
  const listedObjects = Array.isArray(target?.r2?.objects)
    ? target.r2.objects
    : objects;
  const objectMap = new Map(listedObjects.map((object) => [String(object.key), object]));
  const audio = manifest.audio ?? [];
  if (!audio.length) {
    checks.push(check("recordings", true, "backup has no cloud recordings"));
  }
  for (const clip of audio) {
    const expectedKey = `speaking/${encodeURIComponent(userId)}/${clip.id}`;
    const object =
      objectMap.get(expectedKey) ??
      listedObjects.find((entry) => String(entry.key).endsWith(`/${clip.id}`));
    const actualSha = shaEvidence(object, input.shaByKey);
    const shaOk = typeof actualSha === "string" && actualSha.toLowerCase() === String(clip.hash).toLowerCase();
    const sizeOk = object?.size === clip.size;
    checks.push(
      check(
        `recording ${clip.id}`,
        Boolean(object) && sizeOk && shaOk,
        object
          ? `size ${object.size}/${clip.size}, sha ${actualSha ? String(actualSha).slice(0, 12) : "missing"}`
          : "object not listed in target R2 inventory",
      ),
    );
  }

  // 4. Six runtime/evidence tables: counts (review_tasks allows the rebuild).
  const sourceTaskCount = tableRows(source, "review_tasks").length;
  const rebuilt = rebuildableJobs(source).length;
  for (const name of RUNTIME_TABLES) {
    const sourceCount = tableRows(source, name).length;
    const targetCount = tableRows(target, name).length;
    const expectedCount = name === "review_tasks" ? sourceTaskCount + rebuilt : sourceCount;
    checks.push(
      check(
        `runtime table ${name}`,
        targetCount === expectedCount,
        `rows ${targetCount}/${expectedCount}${name === "review_tasks" ? ` (source ${sourceCount} + rebuilt ${rebuilt})` : ""}`,
      ),
    );
  }

  // 5. Receipt output hashes, one line per receipt.
  const targetReceipts = tableRows(target, "review_receipts");
  const targetReceiptById = new Map(targetReceipts.map((row) => [String(row.id), row]));
  const targetReceiptByTask = new Map(targetReceipts.map((row) => [String(row.task_id), row]));
  const sourceReceipts = tableRows(source, "review_receipts");
  if (!sourceReceipts.length) {
    checks.push(check("receipts", true, "no receipts to verify"));
  }
  for (const receipt of sourceReceipts) {
    const found =
      targetReceiptById.get(String(receipt.id)) ??
      targetReceiptByTask.get(String(receipt.task_id));
    const hashOk =
      found &&
      String(found.output_sha256) === String(receipt.output_sha256) &&
      (found.output_sha256_v2 ?? null) === (receipt.output_sha256_v2 ?? null);
    checks.push(
      check(
        `receipt ${receipt.id} outputSha256`,
        Boolean(hashOk),
        found
          ? `${String(found.output_sha256).slice(0, 12)}/${String(receipt.output_sha256).slice(0, 12)}`
          : "receipt missing from target",
      ),
    );
  }

  // 6. Pending task counts and rebuild presence.
  const sourcePending = awaitingFeedbackJobs(source);
  const targetPending = awaitingFeedbackJobs(target);
  checks.push(
    check(
      "pending task count",
      sourcePending.length === targetPending.length,
      `${targetPending.length}/${sourcePending.length}`,
    ),
  );
  const targetTaskJobs = new Set(
    tableRows(target, "review_tasks").map((task) => String(task.review_job_id)),
  );
  const missingTasks = targetPending.filter((job) => !targetTaskJobs.has(String(job.id)));
  checks.push(
    check(
      "pending jobs have review_tasks",
      missingTasks.length === 0,
      missingTasks.length
        ? `missing ${missingTasks.map((job) => job.id).join(", ")}`
        : `${targetPending.length} pending jobs covered`,
    ),
  );

  // 7. Bundle and runtime SHA against the frozen manifest.
  const expectedBundle =
    input.expectedBundleSha ??
    input.frozenManifest?.bundleSha256 ??
    input.frozenManifest?.bundle?.sha256 ??
    null;
  const expectedRuntime =
    input.expectedRuntimeSha ??
    input.frozenManifest?.runtimeSha256 ??
    input.frozenManifest?.runtimeBundleSha256 ??
    input.frozenManifest?.runtime?.sha256 ??
    null;
  checks.push(
    check(
      "analysis bundle SHA",
      Boolean(input.bundleSha && expectedBundle && input.bundleSha === expectedBundle),
      `${input.bundleSha ?? "missing"} / ${expectedBundle ?? "missing"}`,
    ),
  );
  checks.push(
    check(
      "runtime bundle SHA",
      Boolean(input.runtimeSha && expectedRuntime && input.runtimeSha === expectedRuntime),
      `${input.runtimeSha ?? "missing"} / ${expectedRuntime ?? "missing"}`,
    ),
  );

  return { checks, ok: checks.every((entry) => entry.ok) };
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
  } catch (error) {
    throw new Error(`Unable to read ${label} ${path}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const args = {};
  const flags = new Map([
    ["--backup", "backup"],
    ["--source", "source"],
    ["--target", "target"],
    ["--sha-map", "shaMap"],
    ["--frozen-manifest", "frozenManifest"],
    ["--bundle-sha", "bundleSha"],
    ["--runtime-sha", "runtimeSha"],
    ["--user-id", "userId"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") args.json = true;
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
  return args;
}

function usage() {
  return `Usage: node scripts/migrate/verify-migration.mjs --backup <json> --source <json> --target <json> [options]

Options:
  --sha-map <json>          Map of R2 key -> sha256 (or {recordings:[{key,sha256}]}).
  --frozen-manifest <json>  Frozen bundle/runtime manifest (bundleSha256, runtimeSha256).
  --bundle-sha <hex>        Actual analysis bundle SHA.
  --runtime-sha <hex>       Actual runtime bundle SHA.
  --user-id <id>            Owner userId (otherwise matched via manifest.owner).
  --json                    Print the full checklist as JSON.
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (!args.backup || !args.source || !args.target) {
    throw new Error("--backup, --source and --target are required.");
  }
  const shaMapRaw = args.shaMap ? readJson(args.shaMap, "sha map") : {};
  const shaByKey = {};
  if (Array.isArray(shaMapRaw.recordings)) {
    for (const entry of shaMapRaw.recordings) shaByKey[entry.key] = entry.sha256;
  } else {
    Object.assign(shaByKey, shaMapRaw);
  }
  const result = verifyMigration({
    backup: readJson(args.backup, "backup"),
    source: readJson(args.source, "source export"),
    target: readJson(args.target, "target export"),
    frozenManifest: args.frozenManifest ? readJson(args.frozenManifest, "frozen manifest") : null,
    shaByKey,
    bundleSha: args.bundleSha,
    runtimeSha: args.runtimeSha,
    userId: args.userId,
  });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    for (const entry of result.checks) {
      process.stdout.write(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}${entry.detail ? ` — ${entry.detail}` : ""}\n`);
    }
    const passed = result.checks.filter((entry) => entry.ok).length;
    process.stdout.write(`\n${passed}/${result.checks.length} checks passed\n`);
  }
  if (!result.ok) process.exitCode = 1;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `[verify] ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}