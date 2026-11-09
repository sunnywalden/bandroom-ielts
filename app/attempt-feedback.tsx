'use client';
import {createContext,useContext,useEffect,useState,type ReactNode} from 'react';
import {feedbackFor,reviewAttempts,reviewRequest,type CoachFeedback,type ReviewAttempt,type ReviewLink} from './feedback-model';
import './feedback.css';

type Context = {attempts:ReviewAttempt[];feedback:CoachFeedback[];error:boolean;refresh:()=>void;ready:boolean;identificationFailed:boolean;retry:()=>void};
const FeedbackContext=createContext<Context>({attempts:[],feedback:[],error:false,refresh:()=>{},ready:false,identificationFailed:false,retry:()=>{}});
export function FeedbackProvider({day,entry,feedback,links,error,refresh,children}:{day:number;entry:Record<string,string>;feedback:CoachFeedback[];links?:ReviewLink[];error:boolean;refresh:()=>void;children:ReactNode}) {
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
  return <FeedbackContext.Provider value={{attempts,feedback,error,refresh,ready:Boolean(current&&!current.failed),identificationFailed:Boolean(current?.failed),retry:()=>setRetryCount(n=>n+1)}}>{children}</FeedbackContext.Provider>;
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
  return <p className="af-check">已保存你的反思。教练将针对下一步练习给出建议。</p>;
}
export default function AttemptFeedback({field,index=0}:{field:string;index?:number}) {
  const {attempts,feedback,error,refresh}=useContext(FeedbackContext);
  const attempt=attempts.find(a=>a.field===field&&a.index===index);
  const [copyStatus,setCopyStatus]=useState(''),[fallback,setFallback]=useState(false);
  if(!attempt)return null;
  const rows=feedbackFor(attempt,feedback);
  if(attempt.kind==='objective'&&!rows.length)return null;
  const request=reviewRequest(attempt);
  return <section className="attempt-feedback" aria-label={attempt.title+'反馈'}>
    <div className="af-heading"><strong>{attempt.title} · {rows.length?'教练批改':'已保存'}</strong><span className={'af-badge '+(rows.length?'af-ready':'')}>{rows.length?'批改已返回':'待在 Work 中发起'}</span></div>
    {!rows.length&&<QuickCheck attempt={attempt}/>}
    <div aria-live="polite" aria-relevant="additions text">{rows.map(row=><article className="af-review" key={row.id}>
      <p>{row.feedback}</p><details><summary>批改依据与时间</summary><p>{row.evidence}</p><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString('zh-CN')}</time></details>
    </article>)}</div>
    {!rows.length&&<><p className="af-hint">在当前 Work 会话里说“批改 Day {attempt.day}”，或复制本题请求发给教练。批改完成后，这里会自动显示结果。</p>
      <button type="button" className="secondary" onClick={async()=>{
        try{await navigator.clipboard.writeText(request);setCopyStatus('已复制，请粘贴到当前 Work 会话。');setFallback(false)}
        catch{setFallback(true);setCopyStatus('请选中下方请求并复制到 Work 会话。')}
      }}>复制本题批改请求</button>
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
