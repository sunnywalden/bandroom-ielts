'use client';
import {useEffect,useRef,useState} from 'react';
import RecordingClipPlayer from './recording-clip-player';
import {
  COLD_START_COPY, PROGRESS_METRIC_LABEL, PROGRESS_METRIC_NOTE, RESET_DIALOG_COPY,
  SAME_CLASS_CONFIRMATIONS_REQUIRED, TIER_HEADINGS, VERDICT_LABELS, VERDICT_RECORDED_LABELS,
  buildProgressSeries, classProgress, extractPronunciation, formatTimestampSeconds,
  normalizeProfileResult, progressDisclosure, progressFromFeedback, reliabilityDisclosure,
  splitDeterministicSections, type CatchTrialSummary, type ClassProgress, type ProfileClass, type ProfileSnapshot,
  type ProgressFeedbackRow, type ProgressSeries, type PronunciationCandidate,
  type ReliabilitySummary, type Verdict,
} from './pronunciation-review';
import {readPronunciationProfile, recordPronunciationVerdict, resetPronunciationProfile} from './pronunciation-coach-client';
import './pronunciation-coach.css';

const SERIES_COLORS = ['#2a78d6', '#eb6834', '#1baf7a'];
const OTHER_SERIES_COLOR = '#6b7280';

function verdictButtonLabel(verdict: Verdict): string {
  return VERDICT_LABELS[verdict];
}

function classKey(expected: string, actual: string): string {
  return `${expected} → ${actual}`;
}

export function ReliabilityBlock({reliability}:{reliability:ReliabilitySummary}) {
  const disclosure = reliabilityDisclosure(reliability);
  if (!disclosure) return null;
  return <aside className="pc-reliability" aria-label="停顿检测可靠性">
    <h4>停顿检测可靠性</h4>
    <p>{disclosure.pauseLine}{disclosure.detail}</p>
    <p className="pc-hint">{disclosure.caveat}</p>
  </aside>;
}

export function ColdStartDisclosure() {
  return <section className="pc-coldstart" aria-label="个人发音画像尚未建立">
    <h4>{COLD_START_COPY.title}</h4>
    <p>{COLD_START_COPY.body}</p>
    <p>{COLD_START_COPY.sameClassRule}</p>
    <p>{COLD_START_COPY.pedagogy}</p>
    <p className="pc-hint">可在「阶段评估 → 个人发音画像」查看每个类别的同类确认进度。</p>
  </section>;
}

/**
 * Control items are indistinguishable from real candidates by design, so the
 * learner is never told which was which. This disclosure only reports the
 * aggregate consequence: confirming most controls means the answers are not
 * distinguishing errors, and the profile cannot learn from them.
 */
export function ControlItemDisclosure({controls}:{controls:CatchTrialSummary}) {
  if (controls.answered<=0) return null;
  if (!controls.constantConfirmerFlag) {
    return <p className="pc-hint">
      已回答 {controls.answered} 个对照项，其中 {controls.confirmed} 个判为有问题。
      对照项不计入类别进度。
    </p>;
  }
  return <section className="pc-coldstart" aria-label="确认结果区分度不足">
    <h4>确认结果区分度不足</h4>
    <p>
      在最近 {controls.answered} 个对照项中，你有 {controls.confirmed} 个判为「有问题」。
      对照项本身并不包含发音错误，因此这样的回答无法用于区分你的真实发音类别。
    </p>
    <p>
      个人校准暂时不会从这些回答中学习。建议先听标准读音再判断，
      拿不准时选「不确定」——它不会被计入任何类别。
    </p>
  </section>;
}

export function SameClassProgress({classes}:{classes:ProfileClass[]}) {
  const rows = classProgress(classes, SAME_CLASS_CONFIRMATIONS_REQUIRED);
  if (!rows.length) return null;
  return <div className="pc-class-progress" aria-label="同类别确认进度">
    <h4>同类别的确认进度</h4>
    <p className="pc-hint">只按同一类别累计，不是所有类别的总数；「不确定」会记录，但不计入。</p>
    <ul>{rows.map(row=><ClassProgressRow key={row.key} row={row}/>)}</ul>
  </div>;
}

