#!/usr/bin/env node
// CLI for the QA receipt-identity backfill. The QA worker uses the same D1 implementation.
import {readFile} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ACCEPTED_JOB_ID} from "./receipt-identity.js";
import {migrateReceiptIdentity, transformReceipt} from "./receipt-identity-migration.mjs";

export {ACCEPTED_JOB_ID, ACCEPTED_PAYLOAD_SHA256, QA_IDENTITY} from "./receipt-identity.js";
export {migrateReceiptIdentity, sha256Hex, transformReceipt} from "./receipt-identity-migration.mjs";

function parseArgs(argv) {
  const options = {jobIds: [], dryRun: false};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--job-id") options.jobIds.push(argv[++i]);
    else if (arg === "--binding-module") options.bindingModule = argv[++i];
    else if (arg === "--receipt-file") options.receiptFile = argv[++i];
    else if (arg === "--payload-sha") options.payloadSha = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

const usage = `Usage:
  node migrate_receipt_identity.mjs --binding-module <qa-d1-binding.mjs> [--dry-run] [--job-id <id>]...
  node migrate_receipt_identity.mjs --receipt-file <receipt.json> --payload-sha <64 hex>
The binding module must export db, default or createDb() returning a Worker-style D1 binding.`;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage); return; }
  if (options.receiptFile) {
    if (!options.payloadSha) throw new Error("--payload-sha is required with --receipt-file");
    const text = await readFile(resolve(options.receiptFile), "utf8");
    const transformed = await transformReceipt(text, options.payloadSha);
    console.log(JSON.stringify(transformed, null, 2));
    return;
  }
  const modulePath = options.bindingModule ?? process.env.QA_D1_BINDING_MODULE;
  if (!modulePath) throw new Error("--binding-module (or QA_D1_BINDING_MODULE) is required\n" + usage);
  const mod = await import(pathToFileURL(resolve(modulePath)).href);
  const db = mod.db ?? mod.default ?? (typeof mod.createDb === "function" ? await mod.createDb() : null);
  if (!db) throw new Error("binding module did not export db, default or createDb");
  const jobIds = options.jobIds.length > 0 ? options.jobIds : [ACCEPTED_JOB_ID];
  const report = await migrateReceiptIdentity(db, {jobIds, dryRun: options.dryRun});
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
