'use client';
import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {etaText,runningLabel} from './review-polling';
import {feedbackFor,reviewAttempts,reviewRequest,type AutomationStatus,type CoachFeedback,type ReviewAttempt,type ReviewLink,type ReviewTaskStatus,type WritingRecheckStatus} from './feedback-model';
import {legacyPromptTitle,sideFromFeedback,type CompareSide,type QuestionRef} from './speaking-compare';
import {questionById} from './speaking-questions';
import AttemptCompare from './attempt-compare';
import {displayPronunciationErrors} from './pronunciation-display';
import RecordingClipPlayer from './recording-clip-player';
import {PronunciationCoach,TieredFeedbackProse} from './pronunciation-coach';
import SpeakingScorecard from './speaking-scorecard';
import './feedback.css';

type Context = {attempts:ReviewAttempt[];feedback:CoachFeedback[];tasks:ReviewTaskStatus[];automation?:AutomationStatus;error:boolean;refresh:()=>void;ready:boolean;identificationFailed:boolean;retry:()=>void;account:string;drillTakes?:string;saveDrillTakes?:(raw:string)=>Promise<boolean>;rechecks:WritingRecheckStatus[]};
const FeedbackContext=createContext<Context>({attempts:[],feedback:[],tasks:[],automation:undefined,error:false,refresh:()=>{},ready:false,identificationFailed:false,retry:()=>{},account:'',rechecks:[]});
export function FeedbackProvider({day,entry,feedback,links,tasks,automation,error,refresh,children,account='',drillTakes,saveDrillTakes,rechecks=[]}:{day:number;entry:Record<string,string>;feedback:CoachFeedback[];links?:ReviewLink[];tasks?:ReviewTaskStatus[];automation?:AutomationStatus;error:boolean;refresh:()=>void;children:ReactNode;account?:string;drillTakes?:string;saveDrillTakes?:(raw:string)=>Promise<boolean>;rechecks?:WritingRecheckStatus[]}) {
  const source=JSON.stringify(entry),[identified,setIdentified]=useState<{day:number;source:string;attempts:ReviewAttempt[];failed?:boolean}|null>(null);
  const [retryCount,setRetryCount]=useState(0);
  useEffect(()=>{
    let active=true;
    void reviewAttempts(day,JSON.parse(source)).then(attempts=>{if(active)setIdentified({day,source,attempts})}).catch(()=>{if(active)setIdentified({day,source,attempts:[],failed:true})});
    return ()=>{active=false};
  },[day,source,retryCount]);
  const current=identified?.day===day&&identified.source===source?identified:null;
  const attempts=(current?.attempts??[]).map(attempt=>{
    const link=links?.find(row=>row.day===day&&row.sourceId===attempt.id);
    return link?{...attempt,id:link.id}:attempt;
  });
  return <FeedbackContext.Provider value={{attempts,feedback,tasks:tasks??[],automation,error,refresh,ready:Boolean(current&&!current.failed),identificationFailed:Boolean(current?.failed),retry:()=>setRetryCount(n=>n+1),account,drillTakes,saveDrillTakes,rechecks}}>{children}</FeedbackContext.Provider>;
}
export function FeedbackIdentificationStatus(){
  const {identificationFailed,retry}=useContext(FeedbackContext);
  return identificationFailed?<div className="alert" role="status"><span>暂时无法定位对应练习的反馈。已保存的答案和评语仍保留。</span><button type="button" onClick={retry}>重试定位反馈</button></div>:null;
}
function QuickCheck({attempt}:{attempt:ReviewAttempt}) {
  const {field,response,recordingId,conditions}=attempt;
  if(field.startsWith('write'))return <p className="af-check">提交核对：{(response.match(/\S+/g)||[]).length} 词。{field==='writeRevision'?'首稿和修改说明均已保留。':'首稿已锁定，二稿会单独保存。'}批改会显示在稿件旁。</p>;
  if(field==='vocabUse')return <p className="af-check">例句已保存。教练将核对搭配、语法及是否回应题目。</p>;
  if(field.startsWith('readQ'))return <p className="af-check">选择题已即时核对；你写的证据说明将单独批改。</p>;
  if(field==='speakingPart2'||field==='speakingFollowup')return <p className="af-check">{recordingId?'录音已提交。教练需听到这段录音后，才能评价发音和流利度。':conditions+'。发音和流利度暂不评分。'}</p>;
  if(field==='speakingReview')return <p className="af-check">口语自评已保存。交给教练后，教练可根据你的自评给出下一次口语练习的建议。</p>;
  return <p className="af-check">已保存你的反思。教练将针对下一步练习给出建议。</p>;
}
export const taskReason:Record<string,string>={
  qualified_analyzer_unavailable:'声学分析器暂不可用', temporary_read_failure:'读取原录音暂时失败',
  processing_budget_exhausted:'自动重试次数已用完', recording_missing:'原录音暂不可用',
  recording_digest_mismatch:'录音摘要不一致', analysis_required:'尚未取得声学证据',
};
const stageLabel:Record<string,string>={
  read_input:'读取原录音', decode:'解码原声', vad:'检测语音', chunk:'分段',
  acoustic:'分析声学', align:'对齐音素', detect:'识别错音', validate:'校验结果', explain:'生成解释',
};
const clock=(ms:number)=>new Date(ms).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
// Honest ETA: only a connected automation with a real nextExpectedAt may show a
// time. The task's own `nextAt` is a retry time and is labelled as such.
function eta(automation?:AutomationStatus){
  return etaText(automation,Date.now(),clock);
}
type TaskNext={text:string;refresh?:boolean;manual?:boolean;redo?:boolean;wait?:boolean};
function nextSteps(task:ReviewTaskStatus,disconnected:boolean):TaskNext {
  const retry=task.nextAt?clock(task.nextAt):'稍后';
  if(task.lastError==='temporary_read_failure')
    return {text:`读取原录音暂时失败。可以重新读取反馈，或重录本题；不会凭空生成纠音结论。`,refresh:true,manual:true,redo:true};
  if(task.lastError==='recording_missing'||task.lastError==='recording_digest_mismatch')
    return {text:'本题的云端原录音不可用或校验未通过。请回到口语练习重新录制并提交本题；这类问题不会静默重试。',manual:true,redo:true};
  if(task.lastError==='processing_budget_exhausted')
    return {text:'自动重试次数已用完，这次批改暂时无法自动完成。可以交给教练批改，或明天重新提交本题。',manual:true};
  if(task.lastError==='analysis_required')
    return {text:'还没有取得可核对的声学证据。稍后会继续尝试；也可以交给教练批改。',manual:true,wait:true};
  if(task.lastError==='qualified_analyzer_unavailable')
    return {text:'声学分析器暂不可用，稍后会自动重试；也可以交给教练批改。',manual:true,wait:true};
  if(task.state==='retry_wait')
    return {text:`暂时无法读取原录音，后台会在约 ${retry} 重试（重试时间，不是完成时间）。录音仍可回听。`,manual:true,wait:true};
  if(task.state==='needs_attention')
    return {text:'自动批改未能完成。已保存的录音和作答仍保留，可以交给教练批改。',manual:true};
  if(task.state==='blocked')
    return {text:disconnected?'这道题的批改已停止，批改服务当前也未连接。已保存的作答仍保留。':'这道题的批改已停止（例如撤回了分析同意）。已保存的作答仍保留。'};
  if(task.state==='queued')
    return {text:disconnected?'批改服务当前未连接，任务会保持排队。可以检查连接，或交给教练批改。':'已排队，等待批改服务领取。',manual:true,wait:true};
  return {text:'正在等待批改状态。',refresh:true};
}
function TaskState({task,automation,refresh,onManual,manualBusy}:{task:ReviewTaskStatus;automation?:AutomationStatus;refresh:()=>void;onManual:()=>void;manualBusy:boolean}) {
  const disconnected=Boolean(automation&&!automation.connected);
  if(task.state==='completed')
    return <p className="af-hint" role="status">结果已生成，正在读取反馈… <button type="button" className="sp-link" onClick={refresh}>重新读取反馈</button></p>;
  if(task.state==='running')
    return disconnected
      ? <p className="af-hint" role="status">上次读取时这道题还在分析中；批改服务连接已断开，现在无法确认进度，状态可能暂时不会更新。已保存的作答仍保留。</p>
      : <p className="af-hint" role="status">教练正在分析{task.kind==='speaking'?'这段录音':'这份作答'}（{runningLabel(task.kind,task.stage,stageLabel)}）。已完成的部分会保留；可以先离开页面，回来自动刷新。</p>;
  const next=nextSteps(task,disconnected);
  const reason=task.lastError?taskReason[task.lastError]:undefined;
  return <div className="af-next" role="status">
    <p className="af-hint">{reason?`${reason}。`:''}{next.text}{eta(automation)}</p>
    <div className="af-next-actions">
      {next.refresh&&<button type="button" className="sp-link" onClick={refresh}>重新读取反馈</button>}
      {next.manual&&<button type="button" className="sp-link" disabled={manualBusy} onClick={onManual}>{manualBusy?'正在接管…':'交给教练批改'}</button>}
      {next.redo&&<span className="af-hint">回到口语练习中的“重新录制”即可重录本题。</span>}
    </div>
  </div>;
}
function taskBadge(task:ReviewTaskStatus|undefined,linked=false) {
  if(!task)return linked?'等待提交批改':'待提交';
  if(task.state==='completed')return '批改已返回';
  if(task.state==='running')return '正在分析';
  if(task.state==='retry_wait')return '等待重试';
  if(task.state==='blocked')return '已停止';
  if(task.state==='needs_attention')return '需要处理';
  return '已排队';
}

