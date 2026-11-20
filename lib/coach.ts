import { reviewAttempts, feedbackFor } from "@/app/feedback-model";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { automationHeartbeats, learnerStates, reviewTasks, teacherFeedback, teacherLessons } from "@/db/schema";
import { getExercises, type Lesson } from "@/app/curriculum";
import { targets, overallTarget } from "@/app/goals";
import { coachingContentViolation } from "./content-rules";
import { assertConsent, ConsentError } from "./consent";
import { frozenReviews } from "./review-jobs";
import { reviewContext } from "./review-context";
import { listRecoverable } from "./recording-recovery";
import { initial, oldResults, part3, writings, type Ledger } from "@/app/ledger";
import { callReviewTool, reviewTools, type ReviewToolOptions } from "./review-tools";
import { calibrationToolNames, calibrationTools, callCalibrationTool, issueCalibrationCandidates, verdictsForCandidates } from "./calibration";
import { claimManualReviewTask, completeReviewTask, createReviewTaskStatement, findReviewTaskByAttempt, reviewTaskDb, ReviewTaskError } from "./review-tasks";

const text = (max: number, description: string) => z.string().trim().min(1).max(max).describe(description);
const term = text(160, "English word, phrase or collocation.");
const gloss = text(300, "Concise Chinese gloss.");
const prompt = text(1400, "One question or instruction in English.");
const pair = z.strictObject({term, meaning:gloss});
const word = z.strictObject({term, meaning:gloss, example:prompt});
const item = z.strictObject({
  prompt, choices:z.array(prompt).length(3).describe("Three distinct answer options, in display order."),
  answer:z.number().int().min(0).max(2).describe("Zero-based index of the correct option."),
  why:text(900,"Evidence-based explanation in Chinese for display after submission."),
});
const lessonSpec = z.strictObject({
  theme:text(120,"Short English lesson title."),
  speaking:prompt.describe("Part 2 cue about an experience; include what to describe and explain."),
  followup:prompt.describe("An independent Part 3 discussion question."),
  words:z.array(word).length(3).describe("Exactly three new English words with meaning and example."),
  phrases:z.array(pair).length(2), collocations:z.array(pair).length(2),
  recall:z.strictObject({prompt, answer:term}),
  use:prompt.describe("One instruction for independent production using the new expressions."),
  audioTitle:text(160,"Verified title of the source on British Council LearnEnglish."),
  slug:z.string().max(150).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("Final URL segment of an existing British Council /free-resources/listening/c1/ lesson. Check the actual audio and transcript before publishing."),
  listening:z.array(item).length(2).describe("Two original questions about the verified C1 audio."),
  readingTitle:text(160,"English title of the original reading."),
  passage:text(7000,"Original English passage containing the evidence needed for both questions."),
  reading:z.array(item).length(2).describe("Two original questions supported by this passage."),
  writing:prompt.describe("Independent English writing task, including word count and scope."),
  edit:text(1000,"Revision instructions shown after the original draft."),
  fullEssay:z.boolean().optional().describe("True only for a complete timed Task 2 essay."),
});

