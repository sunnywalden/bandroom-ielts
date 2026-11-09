"use client";

import { useEffect, useRef, useState } from "react";
import "./speaking.css";

type Phase = "part2" | "followup" | "review";
type Answer = {
  at: string;
  text: string;
  spoken: boolean;
  audio?: string;
  local?: string;
};
type Props = {
  account:string;
  day: number;
  prompt: string;
  followup: string;
  entry: Record<string, string>;
  save: (patch: Record<string, string>) => Promise<boolean>;
  advance: () => void;
};

function answers(raw?: string): Answer[] {
  try {
    const value = JSON.parse(raw || "[]");
    return Array.isArray(value) ? value.filter(a => a && typeof a.text === "string" && typeof a.at === "string") : [];
  } catch { return []; }
}

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

async function localClip(key: string, data?: Blob): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("ielts-speaking-audio", 1);
    open.onupgradeneeded = () => open.result.createObjectStore("clips");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("clips", data ? "readwrite" : "readonly");
      const store = tx.objectStore("clips");
      const req = data ? store.put(data, key) : store.get(key);
      tx.oncomplete = () => { db.close(); resolve(data || req.result as Blob | undefined); };
      tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
    };
  });
}

function Playback({answer}: {answer:Answer}) {
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let valid = true, url = "";
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

function Recorder({limit,clip,onClip,onActive}:{
  limit:number;clip:Blob|null;onClip:(blob:Blob|null)=>void;onActive:(busy:boolean)=>void;
}) {
  const [mode,setMode] = useState<"idle"|"waiting"|"recording">("idle");
  const [duration,setDuration] = useState(0);
  const [notice,setNotice] = useState("");
  const [url,setUrl] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const activeStream = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  const started = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (recorder.current?.state === "recording") recorder.current.stop();
      activeStream.current?.getTracks().forEach(t => t.stop());
    };
  }, []);
  useEffect(() => {
    if (!clip) {setUrl(""); return;}
    const address = URL.createObjectURL(clip); setUrl(address);
    return () => URL.revokeObjectURL(address);
  },[clip]);
  useEffect(() => {
    if (mode !== "recording") return;
    const id = setInterval(() => {
      const value = Math.floor((Date.now() - started.current) / 1000);
      setDuration(Math.min(value,limit));
      if (value >= limit && recorder.current?.state === "recording") recorder.current.stop();
    },200);
    return () => clearInterval(id);
  },[limit,mode]);
  async function record() {
    if (mode !== "idle") return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setNotice("此浏览器无法录音。你可以在页面外开口练习并记录要点。"); return;
    }
    setNotice(""); setMode("waiting"); onActive(true);
    let stream:MediaStream | undefined;
    try {
      stream = await navigator.mediaDevices.getUserMedia({audio:true});
      if (!mounted.current) { stream.getTracks().forEach(t => t.stop()); return; }
      activeStream.current = stream;
      const preferred = ["audio/webm;codecs=opus","audio/mp4","audio/ogg;codecs=opus"].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, preferred ? {mimeType:preferred,audioBitsPerSecond:64000} : {audioBitsPerSecond:64000});
      recorder.current = rec;
      const parts:Blob[] = [];
      rec.ondataavailable = event => { if (event.data.size) parts.push(event.data); };
      rec.onstop = () => {
        stream?.getTracks().forEach(t => t.stop());
        if (!mounted.current) return;
        if (parts.length) onClip(new Blob(parts,{type:rec.mimeType || preferred || "audio/webm"}));
        else setNotice("没有录到声音，请重试或记录口头练习。");
        setMode("idle"); onActive(false);
      };
      rec.onerror = () => {
        stream?.getTracks().forEach(t => t.stop());
        if (mounted.current) {setNotice("录音中断，请检查麦克风。");setMode("idle");onActive(false);}
      };
      rec.start(); started.current = Date.now(); setDuration(0); setMode("recording");
    } catch {
      stream?.getTracks().forEach(t => t.stop());
      if (mounted.current) { setNotice("麦克风未能开启。请检查浏览器权限，或改用页面外口头练习。");setMode("idle");onActive(false); }
    }
  }
  return <div className="sp-recorder">
    <div className="sp-rec-main"><button type="button" className={`sp-mic ${mode === "recording" ? "sp-recording" : ""}`}
      disabled={mode==="waiting"} aria-label={mode==="recording"?"停止录音":"开始录音"}
      onClick={() => mode === "recording" ? recorder.current?.stop() : void record()}>
      {mode === "recording" ? <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg> : <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6"><rect x="8.5" y="2.5" width="7" height="13" rx="3.5"/><path d="M5.5 11v1.5a6.5 6.5 0 0 0 13 0V11M12 19v3m-3 0h6"/></svg>}
    </button><div><strong>{mode==="recording"?"正在录音":mode==="waiting"?"正在请求麦克风":clip?"重新录制本次草稿":"录下你的回答"}</strong><small>{mode==="recording" ? `${clock(duration)} / ${clock(limit)} · 点击停止` : `最多 ${clock(limit)} · 手动开始`}</small></div>
    <Wave live={mode==="recording"}/></div>
    {url && <div className="sp-play"><audio controls src={url} aria-label="试听本次录音"/><a href={url} download={clip?.type.includes("mp4")?"speaking.m4a":clip?.type.includes("ogg")?"speaking.ogg":"speaking.webm"}>下载本次录音</a></div>}
    {notice && <p role="status" className="sp-message">{notice}</p>}
  </div>;
}

