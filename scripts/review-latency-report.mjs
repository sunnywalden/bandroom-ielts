#!/usr/bin/env node
// Phase 0 acceptance (docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §4.2-⑤, §6).
// Read-only, content-blind latency report over review_tasks / analysis_events /
// review_receipts. Prints per-kind percentiles for:
//   queue   = task created  → first claim event
//   ready   = task created  → receipt written
//   visible = task created  → first client render (only renders within 30 min of
//             the receipt count, so a learner who came back next day does not
//             distort "time to visible feedback")
// Fewer than 20 samples are labelled "indicative".
// Phase 1 adds `writingAnchors`: writing anchor hit rate (doc §6), content-blind.
//
//   node scripts/review-latency-report.mjs --config ~/.config/bandroom/wrangler.prod.json \
//     --database bandroom-prod --since-hours 72
//   node scripts/review-latency-report.mjs --input rows.json   # offline / tests
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LATENCY_SQL = `
SELECT t.kind AS kind, t.created_at AS created,
  (SELECT MIN(e.at) FROM analysis_events e WHERE e.task_id=t.id AND e.user_id=t.user_id
     AND e.event IN ('claim_next_review_task','claim_review_tasks')) AS claimed,
  (SELECT MIN(r.created_at) FROM review_receipts r WHERE r.task_id=t.id AND r.user_id=t.user_id) AS ready,
  (SELECT MIN(e.at) FROM analysis_events e WHERE e.task_id=t.id AND e.user_id=t.user_id
     AND e.event='feedback_rendered') AS rendered
FROM review_tasks t
WHERE t.created_at >= ?SINCE? AND t.claim_kind='auto'
ORDER BY t.created_at`;

export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

const VISIBLE_WINDOW_MS = 30 * 60_000;

export function summarize(rows) {
  const out = {};
  for (const row of rows) {
    const kind = String(row.kind ?? "unknown");
    const bucket = (out[kind] ??= { queue: [], ready: [], visible: [] });
    const created = Number(row.created);
    if (!Number.isFinite(created)) continue;
    if (row.claimed != null) bucket.queue.push(Number(row.claimed) - created);
    if (row.ready != null) bucket.ready.push(Number(row.ready) - created);
    if (row.rendered != null && row.ready != null && Number(row.rendered) - Number(row.ready) <= VISIBLE_WINDOW_MS)
      bucket.visible.push(Number(row.rendered) - created);
  }
  const report = {};
  for (const [kind, metrics] of Object.entries(out)) {
    report[kind] = {};
    for (const [metric, values] of Object.entries(metrics)) {
      const sorted = values.filter(v => v >= 0).sort((a, b) => a - b);
      report[kind][metric] = {
        n: sorted.length,
        p50Seconds: sorted.length ? Math.round(percentile(sorted, 50) / 100) / 10 : null,
        p90Seconds: sorted.length ? Math.round(percentile(sorted, 90) / 100) / 10 : null,
        label: sorted.length >= 20 ? "measured" : "indicative",
      };
    }
  }
  return report;
}

// Phase 1 (doc §6): writing anchor hit rate = issues whose quote the server
// resolved to a character span / all issues the model produced. Content-blind:
// it only counts issues and whether `anchor` is null; no learner text is read.
// `?SINCE_ISO?` is substituted with a server-generated ISO timestamp
// (teacher_feedback.created_at is ISO text). json_valid guards rows that carry
// other JSON shapes (speaking analysis) or none (legacy prose feedback).
export const ANCHOR_SQL = `
SELECT json_extract(f.analysis_json,'$.mode') AS mode,
  COUNT(*) AS issues,
  SUM(CASE WHEN json_extract(j.value,'$.anchor') IS NULL THEN 0 ELSE 1 END) AS anchored
FROM teacher_feedback f, json_each(f.analysis_json,'$.issues') j
WHERE f.created_at >= '?SINCE_ISO?' AND f.analysis_json IS NOT NULL AND json_valid(f.analysis_json)
  AND json_extract(f.analysis_json,'$.schema')='bandroom-writing-feedback-v1'
  AND json_extract(f.analysis_json,'$.mode') IN ('cards','delta')
GROUP BY mode`;

export const ANCHOR_TARGET = 0.9;
export const ANCHOR_FLOOR = 0.8;

export function summarizeAnchors(rows) {
  const report = {};
  let issues = 0;
  let anchored = 0;
  for (const row of rows) {
    const n = Number(row.issues);
    const a = Number(row.anchored);
    if (!Number.isFinite(n) || !Number.isFinite(a) || n < 0 || a < 0 || a > n) continue;
    report[String(row.mode)] = { issues: n, anchored: a, rate: n ? Math.round((a / n) * 1000) / 1000 : null };
    issues += n;
    anchored += a;
  }
  const rate = issues ? Math.round((anchored / issues) * 1000) / 1000 : null;
  report.all = {
    issues, anchored, rate,
    label: issues >= 20 ? "measured" : "indicative",
    meetsTarget: rate === null ? null : rate >= ANCHOR_TARGET,
    // Doc §6: below this the anchor UI should be hidden. Reported only; the
    // automatic hide switch is not built in Phase 1.
    belowFloor: rate === null ? null : rate < ANCHOR_FLOOR,
  };
  return report;
}

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function d1Rows(wrangler, config, database, sql) {
  const result = spawnSync(process.execPath,
    [wrangler, "d1", "execute", database, "--remote", "--json", "--config", config, "--command", sql.replace(/\s+/g, " ").trim()],
    { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) {
    console.error(result.stderr || result.stdout);
    process.exit(1);
  }
  const parsed = JSON.parse(result.stdout);
  return (Array.isArray(parsed) ? parsed : [parsed]).flatMap(entry => entry.results ?? []);
}

function main() {
  const input = arg("--input");
  const anchorsInput = arg("--anchors-input");
  let rows;
  let anchorRows;
  if (input) {
    rows = JSON.parse(readFileSync(input, "utf8"));
    if (anchorsInput) anchorRows = JSON.parse(readFileSync(anchorsInput, "utf8"));
  } else {
    const config = arg("--config");
    const database = arg("--database");
    if (!config || !database) {
      console.error("usage: --config <wrangler.json> --database <name> [--since-hours 72] | --input rows.json [--anchors-input rows.json]");
      process.exit(2);
    }
    const hours = Number(arg("--since-hours", "72"));
    if (!Number.isFinite(hours) || hours <= 0) {
      console.error("--since-hours must be a positive number");
      process.exit(2);
    }
    const since = Date.now() - hours * 3_600_000;
    const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    rows = d1Rows(wrangler, config, database, LATENCY_SQL.replace("?SINCE?", String(Math.floor(since))));
    anchorRows = d1Rows(wrangler, config, database, ANCHOR_SQL.replace("?SINCE_ISO?", new Date(since).toISOString()));
  }
  console.log(JSON.stringify({
    tasks: rows.length, latency: summarize(rows),
    ...(anchorRows ? { writingAnchors: summarizeAnchors(anchorRows) } : {}),
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
