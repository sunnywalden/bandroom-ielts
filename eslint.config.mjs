import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import { TENANT_DB_ALLOWLIST } from "./scripts/tenant-db-allowlist.mjs";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    "dist/**",
    ".vinext/**",
    ".wrangler/**",
    ".sites-runtime/**",
    "outputs/**",
    "work/**",
  ]),
  {
    // MT-5 S4: learner-facing code must reach D1 through getTenantDb(userId) so
    // the tripwire runs; reviewed service/cross-tenant files are allowlisted in
    // scripts/tenant-db-allowlist.mjs. db/index.ts is the only module allowed to
    // construct Drizzle clients.
    files: ["lib/**/*.ts", "app/api/**/*.ts"],
    ignores: TENANT_DB_ALLOWLIST.map(entry => entry.file),
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          {
            name: "@/db",
            importNames: ["getDb"],
            message: "Use getTenantDb(userId) so the tenant tripwire runs. Reviewed service/cross-tenant files belong in scripts/tenant-db-allowlist.mjs.",
          },
          {
            name: "drizzle-orm/d1",
            message: "Construct Drizzle clients only in db/index.ts so every tenant query passes through getTenantDb(userId).",
            allowTypeImports: true,
          },
        ],
      }],
    },
  },
  {
    files: ["components/ui/**/*.{ts,tsx}", "hooks/use-mobile.ts"],
    rules: {
      // These files are vendored verbatim from shadcn@4.17.0. Keep the
      // registry source intact while applying the stricter rules to Site code.
      "@typescript-eslint/no-unused-vars": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
]);

export default eslintConfig;
