// ---------------------------------------------------------------------------
// NOTE (public release): the "foundation phase" (Day 1-11) below is SYNTHETIC
// SAMPLE DATA used only for demonstration and regression tests. It is not any
// real learner's record. Real users' progress lives in D1 (learner_states) and
// is never seeded from this file. See iteration-26/PUBLIC_RELEASE_PLAN.md.
// ---------------------------------------------------------------------------
export type Stage = 'speak'|'vocab'|'listen'|'read'|'write'|'review'
export const stages: Stage[] = ['speak','vocab','listen','read','write','review']
export const oldOrder: Stage[] = ['vocab','listen','read','write','speak','review']
export const labels:Record<Stage,string>={speak:'口语表达',vocab:'词汇与搭配',listen:'真实听力',read:'阅读与证据',write:'写作与修订',review:'回顾打卡'}
export const english:Record<Stage,string>={speak:'Speaking',vocab:'Vocabulary',listen:'Listening',read:'Reading',write:'Writing',review:'Check-in'}
export type Entry=Record<string,string>
export interface Ledger {
  version:1; day:number; stage:Stage; finished:boolean; completed:number[];
  entries:Record<string,Entry>; started:Record<string,string>; checked:Record<string,string>;
  exam:'未选择'|'Academic'|'General Training'; practice:Record<string,{count:number;date:string}>;
}
// Synthetic sample timeline for the foundation phase (not a real user's dates).
export const sampleEpoch='2026-01-05'
export const sampleHistory:Record<number,string>={8:'2026-01-05',9:'2026-01-06',10:'2026-01-08',11:'2026-01-08'}
export function initial():Ledger{return {version:1,day:11,stage:'speak',finished:false,completed:Array.from({length:10},(_,i)=>i+1),entries:{},started:{11:sampleHistory[11]},checked:{9:sampleHistory[9],10:sampleHistory[10]},exam:'未选择',practice:{}}}
export const dayStamp=(date=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
export function budgets(day:number,date:string,fullEssay=day===13||day===16):Record<Stage,number>{
  const weekday=new Date(date+'T12:00:00Z').getUTCDay(), weekend=weekday===6||weekday===0
  if(day===11)return {speak:20,vocab:15,listen:25,read:25,write:25,review:10}
  return fullEssay?{speak:weekend?30:20,vocab:10,listen:15,read:15,write:45,review:5}:{speak:weekend?30:20,vocab:15,listen:20,read:20,write:25,review:10}
}
export const part3="Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?"
export const brief:Record<number,string>={1:'B2 听力首练及复听',2:'听力与写作练习',3:'在线辅导与语法修正',4:'预算与项目细节',5:'影评与独立造句',6:'语言学习与阅读判断',7:'信息来源与学习回顾',8:'健身房广告',9:'创新与公共交通',10:'软件试点与证据',11:'预警信号与判断'}
// Synthetic sample scores (demonstration only).
export const oldResults:Record<number,string[][]>={
1:[['B2 听力首练','3/6'],['复听后另题','3/5']],2:[['学习记录','已打卡，分项数值不全']],
3:[['听力 · 有示例提示','3/4'],['回忆','1/2'],['定向纠错','2/6'],['错误回忆','1/6']],
4:[['分批听力','3/5'],['回忆','1/2'],['阅读','1/2'],['语法','3/6']],
5:[['分批听力','3/5'],['回忆','1/2'],['语法','3/5'],['独立应用','3/6']],
6:[['分批听力','4/5'],['回忆','2/2'],['阅读判断','2/3'],['语法','3/6']],
7:[['分批听力','3/5'],['证据回忆','1/2'],['语法','1/2'],['事实证据','1/2']],
8:[['分批听力','4/5'],['回忆','1/2'],['阅读','1/2'],['纠错','3/6']],
9:[['词汇','2.5/4'],['C1 听力 · 分批','4/7'],['最终概念检查','2/3'],['阅读推断','1/2'],['写作 · 独立首稿','3/10'],['写作 · 辅导后修订','4/10']],
10:[['词汇','2/4'],['C1 听力 · 分批','4/7'],['理解回忆','2/4'],['阅读推断','1.5/2'],['写作 · 独立首稿','4/10'],['写作 · 辅导后修订','5.5/10']],
11:[['词汇','2.5/4'],['C1 听力 · 分批','4/6'],['理解回忆','2.5/4'],['阅读推断','1.5/2'],['写作 · 独立首稿','4.5/10'],['写作 · 辅导后修订','6/10']]
}
// Synthetic sample correction notes (demonstration only).
export const notes=[
{word:'disappear',meaning:'v. 消失；不再出现',day:11,before:'The noise was disappeared.',after:'The noise disappeared after the repair.',tip:'disappear 是不及物动词，不能用于被动语态。',cue:'The noise _____ after the repair.',key:'disappeared'},
{word:'evidence',meaning:'n. 证据（不可数名词）',day:10,before:'proved evidences',after:'We need stronger evidence before expanding the trial.',tip:'evidence 是不可数名词。单条证据可以说 a piece of evidence。',cue:'The team needs stronger _____ before expanding the trial.',key:'evidence'},
{word:'tentative',meaning:'adj. 暂定的；尚未确定的',day:11,before:'a tentative decision that we go',after:'We made a tentative decision to postpone the launch.',tip:'用 a tentative decision to do something 表达初步决定。',cue:'We made a _____ decision, subject to review.',key:'tentative'},
{word:'viable',meaning:'adj. 切实可行的；有望成功的',day:9,before:'a substantiate solution',after:'Lower fares could be a viable solution.',tip:'形容词 viable 表示切实可行的。substantiate 是动词，表示用证据支持。',cue:'The plan is affordable and practical. It is a _____ option.',key:'viable'}]
// Synthetic sample writing drafts (demonstration only; original != revision).
export const writings:Record<number,[string,string]> = {
9:[`In my opinion, which measure should be funded first depends on who uses the service. Bus riders are often sensitive to fares, while subway riders may care more about speed. To summarize, lower fares could help bus services, and better signage could help subway stations.`,`In my opinion, the first funding priority should depend on passengers' needs. Bus riders are usually more sensitive to fares, while subway riders may prioritise speed and clarity. Therefore, reducing fares could benefit bus services, whereas clearer real-time signage could benefit subway stations.

Considering ongoing costs, I would fund lower fares first, because it is a recurring expense that grows over time, while signage is largely a one-off investment with limited operating costs.

Some may argue that signage improves efficiency greatly, but I am not convinced it would reliably increase rider numbers.`],
10:[`In my opinions, the company should not roll out the new system to every team immediately, because several factors may have influenced the result. I suggest they run a second trial with one additional team to identify the main factor behind the shorter response times before deciding.`,`In my view, the shorter response times could be due to the new system, the extra on-call engineer, or both, so the company should not hurry to roll it out everywhere. A second trial with an additional team would help isolate which factor matters most and give measurable results.

Even if the system proves responsible, a company-wide rollout should still depend on an independent security review and on feedback from participating engineers.`],
11:[`I disagree with automatically discarding unusual sensor readings. Instead we should look into the exact reason. If it is a technical fault such as debris, we can fix the sensor and discard the reading; but if it reflects a genuine change, we should verify and warn.`,`I oppose discarding unusual sensor readings automatically. We should first determine the cause: a technical fault (for example, blocked by debris) can be fixed and the reading discarded, whereas a genuine rise in water level must be verified and an appropriate warning issued.

On the other hand, human review is slower and more costly than fully automated warnings, so the trade-off should be weighed carefully.`]}