// The plugin generator supports homogeneous items schemas. Keep the original saved tuple representation.
function toLesson(input:z.infer<typeof lessonSpec>):Lesson {
  const pairValue=(x:z.infer<typeof pair>):[string,string]=>[x.term,x.meaning];
  const mc=(q:z.infer<typeof item>)=>({...q,choices:q.choices as [string,string,string]});
  return {...input,words:input.words.map(w=>[w.term,w.meaning,w.example]),phrases:input.phrases.map(pairValue),
    collocations:input.collocations.map(pairValue),recall:[input.recall.prompt,input.recall.answer],
    listening:[mc(input.listening[0]),mc(input.listening[1])],reading:[mc(input.reading[0]),mc(input.reading[1])]};
}
function compatibleLesson(value:unknown):unknown {
  if(!value||typeof value!=="object"||!("lesson" in value)||!value.lesson||typeof value.lesson!=="object")return value;
  const l=value.lesson as Record<string,unknown>;
  const tuples=(rows:unknown,keys:string[])=>Array.isArray(rows)?rows.map(row=>Array.isArray(row)&&row.length===keys.length?Object.fromEntries(keys.map((k,i)=>[k,row[i]])):row):rows;
  return {...value,lesson:{...l,words:tuples(l.words,["term","meaning","example"]),phrases:tuples(l.phrases,["term","meaning"]),
    collocations:tuples(l.collocations,["term","meaning"]),recall:Array.isArray(l.recall)&&l.recall.length===2?{prompt:l.recall[0],answer:l.recall[1]}:l.recall}};
}
const dayNumber = z.number().int().min(1).max(62);
const stageName = z.enum(["speak","vocab","listen","read","write","review"]);
const readSpec = z.strictObject({ attemptId:text(160,"Exact attempt ID. When set, return only this submitted question, its answer and feedback.").optional(), inspectUnlinkedRecordings:z.boolean().optional().describe("Check for this account’s uploaded but unlinked audio for the active question. Legacy matches are time-window candidates requiring learner audition."), day: dayNumber.optional().describe("Day to inspect; defaults to the current day. Only started days are accessible.") });
const feedbackSpec = z.strictObject({
  day: dayNumber, stage: stageName, feedback: text(6000, "Specific coaching feedback addressed to the learner."),
  evidence: text(2000, "Identify the submitted text or audible sample, its conditions, and evidence used. No pronunciation assessment from text."),
  recordingId:z.uuidv4().optional().describe("Only for feedback based on speech you actually heard. Must identify this day’s submitted recording."),
  pronunciation:z.strictObject({
    band:z.number().min(0).max(9).multipleOf(.5).describe("Provisional pronunciation-only estimate for this single recorded answer, in half-bands."),
    reviewedWholeClip:z.literal(true).describe("Confirm you personally heard the whole clip in an audio-capable client."),
    observation:text(1000,"Concrete audible words, sounds, stress, rhythm or intelligibility observations from this particular attempt."),
  }).optional().describe("Optional practice rating only with recordingId, actual audible evidence and full-clip listening. Leave absent for transcripts, metadata, technical decoding or text-only clients. Never aggregate into an overall Speaking band."),
  attempt: text(160, "Use the exact reviewAttempts[].id from read_study_session for the answer being reviewed. Legacy descriptive labels are for historic records only. Never invent an ID."),
  // Contract amendment (design rev2 FIX-6 / review BL-F): the grounded speaking
  // path needs a transport for its tiered evidence. feedbackSpec was a closed
  // strictObject with no analysis field, so the three-tier provenance had no way
  // to reach the DB. This optional, bounded object is that transport. The server
  // issues candidateIds itself — the runner never supplies them — and stores the
  // enriched analysis via completeReviewTask's output.analysis.
  groundedAnalysis:z.strictObject({
    detectorVersion:text(80,"Detector identity; a profile built by another detector fails closed."),
    inventoryVersion:text(80,"Phone inventory identity, e.g. arpabet-v1."),
    speechSeconds:z.number().min(0).max(10800).describe("Effective speech duration, for the showing-policy-invariant progress metric."),
    candidates:z.array(z.strictObject({
      word:text(80,"The learner word this candidate points at."),expected:text(8,"ARPABET"),actual:text(8,"ARPABET"),
      atMs:z.number().int().min(0).max(10800000),
      detectorConfidence:z.number().min(0).max(1),
      tier:z.enum(["T2","T3"]).describe("T2 is history-conditioned SUGGESTION, not assertion; T2 promotion is RETIRED (structurally unreachable, owner 2026-11-19), so items render as T3."),
      catchTrial:z.boolean().optional().describe("Control item; stored as expected===actual and excluded from profile counts."),
    })).max(24).describe("Bounded to keep the payload and the issuance transaction small."),
    // Speaking redesign (docs/speaking-redesign-2026-11-19.md): ELSA-style
    // score-first feedback. The transcript is ASR (status=asr), never verified
    // ground truth; the scorecard carries mandatory evidence statuses and a
    // NULL pronunciation band while phoneme assertion gates are unmet.
    transcript:z.array(z.strictObject({
      word:text(80,"One ASR transcript word."),
      start:z.number().min(0).max(10800),end:z.number().min(0).max(10800),
      probability:z.number().min(0).max(1),
    })).max(2000).optional().describe("Whisper word timings for click-to-relisten; ASR, not verified text."),
    scorecard:z.object({
      schema:z.literal("bandroom-speaking-scorecard-v1"),
      overall:z.object({band:z.number().min(0).max(9).multipleOf(.5).nullable(),status:z.string(),disclosure_zh:z.string(),basis_zh:z.string()}).passthrough(),
      criteria:z.array(z.object({key:z.string(),label_zh:z.string(),band:z.number().min(0).max(9).nullable(),status:z.string(),disclosure_zh:z.string()}).passthrough()).min(1).max(6),
      drills:z.array(z.object({quote:z.string(),improved:z.string(),focus_zh:z.string()}).passthrough()).max(3).optional(),
      llm_status:z.string().optional(),
    }).passthrough().refine(
      card=>!card.criteria.some(c=>c.key==="pronunciation"&&c.band!=null),
      "Pronunciation band is forbidden while phoneme assertion gates are unmet.",
    ).optional().describe("Score-first feedback; every band is a disclosed reference estimate, pronunciation never scored."),
  }).optional().describe("Grounded speaking evidence only. Requires stage=speak and recordingId. Omit for text reviews."),
});
const publishSpec = z.strictObject({ day: z.number().int().min(17).max(62), lesson: lessonSpec });
// MT-2 (S3.1): learner self-note. Deliberately has NO pronunciation, NO
// groundedAnalysis, NO recordingId, NO scorecard — a learner cannot forge
// coach/detector output or issue calibration candidates. Content rules still
// forbid overall-band claims. Stored with author_scope='learner-note'.
const learnerNoteSpec = z.strictObject({
  day: dayNumber, stage: stageName,
  attempt: text(160, "The exact reviewAttempts[].id this note refers to."),
  feedback: text(6000, "Your own reflection or self-assessment note. Not a coach rating."),
  evidence: text(2000, "Optional: what you observed in your own answer.").optional(),
});
const recordingSpec = z.strictObject({
  day:dayNumber, recordingId:z.uuidv4().describe("Submitted remote audio ID shown in the learner’s saved answer."),
  mode:z.enum(["audio","metadata","bytes"]).optional().describe("audio returns an audible block where supported; metadata gives exact byte count and MIME; bytes returns a small base64 range for private local audio decoding when the client omits audio blocks."),
  offset:z.number().int().min(0).max(12*1024*1024).optional().describe("Zero-based byte offset; only used in bytes mode."),
  length:z.number().int().min(1).max(24576).optional().describe("Bytes to return in bytes mode, default 12288. Follow nextOffset until null. Never show raw base64 to the learner."),

});

