'use client'
import {useEffect,useRef,useState} from 'react'
import {Activity,ArrowLeft,ArrowRight,ArrowUpRight,AudioLines,BookMarked,BookOpen,CalendarDays,Check,CheckCheck,ChevronDown,ChevronRight,Clock3,Cloud,CloudOff,Disc3,FileText,Flag,Headphones,Layers3,LayoutDashboard,ListChecks,LockKeyhole,Mic,NotebookPen,PenLine,RefreshCw,SlidersHorizontal,Target} from 'lucide-react'
import {FieldArt,Mark} from './art'
import {brief,budgets,dayStamp,english,initial,labels,notes,oldOrder,oldResults,part3,stages,writings,type Entry,type Ledger,type Stage} from './ledger'
import {getExercises,getLesson,hasLesson,registerExtraLessons,type Lesson} from './curriculum'
import Speaking from './speaking'
import Exercise from './exercise'
import EntryHistory from './entry-history'
import ReviewRequest from './review-request'
import Reports, { type ReportState } from './reports'

const tabs=[['home','今日练习',LayoutDashboard],['history','学习档案',BookOpen],['notes','错题手记',NotebookPen],['report','阶段评估',Activity]] as const
type Tab=typeof tabs[number][0]|'lesson'|'settings'
const icons={speak:Mic,vocab:BookMarked,listen:Headphones,read:FileText,write:PenLine,review:ListChecks}
const titles:Record<Tab,[string,string,string]>={home:['Study desk','今日练习','从上次停下的地方继续，每次专注一道题。'],lesson:['Practice room','练习室',''],history:['Learning archive','学习档案','查阅每一课的提交记录、独立首稿与修订。'],notes:['Correction notebook','错题手记','用一个新句子，检验容易反复出现的表达。'],report:['Progress review','阶段评估','按实际学习日期回看证据，每七天一个观察窗口。'],settings:['Study preferences','训练设置','确认考试类型，查看课程的预算和评估规则。']}
type Feedback={id:string;day:number;stage:string;evidence:string;attempt:string;feedback:string;createdAt:string}
type Snapshot=ReportState
function Emblem({small=false}:{small?:boolean}){return <div className={'emblem '+(small?'small':'')}><Mark/></div>}
function pill(txt:string,active=false){return <span className={'pill '+(active?'live':'')}>{active&&<i/>}{txt}</span>}
function dayName(s:Ledger){return 'Day '+String(s.day).padStart(2,'0')}
function Goals(){return <div className="target-grid">{[['Listening','8.5'],['Reading','8.5'],['Writing','7.5'],['Speaking','7.0']].map(([a,b])=><div key={a}><span>{a}</span><strong>{b}</strong></div>)}</div>}
export default function Studio(){
 const [s,setS]=useState<Snapshot>(initial); const live=useRef<Snapshot>(s),rev=useRef(0),busy=useRef(false)
 const [tab,setTab]=useState<Tab>('home'),[sync,setSync]=useState<'load'|'ok'|'write'|'fail'|'conflict'|'auth'>('load'),[error,setError]=useState(''),[pending,setPending]=useState(false)
 const [historyDay,setHistoryDay]=useState(11),[feedback,setFeedback]=useState<Feedback[]>([]),[coachError,setCoachError]=useState(false)
 const [note,setNote]=useState(0),[reply,setReply]=useState(''),[result,setResult]=useState<boolean|null>(null),[check,setCheck]=useState(false),[memo,setMemo]=useState(''),[showPacket,setShowPacket]=useState(false)
 const navigate=(page:Tab)=>{setTab(page);setCheck(false);setShowPacket(false);if(typeof window!=='undefined')window.scrollTo({top:0,behavior:'instant'})}
 async function refreshCoach(){try{const res=await fetch('/api/coach',{cache:'no-store'});if(!res.ok)throw Error();const c=await res.json() as {extras:Record<string,Lesson>;feedback:Feedback[]};registerExtraLessons(c.extras||{});setFeedback(c.feedback||[]);setCoachError(false)}catch{setCoachError(true)}}
 async function refresh(){
 if(busy.current)return
 busy.current=true;setSync('load');setError('')
 try{const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok){setSync(res.status===401?'auth':'fail');return}
 const data=await res.json() as {revision:number;state:Snapshot|null};if(data.state&&data.state.version!==1)throw Error()
 const next:Snapshot=data.state??initial();live.current=next;rev.current=data.revision;setS(next);setSync('ok');setMemo(next.entries[next.day]?.reviewMemo||'');await refreshCoach()
 }catch{setSync('fail')}finally{busy.current=false}
 }
 useEffect(()=>{void refresh()},[])
 async function persist(make:(prev:Snapshot)=>Snapshot){
 if(busy.current||sync==='conflict'||sync==='auth'||sync==='load')return false
 busy.current=true;setPending(true);setError('');setSync('write')
 const next=make(live.current)
 try {const r=await fetch('/api/state',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({revision:rev.current,state:next})})
 if(!r.ok){if(r.status===409){setSync('conflict');setError('另一处已保存新进度。请先复制未提交的文字，再读取最新记录。')}else{setSync(r.status===401?'auth':'fail');setError('这次保存没有成功，当前输入仍在页面中。')}return false}
 const data=await r.json() as {revision:number};live.current=next;rev.current=data.revision;setS(next);setSync('ok');return true
 }catch{setSync('fail');setError('连接中断，请保留当前页面并重新提交。');return false}finally{busy.current=false;setPending(false)}
 }
 const entry=s.entries[s.day]||{}, topic=getLesson(s.day),stage=s.stage,order=s.day===11?oldOrder:stages
 const mins=budgets(s.day,s.started[s.day]||dayStamp(),getExercises(s.day)?.fullEssay), cap=Object.values(mins).reduce((a,b)=>a+b,0)
 const stageDone=(st:Stage,e:Entry=entry)=>s.finished||(s.day===11&&['vocab','listen','read','write'].includes(st))||(st==='speak'?e.speakingComplete==='yes':e[st+'Done']==='1')
 const save=(patch:Entry)=>persist(prev=>{const d=prev.day,e=prev.entries[d]||{},p={...patch};for(const k of ['vocabRecall','vocabUse','listenQ0','listenQ1','readQ0','readQ1','writeOriginal','writeRevision'])if(p[k]!==undefined&&e[k]===undefined)p['_date_'+k]=dayStamp();const doneKey=stage==='speak'?'speakingComplete':stage+'Done';if(p[doneKey]&&!e[doneKey])p['_date_'+labels[stage]]=dayStamp();return {...prev,entries:{...prev.entries,[d]:{...e,...p}}}})
 const advance=async()=>{const prev=live.current, current=prev.entries[prev.day]||{};if(!stageDone(prev.stage,current))return;const to=order[order.indexOf(prev.stage)+1];if(to)await persist(p=>({...p,stage:to}))}
 async function start(){const next=s.day+1;if(!s.finished||next>62||!hasLesson(next))return
 if(await persist(p=>({...p,day:next,stage:'speak',finished:false,started:{...p.started,[next]:dayStamp()}}))){setMemo('');navigate('lesson')}}
 async function finish(){if(!check||s.stage!=='review'||!order.filter(st=>st!=='review').every(x=>stageDone(x)))return
 if(await persist(p=>({...p,finished:true,completed:[...new Set([...p.completed,p.day])],checked:{...p.checked,[p.day]:dayStamp()},entries:{...p.entries,[p.day]:{...p.entries[p.day],reviewMemo:memo.trim()}}}))){navigate('home')}}
 function archive(d:number){setHistoryDay(d);navigate('history')}
 const done=s.completed.length, menu=tabs.find(x=>x[0]===tab),tabLabel=menu?.[1]||titles[tab][1], StageIcon=icons[stage]
 const statuses={ok:'进度已同步',write:'正在保存',load:'读取进度',conflict:'发现新版进度',fail:'连接待恢复',auth:'需要登录'}
 const historyFeedback=feedback.filter(row=>row.day===historyDay)
 const nextReady=hasLesson(s.day+1)
 return <div className="app-shell">
 <aside className="side"><button className="brand" onClick={()=>navigate('home')}><Emblem/><span><b>Bandroom</b><small>IELTS STUDY STUDIO</small></span></button>
 <div className="nav-label">WORKSPACE</div><nav>{tabs.map(([id,title,Icon])=><button key={id} className={'nav-item '+((tab===id||(tab==='lesson'&&id==='home'))?'selected':'')} onClick={()=>navigate(id)}><Icon size={18}/>{title}</button>)}</nav>
 <div className="sidebar-bottom"><div className="sidebar-target"><span>MY PROGRAMME</span><b>IELTS <em>8.0</em></b><small>62 课时学习计划</small></div><button className={'nav-item '+(tab==='settings'?'selected':'')} onClick={()=>navigate('settings')}><SlidersHorizontal size={17}/>训练设置</button><div className="profile"><span>HZ</span><div><b>Henry</b><small>个人学习空间</small></div></div></div>
 </aside>
 <div className="main-column"><header className="topbar"><span className="crumb"><span>学习工作台</span><ChevronRight size={13}/><b>{tabLabel}</b></span><span className="mobile-brand"><Emblem small/>Bandroom</span><button className="sync" onClick={()=>void refresh()} disabled={pending||sync==='load'} title="重新读取进度与教练反馈">{sync==='ok'?<Cloud size={15}/>:<RefreshCw size={14}/>} {statuses[sync]}</button></header>
 <nav className="mobile-nav">{[...tabs,['settings','设置',SlidersHorizontal] as const].map(([id,title,I])=><button key={id} className={(tab===id||(id==='home'&&tab==='lesson'))?'selected':''} onClick={()=>navigate(id)}><I size={15}/>{title}</button>)}</nav>
 <main id="main">
 {(sync==='auth'||sync==='fail'||sync==='conflict'||error)&&<div role="status" className="alert"><CloudOff size={17}/><span>{error||(sync==='auth'?'请使用此站点所属的 ChatGPT 账号登录，以保存作答。':'暂时无法读取你的云端进度。请在继续练习前重试。')}</span>{sync==='auth'?<a href="/signin-with-chatgpt?return_to=%2F" target="_top">登录</a>:<button onClick={()=>void refresh()}>重新读取</button>}</div>}
 {coachError&&sync==='ok'&&<div className="alert"><span>教练反馈暂未载入。</span><button onClick={()=>void refreshCoach()}>重试</button></div>}
 {tab!=='lesson'&&<div className="page-intro"><div><div className="eyebrow"><span className="kicker-line"/>{titles[tab][0]}</div><h1>{titles[tab][1]}</h1><p>{titles[tab][2]}</p></div>{tab==='home'&&<div className="edition"><Disc3 size={15}/> PERSONAL EDITION</div>}</div>}
 {tab==='home'&&<div className="dashboard"><div className="desk-main"><section className="hero"><div className="hero-top"><span className="hero-tag"><i/>{s.finished?'本课已打卡':'进行中'}</span><span>LESSON {String(s.day).padStart(2,'0')} / 62</span></div><div className="hero-copy"><div className="hero-over">{s.finished?'LESSON COMPLETE':s.day===11?'SPEAKING LAB  /  PART 3':english[stage].toUpperCase()+' LAB'}</div><h2>{s.day===11?'仪表盘上的警示灯':topic.theme}</h2><p>{s.finished?'本课记录已归档。下一课由你开启。':s.day===11?'接续你的轮胎预警经历，练习解释原因与后果。':'从当前小题继续，保留每一次独立作答。'}</p>
 <button className="hero-btn" onClick={()=>s.finished?archive(s.day):navigate('lesson')}>{s.finished?'查看本课记录':stage==='speak'?'继续口语练习':'继续当前练习'}<ArrowRight size={17}/></button></div><FieldArt/><div className="hero-rule"/><div className="hero-foot"><span><Clock3 size={14}/> {s.finished?'已确认打卡':s.day===11&&stage==='speak'?'本题约 40–60 秒':labels[stage]}</span><span><Layers3 size={14}/> Day {s.day} · {english[stage]}</span></div></section>
 {s.finished&&s.day<62&&<section className="card nextbox"><div><div className="eyebrow">NEXT LESSON</div><h3>Day {s.day+1} · {nextReady?'从口语开始':'等待新课包'}</h3><p>{nextReady?'准备好再开始，开启后才会记录新课。':'可请 ChatGPT 教练为下一课添加新材料。'}</p></div>{nextReady&&<button className="primary" onClick={()=>void start()} disabled={pending}>开始 Day {s.day+1}<ArrowRight size={16}/></button>}{!nextReady&&<a className="secondary" target="_blank" rel="noreferrer" href="https://chatgpt.com/c/6adc0a0c-e9a4-83ec-96a3-ddef0fe89edd">打开教练对话<ArrowUpRight size={15}/></a>}</section>}
 <section className="card itinerary"><div className="section-head"><div><div className="eyebrow">Session plan</div><h2>本课路线</h2></div><span className="time-tag"><Clock3 size={14}/>{cap} 分钟预算</span></div>
 <div className="route-rows">{order.map((k,i)=>{const I=icons[k],finished=stageDone(k),active=!s.finished&&k===stage;return <button key={k} disabled={!finished&&!active} onClick={()=>active?navigate('lesson'):archive(s.day)} className={'route-row '+(active?'active ':'')+(finished?'done':'')}><span className="route-mark">{finished?<Check size={15}/>:active?<AudioLines size={16}/>:String(i+1).padStart(2,'0')}</span><span className="route-name">{labels[k]} <small>{english[k]}</small></span><span className="route-status">{active?'当前':finished?'已完成':'待进行'}</span><span className="route-time">{mins[k]} min</span>{active?<ChevronRight size={16}/>:<span className="end-dot"/>}</button>})}</div></section>
 </div><aside className="desk-aside"><section className="card progress-card"><div className="section-head"><div className="eyebrow">Programme</div><Flag size={16}/></div><h2>课程进度</h2><div className="big-count">{done}<small> / 62</small></div><div className="prog-track"><div style={{width:done/62*100+'%'}}/></div><div className="metric-note"><span>已打卡课时</span><b>{(done/62*100).toFixed(1)}%</b></div><div className="goal-split"/><div className="tiny-label"><Target size={15}/> 我的目标分数</div><Goals/></section>
 <section className="card focus-card"><div className="eyebrow"><span className="coral-dot"/>Coach’s note</div><h2>口语练习重点</h2><p>回答原因类问题时，先说出一个具体原因，再说明它可能带来什么后果。</p><div className="phrase">“One reason is that …”</div><button className="text-btn" onClick={()=>navigate('notes')}>打开错题手记 <ArrowUpRight size={14}/></button></section></aside></div>}
 {tab==='lesson'&&<><button className="back" onClick={()=>navigate('home')}><ArrowLeft size={16}/>今日练习</button><div className="page-intro"><div><div className="eyebrow"><span className="kicker-line"/>{dayName(s)} / {english[stage]}</div><h1>{labels[stage]}</h1><p>{s.day===11?'预警信号与判断':topic.theme}</p></div>{pill(s.finished?'已打卡':'进行中',!s.finished)}</div>
 {s.finished?<section className="card pad"><h2>本课已打卡</h2><button className="secondary" onClick={()=>archive(s.day)}>查看档案</button></section>:stage==='speak'?<Speaking key={s.day} day={s.day} entry={entry} prompt={topic.speaking} followup={s.day===11?part3:topic.followup} save={save} advance={()=>void advance()}/>:stage!=='review'?<Exercise key={s.day+stage} day={s.day} stage={stage} entry={entry} save={save} advance={()=>void advance()}/>:<section className="card pad check-card"><div className="eyebrow">Final check-in</div><h2>给 Day {s.day} 收个尾</h2><p>回想一个下次能独立用出的表达，或一个仍需练习的问题。</p><label>一句复盘 <small>可选</small><textarea value={memo} onChange={e=>setMemo(e.target.value)} placeholder="下次我想试着……"/></label><label className="checkbox"><input type="checkbox" checked={check} onChange={e=>setCheck(e.target.checked)}/>我已完成本课核心练习，确认打卡 Day {s.day}。</label><button className="primary" disabled={!check||pending} onClick={()=>void finish()}>确认完成 Day {s.day}<CheckCheck size={17}/></button></section>}
 <div className="lesson-foot"><Clock3 size={14}/><span>当前模块预算 {mins[stage]} 分钟 · 本课总预算 {cap} 分钟</span><button onClick={()=>navigate('home')}>返回工作台</button></div></>}
 {tab==='history'&&<div className="archive-grid"><div className="card archive-list">{Array.from({length:s.day},(_,i)=>s.day-i).map(d=><button key={d} className={d===historyDay?'selected':''} onClick={()=>{setHistoryDay(d);setShowPacket(false)}}><span>Day {String(d).padStart(2,'0')}</span>{s.completed.includes(d)?<Check size={15}/>:<i/>}</button>)}</div><div className="card pad history-detail"><div className="eyebrow">Lesson record / {String(historyDay).padStart(2,'0')}</div><h2>{brief[historyDay]||getLesson(historyDay).theme}</h2>{pill(s.completed.includes(historyDay)?'已打卡':'进行中',!s.completed.includes(historyDay))}<div className="record-list">{(oldResults[historyDay]||[]).map(([a,b])=><div key={a}><span>{a}</span><b>{b}</b></div>)}</div>
 {writings[historyDay]?.map((t,i)=><details key={i}><summary>{i?'写作修订稿':'写作独立首稿'}<ChevronDown size={15}/></summary><p className="english-text">{t}</p></details>)}
 {historyDay===11&&<details><summary>口语记录 · 轮胎预警<ChevronDown size={15}/></summary><p>你描述了车载系统发出胎压预警、给轮胎充气、提示消失，以及汽车行驶更平稳。原回答分三段，中间有追问。保留转录反馈，发音与流利度尚无可复核评分。</p><div className="example">The warning disappeared after I inflated the tire.</div></details>}
 <EntryHistory entry={s.entries[historyDay]||{}} day={historyDay}/>
 {historyFeedback.length>0&&<><h3>教练评语</h3>{historyFeedback.map(f=><div className="feedback" key={f.id}><small>{labels[f.stage as Stage]||f.stage} · {f.attempt} · {f.evidence}</small><p>{f.feedback}</p></div>)}</>}
 <button className="secondary packet" onClick={()=>setShowPacket(!showPacket)}><FileText size={15}/>{showPacket?'收起批改请求':'生成教练批改请求'}</button>{showPacket&&<ReviewRequest day={historyDay} entry={s.entries[historyDay]||{}}/>}
 </div></div>}
 {tab==='notes'&&<div className="notebook"><div className="note-picks">{notes.map((n,i)=><button className={i===note?'selected':''} key={n.word} onClick={()=>{setNote(i);setReply('');setResult(null)}}><span>0{i+1}</span>{n.word}</button>)}</div><section className="card pad"><div className="eyebrow">Active recall · Day {notes[note].day}</div><h2>{notes[note].word}</h2><p className="sample-line">{notes[note].cue}</p><label>凭记忆填入一个词<input value={reply} onChange={e=>{setReply(e.target.value);setResult(null)}} placeholder="Your answer" autoComplete="off"/></label><button className="primary" disabled={!reply.trim()||pending||result!==null} onClick={async()=>{const ok=reply.trim().toLowerCase()===notes[note].key,word=notes[note].word;if(await persist(p=>({...p,practice:{...p.practice,[word]:{count:(p.practice[word]?.count||0)+1,date:dayStamp(),lastCorrect:ok}}})))setResult(ok)}}>核对并记录<ArrowRight size={16}/></button>
 {result!==null&&<div className="notice"><b>{result?'答对了。':'参考答案为 '+notes[note].key+'。'}</b><p>{notes[note].after}</p><p>{notes[note].tip}</p></div>}<details><summary>回看纠错笔记<ChevronDown size={15}/></summary><p className="before">{notes[note].before}</p><p className="example">{notes[note].after}</p><p>{notes[note].tip}</p></details>
 {s.practice[notes[note].word]&&<small className="muted">已提交 {s.practice[notes[note].word].count} 次 · 最近 {s.practice[notes[note].word].date}</small>}</section></div>}
 {tab==='report'&&<Reports s={s} persist={persist} pending={pending} feedback={feedback}/>}
 {tab==='settings'&&<section className="card pad settings"><div className="eyebrow">Course preferences</div><h2>考试与训练安排</h2><label>考试类型<select value={s.exam} onChange={e=>{const v=e.target.value as Ledger['exam'];void persist(p=>({...p,exam:v}))}}><option>未选择</option><option>Academic</option><option>General Training</option></select></label><p>确认后可用于安排对应的阅读整卷与 Writing Task 1。</p><div className="record-list">{[['整体目标','Overall 8.0'],['每课预算','通常 110 分钟，最高 120 分钟'],['新课第一项','口语 · 工作日 15–20 分钟，周末 25–30 分钟'],['课程日期','按北京时间记录首次分配'],['评估周期','每 7 天回顾，每 28 天合评'],['目标节点','2026 年 12 月 22 日'],['完成条件','核心练习已提交，并由你最终打卡']].map(([k,v])=><div key={k}><span>{k}</span><b>{v}</b></div>)}</div></section>}
 </main><footer className="footer"><span><Mark/>Bandroom</span><small>PERSONAL IELTS STUDY STUDIO</small></footer></div></div>
}
