"use client";

import AttemptFeedback from "./attempt-feedback";
import { useEffect, useRef, useState } from "react";
import "./speaking.css";

import {answers,changeDraft,currentPhase,discardIfMatch,draftKey as recordingKey,submitted,uploadDraft,newRecordingId,type Answer,type QuestionPhase,type RecordingDraft} from './speaking-draft';
import SpeakingRecovery from './speaking-recovery';

type Props = {
  account:string;
  day: number;
  prompt: string;
  followup: string;
  entry: Record<string, string>;
  save: (patch: Record<string, string>) => Promise<boolean>;
  advance: () => void;
};

function clock(n: number) {
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
}

const priorities = ["用完整句说明因果", "用具体细节举例", "让时态前后一致"];
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
function Recorder({limit,clip,disabled,stopRequestRef,onClip,onActive,heading}:{
  limit:number;clip:Blob|null;disabled:boolean;stopRequestRef:{current:(()=>void)|null};onClip:(blob:Blob)=>void;onActive:(mode:MicMode)=>void;heading?:string;
}) {
  const [mode,setMode] = useState<MicMode>("idle");
  const [duration,setDuration] = useState(0);
  const [notice,setNotice] = useState("");
  const [url,setUrl] = useState("");
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
      const preferred = ["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, preferred ? {mimeType:preferred,audioBitsPerSecond:64000} : {audioBitsPerSecond:64000});
      recorder.current = rec;
      const parts:Blob[] = [];
      let finalized=false;
      rec.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      const finish = (incomplete=false) => {
        if(finalized||recorder.current!==rec)return;finalized=true;clearTimeout(stopTimer.current);
        stopRequestRef.current=null;
        stream?.getTracks().forEach(t => t.stop());
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
    <Wave live={mode==="recording"}/></div>
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

export default function Speaking(props:Props) {
  const {day,entry,save,advance} = props;
  const [retake,setRetake] = useState<QuestionPhase|null>(null);
  const phase=retake??currentPhase(day,entry);
  const [focus,setFocus] = useState(entry.speakingReview || "");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const savingReview = useRef(false);
  const first = answers(entry.speakingPart2), second = answers(entry.speakingFollowup);
  async function finish(){
    if (!focus || savingReview.current || !second.some(a=>a.spoken)) return;
    savingReview.current=true;
    setBusy(true);setError("");
    try {
      if (!await save({speakingReview:focus,speakingPhase:"review",speakingComplete:"yes"})) setError("复盘尚未保存，请重试。");
    } catch {setError("复盘尚未保存，请重试。");} finally {savingReview.current=false;setBusy(false);}
  }
  if(phase!=="review") return <AnswerTask {...props} key={`${day}-${phase}`} phase={phase} retake={retake!==null} go={()=>setRetake(null)}/>;
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
    <fieldset className="sp-focus" disabled={busy||entry.speakingComplete==="yes"}><legend>下次开口时，我会优先练习</legend>
      {priorities.map(p=><label key={p} className={focus===p?"chosen":""}><input type="radio" name="speaking-focus" checked={focus===p} onChange={()=>setFocus(p)}/>{p}</label>)}
    </fieldset>
    <AttemptFeedback field="speakingReview"/>
    {error && <p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      {entry.speakingComplete==="yes"
        ? <button type="button" className="primary" onClick={advance} disabled={busy}>{day===11?"进入打卡":"进入词汇"}</button>
        : <button type="button" className="primary" onClick={()=>void finish()} disabled={busy||!focus||!second.some(a=>a.spoken)}>{busy?"保存中…":"保存自评，查看反馈"}</button>}
      <button type="button" className="secondary" disabled={busy} onClick={()=>setRetake("followup")}>{day===11 ? "重答 Part 3" : "重答追问"}</button>
      {day!==11 && <button type="button" className="sp-link" disabled={busy} onClick={()=>setRetake("part2")}>重答 Part 2</button>}
    </div>
  </section>;
}