const coachingTools = [
  {name:"read_study_session",description:"Read canonical reviewAttempts IDs, question context and pending reviews, plus the learner's checkpoint and selected day's saved answers and available original/revised writing, historical results, coach feedback and current small task. Audio references require read_speaking_recording. Never start or complete a day.",schema:readSpec,readOnly:true},
  {name:"add_coach_feedback",description:"Append a private, evidence-based review using its exact reviewAttempts[].id; the page automatically displays it beside that answer. Review one identified attempt for a started day. First use read_study_session or inspect the learner's actual submitted evidence. Never infer pronunciation from a transcript. Existing attempts and scores remain intact; identical retries are deduplicated.",schema:feedbackSpec,readOnly:false},
  {name:"add_learner_note",description:"Save your own reflection or self-assessment note for one submitted attempt. This is a learner note, not a coach rating: it cannot carry a pronunciation band, scorecard, or calibration candidates. Use the exact reviewAttempts[].id from read_study_session.",schema:learnerNoteSpec,readOnly:false},
  {name:"publish_lesson",description:"Add one complete new lesson to this learner's private catalogue for Day 17–62. Verify the British Council source audio, transcript and q/a; use original reading material. Match the learner's exam pathway and budget. Use only after the learner requests preparation or expansion; this does not start the day. A published day cannot be replaced.",schema:publishSpec,readOnly:false},
  {name:"read_recording_bytes",description:"Code-capable clients: retrieve one bounded byte range of the learner's submitted recording, before decoding audio locally. Never display base64. Supply offset=0 for the first block and use nextOffset until null. Use this when an older read_speaking_recording schema lacks bytes mode.",schema:z.strictObject({day:dayNumber,recordingId:z.uuidv4(),offset:z.number().int().min(0).max(12*1024*1024),length:z.number().int().min(1).max(24576).optional()}),readOnly:true},
  {name:"read_speaking_recording",description:"Read a submitted recording. Use audio mode first. If the client omits the sound, retrieve metadata then bytes and reconstruct privately in a supported audio decoder. Technical verification or text alone cannot justify pronunciation or fluency ratings. Device-only recordings can be played in the recording browser.",schema:recordingSpec,readOnly:true},
].map(({schema,readOnly,...tool})=>({...tool,inputSchema:z.toJSONSchema(schema),annotations:{readOnlyHint:readOnly,destructiveHint:false}}));

const reviewToolNames = new Set(reviewTools.map(tool => tool.name));
// Pronunciation calibration tools are appended last so the reviewed 16-tool
// contract stays in its frozen order; rev2 §9 adds exactly these three.
export const coachTools = [...coachingTools, ...reviewTools, ...calibrationTools];

const feedbackColumns = {id:teacherFeedback.id,day:teacherFeedback.day,stage:teacherFeedback.stage,
  feedback:teacherFeedback.feedback,evidence:teacherFeedback.evidence,pronunciation:teacherFeedback.pronunciation,analysisJson:teacherFeedback.analysisJson,attempt:teacherFeedback.attempt,authorScope:teacherFeedback.authorScope,createdAt:teacherFeedback.createdAt};

