// MT-5 static tenant-access guard (design rev3.1 S4/G1, task 4 of MT-5).
//
// Scans raw SQL string literals in lib/*.ts and app/api/**/*.ts. Every literal
// that names a tenant table (TENANT_TABLES) or analysis_artifacts must either:
//   (a) match a small, explicitly reviewed allowlist entry (service/cross-tenant
//       operations documented in lib/tenant-db.ts), or
//   (b) pass the tripwire / carry explicit user_id attribution
//       (INSERT ... (user_id, ...) names the tenant column).
//
// This is a regression guard against a NEW unscoped raw query. It is not a
// parser and does not replace code review or the write-side cross-tenant matrix.
// Statements assembled at runtime (e.g. lib/migrate-export.ts builds
// `FROM ${spec.name}`) cannot be inspected here and are covered by the
// reviewed-exception list in lib/tenant-db.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const { assertTenantPredicate, referencedTenantTables, stripSql, TENANT_TABLES } =
  await import("../lib/tenant-db.ts");
const { TENANT_DB_ALLOWLIST, TENANT_DB_ALLOWLIST_FILES } =
  await import("../scripts/tenant-db-allowlist.mjs");

// Reviewed service / cross-tenant exceptions. Keep this list small; each entry
// must correspond to the rationale in the lib/tenant-db.ts header.
const ALLOWLIST = [
  {
    file: "lib/metrics.ts",
    reason: "scheduled tenant_metrics_daily aggregation is cross-tenant and content-blind",
  },
  {
    file: "lib/review-tasks.ts",
    match: /WHERE \(\(state IN \('queued','retry_wait'\)/,
    reason: "claimNextReviewTask deliberately claims the next due task across tenants",
  },
  {
    file: "lib/review-tasks.ts",
    match: /SET state='needs_attention'[\s\S]*?WHERE \(\s*\(state IN/,
    reason: "markExhaustedGlobal sweeps exhausted tasks across tenants",
  },
  {
    file: "lib/review-tasks.ts",
    match: /SELECT 1 AS ok FROM review_tasks/,
    reason: "hasOtherDueTasks is a cross-tenant fairness probe (excludeUserId)",
  },
  {
    file: "lib/review-tasks.ts",
    match: /INSERT INTO analysis_artifacts/,
    reason: "saveReviewCheckpoint scopes via the shared `active` predicate (id/user_id/fence/lease)",
  },
  {
    file: "lib/review-tasks.ts",
    match: /UPDATE review_tasks\s+SET stage=\?/,
    reason: "saveReviewCheckpoint scopes via the shared `active` predicate",
  },
  {
    file: "lib/dsr.ts",
    match: /dsr_jobs/,
    reason: "DSR jobs are service rows keyed by an explicit admin-supplied jobId/userId",
  },
  {
    file: "lib/tenant-identity.ts",
    match: /idp_iss=\?/,
    reason: "login resolves an IdP subject to a tenant before a tenant id exists",
  },
];

function toPosix(path) {
  return path.split(sep).join("/");
}

/** True when `file`/`sql` is a reviewed exception rather than a regression. */
function allowlisted(file, sql) {
  return ALLOWLIST.find(
    entry => entry.file === file && (!entry.match || entry.match.test(sql)),
  );
}

/**
 * INSERTs that name `user_id` in the target column list attribute the row to a
 * tenant explicitly. This is the write-side analogue of a scoping predicate; the
 * write-side matrix still verifies tenant ownership end-to-end.
 */
function isAttributedInsert(sql) {
  const s = stripSql(sql);
  const match = s.match(
    /\binsert\s+(?:or\s+\w+\s+)?into\s+((?:\w+\.)?(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*))\s*\(([^)]*)\)/i,
  );
  if (!match) return false;
  const table = match[1].split(".").pop().replace(/^["`\[]|["`\]]$/g, "").toLowerCase();
  if (!TENANT_TABLES.has(table)) return false; // indirect tables must join review_tasks
  return /\buser_id\b/i.test(match[2]);
}

function isScoped(sql) {
  try {
    assertTenantPredicate(sql);
    return true;
  } catch {
    return false;
  }
}

// --- Minimal TypeScript string-literal lexer --------------------------------
// Skips comments and regex literals, handles quoted strings and template
// literals (interpolations become ` ${} `), and folds adjacent `"..." + "..."`
// concatenations so a predicate is not lost to line wrapping.

function regexAllowed(lastSignificantChar, lastWord) {
  if (!lastSignificantChar) return true;
  if ("=(:,![{;&|?+-*%^~<>".includes(lastSignificantChar)) return true;
  return /^(?:return|typeof|instanceof|in|of|new|delete|void|case|do|else|yield|await)$/.test(lastWord);
}

function skipRegex(src, start) {
  let i = start + 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) {
      i++;
      while (i < src.length && /[A-Za-z]/.test(src[i])) i++;
      return i;
    }
    i++;
  }
  return i;
}

function readQuoted(src, start, quote) {
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
    if (c === quote) return { value, index: start, end: i + 1 };
    if (c === "\n") break; // malformed / not a real string; stop safely
    value += c;
    i++;
  }
  return { value, index: start, end: i };
}

function readTemplate(src, start) {
  let i = start + 1;
  let value = "";
  while (i < src.length) {
    const c = src[i];
    if (c === "\\") { value += src[i + 1] ?? ""; i += 2; continue; }
    if (c === "`") return { value, index: start, end: i + 1 };
    if (c === "$" && src[i + 1] === "{") {
      let depth = 1;
      i += 2;
      while (i < src.length && depth > 0) {
        const d = src[i];
        if (d === '"' || d === "'" || d === "`") {
          const nested = d === "`" ? readTemplate(src, i) : readQuoted(src, i, d);
          i = nested.end;
          continue;
        }
        if (d === "{") depth++;
        else if (d === "}") depth--;
        i++;
      }
      value += " ${} ";
      continue;
    }
    value += c;
    i++;
  }
  return { value, index: start, end: i };
}

function readLiteralAt(src, start) {
  const c = src[start];
  if (c === '"' || c === "'") return readQuoted(src, start, c);
  if (c === "`") return readTemplate(src, start);
  return null;
}

/** Read a literal and fold any `+ "..."` continuation into it. */
function readChain(src, start) {
  const first = readLiteralAt(src, start);
  if (!first) return null;
  let value = first.value;
  let end = first.end;
  for (;;) {
    let k = end;
    while (k < src.length && /\s/.test(src[k])) k++;
    if (src[k] !== "+") break;
    k++;
    while (k < src.length && /\s/.test(src[k])) k++;
    const next = readLiteralAt(src, k);
    if (!next) break;
    value += " " + next.value;
    end = next.end;
  }
  return { value, index: start, end };
}

function extractSqlLiterals(src) {
  const out = [];
  let i = 0;
  let lastSignificantChar = "";
  let lastWord = "";
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    if (c === "/" && regexAllowed(lastSignificantChar, lastWord)) {
      i = skipRegex(src, i);
      lastSignificantChar = "/";
      lastWord = "";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const chain = readChain(src, i);
      if (chain) {
        out.push({ value: chain.value, index: chain.index });
        i = chain.end;
        lastSignificantChar = c;
        lastWord = "";
        continue;
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_$]/.test(src[j])) j++;
      lastWord = src.slice(i, j);
      lastSignificantChar = src[j - 1] ?? "";
      i = j;
      continue;
    }
    lastSignificantChar = c;
    lastWord = "";
    i++;
  }
  return out;
}

function looksLikeSql(value) {
  if (!/\b(?:select|insert\s+into|update|delete\s+from|with)\b/i.test(value)) return false;
  const { direct, indirect } = referencedTenantTables(value);
  return direct.length > 0 || indirect.length > 0;
}

/** Return unscoped tenant-SQL offenders for one source file. */
function scanSource(file, src) {
  const offenders = [];
  for (const literal of extractSqlLiterals(src)) {
    if (!looksLikeSql(literal.value)) continue;
    if (allowlisted(file, literal.value)) continue;
    if (isScoped(literal.value)) continue;
    if (isAttributedInsert(literal.value)) continue;
    const line = src.slice(0, literal.index).split("\n").length;
    offenders.push({
      file,
      line,
      snippet: literal.value.replace(/\s+/g, " ").trim().slice(0, 140),
    });
  }
  return offenders;
}

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...listFiles(path));
    else if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

function sourceFiles() {
  const lib = listFiles(join(root, "lib")).filter(path => !path.endsWith(".d.ts"));
  const api = listFiles(join(root, "app/api"));
  return [...lib, ...api];
}

/** True when the source has a value (non-type-only) `@/db` import of `name`. */
function importsValue(src, specifier, name) {
  // `[^;{}]*` keeps the clause inside ONE import statement; without it the
  // non-greedy match can start at an earlier `import {` and swallow several
  // statements before reaching the target specifier.
  const escaped = specifier.replace(/[/\\]/g, "\\$&");
  const pattern = new RegExp(
    String.raw`import\s+(?!type\b)\{([^;{}]*?)\}\s+from\s+["']${escaped}["']`,
    "g",
  );
  for (const match of src.matchAll(pattern)) {
    const names = match[1]
      .split(",")
      .map(part => part.trim().replace(/^type\s+/, ""))
      .filter(Boolean);
    if (names.includes(name)) return true;
  }
  return false;
}

/** True when the source imports any runtime value from `specifier`. */
function importsAnyValue(src, specifier) {
  const pattern = new RegExp(
    String.raw`import\s+([^;]+?)\s+from\s+["']${specifier.replace(/[/\\]/g, "\\$&")}["']`,
    "g",
  );
  for (const match of src.matchAll(pattern)) {
    const clause = match[1].trim();
    if (/^type\b/.test(clause)) continue; // `import type {...}`
    const braces = clause.match(/\{([^}]*)\}/);
    if (braces) {
      const parts = braces[1].split(",").map(part => part.trim()).filter(Boolean);
      if (parts.length > 0 && parts.every(part => /^type\s+/.test(part))) continue;
    }
    return true;
  }
  return false;
}

