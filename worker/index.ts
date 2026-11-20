import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { runRetention } from "../lib/retention";
import { aggregateTenantMetrics } from "@/lib/metrics";

const worker = {
  fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    let binding = ctx.props?.CONNECTORS;
    // Local preview emulates the same request-scoped capability. This branch and
    // the auxiliary service binding are absent from production builds.
    if (import.meta.env.DEV && !binding && env.CONNECTORS) {
      const preview = env.CONNECTORS;
      const expiresAt = Date.now() + 60_000;
      binding = {
        async getContext() {
          if (Date.now() >= expiresAt) return { status: "request_context_expired" };
          return preview.getContext?.() ?? { status: "binding_unavailable" };
        },
        async invoke(connectorId, actionName, args) {
          if (Date.now() >= expiresAt) {
            return { status: "request_context_expired", message: "This request has expired. Please try again." };
          }
          return preview.invoke(connectorId, actionName, args);
        },
      };
    }
    return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
  },

  // MT-3 daily retention sweep (wrangler.own.jsonc `triggers.crons`). The
  // scheduled context has no request scope, so use the env bindings directly
  // instead of the request-scoped `getDb()`.
  scheduled(_controller: ScheduledController, env: Cloudflare.Env, ctx: ExecutionContext) {
    if (!env.DB || !env.BUCKET) {
      console.error("retention: DB or BUCKET binding unavailable; skipping purge");
    } else {
      ctx.waitUntil(
        runRetention(env.DB, env.BUCKET, Date.now()).catch(error => {
          console.error("retention: scheduled purge failed", error);
        }),
      );
    }

    // MT-4: per-tenant metrics aggregation runs alongside retention. It only
    // needs D1, so it still runs when the R2 binding is absent.
    if (env.DB) {
      ctx.waitUntil(
        aggregateTenantMetrics(env.DB, Date.now()).catch(error => {
          console.error("metrics: scheduled aggregation failed", error);
        }),
      );
    } else {
      console.error("metrics: DB binding unavailable; skipping aggregation");
    }
  },
};

export default worker;
