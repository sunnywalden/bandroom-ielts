// Shared by the Work tools and the page. An ID binds feedback to the exact
// submitted content, conditions, day and attempt; drafts never enter this list.
export type PronunciationError = {
  wordIndex?: number; phoneIndex?: number; kind: 'substitution'|'deletion'|'addition';
  gapOccurrence?: number;
  target: string; actual: string; word?: string;
  startMs?: number; endMs?: number; anchorMs?: number;
  probability?: number; suggestion?: string;
};
// Speaking redesign (docs/speaking-redesign-2026-11-19.md): score-first
// feedback. Every band is a disclosed reference estimate; pronunciation is
// never scored while phoneme assertion gates are unmet (band === null).
export type TranscriptWord = {word:string;start:number;end:number;probability:number};
export type ScorecardIssue = {quote:string;fix?:string;suggestion?:string;reason_zh?:string;severity?:'major'|'minor'};
export type ScorecardCriterion = {
  key:string;label_zh:string;band:number|null;status:string;disclosure_zh:string;
  evidence?:Record<string,unknown>&{issues?:ScorecardIssue[]};
};
export type SpeakingDrill = {quote:string;improved:string;focus_zh:string;contrast_audio?:{url?:string;status?:string}};
export type SpeakingScorecardData = {
  schema:string;
  overall:{band:number|null;status:string;disclosure_zh:string;basis_zh:string};
  criteria:ScorecardCriterion[];
  transcript?:{source:string;status:string;words?:TranscriptWord[]}|null;
  drills?:SpeakingDrill[];
  llm_status?:string;
};
export type CoachAnalysis = {
  analysisVersion?: string; recordingSha256?: string;
  errors?: PronunciationError[];
  coverage?: {analyzedSamples?: Array<[number,number]>; fraction?: number};
  // Tiered audio-coach evidence (design rev2). Kept unknown here because the
  // display model validates the shape in app/pronunciation-review.ts.
  pronunciation?: unknown;
  pronunciationCoach?: unknown;
  reliability?: unknown;
  tiers?: unknown;
  profile?: unknown;
  progress?: unknown;
  prosody?: unknown;
  // v2 transport: ASR transcript + scorecard (validated server-side).
  transcript?: TranscriptWord[];
  scorecard?: SpeakingScorecardData;
  items?: Array<{candidateId?:string;word?:string;atMs?:number;priorVerdict?:string;answeredVerdict?:string;verdict?:string;isCatchTrial?:boolean}>;
};
export type CoachFeedback = {id:string;day:number;stage:string;attempt:string;evidence:string;feedback:string;createdAt:string;analysis?:CoachAnalysis};
export type ReviewAttempt = {
  id:string; day:number; field:string; index:number; stage:'speak'|'vocab'|'listen'|'read'|'write'|'review';
  title:string; kind:'objective'|'subjective'; response:string; conditions:string;
  evidence:string; recordingId?:string; at?:string; localOnly?:boolean;
  // v2 identity fields (docs/speaking-ux-optimization-2026-11-22.md §7.2).
  // They enter the hash only when the saved row carries them, so legacy
  // attempt ids stay byte-identical.
  questionId?:string; part?:1|2|3; seq?:number; mode?:'daily'|'full'|'mock';
};
export type ReviewLink = { id: string; sourceId: string; day: number };
export type ReviewTaskStatus = {
  id: string; attemptId: string; kind: 'text'|'speaking'; state: string; stage: string;
  nextAt: number; lastError: string|null; updatedAt: number;
};
export type AutomationStatus = {
  connected: boolean; lastSuccessAt: number|null; nextExpectedAt: number|null; status: string|null;
};
type Candidate = Omit<ReviewAttempt,'id'>;
type SavedRow = {at?:unknown;text?:unknown;audio?:unknown;local?:unknown;part?:unknown;questionId?:unknown;seq?:unknown;mode?:unknown;reviewed?:unknown};

type SavedRowMeta={part?:1|2|3;questionId?:string;seq:number;mode?:'daily'|'full'|'mock'};
function rowMeta(row:SavedRow,index:number):SavedRowMeta {
  const part=row.part===1||row.part===2||row.part===3?row.part:undefined;
  const questionId=typeof row.questionId==='string'&&row.questionId.trim()?row.questionId.trim():undefined;
  const seq=Number.isSafeInteger(row.seq)&&(row.seq as number)>=0?row.seq as number:index;
  const mode=row.mode==='daily'||row.mode==='full'||row.mode==='mock'?row.mode:undefined;
  return {part,questionId,seq,mode};
}

function speakTitle(field:string,index:number,meta:ReturnType<typeof rowMeta>):string {
  // Part 2 stays the single answer it always was; only Part 3 practice draws
  // numbered titles from its question sequence.
  if(field==='speakingPart2')return '口语 Part 2 · '+(index===0?'首次回答':'重答 '+index);
  if(meta.questionId||meta.part===3)
    return `口语 Part 3 · 第 ${meta.seq+1} 题`;
  return '口语 Part 3 · '+(index===0?'首次回答':'重答 '+index);
}

