import { z } from "zod";
import { dayStamp, initial, labels, oldOrder, sampleEpoch, stages, type Entry, type Stage } from "../../ledger";

import { getExercises, type Lesson } from "../../curriculum";
import { periods } from "../../period";
import { parseSession } from "../../speaking-session";

const date = z.string().date();
const skill = z.enum(["Listening","Reading","Writing","Speaking"]);
const fullTest = z.object({
  id:z.string().uuid(), skill, date, exam:z.enum(["通用","Academic","General Training"]),
  source:z.string().trim().min(1).max(160),rater:z.string().trim().min(1).max(200),
  raw:z.number().int().min(0).max(40).optional(),band:z.number().min(0).max(9).multipleOf(.5).optional(),
  audio:z.string().uuid().optional()
}).strict().refine(t=>(t.skill==="Listening"||t.skill==="Reading"? t.raw!==undefined : t.band!==undefined)
  && (t.skill==="Speaking"?!!t.audio:!t.audio)
  && (t.skill==="Reading"||t.skill==="Writing"?t.exam!=="通用":t.exam==="通用"));
const digest=z.object({
  from:date,to:date,lines:z.array(z.object({date,day:z.number().int().optional(),kind:z.enum(["Listening","Reading","Writing","Speaking","词汇","综合"]),text:z.string()})),
  tests:z.array(fullTest),recall:z.tuple([z.number().int().nonnegative(),z.number().int().nonnegative()]),
  applications:z.number().int().nonnegative(),priorities:z.array(z.string()).max(2),
  comments:z.array(z.object({day:z.number().int(),stage:z.enum(["speak","listen","read","write","vocab","review"]),attempt:z.string(),evidence:z.string(),feedback:z.string(),createdAt:z.string()})),
}).strict();
const report=z.object({created:z.string().datetime(),updated:z.string().datetime(),week:digest,cycle:digest.optional()}).strict();
export const snapshotSchema = z.object({
  version:z.literal(1), day:z.number().int().min(11).max(62),
  stage:z.enum(["speak","vocab","listen","read","write","review"]), finished:z.boolean(),
  completed:z.array(z.number().int()), checked:z.record(date), started:z.record(date),
  entries:z.record(z.record(z.string())), exam:z.enum(["未选择","Academic","General Training"]),
  practice:z.record(z.object({count:z.number().int().nonnegative(),date,lastCorrect:z.boolean().optional()}).strict()),
  fullTests:z.array(fullTest).optional(),reports:z.record(z.string().regex(/^W[1-9]\d*$/),report).optional(),
}).strict();
const attempt = z.object({ at:z.string().datetime(), text:z.string(), spoken:z.literal(true),
  audio:z.string().uuid().optional(), local:z.string().uuid().optional(),
  // Session-era fields (docs §7.1). Legacy rows omit them and keep parsing.
  sessionId:z.string().trim().min(1).max(80).optional(),
  part:z.union([z.literal(1),z.literal(2),z.literal(3)]).optional(),
  questionId:z.string().trim().min(1).max(96).optional(),
  seq:z.number().int().min(0).max(99).optional(),
  mode:z.enum(["daily","full","mock"]).optional(),
  notes:z.string().max(2048).optional(),
  reviewed:z.boolean().optional(),
}).strict();

function attempts(raw?:string) {
  try { return z.array(attempt).parse(JSON.parse(raw ?? "[]")); } catch { return null; }
}
type Attempt = z.infer<typeof attempt>;

function textBytes(value:string|undefined){return value===undefined?0:new TextEncoder().encode(value).length}
const PART1_CAP=40,PART2_CAP=40,PART3_CAP=40,MOCK_CAP=30,DRILL_CAP=12,NOTES_BYTES=2048,SESSION_BYTES=4096,FOCUS_BYTES=8192,DRILL_BYTES=32768;
const MUTABLE_SPEAK=new Set(["speakingPhase","speakingSession","speakingMockSession","speakingFocus","speakingDrillTakes","notes","speakingMockComplete"]);

