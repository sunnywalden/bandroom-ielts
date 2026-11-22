// P0-3: honest comparison of two attempts answering the same question.
// Calibrated metrics are compared numerically; reference heuristics and
// suggestive candidates are labelled as such; pronunciation is never compared.
import type {CoachAnalysis, CoachFeedback, ScorecardCriterion, SpeakingScorecardData} from './feedback-model';

export type CompareStatus='calibrated'|'reference'|'suggestive'|'asr'|'unavailable';
export type CompareSide={attemptId:string;scorecard?:SpeakingScorecardData;analysis?:CoachAnalysis};
export type CompareRow={
  key:string;label_zh:string;left:string;right:string;status:CompareStatus;
  delta?:string;note?:string;
};
export type CompareResult={
  matched:boolean;reason?:string;rows:CompareRow[];disclosure:string;
};
export const COMPARE_DISCLOSURE='两次录音长度和题目不同会影响停顿与语速；这里只对比同一题的证据，发音不作分数比较。';

function hash(value:string){
  let h=0x811c9dc5;
  for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193)}
  return (h>>>0).toString(16).padStart(8,'0');
}
export function normalizePrompt(prompt:string){return prompt.trim().replace(/\s+/g,' ').toLowerCase()}
export function legacyQuestionKey(day:number,prompt:string){return `lesson:${day}:${hash(normalizePrompt(prompt))}`}
export type QuestionRef={day:number;prompt:string;questionId?:string};
export function comparisonKey(ref:QuestionRef){
  if(ref.questionId?.trim())return {key:`q:${ref.questionId.trim()}`,scheme:'v2' as const};
  return {key:legacyQuestionKey(ref.day,ref.prompt),scheme:'legacy' as const};
}
export function sameQuestion(left:QuestionRef,right:QuestionRef){
  const a=comparisonKey(left),b=comparisonKey(right);
  return a.scheme===b.scheme&&a.key===b.key;
}
export function drillKey(attemptId:string,quote:string,improved:string){
  return `${attemptId}:${hash(normalizePrompt(quote))}:${hash(normalizePrompt(improved))}`;
}
export type DrillTake={
  drillKey:string;attemptId:string;at:string;audio:string;
  selfRating?:'used'|'not_yet';durationMs?:number;
};
type DrillStore={version:1;takes:DrillTake[]};
export const DRILL_TAKE_SESSION_CAP=12;
export const DRILL_TAKE_PER_DRILL_CAP=3;
function parseStore(raw?:string):DrillStore {
  if(!raw?.trim())return {version:1,takes:[]};
  try {
    const value=JSON.parse(raw) as {takes?:unknown};
    if(!value||!Array.isArray(value.takes))return {version:1,takes:[]};
    return {version:1,takes:value.takes.filter((take):take is DrillTake=>{
      const row=take as DrillTake;
      return row&&typeof row.drillKey==='string'&&typeof row.attemptId==='string'
        &&typeof row.at==='string'&&typeof row.audio==='string';
    }).slice(-DRILL_TAKE_SESSION_CAP)};
  } catch {return {version:1,takes:[]}}
}
export function drillTakes(raw?:string){return parseStore(raw).takes}
export function addDrillTake(raw:string|undefined,take:DrillTake){
  const store=parseStore(raw);
  if(store.takes.filter(item=>item.drillKey===take.drillKey).length>=DRILL_TAKE_PER_DRILL_CAP)
    return {value:raw||JSON.stringify(store),added:false,reason:'drill_cap' as const,removed:false};
  const keep=store.takes.filter(item=>item.drillKey!==take.drillKey);
  const perDrill=store.takes.filter(item=>item.drillKey===take.drillKey);
  const next=[...keep,...perDrill,take].sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
  const removed=next.length>DRILL_TAKE_SESSION_CAP;
  const trimmed=next.slice(-DRILL_TAKE_SESSION_CAP);
  return {value:JSON.stringify({version:1,takes:trimmed}),added:true,removed,reason:null};
}
export function latestTakeFor(raw:string|undefined,key:string){
  return drillTakes(raw).filter(take=>take.drillKey===key).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0]||null;
}
// Self-rating applies to the latest take of a drill; earlier takes keep the
// verdict they were given so the learner can see their own state change.
export function rateDrillTake(raw:string|undefined,key:string,selfRating:'used'|'not_yet'){
  const store=parseStore(raw);
  const latest=store.takes.filter(take=>take.drillKey===key)
    .sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
  let changed=false;
  const takes=store.takes.map(take=>{
    if(take!==latest)return take;
    changed=take.selfRating!==selfRating;
    return {...take,selfRating};
  });
  return {value:JSON.stringify({version:1,takes}),changed};
}

function criterion(scorecard:SpeakingScorecardData,keys:string[],labels:string[]){
  return scorecard.criteria.find(item=>keys.includes(item.key)||labels.some(label=>item.label_zh?.includes(label)));
}
function numberIn(evidence:Record<string,unknown>|undefined,keys:string[]){
  for(const key of keys){const value=evidence?.[key];if(typeof value==='number'&&Number.isFinite(value))return value}
  return null;
}
function percent(value:number|null){return value===null?'—':`${Math.round(value*100)}%`}
function percentDelta(left:number|null,right:number|null){
  if(left===null||right===null)return undefined;
  const points=Math.round((right-left)*100);
  return points===0?'0 个百分点':`${points>0?'+':''}${points} 个百分点`;
}
function issueCount(item:ScorecardCriterion|undefined){
  const issues=item?.evidence?.issues;
  return Array.isArray(issues)?issues.length:null;
}
function confirmedWords(analysis:CoachAnalysis|undefined){
  const items=analysis?.items;
  if(!Array.isArray(items))return null;
  return items.filter(item=>item&&item.isCatchTrial!==true
    &&(item.answeredVerdict==='confirmed'||item.verdict==='confirmed')).length;
}
function value(value:number|null,suffix=''){return value===null?'—':`${value}${suffix}`}

