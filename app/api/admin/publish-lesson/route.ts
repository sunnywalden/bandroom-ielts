import { eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { teacherLessons, users } from "@/db/schema";
import { logAdminAudit } from "@/lib/admin";
import { requireAdminScope } from "@/lib/route-guard";
import type { Lesson } from "@/app/curriculum";
import { crossOrigin, json, limitedBody } from "../../shared";

export const dynamic = "force-dynamic";

// H18: admin-publish-to-learner. Shape is validated minimally here (day range +
// object); the full lesson contract is enforced by the learner's state
// transition when the day is started, and by the coach publish path.
const bodySpec = z.strictObject({
  targetUserId: z.string().trim().min(1).max(200),
  day: z.number().int().min(17).max(62),
  lesson: z.record(z.string(), z.unknown()),
});

export async function POST(request: Request) {
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  const auth = await requireAdminScope({ write: true });
  if (auth instanceof Response) return auth;
  const body = await limitedBody(request, 256 * 1024);
  if (body instanceof Response) return body;
  let input: z.infer<typeof bodySpec>;
  try {
    input = bodySpec.parse(JSON.parse(new TextDecoder().decode(body)));
  } catch {
    return json({ error: "invalid_request" }, 400);
  }
  if (!input.lesson.theme || typeof input.lesson.theme !== "string") {
    return json({ error: "invalid_lesson" }, 400);
  }

  const db = getDb();
  const target = await db.select({ userId: users.userId })
    .from(users).where(eq(users.userId, input.targetUserId)).get();
  if (!target) return json({ error: "user_not_found" }, 404);

  const row = await db.insert(teacherLessons)
    .values({
      userId: input.targetUserId,
      day: input.day,
      lesson: input.lesson as unknown as Lesson,
    })
    .onConflictDoNothing()
    .returning({ day: teacherLessons.day })
    .get();

  await logAdminAudit(db, {
    actorUserId: auth.user.userId,
    action: "publish_lesson",
    targetUserId: input.targetUserId,
    metadata: { day: input.day, published: Boolean(row) },
  });
  if (!row) return json({ published: false, error: "lesson_exists" }, 409);
  return json({ published: true, day: row.day });
}