// Explicit allowlist, frozen key order (docs §7.2). Never spread the candidate:
// adding a presentation or mutable field must not move historical ids.
function identityOf(candidate:Candidate):Record<string,unknown> {
  const identity:Record<string,unknown>={
    day:candidate.day,field:candidate.field,index:candidate.index,stage:candidate.stage,
    response:candidate.response,conditions:candidate.conditions,evidence:candidate.evidence,
  };
  // v2 fields sit at a fixed position after `evidence` and before optional
  // recording keys. `seq`, `mode`, `notes`, `reviewed` and `sessionId` never
  // enter the hash.
  if(Object.hasOwn(candidate,'questionId'))identity.questionId=candidate.questionId;
  if(Object.hasOwn(candidate,'part'))identity.part=candidate.part;
  if(Object.hasOwn(candidate,'recordingId'))identity.recordingId=candidate.recordingId;
  if(Object.hasOwn(candidate,'at'))identity.at=candidate.at;
  if(Object.hasOwn(candidate,'localOnly'))identity.localOnly=candidate.localOnly;
  return identity;
}

export async function reviewAttempts(day:number, entry:Record<string,string>):Promise<ReviewAttempt[]> {
  const candidates:Candidate[]=[];
  const add=(field:string,stage:Candidate['stage'],title:string,kind:Candidate['kind']='subjective',conditions='',evidence='')=>{
    if(entry[field]?.trim())candidates.push({day,field,index:0,stage,title,kind,response:entry[field],conditions,evidence});
  };
  const speakRows=(field:string,raw:string|undefined,kindField:'legacy'|'mock')=>{
    let rows:unknown;try{rows=JSON.parse(raw||'[]')}catch{return}
    if(!Array.isArray(rows))return;
    rows.forEach((rawRow,index)=>{
      const row=(rawRow||{}) as SavedRow;
      if(typeof row.at!=='string'||typeof row.text!=='string')return;
      // Part 3 practice questions can be marked unreviewed (daily mode only
      // reviews the first one); legacy rows have no flag and stay reviewable.
      if(field==='speakingFollowup'&&row.reviewed===false)return;
      const meta=rowMeta(row,index);
      const title=kindField==='mock'
        ?`练习模考 · Part ${meta.part??2} · 第 ${meta.seq+1} 题`
        :speakTitle(field,index,meta);
      candidates.push({day,field,index,stage:'speak',title,kind:'subjective',response:row.text,
        conditions:row.audio?'已提交录音':row.local?'录音仅在原浏览器':'自报口练；无可核听录音',evidence:'',
        ...(typeof row.audio==='string'?{recordingId:row.audio}:{}),at:row.at,localOnly:!!row.local,
        ...(meta.questionId?{questionId:meta.questionId}:{}),
        ...(meta.part?{part:meta.part}:{}),
        ...(meta.mode?{mode:meta.mode}:{}),
        ...(Number.isSafeInteger(row.seq)?{seq:meta.seq}:{}),
      });
    });
  };
  for(const field of ['speakingPart2','speakingFollowup'])speakRows(field,entry[field],'legacy');
  // Part 1 warm-ups never become review tasks: the field is intentionally not
  // enumerated here even though it is persisted for session resumes.
  if(entry.speakingMockComplete==='yes')speakRows('speakingMock',entry.speakingMock,'mock');
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
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(identityOf(candidate))));
    const digest=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
    return {...candidate,id:`v1:${candidate.field}:${candidate.index}:${digest}`};
  }));
}
export function feedbackFor(attempt:ReviewAttempt,feedback:CoachFeedback[]) {
  return feedback.filter(f=>f.day===attempt.day&&f.stage===attempt.stage&&f.attempt===attempt.id);
}
// A review submission must carry exactly one NEW reviewable subjective answer
// (server: app/api/state/route.ts). Two session-era changes touch a review
// field without adding one, and must stay plain checkpoints or the server
// rejects them with invalid_review_submission:
//   * speakingMock — the server deliberately excludes mock from submissions;
//     mock feedback is reviewed after the run, not per answer.
//   * speakingFollowup — daily-mode extra practice rows carry reviewed:false
//     and are skipped by reviewAttempts above, so appending one adds no task.
// Answer rows are append-only (the oldest is evicted at the cap), so the newly
// written answer is always the last row; it adds a review task only when it is
// reviewable. This mirrors the server rule on the client so the submission key
// is attached exactly when a submission carries a new reviewable answer.
export function addsReviewableAnswer(field:string,after:string|undefined):boolean{
  if(field==='speakingMock')return false;
  if(field!=='speakingFollowup')return true;
  let rows:unknown;
  try{rows=JSON.parse(after||'[]')}catch{return false}
  if(!Array.isArray(rows)||!rows.length)return false;
  const last=rows[rows.length-1];
  return Boolean(last)&&typeof last==='object'&&(last as {reviewed?:unknown}).reviewed!==false;
}
export function reviewRequest(attempt:ReviewAttempt) {
  return `请通过 Bandroom 调用 read_study_session（day: ${attempt.day}, attemptId: ${attempt.id}）读取已提交作答，批改“${attempt.title}”（attempt: ${attempt.id}）。结合题目逐句指出问题，给出修正表达、原因和下一步练习；使用 add_coach_feedback 将评语写回这个 attempt。口语必须实际听到录音才评发音和流利度。不要完成本课或开启下一课。`;
}