function ClassProgressRow({row}:{row:ClassProgress}) {
  return <li>
    <span className="pc-class-key">{classKey(row.expected,row.actual)}</span>
    <progress value={Math.min(row.nConfirmed,row.needed)} max={row.needed}
      aria-label={`${row.key} 同类确认 ${row.nConfirmed}/${row.needed}`}/>
    <span className="pc-class-count">{row.nConfirmed}/{row.needed} 次同类确认</span>
    <small>{row.reached ? '已达到同类阈值；仍需通过异常确认与断言门检查。' : `还需 ${row.remaining} 次同类确认。`}</small>
    {row.nUnsure>0&&<small>另有 {row.nUnsure} 次「不确定」，不计入。</small>}
    {row.nRejected>0&&<small>另有 {row.nRejected} 次「其实没错」，已记录，不计入确认进度。</small>}
  </li>;
}

function CanonicalContrastPlayer({word,url}:{word:string;url?:string}) {
  const audio=useRef<HTMLAudioElement>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'playing'|'error'>('idle');
  if(!url) return <p className="pc-hint">标准发音对比暂不可用，仍可回听原录音。</p>;
  async function play(rate:number){
    const element=audio.current;
    if(!element)return;
    setStatus('loading');
    try{
      if(element.error)element.load();
      element.currentTime=0;
      element.playbackRate=rate;
      await element.play();
      setStatus('playing');
    }catch{
      setStatus('error');
    }
  }
  return <div className="pc-canonical">
    <audio ref={audio} src={url} preload="none" onEnded={()=>setStatus('idle')} onError={()=>setStatus('error')}/>
    <button type="button" className="secondary" aria-label={`播放 ${word} 的标准发音`} onClick={()=>void play(1)}>
      播放标准发音
    </button>
    <button type="button" className="secondary" aria-label={`用 0.75 倍速对比 ${word} 的标准发音`} onClick={()=>void play(0.75)}>
      0.75× 慢速对比
    </button>
    <span role="status" className="pc-hint">
      {status==='error'?'标准发音暂时无法播放，可以重试。':status==='loading'?'正在加载标准发音…':status==='playing'?'正在播放标准发音。':'标准发音用于对照，不是评分依据。'}
    </span>
  </div>;
}

type CardState = {
  recorded?: Verdict;
  busy: boolean;
  error: string;
};

function ConfirmationCard({item,recordingId,state,onAnswer}:{
  item:PronunciationCandidate;
  recordingId?:string;
  state:CardState;
  onAnswer:(candidateId:string,verdict:Verdict)=>void;
}) {
  const recorded=state.recorded;
  const label=`${item.word} · ${formatTimestampSeconds(item.atMs)}`;
  return <article className="pc-card" aria-label={`自听确认 ${label}`}>
    <div className="pc-card-head">
      <strong lang="en">{item.word}</strong>
      <span className="pc-time">{formatTimestampSeconds(item.atMs)}</span>
    </div>
    <p className="pc-detector-hint">检测器提示：这里可能值得回听。这不是评分结论。</p>
    {recordingId
      ? <RecordingClipPlayer recordingId={recordingId} startMs={item.clipStartMs??item.atMs}
          endMs={item.clipEndMs} label={label}/>
      : <p className="pc-hint">原录音引用不可用，无法定位回听。</p>}
    <CanonicalContrastPlayer word={item.word} url={item.canonicalAudioUrl}/>
    <div className="pc-verdicts" role="group" aria-label={`对 ${item.word} 的自听判断`}>
      {(Object.keys(VERDICT_LABELS) as Verdict[]).map(verdict=><button key={verdict} type="button"
        className={recorded===verdict?'primary':'secondary'}
        aria-pressed={recorded===verdict}
        disabled={Boolean(recorded)||state.busy}
        onClick={()=>onAnswer(item.candidateId,verdict)}>
        {verdictButtonLabel(verdict)}
      </button>)}
    </div>
    <p className="pc-hint">每条只需回答一次；「不确定」会记录，但不计入个人发音画像。</p>
    {recorded&&<p role="status" className="pc-recorded">已记录：{VERDICT_RECORDED_LABELS[recorded]}</p>}
    {state.error&&<p role="alert" className="pc-error">{state.error}</p>}
  </article>;
}

