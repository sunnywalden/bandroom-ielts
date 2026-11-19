"use client";
import { useRef, useState, type FormEvent } from "react";
import { dayStamp, labels, oldResults, sampleEpoch, sampleHistory, type Ledger, type Stage } from "./ledger";
import { getExercises } from "./curriculum";
import { periods } from "./period";
import "./reports.css";
import {targets as goals} from "./goals";
import {newClientId} from "./client-id";

const skills = ["Listening","Reading","Writing","Speaking"] as const;
type Skill = typeof skills[number];

type Feedback={day:number;stage:string;feedback:string;evidence:string;attempt:string;createdAt:string};
type Test={id:string;skill:Skill;date:string;exam:string;source:string;raw?:number;band?:number;rater:string;audio?:string};
type Line={date:string;day?:number;kind:Skill|"词汇"|"综合";text:string};
type Digest={from:string;to:string;lines:Line[];tests:Test[];recall:[number,number];applications:number;priorities:string[];comments:Feedback[]};
type Stored={created:string;updated:string;week:Digest;cycle?:Digest};
export type ReportState=Ledger&{reports?:Record<string,unknown>;fullTests?:Test[]};
type State=ReportState;
type Props={account:string;s:State;pending:boolean;feedback:Feedback[];persist:(make:(prev:State)=>State)=>Promise<boolean>};
const historyDates:Record<number,string>=sampleHistory;
const kinds:Record<string,Skill>={listen:"Listening",read:"Reading",write:"Writing",speak:"Speaking"};
const toDate=(s:string)=>s.length===10?s:Number.isFinite(Date.parse(s))?dayStamp(new Date(s)):"";
const inRange=(d:string,from:string,to:string)=>Boolean(d)&&d>=from&&d<=to;
const conditions:Record<Skill,string>={Listening:"独立完成完整 40 题，录音只播一遍",Reading:"连续 60 分钟，独立完成完整 40 题",Writing:"连续 60 分钟，独立完成 Task 1 和 Task 2",Speaking:"一次连续完成 Part 1–3，实际作答 11–14 分钟，保留原始音频"};
function makeDigest(s:State,comments:Feedback[],from:string,to:string):Digest {
  const lines:Line[]=[],tests=(s.fullTests||[]).filter(t=>inRange(t.date,from,to)).sort((a,b)=>a.date.localeCompare(b.date));
  const inside=(d:string)=>inRange(d,from,to);
  const recent=comments.filter(c=>inside(toDate(c.createdAt))).sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
  const recall:[number,number]=[0,0]; let applications=0;
  let listenMiss=false,readMiss=false,writingPresent=false,recallMiss=false;
  for(const [n,date] of Object.entries(historyDates)){
    if(!inside(date))continue;
    const day=Number(n);
    const rows=oldResults[day]||[];
    for(const [label,result] of rows){
      const kind=label.includes("听力")?"Listening":label.includes("阅读")?"Reading":label.includes("写作")?"Writing":label.includes("词汇")?"词汇":"综合";
      lines.push({date,day,kind,text:label+" "+result+" · 示例记录"});
      if(kind==="Writing") writingPresent=true;
      const [score,total]=result.split("/").map(Number);
      if(kind==="Listening"&&score<total)listenMiss=true;
      if(kind==="Reading"&&score<total)readMiss=true;
    }
    if(day===10||day===11) {
      // Both prompts explicitly requested the Day 9 adjective.
      recall[1]++;
      if(day===11)recall[0]++;else recallMiss=true;
      lines.push({date,day,kind:"词汇",text:day===11?"间隔回忆 viable 正确 · Day 9 学过；Day 10 曾答 substantiate":"间隔回忆 viable 未命中 · 写成了动词 substantiate"});
    }
  }
  for(const [d,e] of Object.entries(s.entries)){
    const day=Number(d), started=s.started[d];
    const add=(stage:Stage,text:string,precise?:string)=>{
      const date=precise||e["_date_"+labels[stage]]||started;
      if(!date||!inside(date))return false;
      lines.push({day,date,kind:kinds[stage]||"词汇",text:text+(!precise?(e["_date_"+labels[stage]]?" · 以模块提交日期归档":" · 仅有课程开始日期"):"")});
      return true;
    };
    if(e.vocabRecall!==undefined&&add("vocab",`间隔回忆 ${getExercises(day)?.recall[1]||""} · ${e.vocabRecallCorrect==="1"?"正确":"未命中"}`,e._date_vocabRecall)){
      recall[1]++;if(e.vocabRecallCorrect==="1")recall[0]++;else recallMiss=true;
    }
    if(e.vocabUse&&add("vocab","已提交原创用句 · 搭配准确性待核对",e._date_vocabUse))applications++;
    for(const st of ["listen","read"] as const){
      for(const i of [0,1]) {
        if(e[st+"Q"+i]===undefined)continue;
        const correct=e[st+"Q"+i+"Correct"]==="1";
        if(add(st,`第 ${i+1} 题 · ${correct?"正确":"未命中"} · ${st==="listen"?(e[st+"Mode"+i]||"播放条件未记录"):"含自述文本依据"}`,e["_date_"+st+"Q"+i])&&!correct) {
          if(st==="listen")listenMiss=true;else readMiss=true;
        }
      }
    }
    if(e.writeOriginal&&add("write",`首稿 ${e.writeOriginal.trim().split(/\s+/).length} 词 · ${e.writeCondition||"条件未记录"}`,e._date_writeOriginal))writingPresent=true;
    if(e.writeRevision)add("write",`修订稿 ${e.writeRevision.trim().split(/\s+/).length} 词 · ${e.writeFocus||"已提交"}`,e._date_writeRevision);
    for(const k of ["speakingPart2","speakingFollowup"]){
      let a:Array<{at:string;audio?:string;local?:string;spoken?:boolean}>=[];
      try {const v=JSON.parse(e[k]||"[]");if(Array.isArray(v))a=v;}catch{/* Incomplete older records have no attempt date. */}
      a.forEach((x,i)=>{if(x?.spoken)add("speak",`${k==="speakingPart2"?"Part 2":"追问"} · 第 ${i+1} 次 · ${x.audio?"有录音":x.local?"设备本地录音":"自报口练"}`,toDate(x.at||""));});
    }
  }
  const priorities:string[]=[];
  if(writingPresent) priorities.push("用新材料独立写一段。标出主张、依据和限定条件，再检查每个谓语。保留首稿与修订稿作下次对照。");
  if(recallMiss)priorities.push("隔至少一个学习日再测试本期未命中的词。先回忆词形，再换一个工作场景独立造句。");
  if(priorities.length<2&&listenMiss)priorities.push("选择一段新录音，首听后分别记下说话人的决定和限制条件，再用原文定位漏听处。");
  if(priorities.length<2&&readMiss)priorities.push("给下一篇阅读的每个推断标记原句，单独核对样本范围与因果关系。");
  if(priorities.length===0&&tests.length){const t=tests.find(t=>t.band!==undefined&&t.band<goals[t.skill]);if(t)priorities.push(`下一次用不同材料复测 ${t.skill}，沿用本次条件，检查得分差距是否复现。`);}
  if(priorities.length===0)priorities.push("下一次独立完成一项完整限时测评，保存材料名、日期和结果，作为后续比较的起点。");
  return {from,to,lines:lines.sort((a,b)=>a.date.localeCompare(b.date)),tests,recall,applications,priorities,comments:recent};
}
const testDescription=(t:Test)=>[t.date,t.exam==="通用"?"":t.exam,t.source,t.raw!==undefined?t.raw+"/40":"",t.band!==undefined?"Band "+t.band.toFixed(1):"",t.rater].filter(Boolean).join(" · ");
function TestForm({s,persist,pending,account}:{account:string;s:State;persist:Props["persist"];pending:boolean}) {
  const [skill,setSkill]=useState<Skill>("Listening"),[date,setDate]=useState(dayStamp()),[source,setSource]=useState(""),[rater,setRater]=useState(""),[raw,setRaw]=useState(""),[band,setBand]=useState(""),[proof,setProof]=useState(false),[file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[info,setInfo]=useState("");
  const cachedAudio=useRef<{file:File;id:string}|null>(null);
  const exact=skill==="Listening"||skill==="Reading", specific=skill==="Reading"||skill==="Writing";
  const needsType=specific&&s.exam==="未选择";
  const okay=proof&&source.trim()&&rater.trim()&&date>=sampleEpoch&&date<=dayStamp()&&!needsType&&(!exact||raw!==""&&Number.isInteger(Number(raw))&&+raw>=0&&+raw<=40)&&(exact||band!=="")&&(band===""||+band>=0&&+band<=9&&Number.isInteger(+band*2))&&(skill!=="Speaking"||file);
  async function submit(ev:FormEvent){
    ev.preventDefault();if(!okay||busy||pending)return;setBusy(true);setInfo("");
    try{
      let audio:string|undefined;
      const exam=specific?s.exam:"通用";
      if((s.fullTests||[]).some(t=>t.skill===skill&&t.date===date&&t.exam===exam&&t.source.trim().toLowerCase()===source.trim().toLowerCase())){setInfo("这项测评已录入。请核对下方的完整测评清单。");return;}
      if(skill==="Speaking"&&file){
        if(file.size>12*1024*1024){setInfo("此录音大于 12 MB，请导出较小的原声 M4A、OGG 或 WebM 文件后再试。");return;}
        if(cachedAudio.current?.file===file)audio=cachedAudio.current.id;
        else {
          const mime=file.type==="audio/x-m4a"||/\.m4a$/i.test(file.name)?"audio/mp4":file.type;
          const resp=await fetch("/api/audio",{method:"POST",headers:{"Content-Type":mime,"X-Bandroom-Account":account,"X-Bandroom-Purpose":"assessment"},body:file});
          if(resp.status===401||resp.status===428){setInfo("登录状态已变化。请重新登录原账号后再上传。");return;}
          if(!resp.ok){setInfo("录音上传失败。请确认文件格式与网络后重试。");return;}
          const result=await resp.json() as {id?:string};if(!result.id)throw Error();audio=result.id;cachedAudio.current={file,id:result.id};
        }
      }
      const t:Test={id:newClientId(),skill,date,source:source.trim(),exam,rater:rater.trim(),...(exact?{raw:+raw}:{}),...(band!==""?{band:+band}:{}),...(audio?{audio}:{})};
      if(await persist(prev=>({...prev,fullTests:[...(prev.fullTests||[]),t]}))){setInfo("已保存。对应窗口到期后可生成或更新回顾。");setProof(false);setSource("");setRater("");setRaw("");setBand("");setFile(null);cachedAudio.current=null;}
      else setInfo("测评记录未保存，请在连接恢复后重试。");
    }catch{setInfo("保存未成功，请保留输入并重试。");}finally{setBusy(false);}
  }
  return <details className="card pad rp-form"><summary><span>完整独立测评</span><small>录入已有结果 · {(s.fullTests||[]).length} 次</small></summary>
    <form onSubmit={submit}><p className="muted">只登记实际做完的整科测评。分数按你提供的成绩单、答案换算表或评阅意见记录。</p>
      <div className="rp-fields"><label>科目<select value={skill} onChange={e=>{setSkill(e.target.value as Skill);setRaw("");setBand("");setProof(false);setFile(null);setInfo("");}}>{skills.map(k=><option key={k}>{k}</option>)}</select></label><label>实际测评日期<input type="date" value={date} min={sampleEpoch} max={dayStamp()} onChange={e=>setDate(e.target.value)} required/></label></div>
      {specific&&<p className="rp-aside">{needsType?"请先到训练设置选择 Academic 或 General Training，再登记这一科。":"考试类型 · "+s.exam}</p>}
      <label>材料或试卷名称<input value={source} maxLength={160} onChange={e=>setSource(e.target.value)} placeholder="例如 Cambridge IELTS · 书号与 Test 编号" required/></label>
      <div className="rp-fields">{exact&&<label>正确题数 / 40<input type="number" min="0" max="40" step="1" value={raw} onChange={e=>setRaw(e.target.value)} required/></label>}
      <label>{exact?"换算 Band（有对应依据时选填）":"评阅 Band"}<select value={band} onChange={e=>setBand(e.target.value)} required={!exact}><option value="">{exact?"尚未换算":"选择实际分数"}</option>{Array.from({length:19},(_,i)=><option key={i} value={String(i*.5)}>{(i*.5).toFixed(1)}</option>)}</select></label></div>
      <label>{exact?"答案或换算依据":"评阅者及评阅依据"}<input value={rater} maxLength={200} onChange={e=>setRater(e.target.value)} placeholder={exact?"例如该套试卷答案及配套换算表":"例如老师按四项评分标准评阅；口语须基于该录音"} required/></label>
      {skill==="Speaking"&&<label>完整作答录音 · 上限 12 MB<input type="file" accept="audio/webm,audio/mp4,audio/ogg,audio/wav,.m4a" onChange={e=>{setFile(e.target.files?.[0]||null);cachedAudio.current=null;}} required/></label>}
      <label className="rp-attest"><input type="checkbox" checked={proof} onChange={e=>setProof(e.target.checked)}/>我已{conditions[skill]}。</label>
      <button type="submit" className="primary" disabled={!okay||busy||pending}>{busy?"正在保存…":"保存本次测评"}</button><p role="status" className="muted">{info}</p>
    </form>{s.fullTests?.length?<details><summary>查看已有测评</summary>{[...s.fullTests].reverse().map(t=><div className="rp-test" key={t.id}><b>{t.skill} · 自报测评</b><p>{testDescription(t)}</p>{t.audio&&<audio controls preload="none" src={"/api/audio?id="+encodeURIComponent(t.audio)}/>}</div>)}</details>:null}</details>;
}
function DigestView({digest,showActions=true}:{digest:Digest;showActions?:boolean}) {
  const d=digest;
  return <div className="rp-digest">
    <div className="rp-grid">{skills.map(skill=>{
      const lines=d.lines.filter(x=>x.kind===skill),samples=d.tests.filter(t=>t.skill===skill),latest=samples[samples.length-1];
      return <article key={skill}><div><span>{skill}</span><b>{goals[skill].toFixed(1)}</b></div>
        <small>{latest?(latest.band===undefined?"已有整科原始分":latest.band>=goals[skill]?"单次自报达标":"最近自报低于目标"):"整科目标待评估"}</small>
        <p>{latest?testDescription(latest):lines.length?lines.length+" 条专项证据 · 最近 "+lines[lines.length-1].text:"此窗口缺少带日期的作答样本。"}</p>
      </article>})}</div>
    <h3>词汇迁移</h3><p>可核对的间隔回忆 <b>{d.recall[0]} / {d.recall[1]}</b>。页面提交的原创用句 <b>{d.applications}</b> 条。新语境用词的准确性以具体评语为准。即时回忆未逐题拆分的历史总分，保留在下方原课记录中。</p>
    <details><summary>查看带日期的练习与教练反馈（{d.lines.length+d.comments.length}）</summary>
      {d.lines.map((l,i)=><p className="rp-line" key={i}><small>{l.date} · Day {l.day}</small>{l.text}</p>)}
      {d.comments.map((c,i)=><div className="rp-line" key={c.createdAt+i}><small>{toDate(c.createdAt)} · Day {c.day} · {labels[c.stage as Stage]||c.stage} · 教练复核</small><p>{c.feedback}</p><p className="muted">{c.attempt} · {c.evidence}</p></div>)}
      {!d.lines.length&&!d.comments.length&&<p>这个窗口还没有练习记录。</p>}</details>
    {d.tests.length>0&&<details><summary>查看本期全部完整测评（{d.tests.length}）</summary>{d.tests.map(t=><p className="rp-line" key={t.id}><small>{t.skill} · 自报结果</small>{testDescription(t)}</p>)}</details>}
    {showActions&&<><h3>下次验证</h3><ol>{d.priorities.map(p=><li key={p}>{p}</li>)}</ol></>}
  </div>;
}
export default function Reports({s,persist,pending,feedback,account}:Props){
  const all=periods(),[id,setId]=useState(all[0]?.id||""),[message,setMessage]=useState("");
  const p=all.find(k=>k.id===id)??all[0], prior=p?s.reports?.[p.id] as Partial<Stored>|undefined:undefined;
  const week=p?makeDigest(s,feedback,p.from,p.to):undefined,cycle=p?.cycleFrom?makeDigest(s,feedback,p.cycleFrom,p.to):undefined;
  const fresh=Boolean(week&&prior?.week&&JSON.stringify([week,cycle])===JSON.stringify([prior.week,prior.cycle]));
  async function capture(){if(!p||!week||fresh)return;const at=new Date().toISOString();
    const ok=await persist(prev=>({...prev,reports:{...prev.reports,[p.id]:{created:prior?.created||at,updated:at,week,...(cycle?{cycle}:{})}}}));
    setMessage(ok?"回顾已保存。":"回顾未能保存，请重试。");}
  return <div className="rp-wrap"><section className="card pad"><div className="eyebrow">Calendar review</div><h2>周评与四周评估</h2>
    {p?<><label>已结束的观察窗口<select value={p.id} onChange={e=>{setId(e.target.value);setMessage("");}}>{all.map(a=><option key={a.id} value={a.id}>{a.label} · {a.from} 至 {a.to}</option>)}</select></label>
      <p className="muted">{p.cycleFrom?`本次同时回顾 ${p.cycleFrom} 至 ${p.to} 的四周。周评与四周评估共用一个归档。`:"按北京时间划分自然周。生成后可查看该周的四科证据与下次验证重点。"}</p>
      <div className="actions"><button className={prior?.week?"secondary":"primary"} disabled={pending||fresh} onClick={()=>void capture()}>{!prior?.week?"生成本期回顾":fresh?"已包含最新证据":"用新证据更新本期回顾"}</button>{prior?.created&&<small>首次生成 {toDate(prior.created)} · 最近更新 {toDate(prior.updated||prior.created)}</small>}</div>
      <p className="muted" role="status">{message}</p>
      {prior?.week?<><h3>{p.cycleFrom?"本周专项表现":"本周四科表现"}</h3><DigestView digest={prior.week} showActions={!p.cycleFrom}/>{prior.cycle&&<><h3>四周合评</h3><DigestView digest={prior.cycle}/></>}</>:<div className="rp-target">{skills.map(k=><span key={k}>{k}<b>{goals[k].toFixed(1)}</b></span>)}</div>}
    </>:<p>第一个观察窗口于 2026-11-04 结束，次日起可生成。</p>}</section><TestForm account={account} s={s} persist={persist} pending={pending}/></div>;
}