function drillTakesValid(raw:string|undefined){
  if(raw===undefined||!raw.trim())return true;
  try {
    const value=JSON.parse(raw) as {takes?:unknown};
    if(!value||!Array.isArray(value.takes)||value.takes.length>DRILL_CAP)return false;
    return value.takes.every(take=>Boolean(take)&&typeof take==="object"
      &&typeof (take as Record<string,unknown>).attemptId==="string");
  } catch {return false}
}
function sessionsValid(after:Entry){
  const session=after.speakingSession?.trim()?parseSession(after.speakingSession):null;
  if(after.speakingSession?.trim()&&(!session||session.mode==="mock"))return false;
  const mock=after.speakingMockSession?.trim()?parseSession(after.speakingMockSession):null;
  if(after.speakingMockSession?.trim()&&(!mock||mock.mode!=="mock"))return false;
  return textBytes(after.speakingSession)<=SESSION_BYTES&&textBytes(after.speakingMockSession)<=SESSION_BYTES;
}
function newRows(after:Attempt[],prior:Attempt[],cap:number,check:(row:Attempt)=>boolean){
  if(!after.length||after.length>cap||!check(after[after.length-1]))return false;
  const append=after.length===prior.length+1;
  // A full field evicts its oldest row before appending, matching the client
  // cap. Without eviction the 41st answer would be rejected instead of saved.
  const evict=after.length===cap&&prior.length>=cap;
  if(!append&&!evict)return false;
  const kept=after.slice(0,-1),drop=prior.length-kept.length;
  return drop>=0&&kept.every((row,index)=>same(row,prior[index+drop]));
}

export function same(a:unknown,b:unknown):boolean {
  if (a===b) return true;
  if (!a || !b || typeof a!=="object" || typeof b!=="object" || Array.isArray(a)!==Array.isArray(b)) return false;
  const one=a as Record<string,unknown>, two=b as Record<string,unknown>;
  return Object.keys(one).length===Object.keys(two).length && Object.keys(one).every(k=>Object.hasOwn(two,k)&&same(one[k],two[k]));
}
const byStage:Record<Stage,RegExp>={
  speak:/^speaking(Part1|Part2|Followup|Mock|MockSession|MockComplete|Session|Focus|DrillTakes)(Draft)?$|^speaking(Phase|Review|Complete)$|^notes$/,
  vocab:/^vocab(Recall(Correct|Draft)?|Use(Draft)?|Batch|Done)$/,
  listen:/^listen(Q[01](Correct)?|Mode[01]|Batch|Done)$/,
  read:/^read(Q[01](Correct)?|Evidence[01]|Batch|Done)$/,
  write:/^write(Original|Revision(Draft)?|Focus|Done|Condition|Draft)$/,review:/^reviewMemo$/,
};
function ready(day:number, stage:Stage, e:Entry) {
  if(day===11 && stage!=="speak" && stage!=="review") return true;
  switch(stage){
    // A finished session may freeze a focus instead of free text; the legacy
    // self-review still counts when present. Neither may be an empty string.
    case "speak": return e.speakingComplete==="yes" && (!!e.speakingReview?.trim() || !!e.speakingFocus?.trim())
      && !!attempts(e.speakingFollowup)?.length && (day===11 || !!attempts(e.speakingPart2)?.length);
    case "vocab": return e.vocabDone==="1" && !!e.vocabRecall?.trim() && !!e.vocabUse?.trim();
    case "listen":case "read": return e[stage+"Done"]==="1" && [0,1].every(i=>
      ["0","1","2"].includes(e[stage+"Q"+i]) && ["0","1"].includes(e[stage+"Q"+i+"Correct"])
        && !!(stage==="listen"?e["listenMode"+i]:e["readEvidence"+i])?.trim());
    case "write":return e.writeDone==="1" && !!e.writeOriginal?.trim() && !!e.writeRevision?.trim() &&
      e.writeOriginal.trim()!==e.writeRevision.trim() && !!e.writeFocus?.trim();
    default:return false;
  }
}