// The runner appends its deterministic T3 / portrait / T2 / reliability blocks
// to the feedback text. Split only at the fixed headers so those blocks keep
// their own sections instead of disappearing into the T1 assessment prose.
export function TieredFeedbackProse({feedback}:{feedback:string}) {
  const parts=splitDeterministicSections(feedback);
  return <div className="pc-prose">
    <p>{parts.t1}</p>
    {parts.t3&&<section className="pc-tier" data-tier="T3" aria-label="建议自听对比（非错误断言）">
      <p className="pc-tier-text">{parts.t3}</p>
    </section>}
    {parts.portraitIntro&&<section className="pc-tier" data-tier="portrait" aria-label="你的发音画像（建议性质）">
      <p className="pc-tier-text">{parts.portraitIntro}</p>
    </section>}
    {parts.t2&&<section className="pc-tier" data-tier="T2" aria-label="个人历史条件化建议（建议，不是断言）">
      <p className="pc-tier-text">{parts.t2}</p>
    </section>}
    {parts.reliabilityTail&&<section className="pc-tier" data-tier="reliability" aria-label="T1 可靠性披露">
      <p className="pc-tier-text">{parts.reliabilityTail}</p>
    </section>}
  </div>;
}

export function PronunciationCoach({analysis,recordingId,feedbackText,onVerdict}:{
  analysis:unknown;
  recordingId?:string;
  feedbackText?:string;
  /** Notifies the parent so the scorecard transcript colors update in-session. */
  onVerdict?:(candidateId:string,verdict:Verdict)=>void;
}) {
  const data=extractPronunciation(analysis);
  const proseParts=feedbackText?splitDeterministicSections(feedbackText):null;
  const proseHasTier=(itemTier:'T2'|'T3')=>Boolean(itemTier==='T2'?proseParts?.t2:proseParts?.t3);
  const [local,setLocal]=useState<Record<string,Verdict>>({});
  const [busy,setBusy]=useState<Record<string,boolean>>({});
  const [errors,setErrors]=useState<Record<string,string>>({});
  const inFlight=useRef<Set<string>>(new Set());
  if(!data.present) return null;
  const recorded=(candidateId:string,prior?:Verdict)=>local[candidateId]??prior;
  async function answer(candidateId:string,verdict:Verdict){
    if(inFlight.current.has(candidateId))return;
    const item=data.items.find(row=>row.candidateId===candidateId);
    if(!item||recorded(candidateId,item.priorVerdict))return;
    inFlight.current.add(candidateId);
    setBusy(current=>({...current,[candidateId]:true}));
    setErrors(current=>({...current,[candidateId]:''}));
    try{
      await recordPronunciationVerdict(candidateId,verdict);
      setLocal(current=>({...current,[candidateId]:verdict}));
      onVerdict?.(candidateId,verdict);
    }catch{
      setErrors(current=>({...current,[candidateId]:'暂时无法保存，请重试。'}));
    }finally{
      inFlight.current.delete(candidateId);
      setBusy(current=>({...current,[candidateId]:false}));
    }
  }
  return <div className="pc-coach">
    {data.reliability&&!feedbackText?.includes('【T1 可靠性披露】')&&<ReliabilityBlock reliability={data.reliability}/>}
    {data.profile?.exists===false&&<ColdStartDisclosure/>}
    {data.profile&&data.profile.classes.length>0&&<SameClassProgress classes={data.profile.classes}/>}
    {data.sections.filter(section=>!proseHasTier(section.tier)).map(section=><section className="pc-tier" data-tier={section.tier} key={section.tier}
      aria-label={TIER_HEADINGS[section.tier]}>
      <h4>{TIER_HEADINGS[section.tier]}</h4>
      <p className="pc-tier-text">{section.text}</p>
    </section>)}
    {data.items.length>0&&<section className="pc-confirm" aria-label="自听确认">
      <h4>自听确认</h4>
      <p className="pc-hint">先回听原录音，再对照标准发音。每条只需回答一次。</p>
      {data.items.map(item=><ConfirmationCard key={item.candidateId} item={item} recordingId={recordingId}
        state={{recorded:recorded(item.candidateId,item.priorVerdict),busy:Boolean(busy[item.candidateId]),error:errors[item.candidateId]??''}}
        onAnswer={(candidateId,verdict)=>void answer(candidateId,verdict)}/>)}
    </section>}
  </div>;
}

