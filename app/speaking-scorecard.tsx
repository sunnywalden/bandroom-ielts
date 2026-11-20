'use client';
// Score-first speaking feedback (ELSA/Speak-inspired, honesty-contracted).
// Design: docs/speaking-redesign-2026-11-19.md. Every band carries a status:
// calibrated evidence / reference estimate / suggestive. Pronunciation has NO
// band while assertion gates are unmet. Transcript colors are honest: amber =
// detector suggestion (NOT an error assertion), red/green = the learner's own
// self-listen verdict, never the detector's claim.
import {useEffect,useRef,useState} from 'react';
import type {CoachAnalysis,ScorecardCriterion,SpeakingDrill,TranscriptWord} from './feedback-model';
import RecordingClipPlayer from './recording-clip-player';

const STATUS_LABEL:Record<string,string>={calibrated:'已校准证据',reference:'参考估计',suggestive:'建议性',asr:'ASR 转写'};
const STATUS_CLASS:Record<string,string>={calibrated:'ss-st-cal',reference:'ss-st-ref',suggestive:'ss-st-sug',asr:'ss-st-asr'};

function StatusChip({status}:{status:string}) {
  return <span className={'ss-status '+(STATUS_CLASS[status]??'ss-st-ref')}>{STATUS_LABEL[status]??status}</span>;
}

function criterionSummary(card:ScorecardCriterion):string {
  const e=card.evidence??{};
  if(card.key==='fluency_coherence'){
    const ratio=typeof e.speech_ratio==='number'?Math.round(e.speech_ratio*100):null;
    const pauses=typeof e.pause_count==='number'?e.pause_count:null;
    const pace=typeof e.pace_wpm==='number'?e.pace_wpm:null;
    return [ratio!=null?`语音占比 ${ratio}%`:null,pauses!=null?`停顿 ${pauses} 个`:null,pace!=null?`语速约 ${pace} 词/分（参考）`:null].filter(Boolean).join(' · ');
  }
  if(card.key==='lexical_resource'){
    const n=typeof e.word_count==='number'?e.word_count:null;
    const issues=Array.isArray(e.issues)?e.issues.length:0;
    return [n!=null?`转写 ${n} 词`:null,issues?`用词建议 ${issues} 条`:'用词无明显问题'].filter(Boolean).join(' · ');
  }
  if(card.key==='grammar'){
    const issues=Array.isArray(e.issues)?e.issues.length:0;
    return issues?`语法问题 ${issues} 条（见下）`:'未发现明显语法问题';
  }
  if(card.key==='pronunciation'){
    const n=typeof e.self_listen_candidates==='number'?e.self_listen_candidates:0;
    return n?`${n} 个建议回听词（见转写与自听确认）`:'本次无建议回听词';
  }
  return '';
}

function Issues({cards}:{cards:ScorecardCriterion[]}) {
  const grammar=cards.find(c=>c.key==='grammar');
  const lexical=cards.find(c=>c.key==='lexical_resource');
  const gIssues=grammar?.evidence?.issues??[];
  const lIssues=lexical?.evidence?.issues??[];
  if(!gIssues.length&&!lIssues.length)return null;
  return <div className="ss-issues">
    {gIssues.length>0&&<section aria-label="语法纠错">
      <h4>语法纠错 · 精确引文</h4>
      {gIssues.map((issue,i)=><article className="ss-issue" key={'g'+i}>
        <p className="ss-quote">“{issue.quote}”{issue.severity==='major'&&<span className="ss-major">影响理解</span>}</p>
        {issue.fix&&<p className="ss-fix">→ {issue.fix}</p>}
        {issue.reason_zh&&<p className="ss-reason">{issue.reason_zh}</p>}
      </article>)}
    </section>}
    {lIssues.length>0&&<section aria-label="用词建议">
      <h4>用词建议</h4>
      {lIssues.map((issue,i)=><article className="ss-issue" key={'l'+i}>
        <p className="ss-quote">“{issue.quote}”</p>
        {issue.suggestion&&<p className="ss-fix">→ {issue.suggestion}</p>}
        {issue.reason_zh&&<p className="ss-reason">{issue.reason_zh}</p>}
      </article>)}
    </section>}
  </div>;
}