// Precision gate not met: the pre-registered SpeechOcean762 random sample
// produced 31.3% displayed-hint precision (80 hints, 16 speakers), below the
// 50% gate. Keep hints hidden until a free-speech human review passes.
const PRONUNCIATION_HINTS_ENABLED = false;
function PronunciationErrors({analysis,recordingId}:{analysis:NonNullable<CoachFeedback['analysis']>;recordingId?:string}) {
  if(!PRONUNCIATION_HINTS_ENABLED)return null;
  const errors=displayPronunciationErrors(analysis.errors);
  if(!errors.length)return null;
  return <div className="af-errors" aria-label="实验性发音提示与回听">
    <p className="af-hint">实验性提示：只显示高置信发音提示，可能包含误报；仅用于回听练习，不作为评分依据。</p>
    {errors.map((error,index)=>{
      const label=error.word??`词 ${error.wordIndex??index}`;
      return <article className="af-error-card" key={`${index}:${error.wordIndex}:${error.phoneIndex}:${error.kind}:${error.target}:${error.actual}`}>
        <div className="af-error-head"><strong>{label}</strong><span>可能值得回听</span></div>
        <p className="af-error-ipa">实验性提示，请回听确认。</p>
        {recordingId
          ? <RecordingClipPlayer recordingId={recordingId} startMs={error.startMs??error.anchorMs??0} endMs={error.endMs} anchorMs={error.anchorMs} label={label}/>
          : <p className="af-hint">原录音引用不可用，无法定位回听。</p>}
      </article>;
    })}
  </div>;
}
// One reviewed answer. The verdict state is lifted here so the scorecard
// transcript (红=确实读错 / 绿=其实没错) updates the moment the learner answers
// the self-listen card below it, instead of only after a reload.
function ReviewRow({row,recordingId,attemptId}:{row:CoachFeedback;recordingId?:string;attemptId:string}) {
  const [verdicts,setVerdicts]=useState<Record<string,string>>({});
  const {account,drillTakes,saveDrillTakes}=useContext(FeedbackContext);
  return <article className="af-review">
    {row.analysis?.scorecard&&<SpeakingScorecard analysis={row.analysis} recordingId={recordingId} attemptId={attemptId}
      account={account||undefined} drillTakes={drillTakes} onSaveDrillTakes={saveDrillTakes} verdicts={verdicts}/>}
    <TieredFeedbackProse feedback={row.feedback}/>
    {row.analysis&&<PronunciationErrors analysis={row.analysis} recordingId={recordingId}/>}
    {row.analysis&&<PronunciationCoach analysis={row.analysis} recordingId={recordingId} feedbackText={row.feedback}
      onVerdict={(candidateId,verdict)=>setVerdicts(current=>current[candidateId]?current:{...current,[candidateId]:verdict})}/>}
    <details><summary>批改依据与时间</summary><p>{row.evidence}</p><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></details>
  </article>;
}