function formatRate(value:number):string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/,'').replace(/\.$/,'');
}

function ProgressChart({series,derived=false}:{series:ProgressSeries[];derived?:boolean}) {
  const disclosure=progressDisclosure(series);
  if(!series.length) return <div className="pc-progress">
    <h4>候选发生率</h4>
    <p className="pc-hint">{disclosure}</p>
  </div>;
  const width=560,height=200,left=46,right=92,top=16,bottom=38;
  const innerWidth=width-left-right,innerHeight=height-top-bottom;
  const labels:string[]=[];
  for(const row of series) for(const point of row.points) if(!labels.includes(point.label)) labels.push(point.label);
  const maximum=Math.max(1,...series.flatMap(row=>row.points.flatMap(point=>[
    point.ratePerMinute??0,point.ciHigh??0,
  ])));
  const yMax=Math.ceil(maximum*10)/10;
  const xFor=(label:string)=>labels.length===1?left+innerWidth/2
    :left+labels.indexOf(label)*(innerWidth/Math.max(1,labels.length-1));
  const visibleLabels=labels.length<=5?labels
    :[labels[0],labels[Math.floor((labels.length-1)/2)],labels[labels.length-1]];
  const yFor=(value:number)=>top+innerHeight*(1-value/yMax);
  const colorFor=(index:number)=>series[index]?.key==='其他'?OTHER_SERIES_COLOR:SERIES_COLORS[index]??OTHER_SERIES_COLOR;
  const lastLabels=series.map((row,index)=>{
    const point=row.points[row.points.length-1];
    return {key:row.key,color:colorFor(index),x:xFor(point.label),y:yFor(point.ratePerMinute??0)};
  }).sort((a,b)=>a.y-b.y);
  let previous=-Infinity;
  for(const label of lastLabels){
    label.y=Math.max(label.y,previous+12);
    label.y=Math.min(label.y,top+innerHeight);
    previous=label.y;
  }
  return <div className="pc-progress">
    <h4>{PROGRESS_METRIC_LABEL}</h4>
    <p className="pc-hint">{PROGRESS_METRIC_NOTE}</p>
    {derived&&<p className="pc-hint">曲线由最近 12 次含声学分析的反馈按语音分钟数推导；服务端暂未提供置信区间，因此只画点估计。</p>}
    {series.length>1&&<ul className="pc-legend">{series.map((row,index)=><li key={row.key}>
      <span className="pc-swatch" style={{background:colorFor(index)}} aria-hidden="true"/>{row.key}
    </li>)}</ul>}
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="候选发生率曲线（每分钟语音的候选数）" className="pc-chart">
      {[0,0.5,1].map(fraction=><g key={fraction}>
        <line x1={left} x2={left+innerWidth} y1={yFor(yMax*fraction)} y2={yFor(yMax*fraction)} className="pc-grid"/>
        <text x={left-8} y={yFor(yMax*fraction)+4} textAnchor="end" className="pc-axis">{formatRate(yMax*fraction)}</text>
      </g>)}
      {visibleLabels.map(label=><text key={label} x={xFor(label)} y={height-12} textAnchor="middle" className="pc-axis">{label}</text>)}
      {series.map((row,index)=>row.points.map(point=>point.ciLow!==null&&point.ciHigh!==null?<g key={row.key+point.label} stroke={colorFor(index)} className="pc-ci">
        <line x1={xFor(point.label)} x2={xFor(point.label)} y1={yFor(point.ciHigh)} y2={yFor(point.ciLow)}/>
        <line x1={xFor(point.label)-4} x2={xFor(point.label)+4} y1={yFor(point.ciHigh)} y2={yFor(point.ciHigh)}/>
        <line x1={xFor(point.label)-4} x2={xFor(point.label)+4} y1={yFor(point.ciLow)} y2={yFor(point.ciLow)}/>
      </g>:null))}
      {series.map((row,index)=><polyline key={row.key} fill="none" stroke={colorFor(index)}
        strokeWidth={2} points={row.points.map(point=>`${xFor(point.label)},${yFor(point.ratePerMinute??0)}`).join(' ')}/>)}
      {series.map((row,index)=>row.points.map(point=><circle key={row.key+point.label}
        cx={xFor(point.label)} cy={yFor(point.ratePerMinute??0)} r={4} fill={colorFor(index)}
        stroke="#fbfcf8" strokeWidth={2} tabIndex={0} role="img"
        aria-label={`${row.key}，${point.label}，每分钟 ${formatRate(point.ratePerMinute??0)} 个候选${point.ciLow!==null&&point.ciHigh!==null?`，置信区间 ${formatRate(point.ciLow)} 至 ${formatRate(point.ciHigh)}`:'，无置信区间'}`}>
        <title>{`${row.key} · ${point.label} · ${formatRate(point.ratePerMinute??0)}/分钟${point.ciLow!==null&&point.ciHigh!==null?` · 95% CI ${formatRate(point.ciLow)}–${formatRate(point.ciHigh)}`:' · 无置信区间'}`}</title>
      </circle>))}
      {series.length<=4&&lastLabels.map(label=><text key={label.key} x={label.x+8} y={label.y+4} className="pc-direct">{label.key}</text>)}
    </svg>
    <p className="pc-hint">{disclosure}</p>
    <details className="pc-table"><summary>查看数据表</summary>
      <table><thead><tr><th scope="col">类别</th><th scope="col">时间点</th><th scope="col">候选数</th><th scope="col">语音分钟</th><th scope="col">每分钟候选</th><th scope="col">置信区间</th></tr></thead>
        <tbody>{series.flatMap(row=>row.points.map(point=><tr key={row.key+point.label}>
          <td>{row.key}</td><td>{point.label}</td><td>{point.candidates}</td>
          <td>{point.speechMinutes.toFixed(2)}</td><td>{formatRate(point.ratePerMinute??0)}</td>
          <td>{point.ciLow!==null&&point.ciHigh!==null?`${formatRate(point.ciLow)}–${formatRate(point.ciHigh)}`:'数据不足'}</td>
        </tr>))}</tbody></table>
    </details>
  </div>;
}

