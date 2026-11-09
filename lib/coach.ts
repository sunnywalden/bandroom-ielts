import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { learnerStates, teacherFeedback, teacherLessons } from "@/db/schema";
import { getExercises, type Lesson } from "@/app/curriculum";
import { initial, oldResults, part3, writings, type Ledger } from "@/app/ledger";

const text = (max: number, description: string) => z.string().trim().min(1).max(max).describe(description);
const term = text(160, "English word, phrase or collocation.");
const gloss = text(300, "Concise Chinese gloss.");
const prompt = text(1400, "One question or instruction in English.");
const pair = z.tuple([term, gloss]);
const item = z.strictObject({
  prompt,
  choices: z.tuple([prompt, prompt, prompt]).describe("Three distinct answer options, in display order."),
  answer: z.number().int().min(0).max(2).describe("Zero-based index of the correct option."),
  why: text(900, "Evidence-based explanation in Chinese for display after submission."),
});
const lessonSpec = z.strictObject({
  theme: text(120, "Short English lesson title."),
  speaking: prompt.describe("Part 2 cue about an experience; include what to describe and explain."),
  followup: prompt.describe("An independent Part 3 discussion question."),
  words: z.tuple([z.tuple([term, gloss, prompt]),z.tuple([term, gloss, prompt]),z.tuple([term, gloss, prompt])])
    .describe("Exactly three [English word, Chinese meaning with part of speech, English example sentence] triples."),
  phrases: z.tuple([pair,pair]).describe("Two [English phrase, Chinese gloss] pairs."),
  collocations: z.tuple([pair,pair]).describe("Two [English fixed collocation, Chinese gloss] pairs."),
  recall: z.tuple([prompt,term]).describe("[Spaced-recall gap question, expected English answer]."),
  use: prompt.describe("One instruction for independent production using the new expressions."),
  audioTitle: text(160, "Verified title of the source on British Council LearnEnglish."),
  slug: z.string().max(150).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .describe("Final URL segment of an existing British Council /free-resources/listening/c1/ lesson. Check the actual audio and transcript before publishing."),
  listening: z.tuple([item,item]).describe("Two original source-verified questions about the C1 audio."),
  readingTitle: text(160, "English title of the original reading."),
  passage: text(7000, "Original English passage with enough specific evidence for the questions."),
  reading: z.tuple([item,item]).describe("Two original reading questions, both supported by this passage."),
  writing: prompt.describe("Independent English writing task, including word count and scope."),
  edit: text(1000, "Targeted revision instructions shown after the original draft."),
  fullEssay: z.boolean().optional().describe("True only for a complete timed Task 2 essay."),
});
const dayNumber = z.number().int().min(1).max(62);
const stageName = z.enum(["speak","vocab","listen","read","write","review"]);
const readSpec = z.strictObject({ day: dayNumber.optional().describe("Day to inspect; defaults to the current day. Only started days are accessible.") });
const feedbackSpec = z.strictObject({
  day: dayNumber, stage: stageName, feedback: text(6000, "Specific coaching feedback addressed to the learner."),
  evidence: text(2000, "Identify the submitted text or audible sample, its conditions, and evidence used. No pronunciation assessment from text."),
  attempt: text(160, "Identify the attempt, e.g. independent first draft, assisted revision, or follow-up recorded at an ISO timestamp."),
});
const publishSpec = z.strictObject({ day: z.number().int().min(17).max(62), lesson: lessonSpec });
const recordingSpec = z.strictObject({
  day: dayNumber, recordingId: z.uuidv4().describe("Submitted remote audio ID from the day's speakingPart2 or speakingFollowup entry."),
});

export const coachTools = [
  {name:"read_study_session",description:"Read the learner's checkpoint, selected day's saved answers and available original/revised writing, historical results, coach feedback and current small task. Audio references require read_speaking_recording. Never start or complete a day.",schema:readSpec,readOnly:true},
  {name:"add_coach_feedback",description:"Append a private, evidence-based review of one identified attempt for a started day. First use read_study_session or inspect the learner's actual submitted evidence. Never infer pronunciation from a transcript. Existing attempts and scores remain intact; identical retries are deduplicated.",schema:feedbackSpec,readOnly:false},
  {name:"publish_lesson",description:"Add one complete new lesson to this learner's private catalogue for Day 17–62. Verify the British Council source audio, transcript and q/a; use original reading material. Match the learner's exam pathway and budget. Use only after the learner requests preparation or expansion; this does not start the day. A published day cannot be replaced.",schema:publishSpec,readOnly:false},
  {name:"read_speaking_recording",description:"Read one audio attachment actually submitted by this learner for this day, up to 2 MiB. If the client cannot present the sound, limit feedback to available text and ask for a directly attached clip for pronunciation. Device-only recordings are available in the recording browser.",schema:recordingSpec,readOnly:true},
].map(({schema,readOnly,...tool})=>({...tool,inputSchema:z.toJSONSchema(schema,{override:({jsonSchema})=>{
  if (Array.isArray(jsonSchema.prefixItems)) {
    jsonSchema.minItems=jsonSchema.prefixItems.length;
    jsonSchema.maxItems=jsonSchema.prefixItems.length;
    jsonSchema.items=false;
  }
}}),annotations:{readOnlyHint:readOnly,destructiveHint:false}}));

