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
import {addDrillTake,drillKey,drillTakes as parseDrillTakes,latestTakeFor,rateDrillTake,type DrillTake} from './speaking-compare';
import {uploadRecording} from './speaking-draft';

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
function Transcript({words,recordingId,candidates,verdicts}:{words:TranscriptWord[];recordingId?:string;candidates:CoachAnalysis['items'];verdicts?:Record<string,string>}) {
  const audio=useRef<HTMLAudioElement>(null);
  const stopTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const playToken=useRef(0);
  const [active,setActive]=useState<number|null>(null);
  const [error,setError]=useState(false);
  useEffect(()=>()=>{if(stopTimer.current)clearTimeout(stopTimer.current);audio.current?.pause();},[]);
  const marks=new Map<number,'suggested'|'confirmed'|'rejected'>();
  for(const item of candidates??[]){
    if(item.isCatchTrial)continue;
    const at=(item.atMs??0)/1000;
    const verdict=(item.candidateId?verdicts?.[item.candidateId]:undefined)??item.priorVerdict??item.answeredVerdict??item.verdict;
    const idx=words.findIndex(w=>w.start<=at&&at<=w.end+0.15&&w.word.toLowerCase().includes(String(item.word??'').toLowerCase()));
    if(idx<0)continue;
    marks.set(idx,verdict==='confirmed'?'confirmed':verdict==='rejected'?'rejected':'suggested');
  }
  function stop(){
    playToken.current+=1;
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
    const token=++playToken.current;
    const w=words[index];
    const from=Math.max(0,w.start-0.12),to=w.end+0.18;
    setError(false);
    setActive(index);
    try{
      if(element.error)element.load();
      element.currentTime=from;
      element.play().catch((reason:unknown)=>{
        if(playToken.current!==token)return;
        // AbortError means a newer play() superseded this one — not a failure.
        if((reason as {name?:string}|null)?.name==='AbortError')return;
        setError(true);setActive(null);
      });
      const tick=()=>{
        if(playToken.current!==token)return;
        const current=audio.current;
        if(!current)return;
        // preload="none": the clip may still be loading. Keep polling instead
        // of giving up, or slow networks play the word into the next sentence.
        if(current.paused){stopTimer.current=setTimeout(tick,100);return;}
        const remaining=(to-current.currentTime)*1000;
        if(remaining<=0){stop();return;}
        stopTimer.current=setTimeout(tick,Math.max(20,remaining));
      };
      stopTimer.current=setTimeout(tick,100);
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

function normToken(value:string):string {
  return value.toLowerCase().replace(/[^a-z0-9']/g,' ').replace(/\s+/g,' ').trim();
}

// Locate the quote by matching its FULL normalized token sequence. A prefix
// match on the first word is not enough: "I went…" would otherwise resolve to
// an earlier "is"/"it" and the learner would hear the wrong part of the take.
function drillRange(words:TranscriptWord[],quote:string):{startMs:number;endMs:number}|null {
  const target=normToken(quote).split(' ').filter(Boolean);
  if(!target.length)return null;
  const flat:{token:string;word:number}[]=[];
  words.forEach((word,index)=>normToken(word.word).split(' ').filter(Boolean).forEach(token=>flat.push({token,word:index})));
  for(let start=0;start<=flat.length-target.length;start+=1){
    let matched=true;
    for(let offset=0;offset<target.length;offset+=1){
      if(flat[start+offset].token!==target[offset]){matched=false;break;}
    }
    if(!matched)continue;
    const first=words[flat[start].word];
    const last=words[flat[start+target.length-1].word];
    if(!first||!last)return null;
    return {startMs:Math.round(first.start*1000),endMs:Math.round(last.end*1000)};
  }
  return null;
}

// TTS URLs expire (the feedback row outlives the link). A failed load must
// degrade to the timestamp-only fallback, not a broken player.
function ModelAudio({url}:{url:string}) {
  const [failed,setFailed]=useState(false);
  if(failed)return <span className="af-hint">示范音频暂不可用（链接可能已过期），可先回听自己的片段。</span>;
  return <label className="ss-tts">示范音频<audio controls preload="none" src={url} onError={()=>setFailed(true)}/></label>;
}

type SaveResult={ok:boolean;notice?:string};
type DrillRecorderProps={attemptId:string;account:string;onSave:(take:DrillTake)=>Promise<SaveResult>;disabled?:boolean};
// A drill take is one sentence, not a full answer: hard-capped at 15 s. The
// take is uploaded through the generic audio route (server mints the id), then
// stored in the append-only speakingDrillTakes field so it survives reloads.
function DrillRecorder({attemptId,account,onSave,disabled}:DrillRecorderProps) {
  const [mode,setMode]=useState<'idle'|'waiting'|'recording'|'stopping'>('idle');
  const [seconds,setSeconds]=useState(0);
  const [notice,setNotice]=useState('');
  const recorder=useRef<MediaRecorder|null>(null);
  const stream=useRef<MediaStream|null>(null);
  const started=useRef(0);
  const mounted=useRef(true);
  const timer=useRef<ReturnType<typeof setInterval>|undefined>(undefined);
  const watchdog=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      clearInterval(timer.current);clearTimeout(watchdog.current);
      if(recorder.current?.state==='recording'){try{recorder.current.stop()}catch{/* already stopped */}}
      stream.current?.getTracks().forEach(track=>track.stop());
    };
  },[]);
  async function start(){
    if(mode!=='idle'||disabled)return;
    if(!navigator.mediaDevices?.getUserMedia||typeof MediaRecorder==='undefined'){
      setNotice('此浏览器无法录音。可以听示范并跟读，再用原句回听。');return;
    }
    setNotice('');setMode('waiting');
    let media:MediaStream|undefined;
    try{
      media=await navigator.mediaDevices.getUserMedia({audio:true});
      if(!mounted.current){media.getTracks().forEach(track=>track.stop());return;}
      stream.current=media;
      const preferred=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus']
        .find(type=>MediaRecorder.isTypeSupported(type));
      const rec=new MediaRecorder(media,preferred?{mimeType:preferred,audioBitsPerSecond:64000}:{audioBitsPerSecond:64000});
      recorder.current=rec;
      const parts:Blob[]=[];
      rec.ondataavailable=event=>{if(event.data.size)parts.push(event.data)};
      rec.onstop=()=>{
        clearInterval(timer.current);clearTimeout(watchdog.current);
        media?.getTracks().forEach(track=>track.stop());
        const durationMs=Date.now()-started.current;
        const blob=parts.length?new Blob(parts,{type:rec.mimeType||preferred||'audio/webm'}):null;
        if(!mounted.current)return;
        setMode('idle');setSeconds(0);
        if(!blob||durationMs<800){setNotice('这段录音太短，没有保存。请在提示后连续说完一句，至少 1 秒。');return;}
        if(durationMs>16_000){setNotice('录音超过 15 秒，没有保存。请只录需要练习的那一句。');return;}
        setMode('stopping');
        void uploadRecording(blob,account).then(audio=>onSave({drillKey:'',attemptId,at:new Date().toISOString(),audio,durationMs}))
          .then(result=>{if(mounted.current)setNotice(result.notice??(result.ok?'已保存。可以在上面回听对比。':'录音未能保存，请重试。'))})
          .catch(()=>{if(mounted.current)setNotice('录音上传失败，网络恢复后请重试。')})
          .finally(()=>{if(mounted.current)setMode('idle')});
      };
      rec.start(500);
      started.current=Date.now();setSeconds(0);setMode('recording');
      timer.current=setInterval(()=>{
        const value=Math.floor((Date.now()-started.current)/1000);
        if(mounted.current)setSeconds(Math.min(value,15));
        if(value>=15&&rec.state==='recording'){
          setMode('stopping');
          watchdog.current=setTimeout(()=>{try{rec.stop()}catch{/* already stopped */}},8_000);
          try{rec.stop()}catch{/* already stopped */}
        }
      },200);
    }catch{
      stream.current?.getTracks().forEach(track=>track.stop());
      if(mounted.current){setMode('idle');setNotice('麦克风未能开启。请检查浏览器权限后再试。')}
    }
  }
  function stop(){
    const rec=recorder.current;
    if(!rec||rec.state!=='recording')return;
    setMode('stopping');
    watchdog.current=setTimeout(()=>{try{rec.stop()}catch{/* already stopped */}},8_000);
    try{rec.stop()}catch{/* already stopped */}
  }
  return <div className="ss-drill-rec">
    <div className="ss-drill-rec-row">
      <button type="button" className="secondary" disabled={disabled||mode==='waiting'||mode==='stopping'}
        onClick={()=>mode==='recording'?stop():void start()}>
        {mode==='recording'?`停止并保存（${seconds}/15 秒）`:mode==='waiting'?'正在请求麦克风…':mode==='stopping'?'正在保存…':'录这一句（≤15 秒）'}
      </button>
      <small>只录这一句。录音会单独保存，不影响原回答。</small>
    </div>
    {notice&&<p className="af-hint" role="status">{notice}</p>}
  </div>;
}

function DrillItem({drill,index,words,recordingId,attemptId,account,takes,canSave,onSave,onRate}:{
  drill:SpeakingDrill;index:number;words:TranscriptWord[];recordingId?:string;attemptId:string;
  account?:string;takes:DrillTake[];canSave:boolean;onSave:(take:DrillTake)=>Promise<SaveResult>;
  onRate:(key:string,rating:'used'|'not_yet')=>Promise<boolean>;
}) {
  const key=drillKey(attemptId,drill.quote,drill.improved);
  const range=recordingId?drillRange(words,drill.quote):null;
  const contrast=drill.contrast_audio;
  const latest=latestTakeFor(JSON.stringify({version:1,takes}),key);
  const [slow,setSlow]=useState(false);
  const [rating,setRating]=useState<'used'|'not_yet'|null>(latest?.selfRating??null);
  useEffect(()=>{setRating(latest?.selfRating??null)},[latest?.at,latest?.selfRating]);
  const [ratingNote,setRatingNote]=useState('');
  async function rate(value:'used'|'not_yet'){
    const ok=await onRate(key,value);
    if(ok){setRating(value);setRatingNote('')}
    else setRatingNote('标记未能保存，请重试。');
  }
  return <article className="ss-drill" data-drill={index}
    onPlayCapture={event=>{(event.target as HTMLAudioElement).playbackRate=slow?0.75:1}}>
    <p className="ss-quote">你的原句：“{drill.quote}”</p>
    <p className="ss-fix">→ {drill.improved}</p>
    {drill.focus_zh&&<p className="ss-reason">练点：{drill.focus_zh}</p>}
    <div className="ss-drill-players">
      {contrast?.url
        ?<ModelAudio url={contrast.url}/>
        :<span className="af-hint">示范音频暂不可用（fail-closed），可先回听自己的片段。</span>}
      {range&&<RecordingClipPlayer recordingId={recordingId!} startMs={range.startMs} endMs={range.endMs} label="你的原句"/>}
      {latest?<label className="ss-tts">你的新录音 {takes.length>1?`· 最新 1 / ${takes.length}`:''}
        <audio controls preload="none" src={'/api/audio?id='+encodeURIComponent(latest.audio)} onPlay={event=>{event.currentTarget.playbackRate=slow?0.75:1}}/>
      </label>:<span className="af-hint">还没有这一句的新录音。</span>}
    </div>
    <div className="ss-drill-actions">
      <button type="button" className="sp-link" aria-pressed={slow} onClick={()=>setSlow(value=>!value)}>{slow?'恢复原速':'0.75× 慢放'}</button>
      {latest&&<span className="ss-drill-rate" role="group" aria-label="这次练习用到了吗">
        <button type="button" className={'sp-link'+(rating==='used'?' ss-rate-on':'')} aria-pressed={rating==='used'} disabled={!canSave} onClick={()=>void rate('used')}>用到了</button>
        <button type="button" className={'sp-link'+(rating==='not_yet'?' ss-rate-on':'')} aria-pressed={rating==='not_yet'} disabled={!canSave} onClick={()=>void rate('not_yet')}>还没做到</button>
      </span>}
    </div>
    {ratingNote&&<p className="af-hint" role="status">{ratingNote}</p>}
    {canSave&&account
      ?<DrillRecorder attemptId={attemptId} account={account} disabled={false}
        onSave={take=>onSave({...take,drillKey:key})}/>
      :<p className="af-hint">逐句重录只在本次作答的批改结果里保存；历史档案中的录音仍可回听。</p>}
  </article>;
}

function Drills({drills,words,recordingId,attemptId,account,store,saveDrillTakes,onStore}:{
  drills:SpeakingDrill[];words:TranscriptWord[];recordingId?:string;attemptId:string;account?:string;
  store:string;saveDrillTakes?:((raw:string)=>Promise<boolean>)|undefined;onStore:(raw:string)=>void;
}) {
  const takes=parseDrillTakes(store);
  const canSave=Boolean(account&&saveDrillTakes);
  async function save(take:DrillTake):Promise<SaveResult> {
    if(!saveDrillTakes)return {ok:false,notice:'当前页面不能保存录音。'};
    const result=addDrillTake(store,{...take,drillKey:take.drillKey});
    if(!result.added)
      return {ok:false,notice:'每个句子最多保留 3 条新录音。先回听对比，再决定是否继续练习；已保存的录音不会被覆盖或删除。'};
    const ok=await saveDrillTakes(result.value);
    if(!ok)return {ok:false,notice:'录音已上传，但练习记录保存失败。请重试保存。'};
    onStore(result.value);
    return {ok:true,notice:result.removed
      ?'已保存。本课最多保留 12 条逐句录音，最早的一条已移出列表（云端原录音不受影响）。'
      :'已保存。可以在上面回听对比。'};
  }
  async function rate(key:string,rating:'used'|'not_yet'){
    if(!saveDrillTakes)return false;
    const result=rateDrillTake(store,key,rating);
    if(!result.changed)return true;
    const ok=await saveDrillTakes(result.value);
    if(ok)onStore(result.value);
    return ok;
  }
  if(!drills.length)return null;
  return <div className="ss-drills" aria-label="跟读练习">
    <h4>跟读闭环 · 这样说更自然</h4>
    {drills.map((drill,i)=><DrillItem key={`${i}:${drill.quote}`} drill={drill} index={i} words={words}
      recordingId={recordingId} attemptId={attemptId} account={account}
      takes={takes.filter(take=>take.drillKey===drillKey(attemptId,drill.quote,drill.improved))}
      canSave={canSave} onSave={save} onRate={rate}/>)}
    <p className="af-hint">练法：听示范 → 跟读一遍 → 回听自己的原句片段 → 录一句新的对比。新录音只用于逐句练习，不会生成发音分数。</p>
  </div>;
}

export default function SpeakingScorecard({analysis,recordingId,verdicts,attemptId,account,drillTakes,onSaveDrillTakes}:{
  analysis:CoachAnalysis;recordingId?:string;verdicts?:Record<string,string>;attemptId?:string;
  account?:string;drillTakes?:string;onSaveDrillTakes?:(raw:string)=>Promise<boolean>;
}) {
  const [store,setStore]=useState(drillTakes??'');
  useEffect(()=>{setStore(current=>drillTakes!==undefined?drillTakes:current)},[drillTakes]);
  const card=analysis.scorecard;
  if(!card||card.schema!=='bandroom-speaking-scorecard-v1')return null;
  const words=card.transcript?.words??analysis.transcript??[];
  const drills=card.drills??[];
  const source=attemptId??recordingId??'attempt';
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
    <Transcript words={words} recordingId={recordingId} candidates={analysis.items} verdicts={verdicts}/>
    <Drills drills={drills} words={words} recordingId={recordingId} attemptId={source}
      account={account} store={store} saveDrillTakes={onSaveDrillTakes} onStore={setStore}/>
    {card.llm_status==='unavailable'&&<p className="af-hint" role="status">本次结构化分析暂不可用，评分卡仅含流利度与发音建议层；教练详评见下方。</p>}
  </div>;
}