function validEntry(day:number, stage:Stage, before:Entry, after:Entry, lesson?:Lesson) {
  const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>before[k]!==after[k]);
  for(const k of changed){
    if(!Object.hasOwn(after,k))return false;
    if(k.startsWith("_date_")){
      const target=k.slice(6);
      if(before[k]!==undefined || !date.safeParse(after[k]).success || (target!==labels[stage] && !byStage[stage].test(target))) return false;
      continue;
    }
    if(!byStage[stage].test(k))return false;
    if(k==="speakingPart1" || k==="speakingPart2" || k==="speakingFollowup" || k==="speakingMock"){
      const prior=attempts(before[k]), next=attempts(after[k]);
      if(!prior || !next)return false;
      const cap=k==="speakingPart1"?PART1_CAP:k==="speakingPart2"?PART2_CAP:k==="speakingFollowup"?PART3_CAP:MOCK_CAP;
      const rowValid=(row:Attempt)=>{
        if(k==="speakingPart1")return row.part===1&&row.reviewed===false;
        if(k==="speakingPart2")return row.part===undefined||row.part===2;
        if(k==="speakingFollowup")return row.part===undefined||row.part===3;
        return row.mode==="mock";
      };
      if(!newRows(next,prior,cap,rowValid))return false;
      if(k==="speakingFollowup" && day!==11 && !attempts(before.speakingPart2)?.length)return false;
    } else if(before[k]!==undefined && !MUTABLE_SPEAK.has(k) && !k.endsWith("Draft"))return false;
  }
  if(stage==="speak"){
    if(changed.includes("speakingPhase") && !["part1","part2","followup","review"].includes(after.speakingPhase??""))return false;
    // A mock is a separate exercise: it may be marked complete on its own but
    // can never complete the day or borrow the daily review flag.
    if(changed.includes("speakingMockComplete")
      &&(after.speakingMockComplete!=="yes"||!attempts(after.speakingMock)?.length))return false;
    if(changed.includes("speakingComplete")
      &&changed.some(k=>k==="speakingMock"||k==="speakingMockComplete"||k==="speakingMockSession"))return false;
    if(!sessionsValid(after))return false;
    if(textBytes(after.notes)>NOTES_BYTES||textBytes(after.speakingFocus)>FOCUS_BYTES
      ||textBytes(after.speakingDrillTakes)>DRILL_BYTES)return false;
    if(!drillTakesValid(after.speakingDrillTakes))return false;
    if(after.speakingFocus?.trim()){
      try {
        const focus=JSON.parse(after.speakingFocus) as {history?:unknown};
        if(!focus||typeof focus!=="object"||(Array.isArray(focus.history)&&focus.history.length>5))return false;
      } catch {return false}
    }
  }
  // Legacy two-question flow keeps mirroring speakingPhase. Once a session
  // object exists the session reducer is authoritative and the mirror is only
  // a display hint.
  if(stage==="speak" && !after.speakingSession?.trim()
    && changed.some(k=>k==="speakingPart2" || k==="speakingFollowup" || k==="speakingPhase")){
    const hasFollowup=Boolean(attempts(after.speakingFollowup)?.length);
    const hasPart2=Boolean(attempts(after.speakingPart2)?.length);
    const expectedPhase=hasFollowup?"review":day===11||hasPart2?"followup":"part2";
    if(after.speakingPhase!==expectedPhase)return false;
  }
  if(stage==="vocab" && changed.length){
    if(!lesson)return false;
    if(changed.includes("vocabBatch") && (after.vocabBatch!=="2"||!before.vocabRecall))return false;
    if(changed.includes("vocabUse") && before.vocabBatch!=="2")return false;
    if(changed.includes("vocabRecall") || changed.includes("vocabRecallCorrect")){
      const normalize=(s:string)=>s.trim().toLowerCase().replace(/[.!?。]$/,"").trim();
      if(!after.vocabRecall?.trim()||after.vocabRecallCorrect!==(normalize(after.vocabRecall)===normalize(lesson.recall[1])?"1":"0"))return false;
    }
  }
  if((stage==="listen"||stage==="read")&&changed.length){
    if(!lesson)return false;
    if(changed.includes(stage+"Batch") && (after[stage+"Batch"]!=="2"||before[stage+"Q0"]===undefined))return false;
    for(const i of [0,1]){
      const k=stage+"Q"+i;
      if(!changed.includes(k)&&!changed.includes(k+"Correct"))continue;
      if(i===1&&before[stage+"Batch"]!=="2")return false;
      const item=(stage==="listen"?lesson.listening:lesson.reading)[i];
      if(!["0","1","2"].includes(after[k]) || after[k+"Correct"]!==(String(item.answer)===after[k]?"1":"0"))return false;
      if(stage==="listen"&&!["首听一遍","有额外重播","作答前参考了原文"].includes(after["listenMode"+i]))return false;
      if(stage==="read"&&!after["readEvidence"+i]?.trim())return false;
    }
  }
  if(changed.includes("writeOriginal")&&(!after.writeOriginal.trim()||!["独立 · 未计时","独立 · 我已自行计时","有参考或获得提示"].includes(after.writeCondition)))return false;
  if(changed.includes("writeRevision") && !before.writeOriginal?.trim())return false;
  if(changed.includes("speakingComplete") && !attempts(before.speakingFollowup)?.length)return false;
  const done=stage==="speak"?"speakingComplete":stage+"Done";
  return !changed.includes(done) || ready(day,stage,after);
}