const feedbackColumns = {id:teacherFeedback.id,day:teacherFeedback.day,stage:teacherFeedback.stage,
  feedback:teacherFeedback.feedback,evidence:teacherFeedback.evidence,attempt:teacherFeedback.attempt,createdAt:teacherFeedback.createdAt};

function reviews(userId:string, day?:number) {
  return getDb().select(feedbackColumns).from(teacherFeedback)
    .where(day === undefined ? eq(teacherFeedback.userId,userId)
      : and(eq(teacherFeedback.userId,userId),eq(teacherFeedback.day,day)))
    .orderBy(desc(teacherFeedback.createdAt),desc(teacherFeedback.id));
}
export async function coachData(userId:string) {
  const [lessons,feedback] = await Promise.all([
    getDb().select({day:teacherLessons.day,lesson:teacherLessons.lesson}).from(teacherLessons).where(eq(teacherLessons.userId,userId)), reviews(userId)
  ]);
  return {extras:Object.fromEntries(lessons.map(({day,lesson})=>[day,lesson])),feedback};
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
    const phase = entry.speakingPhase || (day===11?"review":"part2");
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

async function studySession(userId:string, selected?:number) {
  const {revision, ledger} = await checkpoint(userId);
  const day = selected ?? ledger.day;
  requireStarted(day,ledger);
  const lesson = ledger.day<=16 ? getExercises(ledger.day) :
    (await getDb().select({lesson:teacherLessons.lesson}).from(teacherLessons)
      .where(and(eq(teacherLessons.userId,userId),eq(teacherLessons.day,ledger.day))).get())?.lesson;
  return {revision, checkpoint:{day:ledger.day,stage:ledger.stage,finished:ledger.finished,
    completed:ledger.completed,started:ledger.started,checked:ledger.checked,exam:ledger.exam}, day,
    entry:ledger.entries[day]??{}, history:oldResults[day]??[],
    ...writings[day] && {writingSamples:{original:writings[day][0],revision:writings[day][1]}},
    ...day===11 && {speakingCarryover:{provenance:"Prior dialogue transcript. Original audio unavailable here. Spoken story and prompted follow-up already attempted.",
      lastTranscript:"If there comes the same type pressure warning. Are there with it immediately"}},
    feedback:await reviews(userId,day),nextTask:question(ledger,lesson)};
}
const content = (value:unknown)=>({content:[{type:"text",text:JSON.stringify(value)}]});
export const toolError = (message:string)=>({content:[{type:"text",text:message}],isError:true});
export async function callCoach(userId:string, name:string, args:unknown) {
  try {
    switch(name) {
      case "read_study_session": return content(await studySession(userId,readSpec.parse(args).day));
      case "add_coach_feedback": {
        const values=feedbackSpec.parse(args);
        requireStarted(values.day,(await checkpoint(userId)).ledger);
        const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify([userId,values])));
        const id=Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
        await getDb().insert(teacherFeedback).values({...values,id,userId,createdAt:new Date().toISOString()}).onConflictDoNothing();
        return content({saved:true,id,day:values.day,attempt:values.attempt});
      }
      case "publish_lesson": {
        const values=publishSpec.parse(args);
        if ([...values.lesson.listening,...values.lesson.reading].some(q=>new Set(q.choices.map(c=>c.toLowerCase())).size!==3))
          throw new CoachError("Provide three distinct options in every multiple-choice question.");
        const row=await getDb().insert(teacherLessons).values({userId,...values}).onConflictDoNothing()
          .returning({day:teacherLessons.day}).get();
        if (!row) throw new CoachError("A lesson exists for this day. It has not been replaced.");
        return content({published:true,day:row.day,theme:values.lesson.theme});
      }
      case "read_speaking_recording": {
        const {day,recordingId} = recordingSpec.parse(args);
        const {ledger} = await checkpoint(userId);
        requireStarted(day,ledger);
        const entry=ledger.entries[day]??{};
        const submitted=["speakingPart2","speakingFollowup"].some(k=>{
          try { const rows=JSON.parse(entry[k]||"[]"); return Array.isArray(rows)&&rows.some(a=>a?.audio===recordingId); }
          catch { return false; }
        });
        if (!submitted) throw new CoachError("No submitted server recording matches this ID and day.");
        const key=`speaking/${encodeURIComponent(userId)}/${recordingId}`;
        const file=await env.BUCKET?.get(key);
        if (!file) throw new CoachError("Recording unavailable. Reopen the recording browser to play or attach it.");
        if (file.size>2*1024*1024) {await file.body.cancel(); throw new CoachError("Recording exceeds the 2 MiB in-chat limit. Download it from the speaking page and attach it directly.");}
        const bytes=new Uint8Array(await file.arrayBuffer());
        let binary="";
        for (let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
        return {content:[{type:"audio",data:btoa(binary),mimeType:file.httpMetadata?.contentType || "audio/webm"}]};
      }
      default: return toolError("Unknown coaching tool.");
    }
  } catch(error) {
    if (error instanceof z.ZodError) return toolError(error.issues.slice(0,5).map(i=>i.path.join(".")+" "+i.message).join(" | "));
    if (error instanceof CoachError) return toolError(error.message);
    console.error("IELTS coach operation failed",name);
    return toolError("The private coaching service could not finish this request. Reload the study record before retrying.");
  }
}
