// P0-2: personalised practice focus, derived deterministically from the most
// recent reviewed scorecard. A focus is coaching language, never a score:
// pronunciation wording is limited to self-listening confirmation and no text
// may claim an error rate, accuracy or progress.
import type {CoachAnalysis, CoachFeedback, ScorecardIssue, SpeakingScorecardData} from './feedback-model';

export type FocusKind = 'pronunciation'|'grammar'|'fluency'|'lexical'|'drill'|'topic';
export type FocusStatus = 'active'|'done'|'dismissed';
export type SpeakingFocus = {
  id:string;
  kind:FocusKind;
  text_zh:string;
  source?:{attemptId?:string;quote?:string};
  createdAt:string;
  status:FocusStatus;
};
export type FocusHistory = {version:1;current?:SpeakingFocus;history:SpeakingFocus[]};
export const FOCUS_HISTORY_LIMIT=5;
const FORBIDDEN=/(发音错误|准确率|进步|提高了|提升了)/;

function record(value:unknown):Record<string,unknown>|null {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
function text(value:unknown){return typeof value==='string'?value.trim():''}
function num(value:unknown){return typeof value==='number'&&Number.isFinite(value)?value:null}
function arr(value:unknown){return Array.isArray(value)?value:[]}
function safeText(value:string){
  // A generated focus must never smuggle a score claim into the learner UI.
  return FORBIDDEN.test(value)?'':value;
}
function digest(value:string){
  let h=0x811c9dc5;
  for(let i=0;i<value.length;i++){h^=value.charCodeAt(i);h=Math.imul(h,0x01000193)}
  return (h>>>0).toString(16).padStart(8,'0');
}
export function focusId(kind:FocusKind,text_zh:string,attemptId?:string){
  return `${kind}-${attemptId||'topic'}-${digest(text_zh)}`;
}
function make(kind:FocusKind,text_zh:string,createdAt:string,source?:SpeakingFocus['source']):SpeakingFocus|null {
  const clean=safeText(text_zh.trim());
  if(!clean)return null;
  return {id:focusId(kind,clean,source?.attemptId),kind,text_zh:clean,createdAt,status:'active',...(source?{source}:{})};
}
function criterion(scorecard:SpeakingScorecardData,keys:string[],labels:string[]) {
  return scorecard.criteria.find(item=>keys.includes(item.key)
    || labels.some(label=>item.label_zh?.includes(label)));
}
function issues(item:{evidence?:Record<string,unknown>}|undefined):ScorecardIssue[] {
  const value=item?.evidence?.issues;
  return Array.isArray(value)?value.filter((issue):issue is ScorecardIssue=>
    Boolean(issue&&typeof issue==='object'&&typeof (issue as ScorecardIssue).quote==='string')):[];
}
export function focusFromFeedback(day:number,feedback:CoachFeedback[]):SpeakingFocus|null {
  const latest=feedback.filter(row=>row.day===day&&row.analysis?.scorecard)
    .slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  if(!latest?.analysis?.scorecard)return null;
  const at=latest.createdAt||new Date(0).toISOString();
  const attemptId=latest.attempt;
  const scorecard=latest.analysis.scorecard;
  const analysis:CoachAnalysis=latest.analysis;
  // 1. Self-listening confirmation only; catch trials never become focuses.
  const confirmed=[...new Set(arr(analysis.items).filter(item=>{
    const row=record(item);
    return row&&row.isCatchTrial!==true
      && (row.answeredVerdict==='confirmed'||row.verdict==='confirmed')
      && text(row.word);
  }).map(item=>text((item as Record<string,unknown>).word)))].slice(0,4);
  if(confirmed.length){
    const list=confirmed.map(word=>`「${word}」`).join('、');
    return make('pronunciation',`把这 ${confirmed.length} 个词放慢读一遍，再自听确认：${list}。`,at,
      {attemptId,quote:confirmed.join('、')});
  }
  // 2. Major grammar issue with a verified quote/fix from the scorecard.
  const grammar=criterion(scorecard,['grammar'],['语法']);
  const major=issues(grammar).find(issue=>issue.quote.trim()&&issue.severity==='major')
    ||issues(grammar).find(issue=>issue.quote.trim());
  if(major){
    const fix=text(major.fix)||text(major.suggestion);
    return make('grammar',fix?`把「${major.quote.trim()}」改说成「${fix}」。`:`把「${major.quote.trim()}」再完整说一遍。`,at,
      {attemptId,quote:major.quote.trim()});
  }
  // 3. Only calibrated fluency evidence may drive a timing focus.
  const fluency=criterion(scorecard,['fluency'],['流利']);
  const evidence=fluency?.evidence;
  const calibrated=evidence?.metrics_status==='calibrated'||fluency?.status==='calibrated';
  const speech=num(evidence?.speech_ratio), pause=num(evidence?.long_pause_ratio);
  if(calibrated&&((speech!==null&&speech<0.55)||(pause!==null&&pause>0.15)))
    return make('fluency','先列两个要点，把 ≥1 秒停顿压到 2 次以内。',at,{attemptId});
  // 4. A scorecard drill's own focus wording.
  const drill=arr(scorecard.drills).map(record).find(row=>row&&text(row.improved)&&text(row.focus_zh));
  if(drill){
    const improved=text(drill!.improved);
    return make('drill',`用「${improved}」的句式回答下一题。`,at,{attemptId,quote:improved});
  }
  // 5. Lexical suggestion, again quoting verified scorecard evidence.
  const lexical=criterion(scorecard,['lexical','vocabulary'],['词汇']);
  const lexicalIssue=issues(lexical)[0];
  if(lexicalIssue&&text(lexicalIssue.suggestion)){
    return make('lexical',`把「${lexicalIssue.quote.trim()}」换成「${text(lexicalIssue.suggestion)}」。`,at,
      {attemptId,quote:lexicalIssue.quote.trim()});
  }
  // 6. No usable evidence: a topic prompt, not a diagnosis.
  return make('topic','说满 30 秒，并补一个具体例子。',at,{attemptId});
}
export function parseFocus(raw?:string):FocusHistory {
  if(!raw||!raw.trim())return {version:1,history:[]};
  try {
    const value=JSON.parse(raw) as unknown;
    const row=record(value);
    if(!row)return {version:1,history:[]};
    const clean=(item:unknown):SpeakingFocus|null=>{
      const f=record(item);
      if(!f||typeof f.id!=='string'||typeof f.text_zh!=='string'||typeof f.createdAt!=='string')return null;
      const kind=(['pronunciation','grammar','fluency','lexical','drill','topic'] as const)
        .find(k=>k===f.kind);
      const status=(['active','done','dismissed'] as const).find(s=>s===f.status)||'active';
      if(!kind)return null;
      const source=record(f.source);
      return {id:f.id,kind,text_zh:f.text_zh,createdAt:f.createdAt,status,
        ...(source?{source:{...(typeof source.attemptId==='string'?{attemptId:source.attemptId}:{}),
          ...(typeof source.quote==='string'?{quote:source.quote}:{})}}:{})};
    };
    // A bare focus object is also accepted; older builds never wrote one.
    if(typeof row.id==='string'&&typeof row.kind==='string') {
      const current=clean(row);
      return {version:1,history:[],...(current?{current}:{})};
    }
    const current=clean(row.current)||undefined;
    const history=arr(row.history).map(clean).filter((item):item is SpeakingFocus=>Boolean(item)).slice(0,FOCUS_HISTORY_LIMIT);
    return {version:1,history,...(current?{current}:{})};
  } catch {return {version:1,history:[]}}
}
export function serializeFocus(state:FocusHistory){return JSON.stringify({version:1,...(state.current?{current:state.current}:{}),history:state.history.slice(0,FOCUS_HISTORY_LIMIT)})}
export function activeFocus(raw?:string){return parseFocus(raw).current}
export function mergeFocus(raw:string|undefined,candidate:SpeakingFocus|null,now=new Date().toISOString()){
  const state=parseFocus(raw);
  if(!candidate)return {value:raw||serializeFocus(state),changed:false,state};
  const current=state.current;
  // Same attempt or an already-decided focus is never rewritten automatically.
  if(current&&(current.id===candidate.id||current.source?.attemptId===candidate.source?.attemptId
    ||current.status!=='active'))
    return {value:raw||serializeFocus(state),changed:false,state};
  const known=[current,...state.history].filter((item):item is SpeakingFocus=>Boolean(item));
  if(known.some(item=>item.id===candidate.id
    ||(candidate.source?.attemptId&&item.source?.attemptId===candidate.source.attemptId)))
    return {value:raw||serializeFocus(state),changed:false,state};
  // Only a newer attempt may replace an active focus.
  if(current&&current.createdAt&&candidate.createdAt&&
    Date.parse(candidate.createdAt)<=Date.parse(current.createdAt))
    return {value:raw||serializeFocus(state),changed:false,state};
  const next:FocusHistory={version:1,current:{...candidate,createdAt:candidate.createdAt||now},
    history:[...(current?[current]:[]),...state.history].slice(0,FOCUS_HISTORY_LIMIT)};
  return {value:serializeFocus(next),changed:true,state:next};
}
export function setFocusStatus(raw:string|undefined,id:string,status:FocusStatus){
  const state=parseFocus(raw);
  if(state.current?.id===id)state.current={...state.current,status};
  state.history=state.history.map(item=>item.id===id?{...item,status}:item);
  return serializeFocus(state);
}
// Evidence shown under a focus on the next session's page. Only rows that the
// scorecard itself backs are listed, each with its honest status label.
export type FocusEvidence={label_zh:string;value:string;status:'calibrated'|'reference'|'suggestive'};
export function focusEvidence(focus:SpeakingFocus,feedback:CoachFeedback[]):FocusEvidence[] {
  const attemptId=focus.source?.attemptId;
  const row=feedback.filter(item=>item.attempt===attemptId&&item.analysis?.scorecard)
    .slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  if(!row?.analysis?.scorecard)return [];
  const analysis=row.analysis;
  const scorecard=analysis.scorecard;
  if(!scorecard)return [];
  const lines:FocusEvidence[]=[];
  const confirmed=[...new Set(arr(analysis.items).filter(item=>{
    const entry=record(item);
    return entry&&entry.isCatchTrial!==true
      &&(entry.answeredVerdict==='confirmed'||entry.verdict==='confirmed')&&text(entry.word);
  }).map(item=>text((item as Record<string,unknown>).word)))];
  if(confirmed.length)lines.push({label_zh:'自听确认词数',value:`${confirmed.length} 个`,status:'suggestive'});
  const fluency=criterion(scorecard,['fluency'],['流利']);
  const evidence=fluency?.evidence;
  const calibrated=evidence?.metrics_status==='calibrated'||fluency?.status==='calibrated';
  const speech=num(evidence?.speech_ratio),pause=num(evidence?.long_pause_ratio);
  if(speech!==null&&calibrated)lines.push({label_zh:'语音占比',value:`${Math.round(speech*100)}%`,status:'calibrated'});
  if(pause!==null&&calibrated)lines.push({label_zh:'长停顿占比',value:`${Math.round(pause*100)}%`,status:'calibrated'});
  if(speech!==null&&!calibrated)lines.push({label_zh:'语音占比（参考）',value:`${Math.round(speech*100)}%`,status:'reference'});
  const grammar=issues(criterion(scorecard,['grammar'],['语法']));
  if(grammar.length)lines.push({label_zh:'语法问题条数（参考）',value:String(grammar.length),status:'reference'});
  const lexical=issues(criterion(scorecard,['lexical','vocabulary'],['词汇']));
  if(lexical.length)lines.push({label_zh:'词汇问题条数（参考）',value:String(lexical.length),status:'reference'});
  return lines;
}

export function focusSuggestions(day:number,feedback:CoachFeedback[]):SpeakingFocus[] {  const latest=feedback.filter(row=>row.day===day&&row.analysis?.scorecard)
    .slice().sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
  if(!latest)return [];
  const result:SpeakingFocus[]=[];
  const scorecard=latest.analysis?.scorecard;
  if(!scorecard)return result;
  const grammar=issues(criterion(scorecard,['grammar'],['语法'])).find(issue=>issue.quote.trim()&&issue.severity==='major');
  if(grammar){
    const fix=text(grammar.fix)||text(grammar.suggestion);
    const focus=make('grammar',fix?`把「${grammar.quote.trim()}」改说成「${fix}」。`:`把「${grammar.quote.trim()}」再完整说一遍。`,
      latest.createdAt,{attemptId:latest.attempt,quote:grammar.quote.trim()});
    if(focus)result.push(focus);
  }
  const fluency=criterion(scorecard,['fluency'],['流利']);
  if(fluency?.evidence?.metrics_status==='calibrated'){
    const focus=make('fluency','先列两个要点，把 ≥1 秒停顿压到 2 次以内。',latest.createdAt,{attemptId:latest.attempt});
    if(focus)result.push(focus);
  }
  const drill=arr(scorecard.drills).map(record).find(row=>row&&text(row.improved));
  if(drill){
    const focus=make('drill',`用「${text(drill!.improved)}」的句式回答下一题。`,latest.createdAt,
      {attemptId:latest.attempt,quote:text(drill!.improved)});
    if(focus)result.push(focus);
  }
  const topic=make('topic','说满 30 秒，并补一个具体例子。',latest.createdAt,{attemptId:latest.attempt});
  if(topic)result.push(topic);
  const seen=new Set<string>();
  return result.filter(item=>{if(seen.has(item.text_zh))return false;seen.add(item.text_zh);return true});
}
