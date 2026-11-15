#!/usr/bin/env node
// Self-hosted deployment for the vinext Worker.
//
//   node scripts/own-deploy.mjs --dry-run
//   BANDROOM_D1_DATABASE_ID=<uuid> BANDROOM_DOMAIN=bandroom.example.com \
//     node scripts/own-deploy.mjs --environment prod
//
// The merged Wrangler config is written *inside* dist/server/ so the generated
// `main` and `assets.directory` paths keep resolving relative to their build
// layout. Only this script writes deployment configuration; the build output is
// otherwise untouched.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

export const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const wranglerBin = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);

const D1_PLACEHOLDER_ID = "00000000-0000-4000-8000-000000000000";

/**
 * Parse the JSON-with-comments subset used by wrangler config templates.
 * Handles line/block comments, trailing commas and `${VAR}` placeholders.
 */
export function parseJsonc(text) {
  let stripped = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        stripped += char;
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
        stripped += " ";
      }
      continue;
    }
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    stripped += char;
  }

  // Drop trailing commas outside strings.
  let output = "";
  inString = false;
  escaped = false;
  for (let index = 0; index < stripped.length; index += 1) {
    const char = stripped[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let ahead = index + 1;
      while (ahead < stripped.length && /\s/.test(stripped[ahead])) ahead += 1;
      if (stripped[ahead] === "}" || stripped[ahead] === "]") continue;
    }
    output += char;
  }
  return JSON.parse(output);
}

function substitute(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Z0-9_]+)\}/g, (match, name) =>
      Object.hasOwn(variables, name) ? String(variables[name]) : match,
    );
  }
  if (Array.isArray(value)) return value.map((entry) => substitute(entry, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, substitute(entry, variables)]),
    );
  }
  return value;
}

function unresolvedPlaceholders(value, path = "", found = []) {
  if (typeof value === "string") {
    const matches = value.match(/\$\{[A-Z0-9_]+\}/g);
    if (matches) found.push(`${path || "<root>"}: ${matches.join(", ")}`);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => unresolvedPlaceholders(entry, `${path}[${index}]`, found));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      unresolvedPlaceholders(entry, path ? `${path}.${key}` : key, found);
    }
  }
  return found;
}

/**
 * Merge the build's wrangler.json with the self-hosted template.
 *
 * `main`/`assets` always come from the build output; binding collections and
 * deployment constraints come from the template. The result is a plain object
 * intended to be written next to the build's wrangler.json.
 */
export function mergeWranglerConfig(base, overrides, migrationsDir) {
  const merged = { ...base, ...overrides };
  // Relative paths in the generated config must keep their original anchor.
  if (base.main !== undefined) merged.main = base.main;
  if (base.assets !== undefined) merged.assets = base.assets;
  // Deployment hardening is not optional.
  merged.workers_dev = false;
  merged.preview_urls = false;
  delete merged.$schema;
  if (Array.isArray(merged.d1_databases)) {
    merged.d1_databases = merged.d1_databases.map((database) => ({
      ...database,
      migrations_dir: migrationsDir,
    }));
  }
  return merged;
}

export function listMigrations(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
}

export function verifyMigrationSequence(files) {
  if (!files.length) throw new Error("No drizzle migrations found.");
  files.forEach((file, index) => {
    const prefix = file.slice(0, 4);
    const expected = String(index).padStart(4, "0");
    if (prefix !== expected) {
      throw new Error(
        `Migration sequence gap: expected ${expected}_*.sql at position ${index}, found ${file}.`,
      );
    }
  });
  return files;
}