function ResetControl({onReset,onManageRecordings}:{onReset:()=>Promise<void>;onManageRecordings?:()=>void}) {
  const [open,setOpen]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  async function confirm(){
    if(busy)return;
    setBusy(true);setError('');
    try{
      await onReset();
      setOpen(false);
    }catch{
      setError('暂时无法重置，请稍后重试。');
    }finally{
      setBusy(false);
    }
  }
  return <div className="pc-reset">
    <button type="button" className="secondary" onClick={()=>{setOpen(true);setError('');}}>重置个人发音画像</button>
    {open&&<div role="dialog" aria-modal="true" aria-labelledby="pc-reset-title" className="pc-dialog"
      onKeyDown={event=>{if(event.key==='Escape'&&!busy)setOpen(false)}}>
      <h4 id="pc-reset-title">{RESET_DIALOG_COPY.title}</h4>
      <p>{RESET_DIALOG_COPY.clear}</p>
      <p className="pc-retention">{RESET_DIALOG_COPY.retention}</p>
      <p className="pc-hint">{RESET_DIALOG_COPY.retentionDetail}</p>
      <p>{RESET_DIALOG_COPY.consequence}</p>
      {onManageRecordings
        ? <p><button type="button" className="secondary" onClick={onManageRecordings}>{RESET_DIALOG_COPY.manage}</button></p>
        : <p className="pc-hint">可在「学习档案」中回听和管理录音。</p>}
      {error&&<p role="alert" className="pc-error">{error}</p>}
      <div className="pc-dialog-actions">
        <button type="button" className="secondary" autoFocus disabled={busy} onClick={()=>setOpen(false)}>{RESET_DIALOG_COPY.cancel}</button>
        <button type="button" className="primary" disabled={busy} onClick={()=>void confirm()}>{busy?'正在重置…':RESET_DIALOG_COPY.confirm}</button>
      </div>
    </div>}
  </div>;
}