test("only reviewed files import the unscoped getDb client", () => {
  const importers = sourceFiles()
    .filter(path => importsValue(readFileSync(path, "utf8"), "@/db", "getDb"))
    .map(path => toPosix(relative(root, path)))
    .sort();
  assert.deepEqual(
    importers,
    [...TENANT_DB_ALLOWLIST_FILES].sort(),
    "learner-facing files must use getTenantDb(userId); add a reviewed entry to scripts/tenant-db-allowlist.mjs only for a service/cross-tenant path",
  );
  assert.equal(
    TENANT_DB_ALLOWLIST.length,
    TENANT_DB_ALLOWLIST_FILES.size,
    "allowlist must not contain duplicate entries",
  );
});

test("Drizzle clients are constructed only in db/index.ts", () => {
  const offenders = sourceFiles()
    .filter(path => importsAnyValue(readFileSync(path, "utf8"), "drizzle-orm/d1"))
    .map(path => toPosix(relative(root, path)))
    .sort();
  assert.deepEqual(
    offenders,
    [],
    "construct Drizzle clients only in db/index.ts; learner code must call getTenantDb(userId)",
  );
});

test("guard scanner detects a synthetic unscoped tenant query", () => {
  const offenders = scanSource(
    "lib/synthetic-offender.ts",
    'db.prepare("SELECT * FROM review_tasks").all();',
  );
  assert.equal(offenders.length, 1);
  assert.match(offenders[0].snippet, /SELECT \* FROM review_tasks/);
});