function History({items}: {items:Answer[]}) {
  if (!items.length) return null;
  return <details className="sp-history"><summary>查看已保存的回答（{items.length}）</summary>
    {items.map((a,i) => <div className="sp-hist-item" key={a.at}>
      <b>{i>0 ? "练习重答" : "首次回答"} {i+1}</b>
      <small>{a.audio || a.local ? "录音" : a.spoken ? "本人确认口头作答" : "文字草稿"}</small>
      {a.text && <blockquote lang="en">{a.text}</blockquote>}<Playback answer={a}/>
    </div>)}</details>;
}

function AnswerTask({day,account,phase,prompt,followup,entry,save,go,retake}:Props & {phase:"part2"|"followup";go:(p:Phase)=>void;retake:boolean}) {
  const key = phase === "part2" ? "speakingPart2" : "speakingFollowup";
  const items = answers(entry[key]);
  const draftKey = `${key}Draft`;
  const [text,setText] = useState(entry[draftKey] || "");
  const [clip,setClip] = useState<Blob|null>(null);
  const [attest,setAttest] = useState(false);
  const [recording,setRecording] = useState(false);
  const [busy,setBusy] = useState(false);
  const [message,setMessage] = useState("");
  const pendingAudio = useRef<{blob:Blob;reference:Partial<Answer>} | null>(null);
  const isFollow = phase === "followup";
  const day11Part3 = day === 11 && isFollow;
  async function submit(draft:boolean) {
    if (busy || recording) return;
    setBusy(true);setMessage("");
    try {
      if (draft) {
        if (await save({[draftKey]:text.trim()})) setMessage("文字草稿已保存，可稍后接续。");
        else setMessage("草稿保存失败，请保留页面后重试。");
        return;
      }
      if (!clip && !attest) {setMessage("请录音，或在页面外作答后勾选口头练习记录。");return;}
      let ref:Partial<Answer> = {};
      if (clip) {
        if (pendingAudio.current?.blob === clip) ref = pendingAudio.current.reference;
        else {
          try {
            const res = await fetch("/api/audio",{method:"POST",headers:{"Content-Type":clip.type || "audio/webm","X-Bandroom-Account":account},body:clip});
            if(res.status===401||res.status===403||res.status===428){setMessage("当前登录已失效。先下载录音，再登录原账号后提交。");return;}
            if(res.status===413||res.status===415){setMessage("未能接收本次录音文件。请先下载并保留原件，再重新录制。");return;}
            if (!res.ok) throw new Error("upload failed");
            const result = await res.json();
            if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id) throw new Error("missing id");
            ref = {audio:result.id};
          } catch {
            const id = crypto.randomUUID();
            await localClip(id,clip);
            ref = {local:id};
          }
          pendingAudio.current = {blob:clip,reference:ref};
        }
      }
      const next = isFollow || retake ? "review" : "followup";
      const answer:Answer = {at:new Date().toISOString(),text:text.trim(),spoken:!!clip || attest,...ref};
      const ok = await save({[key]:JSON.stringify([...items,answer]),[draftKey]:"",speakingPhase:next});
      if (ok) go(next); else setMessage("回答记录未保存。请保留页面并重试。");
    } catch {setMessage("无法保存本次回答。可以先下载录音，再重试。");}
    finally {setBusy(false);}
  }
  return <section className="card sp-card">
    <div className="sp-top"><span className="eyebrow">{day11Part3 ? "SPEAKING PART 3" : isFollow ? "FOLLOW-UP" : "SPEAKING PART 2"}</span><span className="sp-tag">{retake ? "自主加练" : isFollow ? "追问" : "独立陈述"}</span></div>
    <h2>{day11Part3 ? "为什么有些司机会忽略警示灯？" : isFollow ? "回应一个追问" : "用英语讲一段经历"}</h2>
    <p className="sp-question" lang="en">{day11Part3 ? "Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?" : isFollow ? followup : prompt}</p>
    {!isFollow ? <><p className="sp-help">可以记下三个关键词：情境、你的行动、结果。准备 1 分钟，再自然讲 1–2 分钟。</p><PrepTimer/></> : <p className="sp-help">{day11Part3 ? "用 3–4 句英语回答，给出一个实际原因和一种可能后果。建议 40–60 秒。" : "先直接回答，再用一个理由或例子展开。建议 30–60 秒。"}</p>}
    <Recorder limit={isFollow ? 60 : 120} clip={clip} onClip={setClip} onActive={setRecording}/>
    <label className="sp-label">文字草稿或口述要点 <span>选填</span>
      <textarea rows={3} value={text} onChange={e => setText(e.target.value)} disabled={busy} maxLength={3500} placeholder="Jot down a few ideas in English…"/>
    </label>
    {!clip && <label className="sp-check"><input type="checkbox" checked={attest} onChange={e=>setAttest(e.target.checked)}/> 我已在页面外开口作答，按自报口练记录。</label>}
    <p className="sp-note">仅有文字或自报记录时，发音、停顿和流利度留待音频评估。</p>
    <History items={items}/>
    {message && <p className="sp-message" role="status">{message}</p>}
    <div className="actions sp-actions"><button className="primary" type="button" disabled={busy || recording || (!clip && !attest)} onClick={()=>void submit(false)}>{busy ? "保存中…" : !isFollow && !retake ? "保存回答，进入追问" : "保存回答，进入自评"}</button>
      <button className="secondary" type="button" disabled={busy || recording || !text.trim()} onClick={()=>void submit(true)}>保存文字草稿</button>
      {retake && <button className="sp-link" type="button" disabled={busy||recording} onClick={()=>go("review")}>返回自评</button>}
    </div>
  </section>;
}

