"use client";
import { useState } from "react";
import type { RecoverableClip, SpeakingPhase } from "@/lib/recording-recovery";

export default function SpeakingRecovery({day,account,phase,onChoose,disabled=false}:{day:number;account:string;phase:SpeakingPhase;onChoose:(clip:{id:string;at:string})=>void;disabled?:boolean}){
  const [items,setItems]=useState<RecoverableClip[]>([]);
  const [status,setStatus]=useState(""),[busy,setBusy]=useState(false);
  async function find(){
    setBusy(true);setItems([]);setStatus("");
    try{
      const r=await fetch("/api/audio/recovery?day="+day+"&phase="+phase,{cache:"no-store",headers:{"X-Bandroom-Account":account}});
      if(!r.ok)throw Error();
      const d=await r.json() as {items:RecoverableClip[];complete:boolean};
      setItems(d.items);setStatus(d.items.length?"请试听，确认是本题的回答后再选用。":d.complete?"没有找到本题可找回的云端录音。":"已检查的近期文件中未找到本题录音。");
    }catch{setStatus("暂时无法查询，请稍后重试。")}finally{setBusy(false)}
  }
  return <details className="sp-history"><summary>查找尚未关联的云端录音</summary>
    <button type="button" className="sp-link" onClick={()=>void find()} disabled={busy||disabled}>{busy?"查找中…":"查找本题可用录音"}</button>
    {status&&<p role="status" className="sp-note">{status}</p>}
    {items.map(c=><div className="sp-hist-item" key={c.id}><small>{new Date(c.at).toLocaleString("zh-CN")} · {c.match==="question"?"题目标记匹配":"旧录音 · 归属待确认"}</small>
      <audio controls preload="none" aria-label="试听待找回录音" src={"/api/audio?id="+c.id}/>
      <button type="button" className="secondary" disabled={disabled} onClick={()=>onChoose(c)}>确认选用这段录音</button>
    </div>)}
  </details>;
}