function parseArgs(argv) {
  const args = { dryRun: false };
  const valueFlags = new Map([
    ["--config", "config"],
    ["--dist", "dist"],
    ["--drizzle", "drizzle"],
    ["--environment", "environment"],
    ["--name", "name"],
    ["--domain", "domain"],
    ["--d1-name", "d1Name"],
    ["--d1-id", "d1Id"],
    ["--r2", "r2"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") args.dryRun = true;
    else if (flag === "--no-route") args.noRoute = true;
    else if (flag === "--skip-migrations") args.skipMigrations = true;
    else if (flag === "--skip-schema-check") args.skipSchemaCheck = true;
    else if (flag === "--skip-deploy") args.skipDeploy = true;
    else if (flag === "--local") args.local = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else if (valueFlags.has(flag)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${flag} requires a value.`);
      }
      args[valueFlags.get(flag)] = value;
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return args;
}

function runWrangler(label, wranglerArgs) {
  process.stderr.write(`[own-deploy] ${label}\n`);
  const result = spawnSync(process.execPath, [wranglerBin, ...wranglerArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}.`);
  }
}

function wranglerJson(wranglerArgs) {
  const result = spawnSync(process.execPath, [wranglerBin, ...wranglerArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `wrangler failed (exit ${result.status}): ${(result.stderr || result.stdout || "").trim()}`,
    );
  }
  const text = result.stdout ?? "";
  const start = text.indexOf("[");
  if (start === -1) throw new Error("wrangler did not return JSON.");
  return JSON.parse(text.slice(start));
}

function appliedMigrationNames(payload) {
  const rows = Array.isArray(payload)
    ? payload.flatMap((entry) => entry?.results ?? [])
    : payload?.results ?? [];
  return new Set(rows.map((row) => row?.name).filter((name) => typeof name === "string"));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(`Usage: node scripts/own-deploy.mjs [options]

Options:
  --dry-run              Print the merged config and planned commands; no deploy.
  --config <path>        Wrangler override template (default wrangler.own.jsonc).
  --dist <path>          Built server directory (default dist/server).
  --drizzle <path>       Drizzle migrations directory (default drizzle).
  --environment <name>   Defaults profile: qa (default) or prod.
  --name <name>          Worker name (env BANDROOM_WORKER_NAME).
  --domain <hostname>    Custom domain route (env BANDROOM_DOMAIN).
  --d1-name <name>       D1 database name (env BANDROOM_D1_DATABASE_NAME).
  --d1-id <uuid>         D1 database id (env BANDROOM_D1_DATABASE_ID).
  --r2 <name>            R2 bucket name (env BANDROOM_R2_BUCKET_NAME).
  --no-route             Omit the custom-domain route.
  --local                Apply migrations locally instead of --remote.
  --skip-migrations      Skip wrangler d1 migrations apply.
  --skip-schema-check    Skip the d1_migrations verification query.
  --skip-deploy          Merge and migrate without wrangler deploy.
`);
    return;
  }

  const configPath = args.config
    ? resolve(process.cwd(), args.config)
    : resolve(repoRoot, "wrangler.own.jsonc");
  const distDir = args.dist ? resolve(process.cwd(), args.dist) : resolve(repoRoot, "dist", "server");
  const drizzleDir = args.drizzle
    ? resolve(process.cwd(), args.drizzle)
    : resolve(repoRoot, "drizzle");
  const environment = args.environment ?? "qa";
  if (!["qa", "prod"].includes(environment)) {
    throw new Error("--environment must be qa or prod.");
  }

  const basePath = resolve(distDir, "wrangler.json");
  if (!existsSync(basePath)) {
    throw new Error(`Missing build config ${basePath}; run the build first.`);
  }
  if (!existsSync(configPath)) {
    throw new Error(`Missing deployment template ${configPath}.`);
  }

  const migrations = verifyMigrationSequence(listMigrations(drizzleDir));
  const template = parseJsonc(readFileSync(configPath, "utf8"));

  const d1IdProvided = Boolean(
    args.d1Id ?? process.env.BANDROOM_D1_DATABASE_ID,
  );
  const domainProvided = Boolean(
    args.domain ?? process.env.BANDROOM_DOMAIN,
  );
  const variables = {
    WORKER_NAME: args.name ?? process.env.BANDROOM_WORKER_NAME ?? `bandroom-${environment}`,
    D1_DATABASE_NAME:
      args.d1Name ?? process.env.BANDROOM_D1_DATABASE_NAME ?? `bandroom-${environment}`,
    D1_DATABASE_ID:
      args.d1Id ??
      process.env.BANDROOM_D1_DATABASE_ID ??
      (args.dryRun ? D1_PLACEHOLDER_ID : ""),
    R2_BUCKET_NAME:
      args.r2 ?? process.env.BANDROOM_R2_BUCKET_NAME ?? `bandroom-${environment}-uploads`,
    BANDROOM_DOMAIN:
      args.domain ?? process.env.BANDROOM_DOMAIN ?? (args.dryRun ? `bandroom-${environment}.example.com` : ""),
  };

  let overrides = substitute(template, variables);
  if (args.noRoute || !variables.BANDROOM_DOMAIN) delete overrides.routes;
  else if (Array.isArray(overrides.routes)) {
    overrides.routes = overrides.routes.filter(
      (route) => route && typeof route.pattern === "string" && route.pattern.length > 0,
    );
    if (!overrides.routes.length) delete overrides.routes;
  }

  const base = JSON.parse(readFileSync(basePath, "utf8"));
  const merged = mergeWranglerConfig(base, overrides, resolve(drizzleDir));
  const unresolved = unresolvedPlaceholders(merged);

  if (merged.main) {
    const mainPath = resolve(distDir, merged.main);
    if (!existsSync(mainPath)) {
      throw new Error(`Worker entry ${mainPath} is missing from the build.`);
    }
  }
  if (!args.dryRun) {
    if (!d1IdProvided) {
      throw new Error(
        "Set BANDROOM_D1_DATABASE_ID (or --d1-id) before deploying; refusing to use a placeholder id.",
      );
    }
    if (!domainProvided && !args.noRoute) {
      throw new Error(
        "Set BANDROOM_DOMAIN (or --domain), or pass --no-route deliberately.",
      );
    }
    if (unresolved.length) {
      throw new Error(`Unresolved config placeholders:\n${unresolved.join("\n")}`);
    }
  }

  const mergedPath = resolve(distDir, "wrangler.own.json");
  mkdirSync(dirname(mergedPath), { recursive: true });
  writeFileSync(mergedPath, `${JSON.stringify(merged, null, 2)}\n`);

  const remoteFlag = args.local ? "--local" : "--remote";
  const commands = [
    ["d1", "migrations", "apply", "DB", remoteFlag, "--config", mergedPath],
    [
      "d1", "execute", "DB", remoteFlag, "--config", mergedPath, "--json",
      "--command", "SELECT name FROM d1_migrations ORDER BY id ASC",
    ],
    ["deploy", "--config", mergedPath],
  ];

  if (args.dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          dryRun: true,
          configPath: mergedPath,
          migrations,
          commands,
          warnings: unresolved.length
            ? [`Unresolved placeholders (dry run only): ${unresolved.join("; ")}`]
            : [],
          config: merged,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stderr.write(`[own-deploy] merged config written to ${mergedPath}\n`);
  if (!args.skipMigrations) {
    runWrangler("applying D1 migrations", commands[0]);
  }
  if (!args.skipSchemaCheck) {
    const applied = appliedMigrationNames(wranglerJson(commands[1]));
    const missing = migrations.filter((name) => !applied.has(name));
    if (missing.length) {
      throw new Error(`D1 is missing migrations: ${missing.join(", ")}`);
    }
    process.stderr.write(`[own-deploy] schema check: ${migrations.length} migrations applied\n`);
  }
  if (!args.skipDeploy) {
    runWrangler("deploying Worker", commands[2]);
  }
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[own-deploy] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}