// One shared audio element; clicking a word plays exactly that word's span.
function Transcript({words,recordingId,candidates}:{words:TranscriptWord[];recordingId?:string;candidates:CoachAnalysis['items']}) {
  const audio=useRef<HTMLAudioElement>(null);
  const stopTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const [active,setActive]=useState<number|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>()=>{if(stopTimer.current)clearTimeout(stopTimer.current);audio.current?.pause();},[]);
  const marks=new Map<number,'suggested'|'confirmed'|'rejected'>();
  for(const item of candidates??[]){
    if(item.isCatchTrial)continue;
    const at=(item.atMs??0)/1000;
    const verdict=item.priorVerdict??item.answeredVerdict??item.verdict;
    const idx=words.findIndex(w=>w.start<=at&&at<=w.end+0.15&&w.word.toLowerCase().includes(String(item.word??'').toLowerCase()));
    if(idx<0)continue;
    marks.set(idx,verdict==='confirmed'?'confirmed':verdict==='rejected'?'rejected':'suggested');
  }
  function stop(){
    if(stopTimer.current)clearTimeout(stopTimer.current);
    stopTimer.current=null;
    audio.current?.pause();
    setActive(null);
  }
  function play(index:number){
    const element=audio.current;
    if(!element||!recordingId)return;
    if(active===index){stop();return;}
    if(stopTimer.current)clearTimeout(stopTimer.current);
    const w=words[index];
    const from=Math.max(0,w.start-0.12),to=w.end+0.18;
    setError(false);
    setActive(index);
    try{
      if(element.error)element.load();
      element.currentTime=from;
      void element.play().catch(()=>{setError(true);setActive(null);});
      const tick=()=>{
        if(!audio.current||audio.current.paused)return;
        const remaining=(to-audio.current.currentTime)*1000;
        if(remaining<=0){stop();return;}
        stopTimer.current=setTimeout(tick,Math.max(20,remaining));
      };
      stopTimer.current=setTimeout(tick,(to-from)*1000+250);
    }catch{setError(true);setActive(null);}
  }
  if(!words.length)return null;
  return <div className="ss-transcript" aria-label="逐词转写，点击回听">
    <p className="ss-transcript-hint">逐词转写（ASR，可能含识别误差）。点击任一词回听你的原声；<span className="ss-lg ss-lg-sug">琥珀</span>=检测器建议回听（非错误断言），<span className="ss-lg ss-lg-red">红</span>/<span className="ss-lg ss-lg-green">绿</span>=你的自听确认。</p>
    {recordingId&&<audio ref={audio} src={'/api/audio?id='+encodeURIComponent(recordingId)} preload="none" onEnded={stop} onError={()=>{setError(true);setActive(null);}}/>}
    <p className="ss-words">{words.map((w,i)=>{
      const mark=marks.get(i);
      const cls='ss-word'+(mark?' ss-w-'+mark:'')+(active===i?' ss-w-active':'');
      return <button type="button" key={i} className={cls} onClick={()=>play(i)} disabled={!recordingId}
        title={recordingId?`回听 ${w.word} · ${w.start.toFixed(1)}–${w.end.toFixed(1)} 秒`:'原录音不可用'}>
        {w.word}{mark==='suggested'&&<span className="ss-dot" aria-label="建议回听"/>}
      </button>;
    })}</p>
    {error&&<p className="af-hint" role="status">原录音暂时无法播放，可以重试。</p>}
    {!recordingId&&<p className="af-hint">原录音引用不可用，转写仅供阅读。</p>}
  </div>;
}

function drillRange(words:TranscriptWord[],quote:string):{startMs:number;endMs:number}|null {
  const first=quote.trim().split(/\s+/)[0]?.toLowerCase().replace(/[^a-z']/g,'');
  if(!first)return null;
  const idx=words.findIndex(w=>w.word.toLowerCase().replace(/[^a-z']/g,'').startsWith(first.slice(0,4)));
  if(idx<0)return null;
  const count=quote.trim().split(/\s+/).length;
  const end=words[Math.min(words.length-1,idx+count-1)];
  return {startMs:Math.round(words[idx].start*1000),endMs:Math.round(end.end*1000)};
}

function Drills({drills,words,recordingId}:{drills:SpeakingDrill[];words:TranscriptWord[];recordingId?:string}) {
  if(!drills.length)return null;
  return <div className="ss-drills" aria-label="跟读练习">
    <h4>跟读闭环 · 这样说更自然</h4>
    {drills.map((drill,i)=>{
      const range=recordingId?drillRange(words,drill.quote):null;
      const contrast=drill.contrast_audio;
      return <article className="ss-drill" key={i}>
        <p className="ss-quote">你的原句：“{drill.quote}”</p>
        <p className="ss-fix">→ {drill.improved}</p>
        {drill.focus_zh&&<p className="ss-reason">练点：{drill.focus_zh}</p>}
        <div className="ss-drill-players">
          {contrast?.url
            ?<label className="ss-tts">示范音频<audio controls preload="none" src={contrast.url}/></label>
            :<span className="af-hint">示范音频暂不可用（fail-closed），可先回听自己的片段。</span>}
          {range&&<RecordingClipPlayer recordingId={recordingId!} startMs={range.startMs} endMs={range.endMs} label="你的片段"/>}
        </div>
      </article>;
    })}
    <p className="af-hint">练法：听示范 → 跟读一遍 → 回听自己的片段对比 → 用下方“重答”录一个更好的版本。</p>
  </div>;
}

export default function SpeakingScorecard({analysis,recordingId}:{analysis:CoachAnalysis;recordingId?:string}) {
  const card=analysis.scorecard;
  if(!card||card.schema!=='bandroom-speaking-scorecard-v1')return null;
  const words=card.transcript?.words??analysis.transcript??[];
  const drills=card.drills??[];
  return <div className="ss-card">
    <div className="ss-overall">
      <span className="ss-band">{card.overall.band!=null?card.overall.band.toFixed(1):'—'}</span>
      <div className="ss-overall-text">
        <strong>口语参考 band <StatusChip status={card.overall.status}/></strong>
        <p>{card.overall.basis_zh}。{card.overall.disclosure_zh}</p>
      </div>
    </div>
    <div className="ss-criteria">
      {card.criteria.map(c=><article className={'ss-criterion'+(c.band==null?' ss-c-noband':'')} key={c.key}>
        <div className="ss-c-head"><strong>{c.label_zh}</strong><StatusChip status={c.status}/></div>
        <span className="ss-c-band">{c.band!=null?c.band.toFixed(1):'不评分'}</span>
        <p className="ss-c-summary">{criterionSummary(c)}</p>
        <p className="ss-c-disclosure">{c.disclosure_zh}</p>
      </article>)}
    </div>
    <Issues cards={card.criteria}/>
    <Transcript words={words} recordingId={recordingId} candidates={analysis.items}/>
    <Drills drills={drills} words={words} recordingId={recordingId}/>
    {card.llm_status==='unavailable'&&<p className="af-hint" role="status">本次结构化分析暂不可用，评分卡仅含流利度与发音建议层；教练详评见下方。</p>}
  </div>;
}
