import { and, eq } from "drizzle-orm";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { getDb } from "@/db";
import { learnerStates, teacherLessons } from "@/db/schema";
import { hash, uuid } from "@/lib/backup-format";
import { findSubmission, submitReview } from "@/lib/review-jobs";
import { reviewContext } from "@/lib/review-context";
import { reviewAttempts } from "@/app/feedback-model";
import { linkedRecordings } from "@/lib/recording-recovery";
import { crossOrigin, json, limitedBody } from "../shared";

import { env } from "cloudflare:workers";
import { getExercises } from "../../curriculum";
import { validTransition, same } from "./transition";

export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  const result = await getDb().select({ revision: learnerStates.revision, state: learnerStates.state })
    .from(learnerStates).where(eq(learnerStates.userId, user.userId)).get();
  return json({ account:user.userId, ...(result ?? { revision: 0, state: null }) });
}

export async function PUT(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "sign_in_required" }, 401);
  if (crossOrigin(request)) return json({ error: "invalid_origin" }, 403);
  if (request.headers.get("X-Bandroom-Account")!==user.userId) return json({error:"refresh_account"},428);
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

  const submissionKey = payload?.submissionKey;
  if (submissionKey !== undefined && (typeof submissionKey !== "string" || !uuid.test(submissionKey)))
    return json({ error: "invalid_submission_key" }, 400);
  const requestHash = submissionKey ? await hash(body) : "";
  const receipt = (job: NonNullable<Awaited<ReturnType<typeof findSubmission>>>) =>
    job.requestHash === requestHash
      ? json({ revision: job.revision, attemptId: job.id, submissionKey, sourceId: job.snapshot.sourceId })
      : json({ error: "submission_key_conflict" }, 409);
  if (submissionKey) {
    const saved = await findSubmission(user.userId, submissionKey);
    if (saved) return receipt(saved);
  }
  const db = getDb();
  const read = () => db.select({ revision: learnerStates.revision, state: learnerStates.state })
    .from(learnerStates).where(eq(learnerStates.userId, user.userId)).get();
  const prior=await read();
  // A lost response may cause an exact replay. A divergent stale write must still conflict.
  const conflict=(row:typeof prior)=>row&&row.revision===revision+1 && same(row.state,state)
    ? json({revision:row.revision}) : json({error:"revision_conflict"},409);
  if ((prior?.revision ?? 0) !== revision) {
    if (submissionKey) {
      const saved = await findSubmission(user.userId, submissionKey);
      return saved ? receipt(saved) : json({ error: "revision_conflict" }, 409);
    }
    return conflict(prior);
  }
  if (!Number.isInteger(state.day)||state.day<11||state.day>62) return json({error:"invalid_checkpoint"},422);
  const lesson=state.day<=16?getExercises(state.day):(await db.select({lesson:teacherLessons.lesson}).from(teacherLessons)
    .where(and(eq(teacherLessons.userId,user.userId),eq(teacherLessons.day,state.day))).get())?.lesson;
  if (state.day>=12&&!lesson) return json({error:"lesson_unavailable"},422);
  if (!validTransition(prior?.state,state,lesson)) return json({error:"invalid_transition"},422);
  const previous=prior?.state as typeof state|undefined, refs:{id:string;phase:string}[]=[];
  const entry=state.entries[state.day]??{}, old=previous?.entries?.[state.day]??{};
  for (const key of ["speakingPart2","speakingFollowup"]) {
    if (entry[key]===old[key]||!entry[key]) continue;
    const last=JSON.parse(entry[key]).at(-1);
    if (last?.audio) refs.push({id:last.audio,phase:key==="speakingPart2"?"part2":"followup"});
  }
  if ((state.fullTests?.length??0)>(previous?.fullTests?.length??0) && state.fullTests.at(-1)?.audio)
    refs.push({id:state.fullTests.at(-1).audio,phase:"assessment"});
  const linked=refs.length&&previous?linkedRecordings(previous):new Set<string>();
  const recordingIdentities = new Map<string, { sha256: string; bytes: number }>();
  for (const {id,phase} of refs) {
    if (!env.BUCKET) return json({error:"recordings_unavailable"},503);
    const object=await env.BUCKET.head(`speaking/${encodeURIComponent(user.userId)}/${id}`);
    if (!object)
      return json({error:"recording_not_found"},422);
    const m=object.customMetadata;
    if(linked.has(id)||(m?.purpose==="assessment"&&phase!=="assessment")||(m?.purpose==="speaking"&&(m.day!==String(state.day)||m.phase!==phase)))
      return json({error:"recording_question_mismatch"},422);
    if (m?.digest && /^[0-9a-f]{64}$/.test(m.digest) && Number.isSafeInteger(object.size) && object.size > 0)
      recordingIdentities.set(id, { sha256: m.digest, bytes: object.size });
    linked.add(id);
  }
  if (submissionKey) {
    const before = await reviewAttempts(state.day, old);
    const after = await reviewAttempts(state.day, entry);
    const submitted = after.filter(a => a.kind === "subjective" && !before.some(b => a.id === b.id));
    if (submitted.length !== 1 || state.finished || state.stage !== submitted[0].stage)
      return json({ error: "invalid_review_submission" }, 422);
    const attempt = submitted[0];
    const recording = attempt.recordingId ? recordingIdentities.get(attempt.recordingId) : undefined;
    const saved = await submitReview(user.userId, submissionKey, requestHash, revision, state, {
      sourceId: attempt.id, attempt: { ...attempt, id: "v2:" + crypto.randomUUID() },
      context: reviewContext(attempt, lesson),
      ...(recording && { recording }),
    }, env.ANALYSIS_BUNDLE_VERSION);
    return saved ? receipt(saved) : json({ error: "revision_conflict" }, 409);
  }
  if (prior&&same(prior.state,state)) return json({revision:prior.revision});
  const returning = { revision: learnerStates.revision };
  const result = revision === 0
    ? await db.insert(learnerStates).values({ userId: user.userId, revision: 1, state })
        .onConflictDoNothing({ target: learnerStates.userId }).returning(returning).get()
    : await db.update(learnerStates).set({ revision: revision + 1, state })
        .where(and(eq(learnerStates.userId, user.userId), eq(learnerStates.revision, revision)))
        .returning(returning).get();
  return result ? json(result) : conflict(await read());
}
