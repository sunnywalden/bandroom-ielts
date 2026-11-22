"use client";

import AttemptFeedback from "./attempt-feedback";
import { useEffect, useMemo, useRef, useState } from "react";
import "./speaking.css";

import {answers,changeDraft,currentPhase,discardIfMatch,draftKey as recordingKey,submitted,uploadDraft,newRecordingId,type Answer,type AudioPhase,type QuestionPhase,type RecordingDraft} from './speaking-draft';
import SpeakingRecovery from './speaking-recovery';
import SessionRecorder,{type TakeMeta} from './speaking-recorder';
import {discardQueued,isQueueStorageError,queueRecording,queuedAudio,retryPending} from './speaking-queue';
import type {CoachFeedback} from './feedback-model';
import {activeFocus,focusEvidence,focusFromFeedback,focusSuggestions,mergeFocus,parseFocus,serializeFocus,setFocusStatus,type SpeakingFocus} from './speaking-focus';
import {answer as nextAnswer,begin,createSession,parseSession,pause as pauseSession,phasePart,questionFor,remainingSeconds,resume as resumeSession,serializeSession,sessionStorageKey,startPart2,type SpeakingSession} from './speaking-session';
import {buildPlan,partAnswerField,partDuration,questionById,reviewedFor,topicLabel,type SpeakingMode,type SpeakingPlan} from './speaking-questions';

type Props = {
  account:string;
  day: number;
  prompt: string;
  followup: string;
  entry: Record<string, string>;
  save: (patch: Record<string, string>) => Promise<boolean>;
  advance: () => void;
  feedback?: CoachFeedback[];
};

function clock(n: number) {
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

const KIND_LABEL:Record<string,string>={pronunciation:'自听确认',grammar:'语法',fluency:'流利度',lexical:'词汇',drill:'句式',topic:'话题'};
const EVIDENCE_LABEL:Record<string,string>={calibrated:'已校准证据',reference:'参考估计',suggestive:'建议性'};
// The learner may pick a different suggestion by hand; this bypasses mergeFocus's
// automatic-overwrite guard but keeps the five-item history contract.
function pickFocus(raw:string|undefined,item:SpeakingFocus){
  const state=parseFocus(raw);
  const known=[...(state.current?[state.current]:[]),...state.history]
    .filter(row=>row.id!==item.id).slice(0,5);
  return serializeFocus({version:1,current:{...item,status:'active'},history:known});
}
function FocusPanel({focus,feedback,suggestions,canRate,onPick,onStatus}:{
  focus:SpeakingFocus;feedback:CoachFeedback[];suggestions:SpeakingFocus[];canRate:boolean;
  onPick:(item:SpeakingFocus)=>void;onStatus:(status:'active'|'done'|'dismissed')=>void;
}) {
  const evidence=focusEvidence(focus,feedback);
  return <section className="card sp-card sp-focus-card" aria-label="练习焦点">
    <div className="sp-top"><span className="eyebrow">FOCUS</span><span className="sp-tag">{KIND_LABEL[focus.kind]??focus.kind}</span></div>
    <h3>本次开口的练习点</h3>
    <p className="sp-focus-text">{focus.text_zh}</p>
    <details className="sp-history"><summary>这个练习点从哪来</summary>
      {focus.source?.quote&&<p className="sp-note">来源原句：「{focus.source.quote}」</p>}
      {evidence.length
        ?<ul className="sp-focus-evidence">{evidence.map(line=><li key={line.label_zh}>{line.label_zh}：{line.value}<small>（{EVIDENCE_LABEL[line.status]??line.status}）</small></li>)}</ul>
        :<p className="sp-note">这条练习点暂时没有可展示的评分卡证据。</p>}
      <p className="sp-note">焦点只决定下一次开口的练习方向，不代表发音或水平评价。</p>
    </details>
    <div className="sp-focus-actions">
      {suggestions.filter(item=>item.id!==focus.id).slice(0,2).map(item=>
        <button key={item.id} type="button" className="sp-link" onClick={()=>onPick(item)}>换成：{item.text_zh}</button>)}
      {canRate&&focus.status==='active'&&<>
        <button type="button" className="sp-link" onClick={()=>onStatus('done')}>这次用到了</button>
        <span className="sp-note sp-focus-note">还没做到也没关系，焦点会保留到下一次。</span>
      </>}
      {canRate&&focus.status==='active'&&<button type="button" className="sp-link" onClick={()=>onStatus('dismissed')}>关闭这个练习点</button>}
      {focus.status==='done'&&<p className="sp-note" role="status">已标记：这次用到了。之后的新反馈不会自动替换它。</p>}
      {focus.status==='dismissed'&&<p className="sp-note" role="status">这个练习点已关闭。</p>}
    </div>
  </section>;
}
const wave = [8,14,9,24,18,33,23,14,27,39,17,26,46,32,18,25,12,19,10,13,7];

function Wave({ live = false }: { live?: boolean }) {
  return <span className={`sp-wave ${live ? "sp-live" : ""}`} aria-hidden="true">
    {wave.map((height,i) => <i key={i} style={{height, animationDelay:`${i * -0.067}s`}} />)}
  </span>;
}

async function localClip(key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ielts-speaking-audio", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("clips");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("clips", "readonly");
      const store = tx.objectStore("clips");
      const req = store.get(key);
      tx.oncomplete = () => { db.close(); resolve(req.result as Blob | undefined); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function Playback({answer}: {answer:Answer}) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let valid = true, url = "";
    // Reset playback status when the externally stored audio source changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFailed(false);
    if (answer.audio) setSource(`/api/audio?id=${encodeURIComponent(answer.audio)}`);
    else if (answer.local) {
      setSource("");
      localClip(answer.local).then(blob => {
        if (!valid) return;
        if (!blob) { setFailed(true); return; }
        url = URL.createObjectURL(blob);
        setSource(url);
      }).catch(() => valid && setFailed(true));
    }
    return () => { valid = false; if (url) URL.revokeObjectURL(url); };
  }, [answer.audio,answer.local]);
  if (!answer.audio && !answer.local) return null;
  return <div className="sp-play">
    {source && <audio controls preload="none" src={source} aria-label="回听这次回答" onError={() => setFailed(true)} />}
    {answer.local && <small>录音保存在录制时使用的浏览器。</small>}
    {failed && <small role="status">当前无法读取这段录音。</small>}
  </div>;
}