test("guard scanner accepts synthetic scoped and attributed queries", () => {
  const source = [
    'db.prepare("SELECT * FROM learner_states WHERE user_id=?");',
    'db.prepare("INSERT INTO teacher_feedback (id, user_id) VALUES (?,?)");',
    'db.prepare("SELECT * FROM analysis_artifacts a JOIN review_tasks t ON t.id=a.task_id WHERE t.user_id=?");',
  ].join("\n");
  assert.deepEqual(scanSource("lib/synthetic-scoped.ts", source), []);
});

test("guard scanner rejects the known bypass shapes", () => {
  const source = [
    'db.prepare("SELECT * FROM review_tasks WHERE user_id=? OR 1=1");',
    'db.prepare("SELECT * FROM review_tasks WHERE user_id=user_id");',
    'db.prepare("SELECT * FROM review_tasks t JOIN review_jobs j ON 1=1 WHERE t.user_id=?");',
    'db.prepare("SELECT * FROM review_tasks WHERE user_id=? UNION ALL SELECT * FROM review_tasks");',
  ].join("\n");
  assert.equal(scanSource("lib/synthetic-bypass.ts", source).length, 4);
});

test("no unscoped raw tenant SQL outside the reviewed allowlist", () => {
  const offenders = sourceFiles().flatMap(path =>
    scanSource(toPosix(relative(root, path)), readFileSync(path, "utf8")),
  );
  assert.deepEqual(
    offenders,
    [],
    `unscoped raw tenant SQL found; add a user_id predicate or an explicit reviewed allowlist entry:\n${offenders
      .map(o => `  ${o.file}:${o.line} :: ${o.snippet}`)
      .join("\n")}`,
  );
});