// Phase 0 telemetry: report the first render of a completed review once per
// page session (the server is idempotent per task). Timing only, best effort.
const reportedRenders=new Set<string>();
function reportRendered(attemptId:string){
  if(reportedRenders.has(attemptId)||typeof fetch!=='function')return;
  reportedRenders.add(attemptId);
  void fetch('/api/review-tasks/rendered',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attemptId}),keepalive:true}).catch(()=>{});
}
/** Phase 1: the writing loop renders structured cards itself and only needs
 * the attempt, its review rows and task state from the shared context. */
export function useAttemptReview(field:string,index=0){
  const {attempts,feedback,tasks,ready,rechecks,refresh}=useContext(FeedbackContext);
  const attempt=attempts.find(a=>a.field===field&&a.index===index);
  const rows=attempt?feedbackFor(attempt,feedback):[];
  const task=attempt?tasks.find(t=>t.attemptId===attempt.id):undefined;
  return {attempt,rows,task,ready,rechecks,refresh};
}
export default function AttemptFeedback({field,index=0,structured=false}:{field:string;index?:number;structured?:boolean}) {
  const {attempts,feedback,tasks,automation,error,refresh}=useContext(FeedbackContext);
  const attempt=attempts.find(a=>a.field===field&&a.index===index);
  const [copyStatus,setCopyStatus]=useState(''),[fallback,setFallback]=useState(false),[takingOver,setTakingOver]=useState(false);
  const renderedTaskAttempt=attempt&&feedbackFor(attempt,feedback).length&&tasks.some(t=>t.attemptId===attempt.id&&t.state==='completed')?attempt.id:'';
  useEffect(()=>{if(renderedTaskAttempt)reportRendered(renderedTaskAttempt)},[renderedTaskAttempt]);
  if(!attempt)return null;
  const rows=feedbackFor(attempt,feedback);
  const task=tasks.find(t=>t.attemptId===attempt.id);
  const linked=attempt.id.startsWith('v2:');
  const attemptId=attempt.id;
  const manualTakeover=Boolean(task&&task.state!=='completed');
  const request=reviewRequest(attempt);
  async function copyManualRequest(){
    if(takingOver)return;
    setTakingOver(true);
    try{
      if(manualTakeover){
        const res=await fetch('/api/review-tasks/takeover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({attemptId})});
        const data=await res.json().catch(()=>({})) as {error?:string};
        if(!res.ok){
          setCopyStatus(data?.error==='review_completed'?'批改已经完成，请刷新查看结果。':'暂时无法接管自动批改，请稍后重试。');
          return;
        }
      }
      const disclosure=manualTakeover?'本次批改将交给你的教练会话完成，自动批改不会再领取。 ':'';
      try{await navigator.clipboard.writeText(request);setCopyStatus(disclosure+'批改请求已复制，粘贴给教练并发送即可。');setFallback(false)}
      catch{setFallback(true);setCopyStatus(disclosure+'请选中下方请求并复制给教练。')}
    }catch{setCopyStatus('暂时无法接管自动批改，请稍后重试。')}
    finally{setTakingOver(false)}
  }
  if(attempt.kind==='objective'&&!rows.length)return null;
  const receipt=attempt.kind==='subjective';
  // Same-question comparison: only attempts in one identical group are ever
  // paired. v2 rows group by questionId; legacy rows group by field+day.
  const groupKey=(row:ReviewAttempt)=>`${row.day}|${row.field}|${row.part??''}|${row.questionId?.trim()||''}`;
  const speakingGroup=attempt.stage==='speak'
    ?attempts.filter(row=>groupKey(row)===groupKey(attempt))
      .slice().sort((a,b)=>(Date.parse(a.at??'')||0)-(Date.parse(b.at??'')||0)||a.index-b.index)
    :[];
  const latestInGroup=speakingGroup[speakingGroup.length-1];
  const reviewed=speakingGroup.map(row=>({row,side:sideFromFeedback(feedback,row.id,row.day)}))
    .filter((item):item is {row:ReviewAttempt;side:CompareSide}=>Boolean(item.side));
  const pair=latestInGroup?.id===attempt.id&&reviewed.length>=2?reviewed.slice(-2):null;
  const questionRef=(row:ReviewAttempt):QuestionRef=>({day:row.day,prompt:questionById(row.questionId)?.prompt??legacyPromptTitle(row.title),questionId:row.questionId});
  const nth=(row:ReviewAttempt)=>`第 ${speakingGroup.findIndex(item=>item.id===row.id)+1} 次作答`;
  return <section className="attempt-feedback" aria-label={attempt.title+'反馈'}>
    <div className="af-heading"><strong>{attempt.title} · {rows.length?'教练批改':'已保存'}</strong><span className={'af-badge '+((rows.length||task?.state==='completed')?'af-ready':'')}>{rows.length?'批改已返回':taskBadge(task,linked)}</span></div>
    {receipt&&<dl className="af-receipt" aria-label="批改单">
      <div><dt>题目</dt><dd>{attempt.title}</dd></div>
      <div><dt>提交时间</dt><dd>{attempt.at?new Date(attempt.at).toLocaleString('zh-CN'):'未记录'}</dd></div>
      <div><dt>状态</dt><dd>{rows.length?'已返回批改':taskBadge(task,linked)}</dd></div>
      <div><dt>录音</dt><dd>{attempt.recordingId?'可回听':attempt.localOnly?'仅保存在原浏览器':attempt.stage==='speak'?'无录音':'—'}</dd></div>
    </dl>}
    {!rows.length&&<QuickCheck attempt={attempt}/>}
    {!rows.length&&!task&&linked&&<p className="af-hint" role="status">已保存，正在核对批改队列…</p>}
    {!rows.length&&task&&<TaskState task={task} automation={automation} refresh={refresh} onManual={()=>void copyManualRequest()} manualBusy={takingOver}/>}
    <div aria-live="polite" aria-relevant="additions text">{rows.map(row=>structured&&row.writing
      ?<p key={row.id} className="af-hint">结构化批改已到达，见上方的问题卡。</p>
      :<ReviewRow key={row.id} row={row} recordingId={attempt.recordingId} attemptId={attemptId}/>)}</div>
    {pair&&<AttemptCompare left={pair[0].side} right={pair[1].side}
      leftRef={questionRef(pair[0].row)} rightRef={questionRef(pair[1].row)}
      labelLeft={nth(pair[0].row)} labelRight={nth(pair[1].row)}/>}
    {!rows.length&&(!task||task.state!=='completed')&&<><p className="af-hint">{task?'自动批改未返回？可以把本题请求交给教练批改；手动批改会成为本次作答的唯一结果。':'可以把本题请求交给教练批改。批改写回后，留在这里或稍后重新打开本题都能看到结果。'}</p>
      <button type="button" className="secondary" disabled={takingOver} onClick={()=>void copyManualRequest()}>{takingOver?'正在接管…':manualTakeover?'交给教练批改（接管本次）':'交给教练批改'}</button>
      {fallback&&<label className="af-copy">本题批改请求<textarea readOnly value={request} onFocus={e=>e.target.select()}/></label>}
      {copyStatus&&<p role="status" className="af-hint">{copyStatus}</p>}</>}
    {error&&<p role="status" className="af-error">反馈同步暂时失败，已显示的评语仍保留。<button type="button" onClick={refresh}>重试同步</button></p>}
  </section>;
}
export function UnmatchedFeedback(){
  const {attempts,feedback,ready}=useContext(FeedbackContext);
  if(!ready)return null;
  const rows=feedback.filter(f=>!attempts.some(a=>feedbackFor(a,[f]).length));
  return rows.length?<details className="af-legacy"><summary>其他已保存的教练评语 · {rows.length}</summary><p className="af-hint">这些评语未绑定到当前这一次提交，保留供你回看。</p>{rows.map(f=><article key={f.id}><small>{f.attempt} · {f.evidence}</small><TieredFeedbackProse feedback={f.feedback}/></article>)}</details>:null;
}