function PrepTimer() {
  const [left,setLeft] = useState(60);
  const [running,setRunning] = useState(false);
  useEffect(() => {
    if (!running) return;
    const end = Date.now() + left * 1000;
    const interval = setInterval(() => {
      const now = Math.max(0, Math.ceil((end - Date.now()) / 1000));
      setLeft(now);
      if (now === 0) setRunning(false);
    }, 200);
    return () => clearInterval(interval);
    // The running deadline is fixed at the moment the timer is started.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  return <div className="sp-timer">
    <span>准备时间 <b>{clock(left)}</b></span>
    <button className="sp-link" type="button" onClick={() => {
      if (left === 0) setLeft(60);
      setRunning(!running);
    }}>{running ? "暂停" : left === 60 ? "开始准备" : left === 0 ? "重新计时" : "继续计时"}</button>
  </div>;
}

type MicMode="idle"|"waiting"|"recording"|"stopping";
// Real microphone level meter (speaking redesign): the decorative wave gave no
// signal about whether the mic actually captures speech. RMS from an
// AnalyserNode drives the bar; a near-silent take is flagged at stop so the
// learner re-records BEFORE submitting (the 2026-11-19 outage showed silent
// submissions waste a full review cycle).
function LiveLevel({level,live}:{level:number;live:boolean}) {
  if(!live)return <Wave/>;
  const pct=Math.min(100,Math.round(level*100));
  return <span className="sp-level" role="meter" aria-label="麦克风电平" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
    <i style={{width:`${pct}%`}} className={pct<4?"sp-level-low":""}/>
  </span>;
}

function Recorder({limit,clip,disabled,stopRequestRef,onClip,onActive,heading}:{
  limit:number;clip:Blob|null;disabled:boolean;stopRequestRef:{current:(()=>void)|null};onClip:(blob:Blob)=>void;onActive:(mode:MicMode)=>void;heading?:string;
}) {
  const [mode,setMode] = useState<MicMode>("idle");
  const [duration,setDuration] = useState(0);
  const [notice,setNotice] = useState("");
  const [url,setUrl] = useState("");
  const [level,setLevel] = useState(0);
  const meterCtx=useRef<AudioContext|null>(null);
  const meterRaf=useRef(0);
  const speechSeen=useRef(false);
  const meterRan=useRef(false);
  const stopMeter=()=>{
    if(typeof cancelAnimationFrame==="function")cancelAnimationFrame(meterRaf.current);
    void meterCtx.current?.close().catch(()=>{});
    meterCtx.current=null;
    setLevel(0);
  };
  const startMeter=(stream:MediaStream)=>{
    speechSeen.current=false;
    meterRan.current=false;
    let ctx:AudioContext|undefined;
    try{
      const Ctor=window.AudioContext??(window as unknown as {webkitAudioContext?:typeof AudioContext}).webkitAudioContext;
      if(!Ctor)return;
      ctx=new Ctor();
      // Safari/iOS commonly leaves a context created outside the live gesture
      // suspended; a suspended analyser returns all zeros, which must not be
      // reported as a silent recording.
      void ctx.resume().catch(()=>{});
      meterCtx.current=ctx;
      const source=ctx.createMediaStreamSource(stream);
      const analyser=ctx.createAnalyser();
      analyser.fftSize=1024;
      source.connect(analyser);
      const data=new Float32Array(analyser.fftSize);
      let last=0;
      const loop=(t:number)=>{
        if(!meterCtx.current)return;
        meterRaf.current=requestAnimationFrame(loop);
        if(t-last<100)return;
        last=t;
        if(ctx?.state!=='running')return;
        analyser.getFloatTimeDomainData(data);
        meterRan.current=true;
        let sum=0;
        for(let i=0;i<data.length;i++)sum+=data[i]*data[i];
        const rms=Math.sqrt(sum/data.length);
        if(rms>0.02)speechSeen.current=true;
        setLevel(Math.min(1,rms*6));
      };
      meterRaf.current=requestAnimationFrame(loop);
    }catch{
      // Meter is best-effort; recording must never depend on it. Close a
      // half-constructed context instead of leaking it.
      void ctx?.close().catch(()=>{});
      meterCtx.current=null;
    }
  };
  const recorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const started = useRef(0);
  const startPending=useRef(false);
  const locked=useRef(false);
  const stopTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const onFinalized=useRef(onClip);
  useEffect(()=>{onFinalized.current=onClip},[onClip]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearTimeout(stopTimer.current);
      stopRequestRef.current=null;
      if(typeof cancelAnimationFrame==="function")cancelAnimationFrame(meterRaf.current);
      void meterCtx.current?.close().catch(()=>{});
      meterCtx.current=null;
      if (recorder.current?.state === "recording") recorder.current.stop();
      activeStream.current?.getTracks().forEach(t => t.stop());
    };
  }, [stopRequestRef]);
  useEffect(() => {
    // Studio hides this surface when the account lock is triggered; keep the
    // microphone from capturing behind the login gate.
    const stop = () => {
      locked.current = true;
      if (stopRequestRef.current) { stopRequestRef.current(); return; }
      if (recorder.current?.state === "recording") {
        try { recorder.current.stop(); } catch { /* already stopped */ }
      }
      activeStream.current?.getTracks().forEach(t => t.stop());
    };
    window.addEventListener("bandroom:access-locked", stop);
    return () => window.removeEventListener("bandroom:access-locked", stop);
  }, [stopRequestRef]);
  useEffect(() => {
    // Object URLs must be allocated and revoked in an effect, outside render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!clip) {setUrl(""); return;}
    const address = URL.createObjectURL(clip); setUrl(address);
    return () => URL.revokeObjectURL(address);
  },[clip]);
  useEffect(() => {
    if (mode !== "recording") return;
    const id = setInterval(() => {
      const value = Math.floor((Date.now() - started.current) / 1000);
      setDuration(Math.min(value,limit));
      if (value >= limit) stopRequestRef.current?.();
    },200);
    return () => clearInterval(id);
  },[limit,mode,stopRequestRef]);
  async function record() {
    if (mode !== "idle" || disabled || startPending.current) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("此浏览器无法录音。你可以在页面外开口练习并记录要点。"); return;
    }
    locked.current=false;
    startPending.current=true;setNotice(""); setMode("waiting"); onActive("waiting");
    let stream:MediaStream | undefined;
    let waiting=true,permissionTimer:ReturnType<typeof setTimeout>|undefined;
    try {
      stream = await Promise.race([navigator.mediaDevices.getUserMedia({audio:true}).then(value=>{
        if(!waiting||!mounted.current)value.getTracks().forEach(t=>t.stop());
        return value;
      }),new Promise<never>((_,reject)=>{permissionTimer=setTimeout(()=>reject(Error('microphone_timeout')),30_000)})]);
      waiting=false;clearTimeout(permissionTimer);
      if (!mounted.current || locked.current) {
        stream.getTracks().forEach(t => t.stop());setMode("idle");onActive("idle");return;
      }
      activeStream.current = stream;
      startMeter(stream);
      const preferred = ["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, preferred ? {mimeType:preferred,audioBitsPerSecond:64000} : {audioBitsPerSecond:64000});
      recorder.current = rec;
      const parts:Blob[] = [];
      let finalized=false;
      rec.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      const finish = (incomplete=false) => {
        if(finalized||recorder.current!==rec)return;finalized=true;clearTimeout(stopTimer.current);
        stopRequestRef.current=null;
        stopMeter();
        stream?.getTracks().forEach(t => t.stop());
        if(meterRan.current&&!speechSeen.current&&parts.length&&mounted.current){
          setNotice("电平表显示本次录音全程接近静音：可能麦克风未拾音。建议重录后再提交，否则批改无法分析流利度。");
        }
        // The timeout/error path cancels stop-and-submit before exposing any
        // partial bytes. They remain available for inspection and download.
        if(incomplete&&mounted.current){onActive("idle");setNotice("录音整理超时或中断。已收到的音频可试听和下载；确认完整后再提交。");}
        if (parts.length) onFinalized.current(new Blob(parts,{type:rec.mimeType || preferred || "audio/webm"}));
        if (!mounted.current) return;
        if (!parts.length) setNotice("没有录到声音，请重试或记录口头练习。");
        setMode("idle"); onActive("idle");
      };
      const waitForStop = () => {
        clearTimeout(stopTimer.current);
        stopTimer.current=setTimeout(()=>finish(true),10_000);
      };
      rec.onstop = () => finish();
      rec.onerror = () => {
        stream?.getTracks().forEach(t => t.stop());
        // Cancel automatic submission; the subsequent stop event can still
        // deliver recoverable audio for the learner to inspect.
        if (mounted.current) {setNotice("录音中断，请试听并下载已录部分，确认完整后再提交。");onActive("idle");setMode("stopping");onActive("stopping");}
        waitForStop();
      };
      rec.start(1000);stopRequestRef.current=()=>{
        if(rec.state!=="recording")return;
        setMode("stopping");onActive("stopping");waitForStop();
        try{rec.stop()}catch{finish(true)}
      };onActive("recording"); started.current = Date.now(); setDuration(0); setMode("recording");
    } catch {
      stopMeter();
      stream?.getTracks().forEach(t => t.stop());
      if (mounted.current) { setNotice("麦克风未能开启。请检查浏览器权限，或改用页面外口头练习。");setMode("idle");onActive("idle"); }
    } finally {waiting=false;clearTimeout(permissionTimer);startPending.current=false}
  }
  return <div className="sp-recorder">
    <div className="sp-rec-main"><button type="button" className={`sp-mic ${mode === "recording" ? "sp-recording" : ""}`}
      disabled={mode==="waiting" || mode==="stopping" || (disabled && mode!=="recording")} aria-label={mode==="recording"?"停止录音":"开始录音"}
      onClick={() => mode === "recording" ? stopRequestRef.current?.() : void record()}>
      {mode === "recording" ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg> : <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="8.5" y="2.5" width="7" height="13" rx="3.5"/><path d="M5.5 11v1.5a6.5 6.5 0 0 0 13 0V11M12 19v3m-3 0h6"/></svg>}
    </button><div><strong>{mode==="stopping"?"正在整理录音":mode==="recording"?"正在录音":mode==="waiting"?"正在请求麦克风":clip?"重新录制本次草稿":(heading??"录下你的回答")}</strong><small>{mode==="recording" ? `${clock(duration)} / ${clock(limit)} · 点击停止` : `最多 ${clock(limit)} · 手动开始`}</small></div>
    <LiveLevel level={level} live={mode==="recording"}/></div>
    {url && <div className="sp-play"><audio controls src={url} aria-label="试听本次录音"/><a href={url} download={clip?.type.includes("mp4")?"speaking.m4a":clip?.type.includes("ogg")?"speaking.ogg":clip?.type.includes("wav")?"speaking.wav":"speaking.webm"}>下载本次录音</a></div>}
    {notice && <p role="status" className="sp-message">{notice}</p>}
  </div>;
}

function History({items,title="查看已保存的回答"}: {items:Answer[];title?:string}) {
  if (!items.length) return null;
  return <details className="sp-history"><summary>{title}（{items.length}）</summary>
    {items.map((a,i) => <div className="sp-hist-item" key={a.at}>
      <b>{i>0 ? "练习重答" : "首次回答"} {i+1}</b>
      <small>{a.audio || a.local ? "录音" : a.spoken ? "本人确认口头作答" : "文字草稿"}</small>
      {a.text && <blockquote lang="en">{a.text}</blockquote>}<Playback answer={a}/>
    </div>)}</details>;
}

