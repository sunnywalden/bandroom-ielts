'use client';
import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {feedbackFor,reviewAttempts,reviewRequest,type AutomationStatus,type CoachFeedback,type ReviewAttempt,type ReviewLink,type ReviewTaskStatus} from './feedback-model';
import {displayPhone} from './phonemes';
import RecordingClipPlayer from './recording-clip-player';
import './feedback.css';

type Context = {attempts:ReviewAttempt[];feedback:CoachFeedback[];tasks:ReviewTaskStatus[];automation?:AutomationStatus;error:boolean;refresh:()=>void;ready:boolean;identificationFailed:boolean;retry:()=>void};
const FeedbackContext=createContext<Context>({attempts:[],feedback:[],tasks:[],automation:undefined,error:false,refresh:()=>{},ready:false,identificationFailed:false,retry:()=>{}});
export function FeedbackProvider({day,entry,feedback,links,tasks,automation,error,refresh,children}:{day:number;entry:Record<string,string>;feedback:CoachFeedback[];links?:ReviewLink[];tasks?:ReviewTaskStatus[];automation?:AutomationStatus;error:boolean;refresh:()=>void;children:ReactNode}) {
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
  return <FeedbackContext.Provider value={{attempts,feedback,tasks:tasks??[],automation,error,refresh,ready:Boolean(current&&!current.failed),identificationFailed:Boolean(current?.failed),retry:()=>setRetryCount(n=>n+1)}}>{children}</FeedbackContext.Provider>;
}
export function FeedbackIdentificationStatus(){
  const {identificationFailed,retry}=useContext(FeedbackContext);
  return identificationFailed?<div className="alert" role="status"><span>暂时无法定位对应练习的反馈。已保存的答案和评语仍保留。</span><button type="button" onClick={retry}>重试定位反馈</button></div>:null;
}
function QuickCheck({attempt}:{attempt:ReviewAttempt}) {
  const {field,response,recordingId,conditions}=attempt;
  if(field.startsWith('write'))return <p className="af-check">提交核对：{(response.match(/\S+/g)||[]).length} 词。{field==='writeRevision'?'首稿和修改说明均已保留。':'首稿已锁定，修订会单独保存。'}论证和语言反馈见下方。</p>;
  if(field==='vocabUse')return <p className="af-check">例句已保存。教练将核对搭配、语法及是否回应题目。</p>;
  if(field.startsWith('readQ'))return <p className="af-check">选择题已即时核对；你写的证据说明将单独批改。</p>;
  if(field==='speakingPart2'||field==='speakingFollowup')return <p className="af-check">{recordingId?'录音已提交。教练需听到这段录音后，才能评价发音和流利度。':conditions+'。发音和流利度暂不评分。'}</p>;
  if(field==='speakingReview')return <p className="af-check">口语自评已保存。发给 Work 后，教练可根据你的自评给出下一次口语练习的建议。</p>;
  return <p className="af-check">已保存你的反思。教练将针对下一步练习给出建议。</p>;
}
const taskReason:Record<string,string>={
  qualified_analyzer_unavailable:'声学分析器暂不可用', temporary_read_failure:'读取原录音暂时失败',
  processing_budget_exhausted:'自动重试次数已用完', recording_missing:'原录音暂不可用',
  recording_digest_mismatch:'录音摘要不一致', analysis_required:'尚未取得声学证据',
};
const stageLabel:Record<string,string>={
  read_input:'读取原录音', decode:'解码原声', vad:'检测语音', chunk:'分段',
  acoustic:'分析声学', align:'对齐音素', detect:'识别错音', validate:'校验结果', explain:'生成解释',
};
function TaskState({task,automation,refresh}:{task:ReviewTaskStatus;automation?:AutomationStatus;refresh:()=>void}) {
  if(task.state==='completed')return <p className="af-hint" role="status">批改已完成，正在读取反馈… <button type="button" className="sp-link" onClick={refresh}>重新读取反馈</button></p>;
  if(task.state==='running')return <p className="af-hint" role="status">{automation&&!automation.connected?'Work 之前领取了任务，但自动批改连接已断开；状态可能不会更新。':`Work 正在分析${task.kind==='speaking'?'原声':'作答'}（${stageLabel[task.stage]??task.stage}）；已完成的部分会保留。`}</p>;
  if(task.state==='queued')return <p className="af-hint" role="status">{automation&&!automation.connected?'自动批改当前未连接，任务保持排队。':'已保存，等待 Work 领取。'}</p>;
  if(task.state==='retry_wait')return <p className="af-hint" role="status">{automation&&!automation.connected?'自动批改当前未连接，之前的重试不会自动继续；录音仍可回听。':`暂时无法读取原录音，后台会继续重试${task.nextAt?`（下一次约 ${new Date(task.nextAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}）`:''}；录音仍可回听。`}</p>;
  if(task.state==='blocked')return <p className="af-hint" role="status">暂时无法可靠判断{task.kind==='speaking'?'这段发音':'这次作答'}，尚未生成纠音结论{task.lastError?`（${taskReason[task.lastError]??task.lastError}）`:''}。</p>;
  if(task.state==='needs_attention')return <p className="af-error" role="status">本次批改未能完成{task.lastError?`（${taskReason[task.lastError]??task.lastError}）`:''}。已保存的录音和作答仍保留。</p>;
  return <p className="af-hint" role="status">已保存，Work 状态：{task.state||'等待中'}。</p>;
}
function taskBadge(task:ReviewTaskStatus|undefined,linked=false) {
  if(!task)return linked?'已提交':'待在 Work 中发起';
  if(task.state==='completed')return '批改已返回';
  if(task.state==='running')return '正在分析';
  if(task.state==='retry_wait')return '等待重试';
  if(task.state==='blocked')return '暂无法判断';
  if(task.state==='needs_attention')return '需要处理';
  return '已排队';
}

const kindLabel:Record<string,string>={substitution:'替换',deletion:'漏音',addition:'添音'};
function PronunciationErrors({analysis,recordingId}:{analysis:NonNullable<CoachFeedback['analysis']>;recordingId?:string}) {
  const errors=analysis.errors??[];
  if(!errors.length)return null;
  return <div className="af-errors" aria-label="发音错误与回听">
    {errors.map((error,index)=>{
      const label=error.word??`词 ${error.wordIndex??index}`;
      return <article className="af-error-card" key={`${index}:${error.wordIndex}:${error.phoneIndex}:${error.kind}:${error.target}:${error.actual}`}>
        <div className="af-error-head"><strong>{label}</strong><span>{kindLabel[error.kind]??error.kind}</span></div>
        <p className="af-error-ipa">目标 /{displayPhone(error.target)}/ · 实际 {error.actual==='∅'?'漏音':`/${displayPhone(error.actual)}/`}</p>
        {error.probability!=null&&<small>校准后置信度 {Math.round(error.probability*100)}%</small>}
        {recordingId
          ? <RecordingClipPlayer recordingId={recordingId} startMs={error.startMs??error.anchorMs??0} endMs={error.endMs} anchorMs={error.anchorMs} label={label}/>
          : <p className="af-hint">原录音引用不可用，无法定位回听。</p>}
      </article>;
    })}
  </div>;
}
export default function AttemptFeedback({field,index=0}:{field:string;index?:number}) {
  const {attempts,feedback,tasks,automation,error,refresh}=useContext(FeedbackContext);
  const attempt=attempts.find(a=>a.field===field&&a.index===index);
  const [copyStatus,setCopyStatus]=useState(''),[fallback,setFallback]=useState(false),[takingOver,setTakingOver]=useState(false);
  if(!attempt)return null;
  const rows=feedbackFor(attempt,feedback);
  const task=tasks.find(t=>t.attemptId===attempt.id);
  const linked=attempt.id.startsWith('v2:');
  const attemptId=attempt.id;
  const manualTakeover=Boolean(task&&task.state!=='completed');
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
      try{await navigator.clipboard.writeText(request);setCopyStatus(manualTakeover?'已接管并复制，请粘贴到 Work 会话并发送。':'已复制，请粘贴到 Work 会话并发送。');setFallback(false)}
      catch{setFallback(true);setCopyStatus(manualTakeover?'已接管。请选中下方请求并复制到 Work 会话。':'请选中下方请求并复制到 Work 会话。')}
    }catch{setCopyStatus('暂时无法接管自动批改，请稍后重试。')}
    finally{setTakingOver(false)}
  }
  if(attempt.kind==='objective'&&!rows.length)return null;
  const request=reviewRequest(attempt);
  return <section className="attempt-feedback" aria-label={attempt.title+'反馈'}>
    <div className="af-heading"><strong>{attempt.title} · {rows.length?'教练批改':'已保存'}</strong><span className={'af-badge '+((rows.length||task?.state==='completed')?'af-ready':'')}>{rows.length?'批改已返回':taskBadge(task,linked)}</span></div>
    {!rows.length&&<QuickCheck attempt={attempt}/>}
    {!rows.length&&!task&&linked&&<p className="af-hint" role="status">已保存，正在核对批改队列…</p>}
    {!rows.length&&task&&<TaskState task={task} automation={automation} refresh={refresh}/>}
    <div aria-live="polite" aria-relevant="additions text">{rows.map(row=><article className="af-review" key={row.id}>
      <p>{row.feedback}</p>
      {row.analysis&&<PronunciationErrors analysis={row.analysis} recordingId={attempt.recordingId}/>}
      <details><summary>批改依据与时间</summary><p>{row.evidence}</p><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></details>
    </article>)}</div>
    {!rows.length&&(!task||task.state!=='completed')&&<><p className="af-hint">{task?'自动批改未返回？复制本题请求，粘贴到 Work 会话并发送；手动批改会成为本次作答的唯一结果。':'复制本题请求，粘贴到 Work 会话并发送。Work 写回后，留在这里或稍后重新打开本题都能看到结果。'}</p>
      <button type="button" className="secondary" disabled={takingOver} onClick={()=>void copyManualRequest()}>{takingOver?'正在接管…':'复制本题批改请求'}</button>
      {fallback&&<label className="af-copy">本题批改请求<textarea readOnly value={request} onFocus={e=>e.target.select()}/></label>}
      {copyStatus&&<p role="status" className="af-hint">{copyStatus}</p>}</>}
    {error&&<p role="status" className="af-error">反馈同步暂时失败，已显示的评语仍保留。<button type="button" onClick={refresh}>重试同步</button></p>}
  </section>;
}
export function UnmatchedFeedback(){
  const {attempts,feedback,ready}=useContext(FeedbackContext);
  if(!ready)return null;
  const rows=feedback.filter(f=>!attempts.some(a=>feedbackFor(a,[f]).length));
  return rows.length?<details className="af-legacy"><summary>其他已保存的教练评语 · {rows.length}</summary><p className="af-hint">这些评语未绑定到当前这一次提交，保留供你回看。</p>{rows.map(f=><article key={f.id}><small>{f.attempt} · {f.evidence}</small><p>{f.feedback}</p></article>)}</details>:null;
}
