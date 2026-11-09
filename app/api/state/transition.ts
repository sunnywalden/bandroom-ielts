import { z } from "zod";
import { initial, labels, oldOrder, stages, type Entry, type Stage } from "../../ledger";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const snapshot = z.object({
  version:z.literal(1), day:z.number().int().min(11).max(62),
  stage:z.enum(["speak","vocab","listen","read","write","review"]), finished:z.boolean(),
  completed:z.array(z.number().int()), checked:z.record(date), started:z.record(date),
  entries:z.record(z.record(z.string())), exam:z.enum(["未选择","Academic","General Training"]),
  practice:z.record(z.object({count:z.number().int().nonnegative(), date})),
});
const attempt = z.object({ at:z.string().datetime(), text:z.string(), spoken:z.literal(true),
  audio:z.string().uuid().optional(), local:z.string().uuid().optional() }).strict();

function attempts(raw?:string) {
  try { return z.array(attempt).parse(JSON.parse(raw ?? "[]")); } catch { return null; }
}

function same(a:unknown,b:unknown):boolean {
  if (a===b) return true;
  if (!a || !b || typeof a!=="object" || typeof b!=="object") return false;
  const one=a as Record<string,unknown>, two=b as Record<string,unknown>;
  return Object.keys(one).length===Object.keys(two).length && Object.keys(one).every(k=>Object.hasOwn(two,k)&&same(one[k],two[k]));
}
const byStage:Record<Stage,RegExp>={
  speak:/^speaking(Part2|Followup)(Draft)?$|^speaking(Phase|Review|Complete)$/,
  vocab:/^vocab(Recall(Correct|Draft)?|Use(Draft)?|Batch|Done)$/,
  listen:/^listen(Q[01](Correct)?|Mode[01]|Batch|Done)$/,
  read:/^read(Q[01](Correct)?|Evidence[01]|Batch|Done)$/,
  write:/^write(Original|Revision(Draft)?|Focus|Done|Condition|Draft)$/,review:/^reviewMemo$/,
};
function ready(day:number, stage:Stage, e:Entry) {
  if(day===11 && stage!=="speak" && stage!=="review") return true;
  switch(stage){
    case "speak": return e.speakingComplete==="yes" && !!e.speakingReview?.trim()
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

function validEntry(day:number, stage:Stage, before:Entry, after:Entry) {
  const changed=[...new Set([...Object.keys(before),...Object.keys(after)])].filter(k=>before[k]!==after[k]);
  for(const k of changed){
    if(!Object.hasOwn(after,k))return false;
    if(k.startsWith("_date_")){
      const target=k.slice(6);
      if(before[k]!==undefined || !date.safeParse(after[k]).success || (target!==labels[stage] && !byStage[stage].test(target))) return false;
      continue;
    }
    if(!byStage[stage].test(k))return false;
    if(k==="speakingPart2" || k==="speakingFollowup"){
      const prior=attempts(before[k]), next=attempts(after[k]);
      if(!prior || !next || next.length!==prior.length+1 || !prior.every((a,i)=>same(a,next[i])))return false;
      if(k==="speakingFollowup" && day!==11 && !attempts(before.speakingPart2)?.length)return false;
    } else if(before[k]!==undefined && !(k.endsWith("Draft") || k==="speakingPhase"))return false;
  }
  if(changed.includes("writeRevision") && !before.writeOriginal?.trim())return false;
  if(changed.includes("speakingComplete") && !attempts(before.speakingFollowup)?.length)return false;
  const done=stage==="speak"?"speakingComplete":stage+"Done";
  return !changed.includes(done) || ready(day,stage,after);
}

// The client saves answers, advances modules, checks in, and starts the next lesson in separate requests.
export function validTransition(previous:unknown, candidate:unknown):boolean {
  const old=snapshot.safeParse(previous??initial()), next=snapshot.safeParse(candidate);
  if(!old.success||!next.success)return false;
  const a=old.data,b=next.data, newDay=b.day===a.day+1, checking=!a.finished&&b.finished;
  if(b.day!==a.day&&!newDay)return false;
  if(newDay&&(!a.finished||!a.checked[a.day]||b.stage!=="speak"||b.finished))return false;
  if(!newDay && a.finished && (!b.finished || b.stage!==a.stage))return false;
  const completed=checking?[...a.completed,a.day]:a.completed;
  if(!same(completed,b.completed))return false;
  if(checking&&!b.checked[a.day] || newDay&&!b.started[b.day])return false;
  if(!same(b.checked,checking?{...a.checked,[a.day]:b.checked[a.day]}:a.checked))return false;
  if(!same(b.started,newDay?{...a.started,[b.day]:b.started[b.day]}:a.started))return false;
  const prev=a.entries[a.day]??{}, current=b.entries[a.day]??{};
  const expectedEntries={...a.entries};
  if(Object.keys(current).length || Object.hasOwn(b.entries,a.day))expectedEntries[a.day]=current;
  if(!same(expectedEntries,b.entries))return false;
  if(a.finished || newDay || a.stage!==b.stage){
    if(!same(prev,current))return false;
  }else if(!validEntry(a.day,a.stage,prev,current))return false;
  if(newDay)return true;
  const order=a.day===11?oldOrder:stages;
  if(checking)return a.stage==="review"&&b.stage==="review"&&typeof current.reviewMemo==="string"&&order.filter(s=>s!=="review").every(s=>ready(a.day,s,prev));
  return a.stage===b.stage || (b.stage===order[order.indexOf(a.stage)+1]&&ready(a.day,a.stage,prev));
}