// The client saves answers, advances modules, checks in, and starts the next lesson in separate requests.
export function validTransition(previous:unknown, candidate:unknown, lesson?:Lesson):boolean {
  const old=snapshotSchema.safeParse(previous??initial()), next=snapshotSchema.safeParse(candidate);
  if(!old.success||!next.success)return false;
  const a=old.data,b=next.data, newDay=b.day===a.day+1, checking=!a.finished&&b.finished;
  const tests=a.fullTests??[],newTests=b.fullTests??[];
  if(newTests.length<tests.length || newTests.length>tests.length+1 || !tests.every((t,i)=>same(t,newTests[i])))return false;
  if(newTests.length>tests.length){
    const t=newTests[tests.length];
    if(t.date>dayStamp()||t.date<sampleEpoch||(t.exam!=="通用"&&t.exam!==b.exam)
      ||tests.some(old=>old.id===t.id||(old.date===t.date&&old.skill===t.skill&&old.exam===t.exam&&old.source.toLowerCase()===t.source.toLowerCase())))return false;
  }
  for(const [key,prior] of Object.entries(a.reports??{}))if(b.reports?.[key]?.created!==prior.created)return false;
  for(const [key,value] of Object.entries(b.reports??{})){
    if(same(value,a.reports?.[key]))continue;
    const window=periods().find(w=>w.id===key);
    if(!window||value.week.from!==window.from||value.week.to!==window.to||value.created>value.updated||
       (window.cycleFrom ? value.cycle?.from!==window.cycleFrom||value.cycle?.to!==window.to : value.cycle!==undefined))return false;
  }
  for(const [key,prior] of Object.entries(a.practice))if(!b.practice[key]||b.practice[key].count<prior.count)return false;
  for(const [key,value] of Object.entries(b.practice))if(!same(value,a.practice[key]) &&
    (value.count!==(a.practice[key]?.count??0)+1 ||value.date!==dayStamp()))return false;
  if(b.day!==a.day&&!newDay)return false;
  if(newDay&&(!a.finished||!a.checked[a.day]||b.stage!=="speak"||b.finished))return false;
  if(!newDay && a.finished && (!b.finished || b.stage!==a.stage))return false;
  const completed=checking?[...a.completed,a.day]:a.completed;
  if(!same(completed,b.completed))return false;
  if(checking&&b.checked[a.day]!==dayStamp() || newDay&&b.started[b.day]!==dayStamp())return false;
  if(!same(b.checked,checking?{...a.checked,[a.day]:b.checked[a.day]}:a.checked))return false;
  if(!same(b.started,newDay?{...a.started,[b.day]:b.started[b.day]}:a.started))return false;
  const prev=a.entries[a.day]??{}, current=b.entries[a.day]??{};
  const expectedEntries={...a.entries};
  if(Object.keys(current).length || Object.hasOwn(b.entries,a.day))expectedEntries[a.day]=current;
  if(!same(expectedEntries,b.entries))return false;
  if(a.finished || newDay || a.stage!==b.stage){
    if(!same(prev,current))return false;
  }else if(!validEntry(a.day,a.stage,prev,current,lesson??(a.day<=16?getExercises(a.day):undefined)))return false;
  if(newDay)return true;
  const order=a.day===11?oldOrder:stages;
  if(checking)return a.stage==="review"&&b.stage==="review"&&typeof current.reviewMemo==="string"&&order.filter(s=>s!=="review").every(s=>ready(a.day,s,prev));
  return a.stage===b.stage || (b.stage===order[order.indexOf(a.stage)+1]&&ready(a.day,a.stage,prev));
}