function AnswerTask({day,account,phase,prompt,followup,entry,save,go,retake}:Props & {phase:QuestionPhase;go:()=>void;retake:boolean}) {
  const key = phase === "part2" ? "speakingPart2" : "speakingFollowup";
  const items = answers(entry[key]), scope=recordingKey(account,day,phase);
  const draftKey = `${key}Draft`;
  const textKey=scope+'-text';
  const [text,setText] = useState(()=>{try{return localStorage.getItem(textKey)??entry[draftKey]??''}catch{return entry[draftKey]||''}});
  const [voice,setVoice] = useState<RecordingDraft|null>(null);
  const [attest,setAttest] = useState(false);
  const [mic,setMic]=useState<MicMode>("idle");
  const recording=mic!=="idle";
  const stopRequestRef=useRef<(()=>void)|null>(null), saveOnStop=useRef(false);
  const [busy,setBusy] = useState(false),[preparing,setPreparing]=useState(true);
  const [message,setMessage] = useState("");
  const mounted=useRef(false), submitting=useRef(false);
  const isFollow = phase === "followup";
  const day11Part3 = day === 11 && isFollow;
  useEffect(()=>{
    let active=true;mounted.current=true;
    changeDraft(scope).then(d=>{
      if(!active||!d)return;
      if(submitted(d,items)){void changeDraft(scope,discardIfMatch(d.id)).catch(()=>{});return;}
      setVoice(d);setMessage("已找回本机未提交的录音，可先试听再保存。");
    }).catch(()=>{if(active)setMessage("本机录音草稿存储不可用。请在离开页面前下载录音。");})
      .finally(()=>{if(active)setPreparing(false)});
    return ()=>{active=false;mounted.current=false};
    // Each question is keyed by day/phase/account; submissions are reloaded by Studio on remote conflicts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope]);
  async function removeVoice(){
    if(!voice||busy||recording)return;
    const id=voice.id;
    setMessage("正在移除录音…");
    try{
      await changeDraft(scope,discardIfMatch(id));
      const remaining=await changeDraft(scope);
      if(remaining?.id===id)throw Error("draft_still_present");
      setVoice(null);
      setMessage("已移除录音。可重新录制，或在页面外作答后勾选自报记录。");
    }catch{
      setMessage("本机录音草稿未能删除，录音仍保留。请重试。");
    }
  }
  async function keep(draft:RecordingDraft){
    if(mounted.current){setVoice(draft);setPreparing(true);setMessage("正在保留录音草稿…");}
    try{
      await changeDraft(scope,()=>draft);
      if(mounted.current)setMessage("录音草稿已保存在本机，可试听后提交。");
    }catch{if(mounted.current)setMessage("本机存储不足或不可用，请在离开页面前下载录音。");}
    finally{if(mounted.current)setPreparing(false)}
  }
  async function submit(draft:boolean,readyVoice=voice) {
    if (submitting.current) return;
    submitting.current=true;setBusy(true);setMessage("");
    try {
      if (draft) {
        if (await save({[draftKey]:text.trim()})) setMessage("文字草稿已保存，可稍后接续。");
        else setMessage("文字草稿保存失败，请在连接恢复后重试。");
        return;
      }
      if (!readyVoice && !attest) {setMessage("请录音，或在页面外作答后勾选口头练习记录。");return;}
      let audio=readyVoice?.audio;
      if (readyVoice && !audio) {
        try { audio=await uploadDraft(readyVoice,account,day,phase); }
        catch(error){if(mounted.current)setMessage(error instanceof TypeError?'连接中断，录音仍可试听。恢复连接后请重试。':error instanceof Error?error.message:'上传失败，请重试。');return;}
        if(mounted.current)setVoice({...readyVoice,audio});
        await changeDraft(scope,old=>old?.id===readyVoice.id?{...old,audio}:old).catch(()=>{});
      }
      if(!mounted.current)return;
      const answer:Answer={at:readyVoice?.at||new Date().toISOString(),text:text.trim(),spoken:true,...(audio?{audio}:{})};
      const next=isFollow||retake?'review':'followup';
      if (!await save({[key]:JSON.stringify([...items,answer]),[draftKey]:"",speakingPhase:next})){
        if(mounted.current)setMessage(audio?"录音已上传，作答记录尚未确认。可保留录音并重试保存。":"作答尚未确认，请重试保存。");
        return;
      }
      if(readyVoice)void changeDraft(scope,discardIfMatch(readyVoice.id)).catch(()=>{});
      try{if(localStorage.getItem(textKey)===text)localStorage.removeItem(textKey)}catch{/* keep in-memory draft */}
      go();
    } catch {if(mounted.current)setMessage("保存未完成。请保留录音，恢复连接后再次提交。");}
    finally {submitting.current=false;if(mounted.current)setBusy(false);}
  }
  return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">{day11Part3 ? "SPEAKING PART 3" : isFollow ? "FOLLOW-UP" : "SPEAKING PART 2"}</span><span className="sp-tag">{retake ? "自主加练" : isFollow ? "追问" : "独立陈述"}</span></div>
    {isFollow&&day!==11&&<p className="sp-note">第 2 / 2 题 · Part 2 已保存。本题完成后进入口语自评。</p>}
    <h2>{day11Part3 ? "为什么有些司机会忽略警示灯？" : isFollow ? "回应一个追问" : "用英语讲一段经历"}</h2>
    <p className="sp-question" lang="en">{day11Part3 ? "Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?" : isFollow ? followup : prompt}</p>
    {!isFollow ? <><p className="sp-help">可以记下三个关键词：情境、你的行动、结果。准备 1 分钟，再自然讲 1–2 分钟。</p><PrepTimer/></> : <p className="sp-help">{day11Part3 ? "用 3–4 句英语回答，给出一个实际原因和一种可能后果。建议 40–60 秒。" : "先直接回答，再用一个理由或例子展开。建议 30–60 秒。"}</p>}
    {isFollow&&day!==11&&<><History items={answers(entry.speakingPart2)} title="已提交的 Part 2 回答 · 点击回听"/>{answers(entry.speakingPart2).map((_,i)=><AttemptFeedback key={i} field="speakingPart2" index={i}/>)}</>}
    <Recorder limit={isFollow ? 60 : 120} clip={voice?.blob??null} disabled={busy||preparing} stopRequestRef={stopRequestRef}
      heading={day11Part3?"录下你的 Part 3 回答":isFollow?"录下你的追问回答（第 2/2 题）":retake?"录下你的加练回答":undefined} onClip={blob=>{
      const draft={id:newRecordingId(),at:new Date().toISOString(),blob};
      const commit=saveOnStop.current;saveOnStop.current=false;
      void keep(draft).then(()=>{if(commit&&mounted.current)void submit(false,draft)});
    }} onActive={mode=>{if(mode==="waiting"||mode==="idle")saveOnStop.current=false;setMic(mode)}}/>
    {voice?.audio&&!voice.blob&&<Playback answer={{audio:voice.audio,at:voice.at,text:'',spoken:true}}/>}
    {voice&&<button className="sp-link" type="button" disabled={busy||preparing||recording} onClick={()=>void removeVoice()}>移除这段录音，改为文字或自报作答</button>}
    {!voice&&<details className="sp-history"><summary>使用已保存的录音文件</summary>
      <label className="sp-label">选择本题录音（WebM、M4A、OGG 或 WAV，最多 12 MiB）
        <input type="file" accept="audio/webm,audio/mp4,audio/ogg,audio/wav,.webm,.m4a,.mp4,.ogg,.oga,.wav" disabled={busy||preparing||recording}
          onChange={e=>{
            const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;
            const extension=file.name.split('.').pop()?.toLowerCase()||'';
            const types:Record<string,string>={webm:'audio/webm',m4a:'audio/mp4',mp4:'audio/mp4',ogg:'audio/ogg',oga:'audio/ogg',wav:'audio/wav'};
            const type=types[extension]||file.type.split(';')[0];
            if(!file.size||file.size>12*1024*1024||!Object.values(types).includes(type)){setMessage('请选择 12 MiB 以内的 WebM、M4A、OGG 或 WAV 录音。');return;}
            void keep({id:newRecordingId(),at:new Date().toISOString(),blob:file.slice(0,file.size,type)});
          }}/>
      </label>
    </details>}
    {!voice&&<SpeakingRecovery day={day} account={account} phase={phase} disabled={busy||preparing||recording} onChoose={({id,at})=>{void keep({id,at,audio:id})}}/>}
    <label className="sp-label">文字草稿或口述要点 <span>选填</span>
      <textarea rows={3} value={text} onChange={e => {const value=e.target.value;setText(value);try{localStorage.setItem(textKey,value)}catch{setMessage('本机文字草稿存储不可用，请复制保留要点。')}}} disabled={busy} maxLength={3500} placeholder="Jot down a few ideas in English…"/>
    </label>
    {!voice && <label className="sp-check"><input type="checkbox" checked={attest} onChange={e=>setAttest(e.target.checked)}/> 我已在页面外开口作答，按自报口练记录。</label>}
    <p className="sp-note">仅有文字或自报记录时，发音、停顿和流利度留待音频评估。</p>
    <History items={items}/>{items.map((_,i)=><AttemptFeedback key={i} field={isFollow?"speakingFollowup":"speakingPart2"} index={i}/>)}
    {isFollow&&!day11Part3&&<p className="sp-note">上方卡片是 Part 2 的批改与自听确认，该录音已提交保存。本题是追问（第 2/2 题），需单独录一段（或勾选自报）后保存，完成后进入口语自评。</p>}
    {message && <p className="sp-message" role="status">{message}</p>}
    <div className="actions sp-actions"><button className="primary" type="button" disabled={busy || preparing || mic==="waiting" || mic==="stopping" || (mic==="idle" && !voice && !attest)} onClick={()=>{
        if(mic==="recording"){if(stopRequestRef.current){saveOnStop.current=true;stopRequestRef.current()} return;}
        void submit(false);
      }}>{busy ? "保存中…" : mic==="stopping"?"正在整理录音…":mic==="recording" ? "停止录音并保存回答" : !isFollow && !retake ? "保存回答，进入追问" : "保存回答，进入自评"}</button>
      <button className="secondary" type="button" disabled={busy || preparing || recording || !text.trim()} onClick={()=>void submit(true)}>保存文字草稿</button>
      {retake && <button className="sp-link" type="button" disabled={busy||recording} onClick={go}>返回自评</button>}
    </div>
  </section>;
}

// ---------------------------------------------------------------------------
// P0-4 speaking session: intro → Part 1 → prep → Part 2 → Part 3 → review.
// The legacy two-question flow above is kept byte-compatible for days that
// still hold only legacy records; new sessions never mix with it.
// ---------------------------------------------------------------------------

const MODE_LABEL:Record<SpeakingMode,string>={daily:'每日练习',full:'完整练习',mock:'练习模考'};
const MODE_HELP:Record<SpeakingMode,string>={
  daily:'Part 1 ×2 · Part 2 ×1 · Part 3 ×2',
  full:'Part 1 ×3 · Part 2 ×1 · Part 3 ×3',
  mock:'完整流程，严格计时；结束后统一查看反馈',
};
// Mirrors the state-transition caps; a full field evicts the oldest row.
const ANSWER_CAP=40;
const MOCK_ANSWER_CAP=30;

function useCountdown(session:SpeakingSession,onExpire:()=>void){
  const [left,setLeft]=useState(()=>remainingSeconds(session,Date.now())??0);
  const fired=useRef(false);
  const expire=useRef(onExpire);
  useEffect(()=>{expire.current=onExpire},[onExpire]);
  const paused=session.pausedAt!==undefined;
  useEffect(()=>{
    fired.current=false;
    let active=true;
    const tick=()=>{
      const value=remainingSeconds(session,Date.now())??0;
      if(!active)return;
      setLeft(value);
      if(value<=0&&!fired.current){fired.current=true;expire.current()}
    };
    tick();
    const id=setInterval(()=>{
      if(session.pausedAt!==undefined)return;
      tick();
    },250);
    return ()=>{active=false;clearInterval(id)};
  },[session,paused]);
  return left;
}

function SessionIntro({day,prompt,followup,entry,save,existing,onSession}:{
  day:number;prompt:string;followup:string;entry:Record<string,string>;
  save:(patch:Record<string,string>)=>Promise<boolean>;existing?:SpeakingSession;
  onSession:(session:SpeakingSession)=>void;
}) {
  const [mode,setMode]=useState<SpeakingMode>(existing?.mode??'daily');
  const active=existing?.mode??mode;
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const plan=useMemo(()=>{
    try{return buildPlan({mode:active,day,speaking:prompt,followup})}catch{return null}
  },[active,day,followup,prompt]);
  const previous=parseSession(entry.speakingSession)??parseSession(entry.speakingMockSession);
  async function start(){
    if(busy)return;
    setBusy(true);setError('');
    try{
      const chosen=buildPlan({mode:active,day,speaking:prompt,followup});
      const base=existing??createSession(active);
      const next=begin(base,chosen);
      if(next.phase==='intro'){setError('这一节没有可用的口语题目。');return}
      if(await save({[sessionStorageKey(next.mode)]:serializeSession(next)}))onSession(next);
      else setError('练习尚未开始，请检查连接后重试。');
    }catch{setError('这一节没有可用的口语题目。')}
    finally{setBusy(false)}
  }
  if(!plan)return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">SPEAKING SESSION</span><span className="sp-tag">口语练习</span></div>
    <h2>这一节暂时没有可用的口语题目</h2>
    <p className="sp-help">题目库尚未就绪，你已有的作答和反馈不受影响。请稍后重新打开本页。</p>
  </section>;
  return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">SPEAKING SESSION</span><span className="sp-tag">口语练习</span></div>
    <h2>今天练习：{topicLabel(plan.topic)}</h2>
    <p className="sp-help">Part 1 热身，Part 2 独立陈述，Part 3 追问。每题提交后立即保存，刷新或换页可继续。</p>
    <div className="sp-modes" role="radiogroup" aria-label="选择练习模式">
      {(['daily','full','mock'] as const).map(item=><label key={item} className={active===item?'chosen':''}>
        <input type="radio" name="speaking-mode" checked={active===item} disabled={Boolean(existing)||busy}
          onChange={()=>setMode(item)}/>
        <b>{MODE_LABEL[item]}</b><small>{MODE_HELP[item]}</small>
      </label>)}
    </div>
    {active==='mock'&&<p className="sp-note">模考按题限时，结束前不显示逐题反馈；结束后在报告中统一查看。可随时使用无障碍暂停，本场会标记为计时不完整。</p>}
    {active!=='mock'&&<p className="sp-note">练习模式可以暂停，暂停时间不计入本题。录音只在点击保存后上传。</p>}
    {previous&&previous.phase!=='done'&&<p className="sp-note" role="status">已找到一场未完成的{MODE_LABEL[previous.mode]}，重新打开本页会继续该场次。</p>}
    {error&&<p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy} onClick={()=>void start()}>
        {busy?'正在准备…':existing?'继续开始':`开始${MODE_LABEL[active]}`}
      </button>
    </div>
    <details className="sp-history"><summary>本次练习包含什么</summary>
      <p>Part 1：{plan.part1.length} 题，每题 40 秒。{plan.part1.length===2?'第 2 题按每日模式作为加练保存，不产生批改任务。':'完整模式每题都会进入批改。'}</p>
      <p>Part 2：1 题，准备 1 分钟，作答 2 分钟。</p>
      <p>Part 3：{plan.part3.length} 题，每题 60 秒。{plan.part3.length===2?'第 2 题按每日模式仅作加练保存。':'完整模式每题都会进入批改。'}</p>
      <p>口语评分卡只显示已校准或参考证据；发音分数在本产品中不显示，自听确认只在你能回听时出现。</p>
    </details>
  </section>;
}

function SessionHeader({session,plan,day}:{session:SpeakingSession;plan:SpeakingPlan;day:number}) {
  const part=phasePart(session.phase);
  const total=part===1?plan.part1.length:part===3?plan.part3.length:1;
  const label=part?`${MODE_LABEL[session.mode]} · Part ${part} · 第 ${session.qIndex+1} / ${total} 题`:MODE_LABEL[session.mode];
  return <div className="sp-session-head">
    <span className="sp-tag">{label}</span>
    <span className="sp-note">Day {day} · {topicLabel(plan.topic)}</span>
  </div>;
}

function PausePanel({session,onResume,busy}:{session:SpeakingSession;onResume:()=>Promise<void>;busy:boolean}) {
  return <div className="sp-pause" role="status">
    <strong>已暂停</strong>
    <p>暂停时间不计入本题。{session.mode==='mock'?'本场模考已标记为计时不完整。':''}</p>
    <button type="button" className="primary" disabled={busy} onClick={()=>void onResume()}>{busy?'正在保存…':'继续'}</button>
  </div>;
}

type Persist=(next:SpeakingSession,patch?:Record<string,string>,okMessage?:string)=>Promise<boolean>;

function readLocal(key:string){try{return localStorage.getItem(key)??''}catch{return ''}}
function writeLocal(key:string,value:string){try{localStorage.setItem(key,value)}catch{/* notes are best-effort */}}
function notesKey(account:string,day:number,session:SpeakingSession){return `speaking-notes:${account}:${day}:${session.id}`}

function PrepCard({account,day,plan,session,busy,persist,onPause,onResume}:{
  account:string;day:number;plan:SpeakingPlan;session:SpeakingSession;busy:boolean;
  persist:Persist;onPause:()=>Promise<void>;onResume:()=>Promise<void>;
}) {
  const question=plan.part2;
  const bullets=question.bullets?.length?question.bullets:['What the situation was','What you did','What happened in the end','How you felt about it'];
  const key=notesKey(account,day,session);
  const [notes,setNotes]=useState(()=>readLocal(key));
  const [message,setMessage]=useState("");
  const starting=useRef(false);
  const paused=session.pausedAt!==undefined;
  // Only auto-start when the deadline was still in the future at mount. A page
  // reloaded after the prep minute expired gets an explicit button instead of
  // a silently restarted 2-minute answer window.
  const armed=useRef(session.deadlineAt!==null&&session.deadlineAt>Date.now());
  async function startNow(){
    if(starting.current||paused)return;
    starting.current=true;
    try{
      const next=startPart2(session,Date.now());
      if(next===session)return;
      if(!await persist(next,{},'开始 Part 2 作答。'))setMessage('未能开始 Part 2，请重试。');
    } finally {starting.current=false}
  }
  const left=useCountdown(session,()=>{
    if(armed.current)void startNow();
    else setMessage('准备时间已到，请开始 Part 2 作答。');
  });
  const pct=Math.max(0,Math.min(100,(left/60)*100));
  return <section className="card sp-card">
    <SessionHeader session={session} plan={plan} day={day}/>
    <div className="sp-top"><span className="eyebrow">SPEAKING PART 2 · PREPARATION</span><span className="sp-tag">准备 1 分钟</span></div>
    <h2>准备你的独立陈述</h2>
    <p className="sp-question" lang="en">{question.prompt}</p>
    <ul className="sp-bullets">{bullets.map(item=><li key={item}>{item}</li>)}</ul>
    <p className="sp-help">准备时间结束后自动开始作答。写下关键词，不要写完整稿；作答时仍然看着题目说。</p>
    <label className="sp-label">准备笔记 <span>仅保存在本机，不会上传</span>
      <textarea rows={4} value={notes} maxLength={1200} disabled={busy||paused}
        onChange={e=>{setNotes(e.target.value);writeLocal(key,e.target.value)}} placeholder="Situation / action / result — a few words only"/>
    </label>
    {paused
      ? <PausePanel session={session} onResume={onResume} busy={busy}/>
      : <>
        <div className={`sp-prep-timer ${left<=10?'sp-timer-alert':''}`} role="timer" aria-label="准备剩余时间">
          <span>剩余 <b>{clock(left)}</b></span>
          <i style={{width:`${pct}%`}}/>
        </div>
        {left<=10&&left>0&&<p className="sp-timer-warn" role="status" aria-live="polite">还剩 {left} 秒，准备做答。</p>}
        {left===0&&<p className="sp-timer-warn" role="status">准备时间到。开始作答会获得完整的 2 分钟。</p>}
      </>}
    {message&&<p className="sp-message" role="status">{message}</p>}
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy||paused} onClick={()=>void startNow()}>
        {busy?'正在保存…':left===0?'开始 Part 2 作答':'提前开始 Part 2'}
      </button>
      {!paused&&<button type="button" className="sp-link" disabled={busy} onClick={()=>void onPause()}>暂停准备</button>}
    </div>
  </section>;
}

function SessionTask({account,day,entry,plan,session,busy,persist,onPause,onResume}:{
  account:string;day:number;entry:Record<string,string>;plan:SpeakingPlan;session:SpeakingSession;
  busy:boolean;persist:Persist;onPause:(accessible?:boolean)=>Promise<void>;onResume:()=>Promise<void>;
}) {
  const part=phasePart(session.phase)??1;
  const field=session.mode==='mock'?'speakingMock':partAnswerField(part);
  const items=answers(entry[field]);
  // The state API validates the recording's phase against the destination
  // field: speakingMock always accepts `mock`, the legacy fields keep their
  // historical names (Part 3 still uses `followup`).
  const audioPhase:AudioPhase=session.mode==='mock'?'mock':part===1?'part1':part===2?'part2':'followup';
  const question=questionFor(session,plan);
  const seq=part===2?0:session.qIndex;
  const total=part===1?plan.part1.length:part===3?plan.part3.length:1;
  const willReview=part===1?false:reviewedFor(session.mode,seq);
  const scope=recordingKey(account,day,audioPhase,`${session.id}:${part}:${seq}`);
  const draftKey=`${field}Draft`;
  const textKey=scope+'-text';
  const [text,setText]=useState(()=>{try{return localStorage.getItem(textKey)??entry[draftKey]??''}catch{return entry[draftKey]||''}});
  const [prepNotes]=useState(()=>part===2?readLocal(notesKey(account,day,session)):'');
  const [voice,setVoice]=useState<RecordingDraft|null>(null);
  const [takeMeta,setTakeMeta]=useState<TakeMeta|null>(null);
  const takeMetaRef=useRef<TakeMeta|null>(null);
  const [silentOk,setSilentOk]=useState(false);
  const silentOkRef=useRef(false);
  const [queueNote,setQueueNote]=useState<""|"pending"|"failed">("");
  const voiceRef=useRef<RecordingDraft|null>(null),owner=useRef("");
  const [attest,setAttest]=useState(false);
  const [mic,setMic]=useState<MicMode>("idle");
  const [message,setMessage]=useState("");
  const [timeUp,setTimeUp]=useState(false);
  const [localBusy,setLocalBusy]=useState(false),[preparing,setPreparing]=useState(true);
  const recording=mic!=="idle";
  const paused=session.pausedAt!==undefined;
  const stopRequestRef=useRef<(()=>void)|null>(null),saveOnStop=useRef(false);
  const mounted=useRef(false),submitting=useRef(false);
  const micRef=useRef<MicMode>("idle");
  useEffect(()=>{micRef.current=mic},[mic]);
  useEffect(()=>{voiceRef.current=voice},[voice]);
  const disabled=busy||localBusy||preparing||paused;
  useEffect(()=>{
    let active=true;mounted.current=true;
    changeDraft(scope).then(d=>{
      if(!active||!d)return;
      if(submitted(d,items)){void changeDraft(scope,discardIfMatch(d.id)).catch(()=>{});return;}
      owner.current=d.id;setVoice(d);setMessage("已找回本机未提交的录音，可先试听再保存。");
      if(d.blob&&!d.audio)void queuedAudio(account,day,audioPhase,d.blob).then(audio=>{
        if(!active||!audio)return;
        setVoice(value=>value?.id===d.id?{...value,audio}:value);
        void changeDraft(scope,old=>old?.id===d.id?{...old,audio}:old).catch(()=>{});
      }).catch(()=>{});
    }).catch(()=>{if(active)setMessage("本机录音草稿存储不可用。请在离开页面前下载录音。")})
      .finally(()=>{if(active)setPreparing(false)});
    return ()=>{active=false;mounted.current=false};
    // Each question is keyed by session/part/account; remote conflicts reload Studio state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[scope]);
  // Retry staged uploads when the page regains connectivity or visibility.
  // The queue is account-scoped; a different learner's tasks are left alone.
  useEffect(()=>{
    let active=true;
    const retry=()=>{
      if(document.visibilityState==="hidden")return;
      void retryPending(account,uploadDraft).then(()=>{
        const current=voiceRef.current;
        if(!active||!current?.blob||current.audio)return;
        return queuedAudio(account,day,audioPhase,current.blob).then(audio=>{
          if(!active||!audio)return;
          setVoice(value=>value?.id===current.id?{...value,audio}:value);
          void changeDraft(scope,old=>old?.id===current.id?{...old,audio}:old).catch(()=>{});
          if(owner.current===current.id)setQueueNote("");
        });
      }).catch(()=>{});
    };
    retry();
    window.addEventListener("online",retry);
    document.addEventListener("visibilitychange",retry);
    return ()=>{active=false;window.removeEventListener("online",retry);document.removeEventListener("visibilitychange",retry)};
  },[account,day,audioPhase,scope]);
  const left=useCountdown(session,()=>{
    setTimeUp(true);
    if(micRef.current==="recording")stopRequestRef.current?.();
  });
  async function removeVoice(){
    if(!voice||disabled||recording)return;
    const id=voice.id,blob=voice.blob;
    setMessage("正在移除录音…");
    try{
      await changeDraft(scope,discardIfMatch(id));
      const remaining=await changeDraft(scope);
      if(remaining?.id===id)throw Error("draft_still_present");
      setVoice(null);if(owner.current===id)owner.current="";
      setTakeMeta(null);takeMetaRef.current=null;setSilentOk(false);silentOkRef.current=false;setQueueNote("");
      if(blob)void discardQueued(account,day,audioPhase,blob);
      setMessage("已移除录音。可重新录制，或在页面外作答后勾选自报记录。");
    }catch{
      setMessage("本机录音草稿未能删除，录音仍保留。请重试。");
    }
  }
  // The durable queue is the primary path; only unavailable queue storage may
  // fall back to a direct upload, so a server rejection is never re-sent blindly.
  async function uploadTake(draft:RecordingDraft){
    try{return await queueRecording(draft,account,day,audioPhase,uploadDraft);}
    catch(error){
      if(!isQueueStorageError(error))throw error;
      if(draft.audio)return draft.audio;
      if(!draft.blob)throw error;
      return await uploadDraft(draft,account,day,audioPhase);
    }
  }
  async function keep(draft:RecordingDraft){
    const previous=voiceRef.current;
    if(previous?.blob&&previous.blob!==draft.blob)void discardQueued(account,day,audioPhase,previous.blob);
    owner.current=draft.id;
    if(mounted.current){setVoice(draft);setPreparing(true);setMessage("正在保留录音草稿…");}
    if(draft.blob&&mounted.current)setQueueNote("pending");
    try{
      await changeDraft(scope,()=>draft);
      if(mounted.current)setMessage("录音草稿已保存在本机，可试听后提交。");
    }catch{if(mounted.current)setMessage("本机存储不足或不可用，请在离开页面前下载录音。");}
    finally{if(mounted.current)setPreparing(false)}
    if(draft.blob)void uploadTake(draft).then(audio=>{
      if(!mounted.current||owner.current!==draft.id)return;
      setVoice(current=>current?.id===draft.id?{...current,audio}:current);
      void changeDraft(scope,old=>old?.id===draft.id?{...old,audio}:old).catch(()=>{});
      setQueueNote("");
    }).catch(()=>{if(mounted.current&&owner.current===draft.id)setQueueNote("failed")});
  }
  async function submit(draft:boolean,readyVoice=voice) {
    if(submitting.current)return;
    submitting.current=true;setLocalBusy(true);setMessage("");
    try{
      if(draft){
        if(await persist(session,{[draftKey]:text.trim()}))setMessage("文字草稿已保存，可稍后接续。");
        else setMessage("文字草稿保存失败，请在连接恢复后重试。");
        return;
      }
      if(!readyVoice&&!attest){setMessage("请录音，或在页面外作答后勾选口头练习记录。");return;}
      if(readyVoice&&takeMetaRef.current?.silent&&!silentOkRef.current){
        setMessage("这段录音电平接近静音（设备估算）。请先试听；确认确实有可听内容后，勾选下方确认再提交。");
        return;
      }
      let audio=readyVoice?.audio;
      if(readyVoice&&!audio){
        try{audio=await uploadTake(readyVoice);}
        catch(error){if(mounted.current)setMessage(error instanceof TypeError?'连接中断，录音仍可试听。恢复连接后请重试。':error instanceof Error?error.message:'上传失败，请重试。');return;}
        if(mounted.current)setVoice({...readyVoice,audio});
        await changeDraft(scope,old=>old?.id===readyVoice.id?{...old,audio}:old).catch(()=>{});
        if(mounted.current)setQueueNote("");
      }
      if(!mounted.current)return;
      const answer:Answer={
        at:readyVoice?.at||new Date().toISOString(),text:text.trim(),spoken:true,
        ...(audio?{audio}:{}),sessionId:session.id,part,seq,mode:session.mode,reviewed:willReview,
        ...(question?{questionId:question.id}:{}),
      };
      const cap=session.mode==='mock'?MOCK_ANSWER_CAP:ANSWER_CAP;
      const trimmed=items.length>=cap?items.slice(items.length-(cap-1)):items;
      const rows=[...trimmed,answer];
      const next=nextAnswer(session,plan,Date.now());
      const ok=await persist(next,{[field]:JSON.stringify(rows)},
        items.length>=cap?'回答已保存；条目达到上限，已移除最旧记录。':'回答已保存。');
      if(!ok){setMessage(audio?"录音已上传，作答记录尚未确认。可保留录音并重试保存。":"作答尚未确认，请重试保存。");return;}
      if(readyVoice)void changeDraft(scope,discardIfMatch(readyVoice.id)).catch(()=>{});
      try{if(localStorage.getItem(textKey)===text)localStorage.removeItem(textKey)}catch{/* keep in-memory draft */}
    }catch{if(mounted.current)setMessage("保存未完成。请保留录音，恢复连接后再次提交。");}
    finally{submitting.current=false;if(mounted.current)setLocalBusy(false);}
  }
  const saveLabel=part===1
    ? session.qIndex+1<plan.part1.length?"保存并进入下一题":"保存并进入 Part 2 准备"
    : part===2
      ? plan.part3.length?"保存并进入 Part 3":"保存，进入自评"
      : session.qIndex+1<plan.part3.length?"保存并进入下一题"
        : session.mode==='mock'?"保存，结束模考作答":"保存，进入自评";
  return <section className="card sp-card">
    <SessionHeader session={session} plan={plan} day={day}/>
    <div className="sp-top">
      <span className="eyebrow">SPEAKING PART {part}</span>
      <span className="sp-tag">{MODE_LABEL[session.mode]} · 第 {seq+1} / {total} 题</span>
    </div>
    <div className={`sp-part-timer ${left<=15?'sp-timer-alert':''}`} role="timer" aria-label="本题剩余时间">
      <span>{paused?"已暂停":"剩余时间"} <b>{clock(left)}</b></span>
      <span className="sp-note">限时 {clock(partDuration(part))}</span>
    </div>
    {!paused&&left<=15&&left>0&&<p className="sp-timer-warn" role="status" aria-live="polite">还剩 {left} 秒；时间到会自动停止录音，已录内容仍可保存。</p>}
    {timeUp&&<p className="sp-timer-warn" role="status">时间到，录音已停止。请保存已录内容；没有录到音频时可勾选自报作答。</p>}
    <h2>{part===1?"快速回答热身问题":part===2?"用英语讲一段经历":"回应一个追问"}</h2>
    <p className="sp-question" lang="en">{question?.prompt??''}</p>
    {part===1&&<p className="sp-help">用 1–2 句直接回答，再补一个细节。限时 40 秒，说完可直接保存。</p>}
    {part===2&&<p className="sp-help">准备 1 分钟，作答 2 分钟。围绕题目要点讲一个具体经历，说到时间到为止。</p>}
    {part===3&&<p className="sp-help">先直接回答，再用一个理由或例子展开。限时 60 秒。</p>}
    {part===2&&prepNotes.trim()&&<details className="sp-history"><summary>查看准备笔记（仅本机）</summary>
      <p className="sp-note" lang="en">{prepNotes}</p></details>}
    {paused&&<PausePanel session={session} onResume={onResume} busy={busy}/>}
    <SessionRecorder limit={partDuration(part)} clip={voice?.blob??null} disabled={disabled} practice={session.mode!=='mock'} stopRequestRef={stopRequestRef}
      heading={part===1?"录下你的 Part 1 回答":part===2?"录下你的 Part 2 陈述":"录下你的 Part 3 回答"} onClip={(blob,meta)=>{
      const draft={id:newRecordingId(),at:new Date().toISOString(),blob};
      const commit=saveOnStop.current;saveOnStop.current=false;
      takeMetaRef.current=meta;silentOkRef.current=false;setTakeMeta(meta);setSilentOk(false);
      void keep(draft).then(()=>{if(commit&&mounted.current)void submit(false,draft)});
    }} onActive={mode=>{if(mode==="waiting"||mode==="idle")saveOnStop.current=false;setMic(mode)}}
      onDiscard={()=>void removeVoice()}/>
    {voice?.audio&&!voice.blob&&<Playback answer={{audio:voice.audio,at:voice.at,text:'',spoken:true}}/>}
    {voice&&takeMeta?.silent&&<label className="sp-check"><input type="checkbox" checked={silentOk} onChange={e=>{silentOkRef.current=e.target.checked;setSilentOk(e.target.checked)}}/> 我试听过这段录音，确认有可听内容，仍要提交。</label>}
    {voice&&takeMeta?.incomplete&&<p className="sp-note" role="status">这段录音可能不完整；仍可提交，已收到的部分会保留。</p>}
    {voice&&queueNote==="pending"&&<p className="sp-note" role="status">录音正在后台上传；提交时会复用同一次上传。</p>}
    {voice&&queueNote==="failed"&&<p className="sp-note" role="status">录音暂未上传成功；提交时会自动重试。</p>}
    {voice&&<button className="sp-link" type="button" disabled={disabled||recording} onClick={()=>void removeVoice()}>移除这段录音，改为文字或自报作答</button>}
    {!voice&&<details className="sp-history"><summary>使用已保存的录音文件</summary>
      <label className="sp-label">选择本题录音（WebM、M4A、OGG 或 WAV，最多 12 MiB）
        <input type="file" accept="audio/webm,audio/mp4,audio/ogg,audio/wav,.webm,.m4a,.mp4,.ogg,.oga,.wav" disabled={disabled||recording}
          onChange={e=>{
            const file=e.currentTarget.files?.[0];e.currentTarget.value='';if(!file)return;
            const extension=file.name.split('.').pop()?.toLowerCase()||'';
            const types:Record<string,string>={webm:'audio/webm',m4a:'audio/mp4',mp4:'audio/mp4',ogg:'audio/ogg',oga:'audio/ogg',wav:'audio/wav'};
            const type=types[extension]||file.type.split(';')[0];
            if(!file.size||file.size>12*1024*1024||!Object.values(types).includes(type)){setMessage('请选择 12 MiB 以内的 WebM、M4A、OGG 或 WAV 录音。');return;}
            void keep({id:newRecordingId(),at:new Date().toISOString(),blob:file.slice(0,file.size,type)});
          }}/>
      </label>
    </details>}
    {!voice&&(audioPhase==='part2'||audioPhase==='followup')&&
      <SpeakingRecovery day={day} account={account} phase={audioPhase} disabled={disabled||recording} onChoose={({id,at})=>{void keep({id,at,audio:id})}}/>}
    <label className="sp-label">文字备份或口述要点 <span>选填；会随本题作答一起保存</span>
      <textarea rows={3} value={text} onChange={e=>{const value=e.target.value;setText(value);writeLocal(textKey,value)}} disabled={busy||localBusy} maxLength={3500} placeholder="A few keywords or the full answer…"/>
    </label>
    {!voice&&<label className="sp-check"><input type="checkbox" checked={attest} onChange={e=>setAttest(e.target.checked)}/> 我已在页面外开口作答，按自报口练记录。</label>}
    {part===1&&<p className="sp-note">Part 1 是热身，本题只记录作答，不产生批改任务。</p>}
    {part===3&&!willReview&&<p className="sp-note">本题按每日模式仅作加练保存，不产生批改任务。</p>}
    {session.mode==='mock'&&<p className="sp-note">模考结束前不显示逐题反馈；作答会保留在本场报告中。</p>}
    {session.mode!=='mock'&&<><History items={items}/>{items.map((_,i)=><AttemptFeedback key={i} field={field} index={i}/>)}</>}
    {message&&<p className="sp-message" role="status">{message}</p>}
    <div className="actions sp-actions">
      <button className="primary" type="button" disabled={disabled||mic==="waiting"||mic==="stopping"||(mic==="idle"&&!voice&&!attest)||(mic==="idle"&&!!voice&&!!takeMeta?.silent&&!silentOk)} onClick={()=>{
        if(mic==="recording"){if(stopRequestRef.current){saveOnStop.current=true;stopRequestRef.current()}return;}
        void submit(false);
      }}>{localBusy?"保存中…":mic==="stopping"?"正在整理录音…":mic==="recording"?"停止录音并保存回答":saveLabel}</button>
      <button className="secondary" type="button" disabled={disabled||recording||!text.trim()} onClick={()=>void submit(true)}>保存文字草稿</button>
      {session.mode==='mock'
        ? <details className="sp-history"><summary>无障碍选项：暂停计时</summary>
            <p className="sp-note">暂停后本场会标记为“计时不完整”，报告中会如实说明。</p>
            <button type="button" className="sp-link" disabled={disabled||recording} onClick={()=>void onPause(true)}>暂停计时</button>
          </details>
        : <button type="button" className="sp-link" disabled={disabled||recording} onClick={()=>void onPause()}>暂停作答</button>}
    </div>
  </section>;
}

// ---------------------------------------------------------------------------
// Review, mock report and session completion.
// ---------------------------------------------------------------------------

// Session rows carry sessionId; fields written before sessions existed fall
// back to the whole field so old answers stay visible and reviewable.
function sessionRows(items:Answer[],sessionId:string){
  const tagged=items.map((item,index)=>({item,index})).filter(row=>row.item.sessionId===sessionId);
  return tagged.length?tagged:items.map((item,index)=>({item,index}));
}

function reviewFocusPatch(entry:Record<string,string>,stored:SpeakingFocus|undefined,text:string,now:number){
  const patch:Record<string,string>={};
  const clean=text.trim();
  if(clean){
    // The legacy self-review keeps the chosen wording, but it is frozen once
    // this save succeeds. Focus only writes speakingFocus after that.
    patch.speakingReview=clean;
    if(!stored||stored.text_zh!==clean){
      const item:SpeakingFocus={id:`custom-${now.toString(36)}`,kind:stored?.kind??'topic',
        text_zh:clean,createdAt:new Date(now).toISOString(),status:'active'};
      patch.speakingFocus=pickFocus(entry.speakingFocus,item);
    }
  } else if(!stored){
    // Readiness requires a focus. Without any feedback this is a topic cue,
    // not a diagnosis.
    const fallback:SpeakingFocus={id:`topic-${now.toString(36)}`,kind:'topic',
      text_zh:'说满 30 秒，并补一个具体例子。',createdAt:new Date(now).toISOString(),status:'active'};
    patch.speakingFocus=serializeFocus({version:1,current:fallback,history:[]});
  }
  return patch;
}

function LegacySpeaking(props:Props) {
  const {day,entry,save,advance}=props;
  const feedback=props.feedback??[];
  const [retake,setRetake] = useState<QuestionPhase|null>(null);
  const phase=retake??currentPhase(day,entry);
  const storedFocus=activeFocus(entry.speakingFocus);
  const [focus,setFocus] = useState(entry.speakingReview || storedFocus?.text_zh || "");
  const [busy,setBusy] = useState(false);
  const [notice,setNotice] = useState("");
  const [error,setError] = useState("");
  const savingReview = useRef(false);
  const first = answers(entry.speakingPart2), second = answers(entry.speakingFollowup);
  const suggestions=focusSuggestions(day,feedback);
  // A new reviewed attempt may replace an open focus; decided focuses are never
  // revived by feedback. The write only happens when mergeFocus says so, so a
  // re-render or a refresh cannot churn the stored value.
  useEffect(()=>{
    if(entry.speakingComplete==="yes")return;
    const candidate=focusFromFeedback(day,feedback);
    const merged=mergeFocus(entry.speakingFocus,candidate);
    if(merged.changed)void save({speakingFocus:merged.value});
    // save is stable for the mounted day; feedback identity changes on refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[day,entry.speakingFocus,feedback]);
  async function updateFocus(raw:string){
    if(await save({speakingFocus:raw}))setNotice("练习焦点已保存。");
    else setNotice("练习焦点尚未保存，请重试。");
  }
  async function finish(){
    if (savingReview.current || !second.some(a=>a.spoken)) return;
    savingReview.current=true;
    setBusy(true);setError("");
    try {
      const text=focus.trim();
      const patch:Record<string,string>={speakingPhase:"review",speakingComplete:"yes"};
      if(text){
        // The legacy self-review keeps the chosen wording, but it is frozen once
        // this save succeeds. Focus only ever writes speakingFocus afterwards.
        patch.speakingReview=text;
        if(!storedFocus||storedFocus.text_zh!==text){
          const item:SpeakingFocus={id:`custom-${Date.now().toString(36)}`,kind:storedFocus?.kind??'topic',
            text_zh:text,createdAt:new Date().toISOString(),status:'active'};
          patch.speakingFocus=pickFocus(entry.speakingFocus,item);
        }
      } else if(entry.speakingFocus?.trim()){
        // No new wording was chosen and a focus already exists: nothing to add.
      } else {
        // Readiness requires a non-empty focus. Without any feedback this is a
        // topic cue, not a diagnosis.
        const fallback:SpeakingFocus={id:`topic-${day}-fallback`,kind:'topic',
          text_zh:'说满 30 秒，并补一个具体例子。',createdAt:new Date().toISOString(),status:'active'};
        patch.speakingFocus=serializeFocus({version:1,current:fallback,history:[]});
      }
      if (!await save(patch)) setError("复盘尚未保存，请重试。");
    } catch {setError("复盘尚未保存，请重试。");} finally {savingReview.current=false;setBusy(false);}
  }
  const focusCard=storedFocus&&<FocusPanel focus={storedFocus} feedback={feedback} suggestions={suggestions}
    canRate={phase==="review"&&entry.speakingComplete!=="yes"}
    onPick={item=>void updateFocus(pickFocus(entry.speakingFocus,item))}
    onStatus={status=>void updateFocus(setFocusStatus(entry.speakingFocus,storedFocus.id,status))}/>;
  if(phase!=="review") return <>{focusCard}<AnswerTask {...props} key={`${day}-${phase}`} phase={phase} retake={retake!==null} go={()=>setRetake(null)}/></>;
  const choices=[...(storedFocus?[{label:'上次焦点 · ',item:storedFocus}]:[]),
    ...suggestions.filter(item=>item.id!==storedFocus?.id).slice(0,2).map(item=>({label:'',item}))];
  return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">SPEAKING REVIEW</span><span className="sp-tag">口语自评</span></div>
    <h2>{day===11 ? "回顾刚才的 Part 3 回答" : "回听与自评"}</h2>
    {day === 11 ? <>
      <p className="sp-help">回听或回想刚才的回答：你是否给出了司机忽略警示灯的一个实际原因，并解释了可能的后果？</p>
      <History items={second}/>
      <details className="sp-history"><summary>复习此前轮胎预警故事的表达</summary>
      <div className="sp-quote"><span>LANGUAGE NOTE <i/> 条件句</span>
        <p lang="en">“If I got another tire pressure warning, I’d deal with it right away.”</p>
        <small>根据转录推测的表达：用 <b>if I got …, I’d …</b> 说明假设情境下的行动。</small>
      </div>
      <p>下方保留之前假设情境追问的文字转录。</p><blockquote lang="en">If there comes the same type pressure warning. Are there with it immediately</blockquote><p>转录中的个别词可能有偏差。现有记录支持语言反馈，尚无可回放原音或口语分数。</p></details>
    </> : <><p className="sp-help">听自己的首答，或回想刚才的口头表达。选择一处下一次可以具体改进的地方。</p><History items={first} title="已提交的 Part 2 回答 · 点击回听"/></>}
    {day!==11 && <History items={second} title="已提交的追问回答 · 点击回听"/>}
    {second.some(a=>a.local) || first.some(a=>a.local) ? <p className="sp-note">本次有录音仅保存于当前浏览器，换设备后请回到录制设备回听。</p>:null}
    {first.map((_,i)=><AttemptFeedback key={"part2"+i} field="speakingPart2" index={i}/>)}
    {second.map((_,i)=><AttemptFeedback key={"followup"+i} field="speakingFollowup" index={i}/>)}
    {focusCard}
    <fieldset className="sp-focus" disabled={busy||entry.speakingComplete==="yes"}><legend>下次开口时，我会优先练习 <small>可选：留空也能完成自评</small></legend>
      {choices.map(({label,item})=><label key={item.id} className={focus===item.text_zh?"chosen":""}>
        <input type="radio" name="speaking-focus" checked={focus===item.text_zh} onChange={()=>setFocus(item.text_zh)}/>{label}{item.text_zh}
      </label>)}
      <label className="sp-focus-custom">自己写一条
        <textarea rows={2} maxLength={300} value={focus} onChange={e=>setFocus(e.target.value)} placeholder="例如：每个理由都补一个具体例子"/>
      </label>
      {focus&&<button type="button" className="sp-link" onClick={()=>setFocus("")}>本次不设焦点</button>}
      <p className="sp-note">焦点只用于下一次开口的练习方向，不是分数；写下后可在下一次练习页更换或关闭。</p>
    </fieldset>
    <AttemptFeedback field="speakingReview"/>
    {notice&&<p className="sp-message" role="status">{notice}</p>}
    {error && <p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      {entry.speakingComplete==="yes"
        ? <button type="button" className="primary" onClick={advance} disabled={busy}>{day===11?"进入打卡":"进入词汇"}</button>
        : <button type="button" className="primary" onClick={()=>void finish()} disabled={busy||!second.some(a=>a.spoken)}>{busy?"保存中…":"保存自评，查看反馈"}</button>}
      <button type="button" className="secondary" disabled={busy} onClick={()=>setRetake("followup")}>{day===11 ? "重答 Part 3" : "重答追问"}</button>
      {day!==11 && <button type="button" className="sp-link" disabled={busy} onClick={()=>setRetake("part2")}>重答 Part 2</button>}
    </div>
  </section>;
}

function SessionReview({day,entry,plan,session,feedback,busy,persist,storedFocus,suggestions,onFocus}:{
  day:number;entry:Record<string,string>;plan:SpeakingPlan;session:SpeakingSession;feedback:CoachFeedback[];
  busy:boolean;persist:Persist;storedFocus?:SpeakingFocus;suggestions:SpeakingFocus[];
  onFocus:(raw:string)=>Promise<boolean>;
}) {
  const [focus,setFocus]=useState(entry.speakingReview||storedFocus?.text_zh||'');
  const [error,setError]=useState('');
  const first=sessionRows(answers(entry.speakingPart2),session.id);
  const third=sessionRows(answers(entry.speakingFollowup),session.id);
  const warm=sessionRows(answers(entry.speakingPart1),session.id);
  const ready=first.some(row=>row.item.spoken)&&third.some(row=>row.item.spoken);
  const choices=[...(storedFocus?[{label:'上次焦点 · ',item:storedFocus}]:[]),
    ...suggestions.filter(item=>item.id!==storedFocus?.id).slice(0,2).map(item=>({label:'',item}))];
  async function finish(){
    if(busy)return;
    if(!ready){setError('本场 Part 2 / Part 3 的作答尚未完整保存，请返回补全后再结束。');return}
    setError('');
    const patch={...reviewFocusPatch(entry,storedFocus,focus,Date.now()),speakingPhase:'review',speakingComplete:'yes'};
    if(!await persist(nextAnswer(session,plan),patch,'自评已保存，本节口试完成。'))setError('自评尚未保存，请检查连接后重试。');
  }
  const focusCard=storedFocus&&<FocusPanel focus={storedFocus} feedback={feedback} suggestions={suggestions}
    canRate onPick={item=>void onFocus(pickFocus(entry.speakingFocus,item))}
    onStatus={status=>void onFocus(setFocusStatus(entry.speakingFocus,storedFocus.id,status))}/>;
  return <section className="card sp-card">
    <SessionHeader session={session} plan={plan} day={day}/>
    <div className="sp-top"><span className="eyebrow">SPEAKING REVIEW</span><span className="sp-tag">口语自评</span></div>
    <h2>回听与自评</h2>
    <p className="sp-help">回听本场的 Part 2 陈述和 Part 3 回答，选一处下一次可以具体改进的地方。</p>
    <History items={first.map(row=>row.item)} title="本场 Part 2 陈述 · 点击回听"/>
    <History items={third.map(row=>row.item)} title="本场 Part 3 回答 · 点击回听"/>
    {warm.length>0&&<details className="sp-history"><summary>本场 Part 1 热身 · {warm.length} 题</summary><History items={warm.map(row=>row.item)} title="热身回答"/></details>}
    {(first.some(row=>row.item.local)||third.some(row=>row.item.local))&&<p className="sp-note">本次有录音仅保存在当前浏览器，换设备后请回到录制设备回听。</p>}
    {first.map(row=><AttemptFeedback key={'p2-'+row.index} field="speakingPart2" index={row.index}/>)}
    {third.map(row=><AttemptFeedback key={'p3-'+row.index} field="speakingFollowup" index={row.index}/>)}
    {focusCard}
    <fieldset className="sp-focus" disabled={busy}><legend>下次开口时，我会优先练习 <small>可选：留空也能完成自评</small></legend>
      {choices.map(({label,item})=><label key={item.id} className={focus===item.text_zh?'chosen':''}>
        <input type="radio" name="speaking-focus" checked={focus===item.text_zh} onChange={()=>setFocus(item.text_zh)}/>{label}{item.text_zh}
      </label>)}
      <label className="sp-focus-custom">自己写一条
        <textarea rows={2} maxLength={300} value={focus} onChange={e=>setFocus(e.target.value)} placeholder="例如：每个理由都补一个具体例子"/>
      </label>
      {focus&&<button type="button" className="sp-link" onClick={()=>setFocus('')}>本次不设焦点</button>}
      <p className="sp-note">焦点只用于下一次开口的练习方向，不是分数。</p>
    </fieldset>
    <AttemptFeedback field="speakingReview"/>
    {error&&<p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy||!ready} onClick={()=>void finish()}>{busy?'保存中…':'保存自评，查看反馈'}</button>
    </div>
  </section>;
}

function MockFinish({day,entry,plan,session,busy,persist}:{
  day:number;entry:Record<string,string>;plan:SpeakingPlan;session:SpeakingSession;
  busy:boolean;persist:Persist;
}) {
  const [error,setError]=useState('');
  const rows=sessionRows(answers(entry.speakingMock),session.id);
  const count=(part:1|2|3)=>rows.filter(row=>row.item.part===part).length;
  async function finish(){
    if(busy)return;
    if(!rows.length){setError('本场还没有已保存的作答，请先完成至少一题。');return}
    setError('');
    // Ending a mock never marks the day's speaking stage complete: the learner
    // still owes the daily/full session and its self-review.
    if(!await persist(nextAnswer(session,plan),{speakingMockComplete:'yes'},'模考已结束。'))
      setError('结束状态尚未保存，请重试。');
  }
  return <section className="card sp-card">
    <SessionHeader session={session} plan={plan} day={day}/>
    <div className="sp-top"><span className="eyebrow">MOCK EXAM · FINISH</span><span className="sp-tag">结束模考</span></div>
    <h2>本场作答已保存</h2>
    <p className="sp-help">Part 1 {count(1)} 题 · Part 2 {count(2)} 题 · Part 3 {count(3)} 题。结束前不显示逐题反馈；结束后在报告中统一查看。</p>
    {!session.timed&&<p className="sp-timer-warn" role="status">本场使用过暂停，报告中会标记“计时不完整”。</p>}
    <p className="sp-note">结束模考只记录本场练习，不会把今天的口语标记为已完成。</p>
    {error&&<p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy||!rows.length} onClick={()=>void finish()}>{busy?'正在保存…':'结束模考并查看报告'}</button>
    </div>
  </section>;
}

function MockReport({day,entry,plan,session,storedFocus,busy,onDaily,onRestart}:{
  day:number;entry:Record<string,string>;plan:SpeakingPlan|null;session:SpeakingSession|null;
  storedFocus?:SpeakingFocus;busy:boolean;onDaily:()=>Promise<void>;onRestart:()=>Promise<void>;
}) {
  const all=answers(entry.speakingMock);
  const rows=session&&session.startedAt>0?sessionRows(all,session.id):all.map((item,index)=>({item,index}));
  const count=(part:1|2|3)=>rows.filter(row=>row.item.part===part).length;
  const last=rows.reduce((max,row)=>Math.max(max,Date.parse(row.item.at)||0),0);
  const span=session&&session.startedAt>0&&last?Math.max(0,last-session.startedAt-(session.pausedMs||0)):null;
  const strict=Boolean(session?.timed);
  const promptOf=(row:{item:Answer})=>{
    const question=questionById(row.item.questionId);
    if(question)return question.prompt;
    const part=row.item.part??2;
    if(!plan)return '';
    if(part===1)return plan.part1[row.item.seq??0]?.prompt??'';
    if(part===2)return plan.part2.prompt;
    return plan.part3[row.item.seq??0]?.prompt??'';
  };
  return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">MOCK EXAM REPORT</span><span className="sp-tag">练习模考</span></div>
    <h2>本场模考报告</h2>
    <p className="sp-help">按 Part 汇总本场作答和教练反馈。练习模考不是官方 IELTS 成绩，也不显示发音分数；发音和流利度只在教练实际听到录音后评论。</p>
    <dl className="sp-mock-counts">
      <div><dt>Part 1</dt><dd>{count(1)} 题</dd></div>
      <div><dt>Part 2</dt><dd>{count(2)} 题</dd></div>
      <div><dt>Part 3</dt><dd>{count(3)} 题</dd></div>
      <div><dt>录音作答</dt><dd>{rows.filter(row=>row.item.audio).length} / {rows.length}</dd></div>
    </dl>
    {span!==null&&<p className="sp-note">本场作答跨度约 {Math.max(1,Math.round(span/60000))} 分钟（从开始到最后一题提交，含停顿）。</p>}
    {session&&!strict&&<p className="sp-timer-warn" role="status">{session.startedAt===0
      ?'本场没有完整的计时记录，报告不给出时长评价或水平结论。'
      :'本场使用了暂停，计时不完整；报告不给出时长评价或水平结论。'}</p>}
    {!rows.length&&<p className="sp-note">本场没有已保存的作答。</p>}
    {([1,2,3] as const).map(part=>{
      const list=rows.filter(row=>row.item.part===part);
      if(!list.length)return null;
      return <section className="sp-mock-part" key={part} aria-label={`Part ${part} 作答`}>
        <h3>Part {part} · {list.length} 题</h3>
        <ol className="sp-timeline">{list.map(row=><li key={row.index}>
          <div className="sp-timeline-head">
            <span>第 {(row.item.seq??0)+1} 题</span>
            <time dateTime={row.item.at}>{new Date(row.item.at).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})}</time>
          </div>
          {promptOf(row)&&<p className="sp-question" lang="en">{promptOf(row)}</p>}
          <History items={[row.item]} title="本场作答 · 点击回听"/>
          <AttemptFeedback field="speakingMock" index={row.index}/>
        </li>)}</ol>
      </section>;
    })}
    {storedFocus&&<p className="sp-note">当前练习点：{storedFocus.text_zh}</p>}
    <p className="sp-note">报告只显示教练已返回的反馈；仍在批改的题目会显示队列状态，不提前给出结论。</p>
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy} onClick={()=>void onDaily()}>{busy?'正在准备…':'回到每日练习'}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>void onRestart()}>再练一场模考</button>
    </div>
  </section>;
}

function SessionDone({day,entry,plan,session,storedFocus,busy,advance,onRestart,onMock}:{
  day:number;entry:Record<string,string>;plan:SpeakingPlan;session:SpeakingSession;storedFocus?:SpeakingFocus;
  busy:boolean;advance:()=>void;onRestart:()=>Promise<void>;onMock:()=>Promise<void>;
}) {
  const count=(field:string)=>answers(entry[field]).filter(item=>item.sessionId===session.id).length;
  return <section className="card sp-card">
    <SessionHeader session={session} plan={plan} day={day}/>
    <div className="sp-top"><span className="eyebrow">SESSION COMPLETE</span><span className="sp-tag">{MODE_LABEL[session.mode]}</span></div>
    <h2>本节口语已完成</h2>
    <p className="sp-help">本场 {count('speakingPart1')} 个 Part 1 热身、{count('speakingPart2')} 个 Part 2 陈述、{count('speakingFollowup')} 个 Part 3 回答已保存。</p>
    {storedFocus&&<p className="sp-note">本次留下的练习点：{storedFocus.text_zh}</p>}
    <AttemptFeedback field="speakingReview"/>
    <div className="actions sp-actions">
      <button type="button" className="primary" disabled={busy} onClick={advance}>进入下一模块</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>void onRestart()}>再练一次</button>
      {entry.speakingMockComplete!=='yes'&&<button type="button" className="sp-link" disabled={busy} onClick={()=>void onMock()}>开始练习模考</button>}
    </div>
    <p className="sp-note">当天的打卡仍需完成其他模块后在课程页确认；模考只作为额外练习。</p>
  </section>;
}

function SessionSpeaking(props:Props & {initial:SpeakingSession}) {
  const {account,day,entry,save,advance,prompt,followup}=props;
  const feedback=props.feedback??[];
  const [session,setSession]=useState(props.initial);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const plan=useMemo(()=>{
    try{return buildPlan({mode:session.mode,day,speaking:prompt,followup})}catch{return null}
  },[session.mode,day,followup,prompt]);
  const storedFocus=activeFocus(entry.speakingFocus);
  const suggestions=focusSuggestions(day,feedback);
  const persist:Persist=async(next,patch={},okMessage)=>{
    setBusy(true);setError('');
    try{
      const ok=await save({...patch,[sessionStorageKey(next.mode)]:serializeSession(next)});
      if(ok){setSession(next);if(okMessage)setNotice(okMessage)}
      else setError('保存尚未确认。请检查连接后重试；已输入的内容仍保留在本页。');
      return ok;
    }catch{setError('保存尚未确认。请检查连接后重试；已输入的内容仍保留在本页。');return false}
    finally{setBusy(false)}
  };
  // Focus follows the newest reviewed attempt, but mock sessions never mutate
  // it: their feedback is meant to be read after the run, and a focus write
  // during a timed mock would leak a per-question conclusion.
  useEffect(()=>{
    if(session.mode==='mock'||session.phase==='done')return;
    const candidate=focusFromFeedback(day,feedback);
    const merged=mergeFocus(entry.speakingFocus,candidate);
    if(merged.changed)void save({speakingFocus:merged.value});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[day,entry.speakingFocus,feedback,session.mode,session.phase]);
  async function updateFocus(raw:string){
    const ok=await save({speakingFocus:raw});
    setNotice(ok?'练习焦点已保存。':'练习焦点尚未保存，请重试。');
    return ok;
  }
  async function pause(accessible=false){
    const next=pauseSession(session,Date.now(),{accessible});
    if(next===session){
      setNotice(session.mode==='mock'?'模考计时只能通过“无障碍选项：暂停计时”暂停。':'当前阶段不能暂停。');
      return;
    }
    setNotice('');
    await persist(next,{},session.mode==='mock'?'已暂停；本场将标记为计时不完整。':'已暂停，暂停时间不计入本题。');
  }
  async function resume(){setNotice('');await persist(resumeSession(session),{},'继续本场练习。')}
  async function restartRun(){
    if(!plan)return;
    // A new id keeps every report scoped to this run while earlier answers stay
    // in the field as history.
    const next=begin(createSession(session.mode),plan);
    await persist(next,{},'已重新开始本场练习。');
  }
  async function startMock(){
    try{
      const next=begin(createSession('mock'),buildPlan({mode:'mock',day}));
      if(await save({speakingMockSession:serializeSession(next)})){setSession(next);setNotice('模考已开始。')}
      else setError('未能开始模考，请检查连接后重试。');
    }catch{setError('暂时无法开始模考。')}
  }
  async function startDaily(){
    try{
      const next=begin(createSession('daily'),buildPlan({mode:'daily',day,speaking:prompt,followup}));
      if(await save({speakingSession:serializeSession(next)})){setSession(next);setNotice('已开始每日练习。')}
      else setError('未能开始每日练习，请检查连接后重试。');
    }catch{setError('这一节暂时没有可用的口语题目。')}
  }
  if(!plan)return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">SPEAKING SESSION</span><span className="sp-tag">口语练习</span></div>
    <h2>这一节暂时没有可用的口语题目</h2>
    <p className="sp-help">题目库尚未就绪，你已有的作答和反馈不受影响。请稍后重新打开本页。</p>
  </section>;
  const sync=<>{notice&&<p className="sp-message" role="status">{notice}</p>}
    {error&&<p className="sp-message" role="status">{error}</p>}</>;
  if(session.phase==='intro')
    return <SessionIntro day={day} prompt={prompt} followup={followup} entry={entry} save={save}
      existing={session} onSession={next=>{setSession(next);setNotice('')}}/>;
  if(session.phase==='prep')
    return <>{sync}<PrepCard key={session.id} account={account} day={day} plan={plan} session={session}
      busy={busy} persist={persist} onPause={()=>pause(false)} onResume={resume}/></>;
  if(session.phase==='part1'||session.phase==='part2'||session.phase==='part3')
    return <>{sync}<SessionTask key={`${session.id}:${session.phase}:${session.qIndex}`}
      account={account} day={day} entry={entry} plan={plan} session={session} busy={busy}
      persist={persist} onPause={pause} onResume={resume}/></>;
  if(session.phase==='review')
    return <>{sync}{session.mode==='mock'
      ? <MockFinish day={day} entry={entry} plan={plan} session={session} busy={busy} persist={persist}/>
      : <SessionReview day={day} entry={entry} plan={plan} session={session} feedback={feedback} busy={busy}
          persist={persist} storedFocus={storedFocus} suggestions={suggestions} onFocus={updateFocus}/>}</>;
  return <>{sync}{session.mode==='mock'
    ? <MockReport day={day} entry={entry} plan={plan} session={session} storedFocus={storedFocus}
        busy={busy} onDaily={startDaily} onRestart={startMock}/>
    : <SessionDone day={day} entry={entry} plan={plan} session={session} storedFocus={storedFocus}
        busy={busy} advance={advance} onRestart={restartRun} onMock={startMock}/>}</>;
}

export default function Speaking(props:Props) {
  const {day,entry}=props;
  const daily=parseSession(entry.speakingSession);
  const mock=parseSession(entry.speakingMockSession);
  const running=daily&&daily.phase!=='done'?daily:mock&&mock.phase!=='done'?mock:null;
  if(running)return <SessionSpeaking key={running.id} {...props} initial={running}/>;
  // When both finished, the more recently started session is the one the
  // learner just completed; the other stays reachable from its own screen.
  if(daily&&(!mock||daily.startedAt>=mock.startedAt))
    return <SessionSpeaking key={daily.id} {...props} initial={daily}/>;
  if(mock)return <SessionSpeaking key={mock.id} {...props} initial={mock}/>;
  if(entry.speakingMockComplete==='yes')
    return <SessionSpeaking key={`mock-complete-${day}`} {...props}
      initial={{id:`mock-complete-${day}`,mode:'mock',phase:'done',qIndex:0,startedAt:0,deadlineAt:null,timed:false}}/>;
  const legacy=day===11||entry.speakingPhase!==undefined||entry.speakingComplete!==undefined
    ||entry.speakingReview!==undefined||entry.speakingPart1!==undefined
    ||entry.speakingPart2!==undefined||entry.speakingFollowup!==undefined;
  if(legacy)return <LegacySpeaking {...props}/>;
  return <SessionIntro day={day} prompt={props.prompt} followup={props.followup} entry={entry}
    save={props.save} onSession={()=>{}}/>;
}