export function compareAttempts(input:{left:CompareSide;right:CompareSide;labelLeft?:string;labelRight?:string}):CompareResult {
  const {left,right}=input;
  const leftLabel=input.labelLeft||'上次';
  const rightLabel=input.labelRight||'这次';
  if(!left.scorecard||!right.scorecard)
    return {matched:false,reason:'两次作答中至少一次还没有可对比的评分卡。',rows:[],disclosure:COMPARE_DISCLOSURE};
  const rows:CompareRow[]=[];
  const fluencyLeft=criterion(left.scorecard,['fluency'],['流利']);
  const fluencyRight=criterion(right.scorecard,['fluency'],['流利']);
  const calibrated=fluencyLeft?.evidence?.metrics_status==='calibrated'
    &&fluencyRight?.evidence?.metrics_status==='calibrated';
  const speechLeft=numberIn(fluencyLeft?.evidence,['speech_ratio','speechRatio']);
  const speechRight=numberIn(fluencyRight?.evidence,['speech_ratio','speechRatio']);
  const pauseLeft=numberIn(fluencyLeft?.evidence,['long_pause_ratio','longPauseRatio']);
  const pauseRight=numberIn(fluencyRight?.evidence,['long_pause_ratio','longPauseRatio']);
  if(calibrated&&(speechLeft!==null||speechRight!==null))
    rows.push({key:'speech_ratio',label_zh:'语音占比',left:percent(speechLeft),right:percent(speechRight),
      status:'calibrated',delta:percentDelta(speechLeft,speechRight),note:'按每秒语音暴露计算'});
  if(calibrated&&(pauseLeft!==null||pauseRight!==null))
    rows.push({key:'long_pause_ratio',label_zh:'长停顿占比',left:percent(pauseLeft),right:percent(pauseRight),
      status:'calibrated',delta:percentDelta(pauseLeft,pauseRight),note:'≥1 秒停顿'});
  const wpmLeft=numberIn(fluencyLeft?.evidence,['wpm','words_per_minute','wordsPerMinute']);
  const wpmRight=numberIn(fluencyRight?.evidence,['wpm','words_per_minute','wordsPerMinute']);
  if(wpmLeft!==null||wpmRight!==null)
    rows.push({key:'wpm',label_zh:'词速（参考）',left:value(wpmLeft,' wpm'),right:value(wpmRight,' wpm'),
      status:'reference',note:'按转写计算，断句和转写差异会影响数值'});
  const grammarLeft=criterion(left.scorecard,['grammar'],['语法']);
  const grammarRight=criterion(right.scorecard,['grammar'],['语法']);
  const grammarLeftCount=issueCount(grammarLeft),grammarRightCount=issueCount(grammarRight);
  if(grammarLeftCount!==null||grammarRightCount!==null)
    rows.push({key:'grammar_issues',label_zh:'语法问题条数（参考）',left:value(grammarLeftCount),
      right:value(grammarRightCount),status:'reference',note:'转写差异会影响计数'});
  const lexicalLeft=issueCount(criterion(left.scorecard,['lexical','vocabulary'],['词汇']));
  const lexicalRight=issueCount(criterion(right.scorecard,['lexical','vocabulary'],['词汇']));
  if(lexicalLeft!==null||lexicalRight!==null)
    rows.push({key:'lexical_issues',label_zh:'词汇问题条数（参考）',left:value(lexicalLeft),
      right:value(lexicalRight),status:'reference',note:'转写差异会影响计数'});
  const wordsLeft=confirmedWords(left.analysis),wordsRight=confirmedWords(right.analysis);
  if(wordsLeft!==null||wordsRight!==null)
    rows.push({key:'self_listen_words',label_zh:'自听确认词数',left:value(wordsLeft),
      right:value(wordsRight),status:'suggestive',note:'只表示你确认过的词，不是音素判定'});
  return {matched:true,rows,disclosure:COMPARE_DISCLOSURE};
}
export function feedbackByAttempt(feedback:CoachFeedback[],attemptId:string){
  return feedback.filter(row=>row.attempt===attemptId)
    .slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
}
export function sideFromFeedback(feedback:CoachFeedback[],attemptId:string,day:number):CompareSide|null {
  // Same attempt may be reviewed more than once; compare against the latest.
  const row=feedbackByAttempt(feedback,attemptId);
  if(!row||row.day!==day)return null;
  return {attemptId,scorecard:row.analysis?.scorecard,analysis:row.analysis};
}
export function splitSameQuestion(input:{left:QuestionRef;right:QuestionRef;leftSide:CompareSide;rightSide:CompareSide}){
  if(!sameQuestion(input.left,input.right))
    return {matched:false,reason:'两次作答不是同一道题，不能放在一起对比。',rows:[],disclosure:COMPARE_DISCLOSURE} satisfies CompareResult;
  return compareAttempts({left:input.leftSide,right:input.rightSide});
}
