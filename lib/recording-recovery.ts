import type { Ledger } from "../app/ledger";

export type SpeakingPhase = "part2" | "followup";
export type RecoverableClip = { id:string; at:string; bytes:number; match:"question"|"time-only" };
export const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

type Row = {audio?:string; at?:string};
function attempts(raw?:string): Row[] {
  const rows:unknown=JSON.parse(raw||"[]");
  if(!Array.isArray(rows))throw Error("Invalid saved answers");
  return rows;
}

// Scan only the signed-in account's namespace. Objects without v3 question metadata
// can only be offered for explicit listening and selection, never assigned by time.
export function linkedRecordings(ledger:Ledger){
  const linked=new Set<string>();
  for(const e of Object.values(ledger.entries)){
    for(const row of [...attempts(e.speakingPart2),...attempts(e.speakingFollowup)]) if(row.audio)linked.add(row.audio);
  }
  for(const t of (ledger as Ledger&{fullTests?:Row[]}).fullTests||[])if(t.audio)linked.add(t.audio);
  return linked;
}
export async function listRecoverable(bucket:R2Bucket, userId:string, ledger:Ledger, day:number, phase:SpeakingPhase){
  const entry=ledger.entries[day]||{};
  const current=entry.speakingPhase || (day===11?"followup":"part2");
  if(ledger.day!==day||ledger.finished||ledger.stage!=="speak"||current!==phase)
    return {phase,items:[] as RecoverableClip[],complete:true};
  const linked=linkedRecordings(ledger);
  const dayStart=Date.parse(ledger.started[day]+"T00:00:00+08:00");
  if(!Number.isFinite(dayStart))return {phase,items:[] as RecoverableClip[],complete:false};
  let legacyStart=dayStart;
  // The Part 2 receipt supplies an additional lower bound for a follow-up.
  if(phase==="followup"){
    const times=attempts(entry.speakingPart2).map(a=>Date.parse(a.at||"")).filter(Number.isFinite);
    if(times.length)legacyStart=Math.max(dayStart,Math.min(...times)-2000);
  }

  const prefix="speaking/"+encodeURIComponent(userId)+"/";
  const recent:R2Object[]=[];
  let cursor:string|undefined, complete=true;
  for(let page=0;page<10;page++){
    const list=await bucket.list({prefix,limit:200,cursor});
    for(const o of list.objects){
      const id=o.key.slice(prefix.length);
      if(o.key.startsWith(prefix)&&uuid.test(id)&&!linked.has(id)&&o.uploaded.getTime()>=dayStart&&o.size>0)recent.push(o);
    }
    if(!list.truncated)break;
    cursor=list.cursor;
    if(page===9)complete=false;
  }
  recent.sort((a,b)=>b.uploaded.getTime()-a.uploaded.getTime());
  if(recent.length>30)complete=false;
  const items:RecoverableClip[]=[];
  for(const item of recent.slice(0,30)){
    const o=await bucket.head(item.key);
    if(!o||!o.httpMetadata?.contentType?.startsWith("audio/"))continue;
    const id=o.key.slice(prefix.length), meta=o.customMetadata || {};
    const tagged=meta.purpose==="speaking"&&meta.day===String(day)&&meta.phase===phase;
    if(!tagged&&(meta.purpose||o.uploaded.getTime()<legacyStart))continue;
    items.push({id,at:o.uploaded.toISOString(),bytes:o.size,match:tagged?"question":"time-only"});
  }
  return {phase,items,complete};
}
