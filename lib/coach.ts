import { reviewAttempts, feedbackFor } from "@/app/feedback-model";
import { env } from "cloudflare:workers";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod/v4";
import { getDb } from "@/db";
import { learnerStates, teacherFeedback, teacherLessons } from "@/db/schema";
import { getExercises, type Lesson } from "@/app/curriculum";
import { targets, overallTarget } from "@/app/goals";
import { frozenReviews } from "./review-jobs";
import { reviewContext } from "./review-context";
import { listRecoverable } from "./recording-recovery";
import { initial, oldResults, part3, writings, type Ledger } from "@/app/ledger";

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
});
const publishSpec = z.strictObject({ day: z.number().int().min(17).max(62), lesson: lessonSpec });
const recordingSpec = z.strictObject({
  day:dayNumber, recordingId:z.uuidv4().describe("Submitted remote audio ID shown in the learner’s saved answer."),
  mode:z.enum(["audio","metadata","bytes"]).optional().describe("audio returns an audible block where supported; metadata gives exact byte count and MIME; bytes returns a small base64 range for private local audio decoding when the client omits audio blocks."),
  offset:z.number().int().min(0).max(12*1024*1024).optional().describe("Zero-based byte offset; only used in bytes mode."),
  length:z.number().int().min(1).max(24576).optional().describe("Bytes to return in bytes mode, default 12288. Follow nextOffset until null. Never show raw base64 to the learner."),

});

export const coachTools = [
  {name:"read_study_session",description:"Read canonical reviewAttempts IDs, question context and pending reviews, plus the learner's checkpoint and selected day's saved answers and available original/revised writing, historical results, coach feedback and current small task. Audio references require read_speaking_recording. Never start or complete a day.",schema:readSpec,readOnly:true},
  {name:"add_coach_feedback",description:"Append a private, evidence-based review using its exact reviewAttempts[].id; the page automatically displays it beside that answer. Review one identified attempt for a started day. First use read_study_session or inspect the learner's actual submitted evidence. Never infer pronunciation from a transcript. Existing attempts and scores remain intact; identical retries are deduplicated.",schema:feedbackSpec,readOnly:false},
  {name:"publish_lesson",description:"Add one complete new lesson to this learner's private catalogue for Day 17–62. Verify the British Council source audio, transcript and q/a; use original reading material. Match the learner's exam pathway and budget. Use only after the learner requests preparation or expansion; this does not start the day. A published day cannot be replaced.",schema:publishSpec,readOnly:false},
  {name:"read_recording_bytes",description:"Code-capable clients: retrieve one bounded byte range of the learner's submitted recording, before decoding audio locally. Never display base64. Supply offset=0 for the first block and use nextOffset until null. Use this when an older read_speaking_recording schema lacks bytes mode.",schema:z.strictObject({day:dayNumber,recordingId:z.uuidv4(),offset:z.number().int().min(0).max(12*1024*1024),length:z.number().int().min(1).max(24576).optional()}),readOnly:true},
  {name:"read_speaking_recording",description:"Read a submitted recording. Use audio mode first. If the client omits the sound, retrieve metadata then bytes and reconstruct privately in a supported audio decoder. Technical verification or text alone cannot justify pronunciation or fluency ratings. Device-only recordings can be played in the recording browser.",schema:recordingSpec,readOnly:true},
].map(({schema,readOnly,...tool})=>({...tool,inputSchema:z.toJSONSchema(schema),annotations:{readOnlyHint:readOnly,destructiveHint:false}}));

const feedbackColumns = {id:teacherFeedback.id,day:teacherFeedback.day,stage:teacherFeedback.stage,
  feedback:teacherFeedback.feedback,evidence:teacherFeedback.evidence,pronunciation:teacherFeedback.pronunciation,attempt:teacherFeedback.attempt,createdAt:teacherFeedback.createdAt};

async function reviews(userId:string, day?:number) {
  const rows=await getDb().select(feedbackColumns).from(teacherFeedback)
    .where(day === undefined ? eq(teacherFeedback.userId,userId)
      : and(eq(teacherFeedback.userId,userId),eq(teacherFeedback.day,day)))
    .orderBy(desc(teacherFeedback.createdAt),desc(teacherFeedback.id));
  return rows.map(row=>row.pronunciation?{...row,evidence:row.evidence+` · 发音专项暂定 ${row.pronunciation.band.toFixed(1)}/9（本次录音）· ${row.pronunciation.observation}`}:row);
}
export async function coachData(userId:string) {
  const [lessons,feedback,jobs] = await Promise.all([
    getDb().select({day:teacherLessons.day,lesson:teacherLessons.lesson}).from(teacherLessons).where(eq(teacherLessons.userId,userId)), reviews(userId), frozenReviews(userId)
  ]);
  return {account:userId,extras:Object.fromEntries(lessons.map(({day,lesson})=>[day,lesson])),feedback,
    reviewLinks:jobs.map(({id,day,snapshot})=>({id,day,sourceId:snapshot.sourceId}))};
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
export async function callCoach(userId:string, name:string, args:unknown) {
  try {
    switch(name) {
      case "read_study_session": {const q=readSpec.parse(args);return content(await studySession(userId,q.day,q.inspectUnlinkedRecordings,q.attemptId));}
      case "add_coach_feedback": {
        const {recordingId,pronunciation,...values}=feedbackSpec.parse(args);
        if(pronunciation&&!recordingId)throw new CoachError("A pronunciation rating requires a submitted recording you actually heard. For text or self-report, leave pronunciation unassessed.");
        if(values.stage==="speak") {
          // A fragment may receive a provisional criterion rating, never a whole-skill band.
          const claim=[values.feedback,values.evidence,values.attempt].join(" ");
          const number="(?:[0-8](?:[.]5|[.]0)?|9(?:[.]0)?)(?![.0-9])";
          const explicit=(term:string)=>new RegExp(term+"(?:\\s*(?:[:：=]|is|was|would be|estimated at|band|score|为|得分|约为|约|暂定|预估|评分|是|为|大约))*\\s*"+number,"i").test(claim);
          if(explicit("(?:overall speaking|speaking band|口语总分|口语综合分|口语单科分)"))
            throw new CoachError("A partial classroom answer cannot receive an overall Speaking band. Use a full independent assessment record for that.");
          if(!pronunciation&&explicit("(?:pronunciation|发音)"))throw new CoachError("Record a pronunciation estimate in the structured pronunciation field only after listening to its submitted clip.");
        }
        const {ledger}=await checkpoint(userId);
        requireStarted(values.day,ledger);
        const attempts=await reviewAttempts(values.day,ledger.entries[values.day]??{});
        const snapshots=await frozenReviews(userId,values.day);
        const fixed=snapshots.find(job=>job.id===values.attempt)?.snapshot.attempt;
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
        const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(rating?[userId,values,rating]:[userId,values])));
        const id=fixed?.id??Array.from(new Uint8Array(hash),b=>b.toString(16).padStart(2,"0")).join("");
        await getDb().insert(teacherFeedback).values({...values,id,userId,pronunciation:rating,createdAt:new Date().toISOString()}).onConflictDoNothing();
        return content({saved:true,id,day:values.day,attempt:values.attempt});
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
      default: return toolError("Unknown coaching tool.");
    }
  } catch(error) {
    if (error instanceof z.ZodError) return toolError(error.issues.slice(0,5).map(i=>i.path.join(".")+" "+i.message).join(" | "));
    if (error instanceof CoachError) return toolError(error.message);
    console.error("IELTS coach operation failed",name);
    return toolError("The private coaching service could not finish this request. Reload the study record before retrying.");
  }
}
