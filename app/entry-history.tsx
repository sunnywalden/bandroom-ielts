"use client";

import { useEffect, useState, type ReactNode } from "react";
import AttemptFeedback from "./attempt-feedback";
import { ChevronDown } from "lucide-react";
import { getExercises, getLesson, type Item } from "./curriculum";

type Entry = Record<string, string>;
type Attempt = { at: string; text: string; spoken?: boolean; audio?: string; local?: string };

function readAttempts(raw?: string): Attempt[] {
  if (!raw) return [];
  try {
    const parsed:unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(a => a && typeof a.at === "string" && typeof a.text === "string") : [];
  } catch { return []; }
}

function Section({title,date,children}:{title:string;date?:string;children:ReactNode}) {
  return <details><summary>{title}<ChevronDown size={15}/></summary>
    {date && <small className="muted">模块完成于 {date}</small>}
    {children}
  </details>;
}

function dateLabel(value:string) {
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? "" : new Intl.DateTimeFormat("zh-CN", {
    timeZone:"Asia/Shanghai",month:"numeric",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit",hour12:false,
  }).format(time);
}

function readDeviceRecording(id:string):Promise<Blob> {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("ielts-speaking-audio",1);
    request.onupgradeneeded = () => request.result.createObjectStore("clips");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db=request.result, tx=db.transaction("clips","readonly"), clip=tx.objectStore("clips").get(id);
      tx.oncomplete=()=>{db.close(); if (clip.result instanceof Blob) resolve(clip.result); else reject(new Error("missing"));};
      tx.onerror=tx.onabort=()=>{db.close(); reject(tx.error);};
    };
  });
}

function AudioEvidence({answer,filename}:{answer:Attempt;filename:string}) {
  const remote = answer.audio ? "/api/audio?id="+encodeURIComponent(answer.audio) : "";
  const [file,setFile]=useState<Blob|null>(null),[url,setUrl]=useState(""),[message,setMessage]=useState("");
  useEffect(()=>{
    if (!file) return;
    const objectUrl=URL.createObjectURL(file); setUrl(objectUrl);
    return ()=>URL.revokeObjectURL(objectUrl);
  },[file]);
  const source=remote||url, suffix=file ? file.type.includes("mp4")?".m4a":file.type.includes("webm")?".webm":file.type.includes("ogg")?".ogg":"" : "";
  if (!answer.audio && !answer.local) return null;
  return <div className="sp-play">
    {source?<><audio aria-label="回听这次口语回答" controls preload="none" src={source}
      onError={()=>setMessage("录音未能载入。请检查登录状态或在原设备打开。")}/>
      <a download={filename+suffix} href={source}>下载这段录音</a></>:
      <button type="button" className="secondary" onClick={async()=>{
        try {setFile(await readDeviceRecording(answer.local!));setMessage("");}
        catch {setMessage("请在录制这段回答时使用的浏览器里打开。");}
      }}>载入本机录音</button>}
    {message&&<small role="status">{message}</small>}
  </div>;
}

function SpeechGroup({name,items,prompt,day,date,field}:{field:string;name:string;items:Attempt[];prompt?:string;day?:number;date?:string}) {
  if (!items.length) return null;
  return <Section title={name+" · "+items.length+" 次回答"} date={date}>
    {prompt&&<p className="english-text" lang="en">{prompt}</p>}
    {items.map((a,i)=><div className="sp-hist-item" key={a.at+i}>
      <b>{i===0?"首次回答":"重答 "+i}</b>
      <small>{[dateLabel(a.at),a.audio?"已保存录音":a.local?"本机录音":a.spoken?"本人自报已开口作答":"文字草稿"].filter(Boolean).join(" · ")}</small>
      {a.text&&<p className="english-text" lang="en">{a.text}</p>}
      <AudioEvidence answer={a} filename={"Day-"+(day??"IELTS")+"-"+name+"-"+(i+1)}/><AttemptFeedback field={field} index={i}/>
    </div>)}
  </Section>;
}