async function reviews(userId:string, day?:number) {
  const rows=await getDb().select(feedbackColumns).from(teacherFeedback)
    .where(day === undefined ? eq(teacherFeedback.userId,userId)
      : and(eq(teacherFeedback.userId,userId),eq(teacherFeedback.day,day)))
    .orderBy(desc(teacherFeedback.createdAt),desc(teacherFeedback.id));
  // Decorating stored items with the learner's self-listen verdicts keeps the
  // scorecard transcript colors (red=confirmed, green=rejected) alive across
  // reloads; the verdicts live in calibration_events, never in analysisJson.
  const candidateIds=rows.flatMap(({analysisJson})=>{
    const items=(analysisJson as {items?:Array<{candidateId?:string}>}|null)?.items;
    return Array.isArray(items)?items.map(item=>item?.candidateId).filter((id):id is string=>typeof id==='string'):[];
  });
  const verdicts=await verdictsForCandidates(reviewTaskDb(),userId,candidateIds);
  return rows.map(({analysisJson,...row})=>{
    const raw=analysisJson as {items?:Array<Record<string,unknown>>}|null;
    // Only touch analyses that actually carry candidate items; legacy shapes
    // (errors/coverage) must pass through untouched.
    const analysis=raw
      ?(Array.isArray(raw.items)
        ?{...raw,items:raw.items.map(item=>({
          ...item,
          ...(typeof item.candidateId==='string'&&verdicts[item.candidateId]&&item.isCatchTrial!==true
            ?{priorVerdict:verdicts[item.candidateId]}:{}),
        }))}
        :raw)
      :undefined;
    return {
      ...row,
      ...(row.pronunciation?{evidence:row.evidence+` · 发音专项暂定 ${row.pronunciation.band.toFixed(1)}/9（本次录音）· ${row.pronunciation.observation}`}:{}),
      ...(analysis?{analysis}:{}),
    };
  });
}
export async function coachData(userId:string) {
  const [lessons,feedback,jobs,tasks,heartbeats] = await Promise.all([
    getDb().select({day:teacherLessons.day,lesson:teacherLessons.lesson}).from(teacherLessons).where(eq(teacherLessons.userId,userId)), reviews(userId), frozenReviews(userId),
    getDb().select({
      id:reviewTasks.id, attemptId:reviewTasks.attemptId, kind:reviewTasks.kind, state:reviewTasks.state,
      stage:reviewTasks.stage, nextAt:reviewTasks.nextAt, lastError:reviewTasks.lastError, updatedAt:reviewTasks.updatedAt,
    }).from(reviewTasks).where(eq(reviewTasks.userId,userId)).orderBy(desc(reviewTasks.updatedAt)).limit(50),
    // A rolling deploy may reach this code before migration 0006 lands; treat
    // a missing table as "no connected automation" instead of failing /coach.
    Promise.resolve(getDb().select({
      startedAt:automationHeartbeats.startedAt,lastSuccessAt:automationHeartbeats.lastSuccessAt,
      nextExpectedAt:automationHeartbeats.nextExpectedAt,status:automationHeartbeats.status,
    }).from(automationHeartbeats).where(eq(automationHeartbeats.userId,userId))
      .orderBy(desc(automationHeartbeats.startedAt)).limit(1)).catch(()=>[]),
  ]);
  const heartbeat=heartbeats[0],now=Date.now();
  const last=heartbeat?.lastSuccessAt??heartbeat?.startedAt??null;
  const next=heartbeat?.nextExpectedAt??null;
  const automation={
    connected:Boolean(heartbeat&&heartbeat.status!=='failed'&&
      ((last!==null&&now-last<=2*60*60_000)||(next!==null&&now<=next+15*60_000))),
    lastSuccessAt:heartbeat?.lastSuccessAt??null,
    nextExpectedAt:next,
    status:heartbeat?.status??null,
  };
  return {account:userId,extras:Object.fromEntries(lessons.map(({day,lesson})=>[day,lesson])),feedback,
    reviewLinks:jobs.map(({id,day,snapshot})=>({id,day,sourceId:snapshot.sourceId})),reviewTasks:tasks,automation};
}

class CoachError extends Error {}
async function checkpoint(userId:string) {
  const row = await getDb().select().from(learnerStates).where(eq(learnerStates.userId,userId)).get();
  const seed = initial();
  if (!row) return {revision:0,ledger:seed};
  const ledger = {...seed,...row.state} as Ledger;
  if (!dayNumber.safeParse(ledger.day).success || !stageName.safeParse(ledger.stage).success
      || !Array.isArray(ledger.completed) || !ledger.entries || typeof ledger.entries !== "object")
    throw new CoachError("This checkpoint cannot be read. Open the app and check the saved record before adding feedback.");
  return {revision:row.revision,ledger};
}
function requireStarted(day:number, ledger:Ledger) {
  if (day !== ledger.day && !ledger.completed.includes(day)) throw new CoachError("That course day has not been started.");
}
function question(ledger:Ledger,lesson:Lesson|undefined) {
  const {day,stage,finished} = ledger;
  const entry = ledger.entries[day] ?? {};
  if (finished) return "Day checked in. Wait for the learner to explicitly request the next day.";
  if (stage === "review") return "Review the day and ask for explicit final check-in.";
  if (stage === "speak") {
    const phase = entry.speakingPhase || (day===11?"followup":"part2");
    if (phase==="review") return "Choose one speaking improvement to take into the next answer.";
    return phase==="followup" ? (day===11 ? part3 : lesson?.followup) : (day===11 ? "Describe a time when you noticed a potential problem and took action before it became serious." : lesson?.speaking);
  }
  if (!lesson) return "Open the current module to resume the assigned task.";
  if (entry[stage+"Done"]==="1") return "The module is complete. Wait for the learner to move to the next module.";
  if (stage==="vocab") {
    if (entry.vocabBatch==="2") return {phrases:lesson.phrases,collocations:lesson.collocations,prompt:lesson.use};
    if (entry.vocabRecall!==undefined) return {action:"Review the answer and the three words; wait for the learner to continue.",words:lesson.words};
    return lesson.recall[0];
  }
  if (stage==="write") return entry.writeOriginal!==undefined ? lesson.edit : lesson.writing;
  const index=entry[stage+"Batch"]==="2"?1:0;
  const item = stage==="listen" ? lesson.listening[index] : lesson.reading[index];
  if(entry[stage+"Q"+index]!==undefined)
    return {action:"Review this submitted question; wait for the learner to continue.",prompt:item.prompt,feedback:item.why};
  return { ...(stage==="read" ? {passage:lesson.passage} : {source: "https://learnenglish.britishcouncil.org/free-resources/listening/c1/"+lesson.slug}),prompt:item.prompt,choices:item.choices};
}