export function PronunciationProfilePanel({onManageRecordings,feedback}:{
  onManageRecordings?:()=>void;
  feedback?:ProgressFeedbackRow[];
}) {
  const [snapshot,setSnapshot]=useState<ProfileSnapshot|null>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading');
  const [reloadKey,setReloadKey]=useState(0);
  const [resetMessage,setResetMessage]=useState('');
  const derivedProgress=progressFromFeedback(feedback??[]);
  const chartProgress=snapshot?.progress.length?snapshot.progress:derivedProgress;
  const chartDerived=Boolean(snapshot&&snapshot.progress.length===0&&derivedProgress.length>0);
  useEffect(()=>{
    let active=true;
    void readPronunciationProfile().then(result=>{
      if(!active)return;
      setSnapshot(normalizeProfileResult(result));
      setStatus('ready');
    }).catch(()=>{
      if(active)setStatus('error');
    });
    return ()=>{active=false};
  },[reloadKey]);
  async function reset(){
    await resetPronunciationProfile();
    setSnapshot(current=>({exists:false,classes:[],progress:[],...(current?.reliability?{reliability:current.reliability}:{})}));
    setResetMessage(RESET_DIALOG_COPY.done);
  }
  return <section className="pc-profile card pad" aria-label="个人发音画像">
    <div className="pc-profile-head"><div><div className="eyebrow">Pronunciation profile</div><h2>个人发音画像</h2></div></div>
    {status==='loading'&&<p role="status" className="pc-hint">正在读取个人发音画像…</p>}
    {status==='error'&&<div role="status" className="pc-error-box">
      <p>暂时无法读取个人发音画像。录音和已有确认不受影响。</p>
      <button type="button" className="secondary" onClick={()=>{setStatus('loading');setReloadKey(key=>key+1)}}>重试读取</button>
    </div>}
    {status==='ready'&&snapshot&&<>
      {!snapshot.exists&&<ColdStartDisclosure/>}
      {snapshot.catchTrials&&<ControlItemDisclosure controls={snapshot.catchTrials}/>}
      <SameClassProgress classes={snapshot.classes}/>
      {snapshot.reliability&&<ReliabilityBlock reliability={snapshot.reliability}/>}
      <ProgressChart series={buildProgressSeries(chartProgress)} derived={chartDerived}/>
      {(snapshot.ruleVersion||snapshot.detectorVersion)&&<p className="pc-hint">
        规则版本 {snapshot.ruleVersion??'未提供'} · 检测器版本 {snapshot.detectorVersion??'未提供'}
      </p>}
      {resetMessage&&<p role="status" className="pc-hint">{resetMessage}</p>}
      <ResetControl onReset={reset} onManageRecordings={onManageRecordings}/>
    </>}
  </section>;
}