import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { learnerStates } from "@/db/schema";
import { crossOrigin, json, limitedBody } from "../shared";

import { validTransition } from "./transition";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  const result = await getDb().select({ revision: learnerStates.revision, state: learnerStates.state })
    .from(learnerStates).where(eq(learnerStates.userId, user.userId)).get();
  return json(result ?? { revision: 0, state: null });
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json")
    return json({ error: "expected_json" }, 415);

  const body = await limitedBody(request, 1024 * 1024);
  if (body instanceof Response) return body;
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const revision = payload?.revision;
  const state = payload?.state;
  if (!Number.isSafeInteger(revision) || revision < 0 || revision >= Number.MAX_SAFE_INTEGER
    || !state || typeof state !== "object" || Array.isArray(state))
    return json({ error: "invalid_checkpoint" }, 400);

  const db = getDb();
  const prior = await db.select({ revision: learnerStates.revision, state: learnerStates.state })
    .from(learnerStates).where(eq(learnerStates.userId, user.userId)).get();
  if ((prior?.revision ?? 0) !== revision) return json({ error: "revision_conflict" }, 409);
  if (!validTransition(prior?.state, state)) return json({ error: "invalid_transition" }, 422);
  const returning = { revision: learnerStates.revision };
  const result = revision === 0
    ? await db.insert(learnerStates).values({ userId: user.userId, revision: 1, state })
        .onConflictDoNothing({ target: learnerStates.userId }).returning(returning).get()
    : await db.update(learnerStates).set({ revision: revision + 1, state })
        .where(and(eq(learnerStates.userId, user.userId), eq(learnerStates.revision, revision)))
        .returning(returning).get();
  return result ? json(result) : json({ error: "revision_conflict" }, 409);
}