function ChoiceRecord({entry,stage,index,item}:{entry:Entry;stage:"read"|"listen";index:number;item?:Item}) {
  const key=stage+"Q"+index, selected=entry[key];
  if (selected===undefined) return null;
  const n=Number(selected), letter=["A","B","C"][n], recorded=entry[key+"Correct"];
  const evidence=entry["readEvidence"+index], mode=entry["listenMode"+index];
  return <div className="sp-hist-item">
    <b>第 {index+1} 题{recorded==="1"?" · 答对":recorded==="0"?" · 需复习":""}</b>
    {item&&<p className="english-text" lang="en">{item.prompt}</p>}
    <p>你的选择：{letter || "未记录"}{item?.choices[n] ? " · "+item.choices[n] : ""}</p>
    {stage==="listen"&&mode&&<small>作答条件 · {mode}</small>}
    {stage==="read"&&evidence&&<><small>你给出的证据</small><p className="english-text" lang="en">{evidence}</p></>}
    {item&&<p className="muted">正确答案 {"ABC"[item.answer]} · {item.why}</p>}<AttemptFeedback field={key}/>
  </div>;
}

export default function EntryHistory({entry,day}:{entry:Entry;day?:number}) {
  const lesson = day===undefined?undefined:getExercises(day);
  const speaking = day===undefined?undefined:getLesson(day);
  const dates = (label:string)=>entry["_date_"+label];
  const texts = [
    ["speakingPart2Draft","口语陈述 · 未提交草稿","speakingPart2"],
    ["speakingFollowupDraft","口语追问 · 未提交草稿","speakingFollowup"],
    ["writeDraft","写作首稿 · 未提交草稿","writeOriginal"],
    ["writeRevisionDraft","写作修订 · 未提交草稿","writeRevision"],
  ];
  const writingRows = [
    [entry.writeOriginal,entry.writeCondition?.startsWith("独立")?"写作 · 独立首稿":"写作 · 首稿",entry.writeCondition],
    [entry.writeRevision,"写作 · 修订稿",entry.writeFocus?"修改说明 · "+entry.writeFocus:undefined],
  ];
  return <>
    <SpeechGroup field="speakingPart2" name="口语 Part 2" items={readAttempts(entry.speakingPart2)} prompt={speaking?.speaking} day={day} date={dates("口语表达")}/>
    <SpeechGroup field="speakingFollowup" name={day===11?"口语 Part 3":"口语追问"} items={readAttempts(entry.speakingFollowup)} prompt={speaking?.followup} day={day} date={dates("口语表达")}/>
    {entry.speakingReview&&<Section title="口语自评"><p>{entry.speakingReview}</p><AttemptFeedback field="speakingReview"/></Section>}
    {(entry.vocabRecall!==undefined || entry.vocabUse) && <Section title="词汇 · 间隔回忆与造句" date={dates("词汇与搭配")}>
      {entry.vocabRecall!==undefined&&<><strong>间隔回忆{entry.vocabRecallCorrect==="1"?" · 答对":entry.vocabRecallCorrect==="0"?" · 需复习":""}</strong>
        {lesson&&<p className="english-text" lang="en">{lesson.recall[0]}</p>}
        <p>你的答案：{entry.vocabRecall}</p>{lesson&&entry.vocabRecallCorrect==="0"&&<p>参考词：{lesson.recall[1]}</p>}</>}
      {entry.vocabUse&&<><strong>原创例句</strong><p className="english-text" lang="en">{entry.vocabUse}</p></>}
      <AttemptFeedback field="vocabRecall"/><AttemptFeedback field="vocabUse"/>
    </Section>}
    {(["listen","read"] as const).map(stage=>{
      if (entry[stage+"Q0"]===undefined && entry[stage+"Q1"]===undefined) return null;
      const listening=stage==="listen", title=listening?"听力作答":"阅读作答", source=listening?lesson?.audioTitle:lesson?.readingTitle;
      return <Section key={stage} title={title+(source?" · "+source:"")} date={dates(listening?"真实听力":"阅读与证据")}>
        {[0,1].map(index=><ChoiceRecord key={index} entry={entry} stage={stage} index={index} item={(listening?lesson?.listening:lesson?.reading)?.[index]}/>)}
      </Section>;
    })}
    {writingRows.map(([text,title,condition],index)=>text&&<Section key={title} title={title!+" · "+(text.match(/\S+/g)||[]).length+" 词"}>
      {condition&&<small className="muted">{condition}</small>}<p className="english-text" lang="en">{text}</p><AttemptFeedback field={index===0?"writeOriginal":"writeRevision"}/></Section>)}
    {texts.map(([key,title,submitted])=>entry[key]&&!entry[submitted]&&<Section key={key} title={title}><p className="english-text">{entry[key]}</p></Section>)}
    {entry.reviewMemo&&<Section title="结课手记"><p>{entry.reviewMemo}</p><AttemptFeedback field="reviewMemo"/></Section>}
  </>;
}
