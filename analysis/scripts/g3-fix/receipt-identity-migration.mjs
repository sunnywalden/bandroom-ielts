import {ACCEPTED_JOB_ID, ACCEPTED_PAYLOAD_SHA256, addReceiptIds} from "./receipt-identity.js";

const AUDIT_TABLE = "qa_receipt_identity_migrations";
const digestPattern = /^[a-f0-9]{64}$/;

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

const createAuditTableSql = `CREATE TABLE IF NOT EXISTS ${AUDIT_TABLE} (
  job_id TEXT NOT NULL, owner TEXT NOT NULL, payload_sha TEXT NOT NULL,
  original_receipt_sha256 TEXT NOT NULL, migrated_receipt_sha256 TEXT NOT NULL,
  identity_id TEXT NOT NULL, feedback_id TEXT NOT NULL, applied_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, original_receipt_sha256)
)`;

// Pure transform: JSON text in, JSON text out. No DB, no clock, no side effects.
export async function transformReceipt(receiptJson, payloadSha) {
  if (typeof receiptJson !== "string") throw new TypeError("receiptJson must be a JSON string");
  if (typeof payloadSha !== "string" || !digestPattern.test(payloadSha))
    throw new TypeError("payloadSha must be 64 lowercase hex characters");
  const originalReceiptSha256 = await sha256Hex(receiptJson);
  let receipt;
  try { receipt = JSON.parse(receiptJson); }
  catch { throw new Error("receipt is not valid JSON"); }
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new Error("receipt JSON must be an object");
  if (typeof receipt.payloadSha256 === "string" && receipt.payloadSha256 !== payloadSha)
    throw new Error("receipt.payloadSha256 does not match the payload_sha column");

  const identified = addReceiptIds(receipt, payloadSha);
  if (identified === receipt) {
    return {receiptJson, receipt, changed: false, originalReceiptSha256, migratedReceiptSha256: originalReceiptSha256};
  }
  const migratedJson = JSON.stringify(identified);
  return {
    receiptJson: migratedJson, receipt: identified, changed: true,
    originalReceiptSha256, migratedReceiptSha256: await sha256Hex(migratedJson),
  };
}

const selectSql = count => `SELECT job_id, owner, payload_sha, receipt FROM qa_acoustic_completions
  WHERE job_id IN (${Array.from({length: count}, () => "?").join(", ")}) ORDER BY job_id, owner`;

async function selectRows(db, jobIds, owner) {
  const result = await db.prepare(selectSql(jobIds.length)).bind(...jobIds).all();
  const rows = result?.results ?? result ?? [];
  return owner === null ? rows : rows.filter(row => row.owner === owner);
}

// Apply the backfill through a Worker-style D1 binding. Returns a JSON-safe report.
export async function migrateReceiptIdentity(db, {
  jobIds = [ACCEPTED_JOB_ID],
  owner = null,
  dryRun = false,
  expectedPayloadSha256 = null,
  expectedOriginalReceiptSha256 = null,
  appliedAt = Date.now(),
} = {}) {
  if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function")
    throw new TypeError("a D1 binding with prepare() and batch() is required");
  if (!Array.isArray(jobIds) || jobIds.length === 0 || jobIds.some(id => typeof id !== "string" || !id))
    throw new TypeError("jobIds must be a non-empty array of strings");

  const rows = await selectRows(db, jobIds, owner);
  const report = {
    migration: "g3-d2b-receipt-identity-backfill",
    qaOnly: true,
    acceptedPayloadSha256: ACCEPTED_PAYLOAD_SHA256,
    dryRun,
    jobIds,
    scanned: rows.length,
    changed: 0,
    unchanged: 0,
    applied: false,
    rows: [],
    errors: [],
  };
  if (owner !== null && rows.length !== 1) {
    return {...report, ok: false, errors: [{message: "Expected one receipt for this owner and job."}]};
  }
  const pending = [];
  for (const row of rows) {
    try {
      if (expectedPayloadSha256 !== null && row.payload_sha !== expectedPayloadSha256) {
        throw new Error("The stored payload SHA does not match the approved payload.");
      }
      const transformed = await transformReceipt(row.receipt, row.payload_sha);
      if (transformed.changed && expectedOriginalReceiptSha256 !== null &&
          transformed.originalReceiptSha256 !== expectedOriginalReceiptSha256) {
        throw new Error("The receipt changed since the approved dry-run.");
      }
      const entry = {
        jobId: row.job_id,
        owner: row.owner,
        payloadSha256: row.payload_sha,
        id: transformed.receipt.id,
        feedbackId: transformed.receipt.feedbackId,
        changed: transformed.changed,
        originalReceiptSha256: transformed.originalReceiptSha256,
        migratedReceiptSha256: transformed.migratedReceiptSha256,
      };
      report.rows.push(entry);
      if (transformed.changed) {
        report.changed += 1;
        pending.push({row, transformed, entry});
      } else report.unchanged += 1;
    } catch (error) {
      report.errors.push({jobId: row.job_id, owner: row.owner, message: error.message});
    }
  }
  // Fail closed: a malformed or mismatched row aborts the whole migration before any write.
  if (report.errors.length > 0) return {...report, ok: false};
  if (dryRun || pending.length === 0) return {...report, ok: true};

  const statements = [db.prepare(createAuditTableSql)];
  for (const {row, transformed, entry} of pending) {
    statements.push(db.prepare(`UPDATE qa_acoustic_completions SET receipt = ?
      WHERE job_id = ? AND owner = ? AND payload_sha = ? AND receipt = ?`)
      .bind(transformed.receiptJson, row.job_id, row.owner, row.payload_sha, row.receipt));
    // Audit row only lands if the compare-and-swap UPDATE above actually applied.
    statements.push(db.prepare(`INSERT OR IGNORE INTO ${AUDIT_TABLE}
      (job_id, owner, payload_sha, original_receipt_sha256, migrated_receipt_sha256, identity_id, feedback_id, applied_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1`)
      .bind(row.job_id, row.owner, row.payload_sha, entry.originalReceiptSha256, entry.migratedReceiptSha256,
        entry.id, entry.feedbackId, appliedAt));
  }
  // One D1 batch == one transaction: any throw rolls back every UPDATE and audit insert.
  const results = await db.batch(statements);
  const updates = pending.filter((_, index) => results[2 * index + 1]?.meta?.changes === 1).length;
  const audits = pending.filter((_, index) => results[2 * index + 2]?.meta?.changes === 1).length;
  if (updates !== pending.length || audits !== updates) {
    return {...report, ok: false, applied: updates > 0, updates, audits,
      errors: [{message: "Receipt changed concurrently or the batch audit did not match the update."}]};
  }

  const after = await selectRows(db, jobIds, owner);
  const afterByKey = new Map(after.map(row => [row.job_id + "\u0000" + row.owner, row]));
  for (const {row, transformed} of pending) {
    const saved = afterByKey.get(row.job_id + "\u0000" + row.owner);
    if (!saved || saved.receipt !== transformed.receiptJson)
      return {...report, ok: false, applied: true, errors: [{jobId: row.job_id, owner: row.owner, message: "post-batch receipt verification failed"}]};
  }
  return {...report, ok: true, applied: true, updates, audits};
}