async function studySession(userId:string, selected?:number, inspect=false, attemptId?:string) {
  const {revision, ledger} = await checkpoint(userId);
  const day = selected ?? ledger.day;
  requireStarted(day,ledger);
  const lessonFor=async (d:number)=>getExercises(d) ??
    (await getDb().select({lesson:teacherLessons.lesson}).from(teacherLessons)
      .where(and(eq(teacherLessons.userId,userId),eq(teacherLessons.day,d))).get())?.lesson;
  const lesson=await lessonFor(day), currentLesson=day===ledger.day?lesson:await lessonFor(ledger.day);
  const feedback=await reviews(userId,day);
  const frozen=await frozenReviews(userId,day);
  const snapshots=frozen.map(row=>row.snapshot);
  const attempts=(await reviewAttempts(day,ledger.entries[day]??{}))
    .filter(attempt=>!snapshots.some(snapshot=>snapshot.sourceId===attempt.id));
  const reviewRows=[
    ...snapshots.map(({attempt,context})=>({...attempt,context})),
    ...attempts.map(attempt=>({...attempt,context:reviewContext(attempt,lesson)})),
  ].map(attempt=>({...attempt,
    status:feedbackFor(attempt,feedback).length?'reviewed':attempt.kind==='objective'?'answer_key_checked':'awaiting_coach',
  }));
  if(attemptId){
    const attempt=reviewRows.find(a=>a.id===attemptId);
    if(!attempt)throw new CoachError("This exact submitted attempt is unavailable for the selected day.");
    return {day,reviewAttempts:[attempt],feedback:feedbackFor(attempt,feedback)};
  }
  const phase=ledger.entries[day]?.speakingPhase || (day===11?"followup":"part2");
  let recovery;
  if(inspect&&day===ledger.day&&ledger.stage==="speak"&&!ledger.finished&&(phase==="part2"||phase==="followup")){
    try{if(!env.BUCKET)throw Error();recovery=await listRecoverable(env.BUCKET,userId,ledger,day,phase);}
    catch{recovery={phase,items:[],complete:false,error:"lookup_unavailable"};}
  }
  return {...(recovery?{recordingRecovery:recovery}:{}),revision, targets:{...targets,Overall:overallTarget}, checkpoint:{day:ledger.day,stage:ledger.stage,finished:ledger.finished,
    completed:ledger.completed,started:ledger.started,checked:ledger.checked,exam:ledger.exam}, day,
    entry:ledger.entries[day]??{}, history:oldResults[day]??[],
    ...writings[day] && {writingSamples:{original:writings[day][0],revision:writings[day][1]}},
    ...day===11 && {speakingCarryover:{provenance:"Prior dialogue transcript. Original audio unavailable here. Spoken story and prompted follow-up already attempted.",
      lastTranscript:"If there comes the same type pressure warning. Are there with it immediately"}},
    feedback,reviewAttempts:reviewRows,reviewWorkflow:{mode:'work_conversation',instructions:'Review pending subjective attempts using their exact IDs. Quote the learner’s actual wording, give corrections with reasons and one next practice step. Write each result with add_coach_feedback. Audio must actually be heard before pronunciation or fluency assessment. The page synchronizes returned feedback; no lesson progression is authorized.'},
    nextTask:question(ledger,currentLesson)};
}
const content = (value:unknown)=>({content:[{type:"text",text:JSON.stringify(value)}]});
export const toolError = (message:string)=>({content:[{type:"text",text:message}],isError:true});
async function submittedRecording(userId:string,ledger:Ledger,day:number,id:string) {
  requireStarted(day,ledger);
  const entry=ledger.entries[day]??{};
  const submitted=["speakingPart2","speakingFollowup"].some(k=>{
    try {const rows=JSON.parse(entry[k]||"[]");return Array.isArray(rows)&&rows.some(a=>a?.audio===id);}
    catch {return false;}
  });
  if(!submitted)throw new CoachError("No submitted server recording matches this ID and day.");
  const bucket=env.BUCKET, key=`speaking/${encodeURIComponent(userId)}/${id}`;
  const file=await bucket?.head(key);
  if(!file||!bucket)throw new CoachError("Recording unavailable. Reopen the recording browser to play or attach it.");
  return {bucket,key,size:file.size,mimeType:file.httpMetadata?.contentType||"application/octet-stream",etag:file.etag};
}
async function encoded(file:R2ObjectBody) {
  const bytes=new Uint8Array(await file.arrayBuffer());
  let binary="";
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  return btoa(binary);
}
export async function callCoach(userId:string, name:string, args:unknown, options:ReviewToolOptions={}) {
  try {
    switch(name) {
      case "read_study_session": {const q=readSpec.parse(args);return content(await studySession(userId,q.day,q.inspectUnlinkedRecordings,q.attemptId));}
      case "add_coach_feedback": {
        const {recordingId,pronunciation,groundedAnalysis,...values}=feedbackSpec.parse(args);
        if(pronunciation&&!recordingId)throw new CoachError("A pronunciation rating requires a submitted recording you actually heard. For text or self-report, leave pronunciation unassessed.");
        if(groundedAnalysis&&(values.stage!=="speak"||!recordingId))
          throw new CoachError("Grounded analysis requires a speaking attempt with a submitted recording you actually heard.");
        if(values.stage==="speak") {
          // A fragment may receive a provisional criterion rating, never a whole-skill band.
          // The same rules guard complete_review_task via lib/content-rules.ts.
          const violation=coachingContentViolation({feedback:values.feedback,evidence:values.evidence,attempt:values.attempt,
            hasStructuredPronunciation:Boolean(pronunciation)});
          if(violation)throw new CoachError(violation.message);
        }
        const {ledger}=await checkpoint(userId);
        requireStarted(values.day,ledger);
        const attempts=await reviewAttempts(values.day,ledger.entries[values.day]??{});
        const snapshots=await frozenReviews(userId,values.day);
        const frozen=snapshots.find(job=>job.id===values.attempt);
        const fixed=frozen?.snapshot.attempt;
        if(values.attempt.startsWith('v2:')&&(!fixed||fixed.stage!==values.stage))
          throw new CoachError('This exact submitted attempt is unavailable for the selected day and stage.');
        if(snapshots.some(job=>job.snapshot.sourceId===values.attempt))
          throw new CoachError('Read study_session again and use the new exact attempt ID.');
        if(fixed&&recordingId&&fixed.recordingId!==recordingId)
          throw new CoachError('The recording does not belong to this exact attempt.');
        // Descriptive labels are retained only for historical, unstructured records.
        // A structured submission must always use its exact ID, regardless of prefix.
        if(!fixed&&(values.attempt.startsWith('v1:')||attempts.some(a=>a.stage===values.stage))) {
          const attempt=attempts.find(a=>a.id===values.attempt);
          if(!attempt||attempt.stage!==values.stage)throw new CoachError('This exact submitted attempt is unavailable or has changed. Read study_session again and use its current reviewAttempts ID.');
          if(recordingId&&attempt.recordingId!==recordingId)throw new CoachError('The recording does not belong to this exact attempt.');
        }
        if(recordingId){
          if(values.stage!=="speak")throw new CoachError("Attach audio evidence only to a speaking review.");
          await submittedRecording(userId,ledger,values.day,recordingId);
          values.evidence+=` [submitted audio ${recordingId}]`;
        }
        {
          const entry=ledger.entries[values.day]||{};
          const fields={speak:["speakingPart2","speakingFollowup","speakingReview"],vocab:["vocabRecall","vocabUse"],listen:["listenQ0","listenQ1"],read:["readQ0","readQ1"],write:["writeOriginal","writeRevision"],review:["reviewMemo"]};
          const legacyLabels={speak:/口语/,vocab:/词汇|搭配/,listen:/听力/,read:/阅读/,write:/写作|造句|纠错|独立应用|语法/,review:/回忆|证据|纠错/};
          const historic=(oldResults[values.day]||[]).some(([label])=>legacyLabels[values.stage].test(label)) || (values.day===11&&values.stage==="speak") || (values.stage==="review"&&ledger.completed.includes(values.day));
          if(!fixed&&!historic&&!fields[values.stage].some(k=>entry[k]!==undefined))throw new CoachError("Submit a response in this stage before adding an assessment.");
        }
        const rating=pronunciation&&recordingId?{...pronunciation,recordingId,scope:"partial" as const}:null;
        // FIX-6: issue calibration candidates SERVER-SIDE and enrich the analysis
        // with the issued ids. The runner never supplies candidateIds, so a client
        // cannot promote a class that was never actually shown (review MJ-04).
        let storedAnalysis:Record<string,unknown>|null=null;
        if(groundedAnalysis){
          const issued=await issueCalibrationCandidates(reviewTaskDb(),userId,{
            attemptId:values.attempt,recordingId,
            detectorVersion:groundedAnalysis.detectorVersion,
            inventoryVersion:groundedAnalysis.inventoryVersion,
            candidates:groundedAnalysis.candidates.map(c=>({
              word:c.word,expected:c.expected,actual:c.actual,atMs:c.atMs,
              detectorConfidence:c.detectorConfidence,...(c.catchTrial?{catchTrial:true}:{}),
            })),
          });
          storedAnalysis={
            schema:groundedAnalysis.transcript||groundedAnalysis.scorecard?"bandroom-grounded-analysis-v2":"bandroom-grounded-analysis-v1",
            detectorVersion:groundedAnalysis.detectorVersion,
            inventoryVersion:groundedAnalysis.inventoryVersion,
            speechSeconds:groundedAnalysis.speechSeconds,
            ...(groundedAnalysis.transcript?{transcript:groundedAnalysis.transcript}:{}),
            ...(groundedAnalysis.scorecard?{scorecard:groundedAnalysis.scorecard}:{}),
            // T2 stays a history-conditioned SUGGESTION; promotion is RETIRED
            // (structurally unreachable, owner 2026-11-19), so every issued item
            // is rendered as T3. The V3 gates remain as versioned tooling only.
            items:groundedAnalysis.candidates.map((c,i)=>({
              candidateId:issued.candidateIds[i],word:c.word,expected:c.expected,actual:c.actual,
              atMs:c.atMs,detectorConfidence:c.detectorConfidence,
              tier:"T3",requestedTier:c.tier,isCatchTrial:Boolean(c.catchTrial),
            })),
          };
        }
        // New v2 submissions always carry a review task. Route manual feedback
        // through the same fence/receipt transaction so automatic and manual
        // completions cannot both write a formal result for one attempt.
        if(fixed){
          const taskDb=reviewTaskDb();
          let task=await findReviewTaskByAttempt(taskDb,userId,values.attempt);
          if(!task){
            // Restored review_jobs do not carry tasks. Create the missing task
            // so manual feedback still uses the same fence/receipt contract.
            await createReviewTaskStatement(taskDb,{
              taskId:crypto.randomUUID(),reviewJobId:values.attempt,userId,
              kind:fixed.stage==="speak"&&fixed.recordingId?"speaking":"text",
              attemptId:values.attempt,day:values.day,attemptRevision:frozen?.revision??0,
              recordingId:fixed.recordingId??null,analysisVersion:null,now:Date.now(),
            }).run();
            task=await findReviewTaskByAttempt(taskDb,userId,values.attempt);
          }
          if(!task)throw new CoachError("This submission has no review task and one could not be created.");
          // Concurrent manual calls may steal the fence from one another. Retry
          // by re-reading the task; if another call completed the same output,
          // completeReviewTask returns its receipt instead of writing twice.
          for(let attempt=0;attempt<6;attempt++){
            const current=await findReviewTaskByAttempt(taskDb,userId,values.attempt);
            if(!current)throw new CoachError("This submission has no review task.");
            const claimed=current.state==="completed"?current:await claimManualReviewTask(taskDb,userId,current.id);
            const target=claimed??current;
            try{
              const completed=await completeReviewTask(taskDb,userId,{
                taskId:target.id,fence:target.fence,
                output:{feedback:values.feedback,evidence:values.evidence,analysis:storedAnalysis},
                feedback:{id:`rt:${target.id}`,day:values.day,stage:values.stage,attempt:values.attempt,
                  evidence:values.evidence,feedback:values.feedback,pronunciation:rating??undefined,
                  // The UI reads candidateIds from teacher_feedback.analysis_json.
                  // Passing analysis only in `output` merely hashes it, so the
                  // owner would never see a candidate and could never answer.
                  ...(storedAnalysis?{analysis:storedAnalysis}:{})},
                manualGrantSha256:target.claimKind==="manual"?target.manualGrantSha256??undefined:undefined,
                receipt:{recordingSha256:frozen?.snapshot.recording?.sha256??null,
                  analysisVersion:target.analysisVersion??null,payload:{source:"manual_coach",
                    ...(target.claimKind==="manual"&&target.manualGrantSha256?{grant:target.manualGrantSha256}:{})}},
              });
              return content({saved:true,id:completed.receipt.feedbackId,receiptId:completed.receipt.id,
                duplicate:completed.duplicate,day:values.day,attempt:values.attempt});
            }catch(error){
              if(error instanceof ReviewTaskError && (error.code==="stale_lease"||error.code==="task_not_found"))continue;
              if(error instanceof ReviewTaskError)throw new CoachError(error.message);
              throw error;
            }
          }
          throw new CoachError("Another writer kept taking this review. Refresh and try again.");
        }
        const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(rating?[userId,values,rating]:[userId,values])));
        const id=frozen?.snapshot.attempt.id??Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
        // Legacy v1 attempts have no review task, so they take this path. It must
        // persist the enriched analysis too, or the UI gets no candidateIds and
        // the calibration loop is inert for every pre-v2 submission (Day 12).
        await getDb().insert(teacherFeedback).values({...values,id,userId,pronunciation:rating,
          authorScope:"coach",
          ...(storedAnalysis?{analysisJson:storedAnalysis}:{}),createdAt:new Date().toISOString()}).onConflictDoNothing();
        return content({saved:true,id,day:values.day,attempt:values.attempt});
      }
      case "add_learner_note": {
        // MT-2 (S3.1): learner self-note. No pronunciation/analysis/candidates.
        const values=learnerNoteSpec.parse(args);
        const violation=coachingContentViolation({feedback:values.feedback,evidence:values.evidence??"",attempt:values.attempt,
          hasStructuredPronunciation:false});
        if(violation)throw new CoachError(violation.message);
        const {ledger}=await checkpoint(userId);
        requireStarted(values.day,ledger);
        const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([userId,"learner-note",values])));
        const id="ln:"+Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
        await getDb().insert(teacherFeedback).values({
          id,userId,day:values.day,stage:values.stage,attempt:values.attempt,
          evidence:values.evidence??"",feedback:values.feedback,
          authorScope:"learner-note",createdAt:new Date().toISOString(),
        }).onConflictDoNothing();
        return content({saved:true,id,day:values.day,attempt:values.attempt,author:"learner-note"});
      }
      case "publish_lesson": {
        const {day,lesson:input}=publishSpec.parse(compatibleLesson(args));
        const values={day,lesson:toLesson(input)};
        if ([...values.lesson.listening,...values.lesson.reading].some(q=>new Set(q.choices.map(c=>c.toLowerCase())).size!==3))
          throw new CoachError("Provide three distinct options in every multiple-choice question.");
        const row=await getDb().insert(teacherLessons).values({userId,...values}).onConflictDoNothing()
          .returning({day:teacherLessons.day}).get();
        if (!row){
          const existing=await getDb().select({lesson:teacherLessons.lesson}).from(teacherLessons)
            .where(and(eq(teacherLessons.userId,userId),eq(teacherLessons.day,day))).get();
          if(JSON.stringify(existing?.lesson)!==JSON.stringify(values.lesson))throw new CoachError("A different lesson already exists for this day.");
          return content({published:true,day,theme:values.lesson.theme,alreadySaved:true});
        }
        return content({published:true,day:row.day,theme:values.lesson.theme});
      }
      case "read_recording_bytes":
      case "read_speaking_recording": {
        // MT-3 (S8.1): reading learner voice requires active consent.
        try { await assertConsent(getDb(), userId); }
        catch (error) { if (error instanceof ConsentError) throw new CoachError(error.message); throw error; }
        const options=recordingSpec.parse(args);
        const {day,recordingId,offset=0,length=12288}=options;
        const mode=name==="read_recording_bytes"?"bytes":options.mode??"audio";
        const {bucket,key,size,mimeType,etag}=await submittedRecording(userId,(await checkpoint(userId)).ledger,day,recordingId);
        const info={day,recordingId,size,mimeType,etag};
        if(mode==="metadata")return content(info);
        if(mode==="bytes"){
          if(offset>=size)throw new CoachError("Byte offset exceeds this recording.");
          const count=Math.min(length,size-offset),file=await bucket.get(key,{range:{offset,length:count}});
          if(!file)throw new CoachError("Recording unavailable.");
          return content({...info,offset,length:count,nextOffset:offset+count<size?offset+count:null,base64:await encoded(file)});
        }
        if(size>2*1024*1024)return content({...info,guidance:"Recording is over the inline audio limit. Use private bytes mode and a decoder, or download and attach the file directly."});
        const file=await bucket.get(key);
        if(!file)throw new CoachError("Recording unavailable.");
        return {content:[{type:"text",text:JSON.stringify({...info,guidance:"If this client omits the audio block, use bytes mode in code tools to decode privately. Do not infer pronunciation from metadata."})},{type:"audio",data:await encoded(file),mimeType}]};
      }
      default:
        // Calibration tools take the session userId directly; their strict input
        // schemas have no userId field, so a client cannot choose the account.
        if (calibrationToolNames.has(name)) return callCalibrationTool(reviewTaskDb(), userId, name, args);
        if (reviewToolNames.has(name)) return callReviewTool(userId, name, args, options);
        return toolError("Unknown coaching tool.");
    }
  } catch(error) {
    if (error instanceof z.ZodError) return toolError(error.issues.slice(0,5).map(i=>i.path.join(".")+" "+i.message).join(" | "));
    if (error instanceof CoachError) return toolError(error.message);
    console.error("IELTS coach operation failed",name);
    return toolError("The private coaching service could not finish this request. Reload the study record before retrying.");
  }
}