export default function Speaking(props:Props) {
  const {day,entry,save,advance} = props;
  const stored = entry.speakingPhase;
  const [phase,setPhase] = useState<Phase>(stored==="followup" || stored==="review" || stored==="part2" ? stored : day===11 ? "followup" : "part2");
  const [retake,setRetake] = useState(false);
  const [focus,setFocus] = useState(entry.speakingReview || "");
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const first = answers(entry.speakingPart2), second = answers(entry.speakingFollowup);
  async function finish(){
    if (!focus || busy || !second.some(a=>a.spoken)) return;
    setBusy(true);setError("");
    try {
      if (await save({speakingReview:focus,speakingPhase:"review",speakingComplete:"yes"})) advance();
      else setError("复盘尚未保存，请重试。");
    } catch {setError("复盘尚未保存，请重试。");} finally {setBusy(false);}
  }
  if(phase!=="review") return <AnswerTask {...props} key={`${day}-${phase}`} phase={phase} retake={retake} go={setPhase}/>;
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
    </> : <><p className="sp-help">听自己的首答，或回想刚才的口头表达。选择一处下一次可以具体改进的地方。</p><History items={first}/></>}
    {day!==11 && <History items={second}/>}
    {second.some(a=>a.local) || first.some(a=>a.local) ? <p className="sp-note">本次有录音仅保存于当前浏览器，换设备后请回到录制设备回听。</p>:null}
    <fieldset className="sp-focus"><legend>下次开口时，我会优先练习</legend>
      {priorities.map(p=><label key={p} className={focus===p?"chosen":""}><input type="radio" name="speaking-focus" checked={focus===p} onChange={()=>setFocus(p)}/>{p}</label>)}
    </fieldset>
    {error && <p className="sp-message" role="status">{error}</p>}
    <div className="actions sp-actions">
      <button type="button" className="primary" onClick={()=>void finish()} disabled={busy||!focus||!second.some(a=>a.spoken)}>{busy ? "保存中…" : day===11 ? "保存自评，进入打卡" : "保存自评，进入词汇"}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>{setRetake(true);setPhase("followup");}}>{day===11 ? "重答 Part 3" : "重答追问"}</button>
      {day!==11 && <button type="button" className="sp-link" disabled={busy} onClick={()=>{setRetake(true);setPhase("part2");}}>重答 Part 2</button>}
    </div>
  </section>;
}
