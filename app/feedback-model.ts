// Shared by the Work tools and the page. An ID binds feedback to the exact
// submitted content, conditions, day and attempt; drafts never enter this list.
export type CoachFeedback = {id:string;day:number;stage:string;attempt:string;evidence:string;feedback:string;createdAt:string};
export type ReviewAttempt = {
  id:string; day:number; field:string; index:number; stage:'speak'|'vocab'|'listen'|'read'|'write'|'review';
  title:string; kind:'objective'|'subjective'; response:string; conditions:string;
  evidence:string; recordingId?:string; at?:string; localOnly?:boolean;
};
export type ReviewLink = { id: string; sourceId: string; day: number };
type Candidate = Omit<ReviewAttempt,'id'>;
export async function reviewAttempts(day:number, entry:Record<string,string>):Promise<ReviewAttempt[]> {
  const candidates:Candidate[]=[];
  const add=(field:string,stage:Candidate['stage'],title:string,kind:Candidate['kind']='subjective',conditions='',evidence='')=>{
    if(entry[field]?.trim())candidates.push({day,field,index:0,stage,title,kind,response:entry[field],conditions,evidence});
  };
  for(const field of ['speakingPart2','speakingFollowup']) {
    let rows:unknown; try{rows=JSON.parse(entry[field]||'[]')}catch{continue}
    if(!Array.isArray(rows))continue;
    rows.forEach((row,index)=>{
      if(!row||typeof row.at!=='string'||typeof row.text!=='string')return;
      candidates.push({day,field,index,stage:'speak',title:(field==='speakingPart2'?'口语 Part 2':'口语 Part 3')+' · '+(index===0?'首次回答':'重答 '+index),
        kind:'subjective',response:row.text,conditions:row.audio?'已提交录音':row.local?'录音仅在原浏览器':'自报口练；无可核听录音',evidence:'',
        ...(typeof row.audio==='string'?{recordingId:row.audio}:{}),at:row.at,localOnly:!!row.local});
    });
  }
  add('speakingReview','speak','口语自评');
  add('vocabRecall','vocab','词汇回忆','objective');
  add('vocabUse','vocab','词汇造句');
  for(const stage of ['listen','read'] as const)for(const index of [0,1])
    add(stage+'Q'+index,stage,(stage==='listen'?'听力':'阅读')+'第 '+(index+1)+' 题',stage==='listen'?'objective':'subjective',entry[stage+'Mode'+index]||'',entry[stage+'Evidence'+index]||'');
  add('writeOriginal','write','写作首稿','subjective',entry.writeCondition||'');
  add('writeRevision','write','写作修订稿','subjective','',entry.writeFocus||'');
  add('reviewMemo','review','本课复盘');
  return Promise.all(candidates.map(async candidate=>{
    // Presentation labels may change without invalidating saved feedback.
    const identity:Partial<Candidate>={...candidate};delete identity.title;delete identity.kind;
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identity)));
    const digest=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
    return {...candidate,id:`v1:${candidate.field}:${candidate.index}:${digest}`};
  }));
}
export function feedbackFor(attempt:ReviewAttempt,feedback:CoachFeedback[]) {
  return feedback.filter(f=>f.day===attempt.day&&f.stage===attempt.stage&&f.attempt===attempt.id);
}
export function reviewRequest(attempt:ReviewAttempt) {
  return `请通过 Bandroom 调用 read_study_session（day: ${attempt.day}, attemptId: ${attempt.id}）读取已提交作答，批改“${attempt.title}”（attempt: ${attempt.id}）。结合题目逐句指出问题，给出修正表达、原因和下一步练习；使用 add_coach_feedback 将评语写回这个 attempt。口语必须实际听到录音才评发音和流利度。不要完成本课或开启下一课。`;
}
