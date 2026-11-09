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
export function initial():Ledger{return {version:1,day:11,stage:'speak',finished:false,completed:Array.from({length:10},(_,i)=>i+1),entries:{},started:{11:'2026-11-02'},checked:{9:'2026-10-30',10:'2026-11-02'},exam:'未选择',practice:{}}}
export const dayStamp=(date=new Date())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date)
export function budgets(day:number,date:string,fullEssay=day===13||day===16):Record<Stage,number>{
  const weekday=new Date(date+'T12:00:00Z').getUTCDay(), weekend=weekday===6||weekday===0
  if(day===11)return {speak:20,vocab:15,listen:25,read:25,write:25,review:10}
  return fullEssay?{speak:weekend?30:20,vocab:10,listen:15,read:15,write:45,review:5}:{speak:weekend?30:20,vocab:15,listen:20,read:20,write:25,review:10}
}
export const part3="Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?"
export const brief:Record<number,string>={1:'B2 听力首练及复听',2:'听力与写作练习',3:'在线辅导与语法修正',4:'预算与项目细节',5:'影评与独立造句',6:'语言学习与阅读判断',7:'信息来源与学习回顾',8:'健身房广告',9:'创新与公共交通',10:'软件试点与证据',11:'预警信号与判断'}
export const oldResults:Record<number,string[][]>={
1:[['B2 听力首练','4.5/6'],['复听后另题','4/5']],2:[['学习记录','已打卡，分项数值不全']],
3:[['听力 · 有示例提示','4/4'],['回忆','2/2'],['定向纠错','2/6'],['错误回忆','2/6']],
4:[['分批听力','4/5'],['回忆','1/2'],['阅读','1/2'],['语法','4/6']],
5:[['分批听力','4/5'],['回忆','2/2'],['语法','4/5'],['独立应用','5/6']],
6:[['分批听力','5/5'],['回忆','2/2'],['阅读判断','3/3'],['语法','4/6']],
7:[['分批听力','4/5'],['证据回忆','1.5/2'],['语法','2/2'],['事实证据','1/2']],
8:[['分批听力','5/5'],['回忆','1.5/2'],['阅读','1.5/2'],['纠错','4/6']],
9:[['词汇','3.5/4'],['C1 听力 · 分批','5/7'],['最终概念检查','3/3'],['阅读推断','1.5/2'],['写作 · 独立首稿','3/10'],['写作 · 辅导后修订','4/10']],
10:[['词汇','2/4'],['C1 听力 · 分批','6/7'],['理解回忆','2.5/4'],['阅读推断','2/2'],['写作 · 独立首稿','5/10'],['写作 · 辅导后修订','6.5/10']],
11:[['词汇','3/4'],['C1 听力 · 分批','5/6'],['理解回忆','3.5/4'],['阅读推断','1.75/2'],['写作 · 独立首稿','6/10'],['写作 · 辅导后修订','6.5/10']]
}
export const notes=[
{word:'disappear',day:11,before:'The alert was disappeared.',after:'The warning disappeared after I inflated the tire.',tip:'disappear 是不及物动词。谈论过去已经消失的提醒，直接用 disappeared。',cue:'The warning _____ after I inflated the tire.',key:'disappeared'},
{word:'evidence',day:10,before:'proved evidences',after:'We need stronger evidence before expanding the trial.',tip:'evidence 是不可数名词。单条证据可以说 a piece of evidence。',cue:'The team needs stronger _____ before expanding the trial.',key:'evidence'},
{word:'tentative',day:11,before:'a tentative decision that we go',after:'We made a tentative decision to go to the beach this weekend.',tip:'用 a tentative decision to do something 表达初步决定。',cue:'We made a _____ decision, subject to review.',key:'tentative'},
{word:'viable',day:9,before:'a substantiate solution',after:'Lower fares could be a viable solution.',tip:'形容词 viable 表示切实可行的。substantiate 是动词，表示用证据支持。',cue:'The plan is affordable and practical. It is a _____ option.',key:'viable'}]
export const writings:Record<number,[string,string]> = {
9:[`In my opinion, what measure takes can be depends. Bus passengers are usually elder people who's sensitive to fares, while those people who takes subway more cares about efficiency. To summarize, reducing fares can be possibly effective for bus, and investing in real-time arrival displays maybe more effective for subway.`,`In my opinion, which measure takes should be adopted depends on passengers' needs. Bus passengers are usually older people who are sensitive to fares, while those people who take subway may prioritise efficiency. To summarize, reducing fares could be effective for bus service, and investing in real-time arrival displays may be more effective for subway.

Considering the costs of all measures, I choose lower fares as the first funding priority. Because it's a continually spending which could be more and more alongside time goes by.Since real-time arrival displays is just a one time invest and its operation costs could be limited.

I know some people may say real-time arrival displays could increase the transport efficiency a lot, but I don't think it can surely level passenger numbers up.`],
10:[`In my opinions, Westhaven Software should not introduce the system across all engineering teams immediately cause several factors may have influenced the outcome. I strongly suggest them to evaluate the main factor of the shorter response times in the second trial with one additional team. Once there's clearly clue that which one had contributed most, then they can decide wether or not roll out the system to all engineering teams.

Even it comes out that is the system which origined the average response time fall, a company-wide rollout still can be stopped by independent security review or the feedback of participating engineers.`,`In my point of view, it could be the AI system or the extra on-call engineer and alerts classify or even both contributed the average response time's fall from 18 to 13 minutes. So they should not be hurry up to rollout the system to all engineering teams. They should using the second trial with additional team to classify which factor matters most, and it would be great for measurable results.

Assuming that there's proved evidences show it was the system that contributed the number's fall, the rollout still depends on the independent security review. And compare results of the next trial from teams using and not using the tool may effect the system introducing to the whole company.`],
11:[`I definitely disagree with automatically discarding any sensor reading, instead we should lookup into the exactly reason that which makes the sensor's reading unusual. If it was technical or something unexpected such as blocked by debris, we can simply discard it. However if it proved to be the data itself, then the only thing we can do is accept and respect things as they are and report the warnings. For example, a genuine flash flood could affect neighbouring streams unevenly.`,`I oppose automatically discarding any sensor reading directly.instead, we should look into the exactly reason why the sensor's reading unusual. If it was technical fault such as blocked by debris, we can fix the sensor and record it, then discard its reading. However if it reflects a genuine rise in water level, for example, a genuine flash flood could affect neighbouring streams unevenly.then we should verify the danger and issue an appropriate warning.

On the other side, the check requires human review. So it may be slower and more costive than fully automated public warnings which has not yet proved.`]}

