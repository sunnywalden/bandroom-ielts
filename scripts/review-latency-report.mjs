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

function arg(name, fallback) {
  const index = process.argv.indexOf(name);
  return index > -1 ? process.argv[index + 1] : fallback;
}

function main() {
  const input = arg("--input");
  let rows;
  if (input) {
    rows = JSON.parse(readFileSync(input, "utf8"));
  } else {
    const config = arg("--config");
    const database = arg("--database");
    if (!config || !database) {
      console.error("usage: --config <wrangler.json> --database <name> [--since-hours 72] | --input rows.json");
      process.exit(2);
    }
    const since = Date.now() - Number(arg("--since-hours", "72")) * 3_600_000;
    const sql = LATENCY_SQL.replace("?SINCE?", String(Math.floor(since))).replace(/\s+/g, " ").trim();
    const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
    const result = spawnSync(process.execPath,
      [wrangler, "d1", "execute", database, "--remote", "--json", "--config", config, "--command", sql],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    if (result.status !== 0) {
      console.error(result.stderr || result.stdout);
      process.exit(1);
    }
    const parsed = JSON.parse(result.stdout);
    rows = (Array.isArray(parsed) ? parsed : [parsed]).flatMap(entry => entry.results ?? []);
  }
  console.log(JSON.stringify({ tasks: rows.length, latency: summarize(rows) }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
