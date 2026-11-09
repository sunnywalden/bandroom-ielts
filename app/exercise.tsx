"use client";
import { useRef, useState, type ReactNode } from "react";
import { useDraft } from "./use-draft";
import { getExercises, sourceUrl, type Item, type Lesson } from "./curriculum";
import ListeningPlayer from "./listening-player";
import VocabularyReview, { learnedWords } from "./vocabulary-review";
import AttemptFeedback from "./attempt-feedback";
import Pronunciation from "./pronunciation";
import "./exercise.css";

type Stage = "vocab"|"listen"|"read"|"write";
type Props = {
  day:number; account:string; stage:Stage; entry:Record<string,string>; completedDays:number[];
  save:(patch:Record<string,string>)=>Promise<boolean>; advance:()=>void;
};
const names: Record<Stage,[string,string,string]> = {
  vocab:["Word lab","词汇与表达","进入听力"],
  listen:["Listening room","C1 听力","进入阅读"],
  read:["Reading room","阅读与证据","进入写作"],
  write:["Writing desk","写作与修订","进入复盘"],
};
const modes = ["首听一遍","有额外重播","作答前参考了原文"];

function Submit({children,disabled=false,onClick}:{children:ReactNode;disabled?:boolean;onClick:()=>void}) {
  return <button className="primary" type="button" disabled={disabled} onClick={onClick}>{children}</button>;
}
function SavedText({title,text}:{title:string;text:string}) {
  return <div className="ex-saved"><span>{title}</span><p lang="en">{text}</p></div>;
}
function ResponseBox({label,value,onChange,large=false,readOnly=false}:{label:string;value:string;onChange:(s:string)=>void;large?:boolean;readOnly?:boolean}) {
  return <label className="ex-label">{label}<textarea className={large?"ex-long":""} value={value} readOnly={readOnly}
    maxLength={12000} lang="en" rows={large?10:3} onChange={e=>onChange(e.target.value)} placeholder={large?"Start writing here…":"Write your answer in English…"} /></label>;
}
function WordList({pairs}:{pairs:[string,string][]}) {
  return <dl className="ex-pairs">{pairs.map(([term,meaning])=><div key={term}><dt lang="en">{term}</dt><dd>{meaning}</dd></div>)}</dl>;
}
function Vocabulary({lesson,entry,save,advance,day,account,busy,completedDays}:Common) {
  const [recall,setRecall] = useDraft(account,"fieldnotes."+day+".vocab.recall",entry.vocabRecallDraft||"");
  const [sentence,setSentence] = useDraft(account,"fieldnotes."+day+".vocab.use",entry.vocabUseDraft||"");
  const normal = (s:string) => s.trim().toLowerCase().replace(/[.!?。]$/,"").trim();
  const result = entry.vocabRecall !== undefined;
  const pageTwo = entry.vocabBatch==="2";
  const done = entry.vocabDone==="1";
  const [reviewing,setReviewing]=useState(!result&&!pageTwo&&!done);
  const oldWords=learnedWords(day,completedDays,lesson.recall[1]);
  if(reviewing) return <>
    <p className="ex-meta">WORD REVIEW <span>·</span> 练习前热身</p>
    <h2>先回顾旧词，再开始练习</h2>
    <VocabularyReview words={oldWords}/>
    <div className="actions"><Submit disabled={busy} onClick={()=>setReviewing(false)}>{result||pageTwo||done?"返回当前练习":"我复习好了，开始练习"}</Submit></div>
    <p className="ex-hint">按自己的节奏来。浏览旧词不会提交答案或改变学习进度。</p>
  </>;
  return <>
    <div className="ex-review-toolbar"><button type="button" className="secondary" onClick={()=>setReviewing(true)}>回看旧词和含义</button><span>想不起来时，随时看一眼</span></div>
    <p className="ex-meta">ACTIVE RECALL <span>·</span> {pageTwo?"02":"01"} / 02</p>
    {pageTwo?<>
      <h2>让表达进入自己的句子</h2>
      <div className="ex-columns"><div><h3>两条短语</h3><WordList pairs={lesson.phrases}/></div><div><h3>两组固定搭配</h3><WordList pairs={lesson.collocations}/></div></div>
      <p className="ex-question" lang="en">{lesson.use}</p>
      {done?<><SavedText title="你的例句 · 已保存" text={entry.vocabUse}/><AttemptFeedback field="vocabUse"/><Submit disabled={busy} onClick={advance}>进入听力 →</Submit></>:<>
        <ResponseBox label="原创例句" value={sentence} onChange={setSentence} readOnly={busy}/>
        <Submit disabled={busy||!sentence.trim()} onClick={()=>void save({vocabUse:sentence.trim(),vocabDone:"1"})}>提交例句</Submit>
      </>}
    </>:<>
      <h2>试着回忆一个词</h2>
      <p className="ex-question" lang="en">{lesson.recall[0]}</p>
      <label className="ex-label">填写一个词<input lang="en" spellCheck={false} autoComplete="off" maxLength={100}
        value={result?entry.vocabRecall:recall} onChange={e=>setRecall(e.target.value)} readOnly={result||busy}/></label>
      {result?<div className="ex-feedback"><div className="ex-word-heading"><strong role="status">{entry.vocabRecallCorrect==="1"?"回忆正确":"再记一次"} · {lesson.recall[1]}</strong><Pronunciation word={lesson.recall[1]}/></div><p>回顾这个词，再读今天的三个例句。</p></div>:
        <Submit disabled={busy||!recall.trim()} onClick={()=>void save({vocabRecall:recall.trim(),vocabRecallCorrect:normal(recall)===normal(lesson.recall[1])?"1":"0"})}>核对回忆</Submit>}
      {result&&<><AttemptFeedback field="vocabRecall"/><div className="ex-stack">{lesson.words.map(([term,meaning,example])=><div className="ex-word" key={term}><div className="ex-word-heading"><b lang="en">{term}</b><Pronunciation word={term}/><span className="ex-word-meaning">{meaning}</span></div><p lang="en">{example}</p></div>)}</div>
        <Submit disabled={busy} onClick={()=>void save({vocabBatch:"2"})}>继续练习短语与搭配 →</Submit></>}
    </>}
  </>;
}
type Common = Omit<Props,"stage"> & {lesson:Lesson;busy:boolean};
function Question({item,index,selected,onSelect,locked}:{item:Item;index:number;selected:string;onSelect:(s:string)=>void;locked:boolean}) {
  return <fieldset className="ex-item"><legend lang="en">{item.prompt}</legend>
    {item.choices.map((v,i)=><label key={v} className={"ex-option"+(selected===String(i)?" ex-selected":"")}>
      <input type="radio" name={"ex-choice-"+index} checked={selected===String(i)} disabled={locked} onChange={()=>onSelect(String(i))}/>
      <span className="ex-letter" aria-hidden="true">{"ABC"[i]}</span><span lang="en">{v}</span>
    </label>)}
  </fieldset>;
}
function ChoicePractice({lesson,entry,save,advance,day,account,busy,stage}:{stage:"listen"|"read"}&Common) {
  const listening=stage==="listen", index=entry[stage+"Batch"]==="2"?1:0;
  const quiz= listening?lesson.listening:lesson.reading;
  const item=quiz[index], key=stage+"Q"+index, submitted=entry[key]!==undefined;
  const [selection,setSelection]=useDraft(account,"fieldnotes."+day+"."+key+"Choice","");
  const [condition,setCondition]=useDraft(account,"fieldnotes."+day+"."+key+"Conditions","");
  const [evidence,setEvidence]=useDraft(account,"fieldnotes."+day+"."+key+"Evidence","");
  const selected=submitted?entry[key]:selection;
  const mode=submitted?entry[stage+"Mode"+index]:condition;
  const valid=["0","1","2"].includes(selected) && (listening?modes.includes(mode):Boolean(evidence.trim()));
  function commit() {
    const patch:Record<string,string> = {[key]:selected,[key+"Correct"]:Number(selected)===item.answer?"1":"0"};
    if (listening) patch[stage+"Mode"+index]=mode; else patch[stage+"Evidence"+index]=evidence.trim();
    if (index===1) patch[stage+"Done"]="1";
    void save(patch);
  }
  return <>
    <p className="ex-meta">{listening?"BRITISH COUNCIL · C1":"ORIGINAL PASSAGE"} <span>·</span> {index===0?"01":"02"} / 02</p>
    <h2 lang="en">{listening?lesson.audioTitle:lesson.readingTitle}</h2>
    {listening?<ListeningPlayer slug={lesson.slug} source={sourceUrl(lesson)}/>:<blockquote className="ex-passage" lang="en">{lesson.passage}</blockquote>}
    <Question item={item} index={index} selected={selected} onSelect={setSelection} locked={submitted||busy}/>
    {listening?<label className="ex-label">本题作答时的播放条件<select value={mode||""} disabled={submitted||busy} onChange={e=>setCondition(e.target.value)}>
      <option value="">选择实际情况</option>{modes.map(m=><option key={m}>{m}</option>)}</select></label>:
      submitted?<SavedText title="你选择的证据" text={entry[stage+"Evidence"+index]}/>:<ResponseBox label="用一句英语说明哪条证据支持你的选择" value={evidence} onChange={setEvidence} readOnly={busy}/>}
    {submitted?<><div className="ex-feedback" role="status"><strong>{selected===String(item.answer)?"选择正确":"再看一处证据"} · 答案 {"ABC"[item.answer]}</strong><p>{item.why}</p></div>
      <AttemptFeedback field={key}/>
      {index===0?<Submit disabled={busy} onClick={()=>void save({[stage+"Batch"]:"2"})}>继续下一题 →</Submit>:
        <><p className="ex-result">本组选择题 {Number(entry[stage+"Q0Correct"]==="1")+Number(entry[stage+"Q1Correct"]==="1")} / 2 · 专项练习</p>
          <Submit disabled={busy} onClick={advance}>{names[stage][2]} →</Submit></>}
    </>:<Submit disabled={busy||!valid} onClick={commit}>提交并核对依据</Submit>}
  </>;
}
const count = (s:string) => (s.match(/\S+/g)||[]).length;
function Writing({lesson,entry,save,advance,day,account,busy}:Common) {
  const original=entry.writeOriginal, revised=entry.writeRevision, isRevision=original!==undefined;
  const [first,setFirst]=useDraft(account,"fieldnotes."+day+".write.original",entry.writeDraft||"");
  const [second,setSecond]=useDraft(account,"fieldnotes."+day+".write.revision",entry.writeRevisionDraft||original||"");
  const [condition,setCondition]=useDraft(account,"fieldnotes."+day+".write.condition","独立 · 未计时");
  const [shortOk,setShortOk]=useState(false);
  const [submitting,setSubmitting]=useState(false);
  const submittingRef=useRef(false);
  const [focus,setFocus]=useDraft(account,"fieldnotes."+day+".write.focus","");
  const min=lesson.fullEssay?250:90;
  const current=isRevision?second:first;
  const under=count(current)<min;
  const changed=second.trim()!==(original||"").trim();
  const ready=current.trim().length>0 && (!under||shortOk) && (!isRevision||changed&&Boolean(focus.trim()));
  const draftKey=isRevision?"writeRevisionDraft":"writeDraft";
  async function submit() {
    if (!ready||busy||submittingRef.current) return;
    submittingRef.current=true;setSubmitting(true);
    try {
      const ok=await save(isRevision?{writeRevision:second.trim(),writeFocus:focus.trim(),writeDone:"1"}:
        {writeOriginal:first.trim(),writeCondition:condition});
      if(ok)setShortOk(false);
    }finally{submittingRef.current=false;setSubmitting(false);}
  }
  return <>
    <p className="ex-meta">{lesson.fullEssay?"TASK 2 · FULL ESSAY":"WRITING WORKSHOP"} <span>·</span> {isRevision?"REVISION":"FIRST DRAFT"}</p>
    <h2>{revised!==undefined?"对照两次表达":isRevision?"带着一个目标修订":"完成独立首稿"}</h2>
    <p className="ex-question" lang="en">{lesson.writing}</p>
    {!lesson.fullEssay&&<details className="ex-details"><summary>查看写作依据 · {lesson.readingTitle}</summary><p lang="en">{lesson.passage}</p></details>}
    {isRevision&&<><SavedText title={"独立首稿 · "+count(original)+" 词 · "+(entry.writeCondition||"条件未记录")} text={original}/><AttemptFeedback field="writeOriginal"/></>}
    {revised!==undefined?<><SavedText title={"修订稿 · "+count(revised)+" 词"} text={revised}/><AttemptFeedback field="writeRevision"/><div className="ex-feedback"><strong>本次修改意图</strong><p>{entry.writeFocus}</p></div><Submit disabled={busy} onClick={advance}>进入复盘 →</Submit></>:<>
      {isRevision?<div className="ex-feedback"><strong>课程修订提示（非本篇批改）</strong><p>{lesson.edit}</p></div>:
        <p className="ex-hint">{lesson.fullEssay?"本次完整 Task 2 建议独立限时 40 分钟。请按实际情况选择作答条件。":"先用自己的语言写首稿。提交后可查看定向修订提示。"}</p>}
      <ResponseBox label={isRevision?"修订稿":"首稿"} value={current} onChange={isRevision?setSecond:setFirst} large readOnly={submitting}/>
      <div className="ex-count">{count(current)} 词 · {lesson.fullEssay?"目标 ≥ 250 词":"建议 90–130 词"}</div>
      {isRevision?<label className="ex-label">我改了哪一处，为什么？<input value={focus} readOnly={submitting} onChange={e=>setFocus(e.target.value)} maxLength={400} placeholder="中文或英文均可"/></label>:
        <label className="ex-label">实际写作条件<select value={condition} disabled={submitting} onChange={e=>setCondition(e.target.value)}>
          <option>独立 · 未计时</option><option>独立 · 我已自行计时</option><option>有参考或获得提示</option></select></label>}
      {under&&current.trim()&&<label className="ex-check"><input type="checkbox" disabled={submitting} checked={shortOk} onChange={e=>setShortOk(e.target.checked)}/>按当前字数提交，并保留篇幅不足的记录</label>}
      <div className="actions"><Submit disabled={busy||!ready} onClick={submit}>{isRevision?"提交修订稿":"提交并锁定首稿"}</Submit>
        <button type="button" className="secondary" disabled={busy||!current.trim()} onClick={()=>void save({[draftKey]:current})}>保存草稿</button></div>
      <p className="ex-hint">提交后可在当前 Work 会话请教练批改，评语将自动显示在对应稿件旁。你可以先看反馈，再动笔修订。</p>
    </>}
  </>;
}
export default function Exercise(props: Props) {
  const [busy,setBusy]=useState(false), [message,setMessage]=useState("");
  const saving=useRef(false);
  const {stage,entry}=props, lesson=getExercises(props.day);
  if (!lesson) return <section className="card ex-card">这一天的训练内容待编排。</section>;
  async function persist(patch:Record<string,string>) {
    if (saving.current) return false;
    saving.current=true;setBusy(true); setMessage("");
    try {
      const ok=await props.save(patch);
      setMessage(ok?"已保存":"保存未成功。请保留当前页面并重试。");
      return ok;
    } catch { setMessage("保存未成功。请保留当前页面并重试。"); return false; }
    finally { saving.current=false;setBusy(false); }
  }
  const common={...props,save:persist,lesson,busy};
  return <section className="card ex-card" aria-label={names[stage][1]}>
    {stage==="vocab"?<Vocabulary {...common}/>:stage==="write"?<Writing {...common}/>:<ChoicePractice key={stage+entry[stage+"Batch"]} {...common} stage={stage}/>}
    <small className="ex-status" role="status">{busy?"保存中…":message}</small>
  </section>;
}
