// Mounted confirmation/profile UI. These tests use the same jsdom + esbuild
// pattern as tests/feedback-ui.mjs so the real client component is exercised.
import assert from 'node:assert/strict';
import {test,beforeEach,afterEach} from 'node:test';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';

const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
mkdirSync('.sites-runtime/tests',{recursive:true});
await wrangler('esbuild').build({entryPoints:['app/pronunciation-coach.tsx'],bundle:true,platform:'node',format:'esm',outfile:'.sites-runtime/tests/pronunciation-coach.mjs',packages:'external',loader:{'.css':'empty'}});
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','Event','MouseEvent','localStorage'])
 Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
dom.window.HTMLMediaElement.prototype.pause=()=>{};
dom.window.HTMLMediaElement.prototype.load=()=>{};
dom.window.HTMLMediaElement.prototype.play=async()=>{};
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {PronunciationCoach,PronunciationProfilePanel,ControlItemDisclosure}=await import('../.sites-runtime/tests/pronunciation-coach.mjs');

const analysisFixture=()=>({
 pronunciation:{
  items:[
   {candidateId:'c-real',word:'the',expected:'DH',actual:'D',atMs:20310,tier:'T3',isCatchTrial:false,
    detectorConfidence:0.64,canonicalAudioUrl:'https://fixture.example/canonical-the.mp3'},
   // A server-issued catch trial has expected === actual. It must still render
   // exactly like a real item, so the card must not display the phone pair.
   {candidateId:'c-hidden',word:'the',expected:'DH',actual:'DH',atMs:20310,tier:'T3',isCatchTrial:true,
    detectorConfidence:0.64,canonicalAudioUrl:'https://fixture.example/canonical-the.mp3'},
   {candidateId:'c-t2-plain',word:'think',expected:'TH',actual:'S',atMs:8000,tier:'T2'},
   {candidateId:'c-reprobe',word:'think',expected:'TH',actual:'S',atMs:8100,tier:'T2',isReprobe:true,priorVerdict:'confirmed'},
  ],
  sections:{T2:'T2 服务器原文：你的历史里这一类常被确认，值得对比自听。',T3:'T3 服务器原文：检测器提出一个候选，请回听后再判断。'},
  reliability:{pauseCount:36,pausePrecision:0.65,macroPrecision:0.8124,perSpeakerMin:0.333,perSpeakerMax:1},
  profile:{exists:false,classes:[
   {expected:'DH',actual:'D',nConfirmed:1,nRejected:0,nUnsure:2,nShown:3,state:'CANDIDATE'},
   {expected:'TH',actual:'S',nConfirmed:2,nRejected:0,nUnsure:0,nShown:2,state:'CANDIDATE'},
  ]},
 },
});

const profileFixture=()=>({
 profileExists:false,
 classes:[
  {expected:'DH',actual:'D',nConfirmed:1,nRejected:0,nUnsure:2,nShown:3,state:'CANDIDATE'},
  {expected:'TH',actual:'S',nConfirmed:2,nRejected:0,nUnsure:0,nShown:2,state:'CANDIDATE'},
 ],
 reliability:{pauseCount:36,pausePrecision:0.65,macroPrecision:0.8124,perSpeakerMin:0.333,perSpeakerMax:1},
 progress:[{expected:'DH',actual:'D',points:[
  {label:'第 1 次',candidates:4,speechMinutes:2,ciLow:1,ciHigh:3},
  {label:'第 2 次',candidates:6,speechMinutes:3,ciLow:1.5,ciHigh:2.5},
 ]}],
 ruleVersion:'rule-1',detectorVersion:'detector-1',
});

const mcpReply=(payload,isError=false)=>new Response(JSON.stringify({
 jsonrpc:'2.0',id:1,
 result:{content:[{type:'text',text:JSON.stringify(payload)}],...(isError?{isError:true}:{})},
}),{status:200,headers:{'Content-Type':'application/json'}});

let calls,root,recordMode,profileReply,resetMode;
function recordCalls(){return calls.filter(call=>call.name==='record_pronunciation_verdict');}
function resetCalls(){return calls.filter(call=>call.name==='reset_pronunciation_profile');}
function readCalls(){return calls.filter(call=>call.name==='read_pronunciation_profile');}
const text=()=>document.body.textContent;
const buttons=(label,within=document)=>[...within.querySelectorAll('button')].filter(button=>label instanceof RegExp?label.test(button.textContent??''):button.textContent?.trim()===label);
const flush=async()=>act(async()=>{await sleep(20)});
const click=async target=>{assert.ok(target);await act(async()=>target.click());await flush();};
async function render(node){
 root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(node));
 await flush();
}
afterEach(async()=>{if(root){await act(async()=>root.unmount());root=null;}document.body.innerHTML='<div id="root"></div>';});
beforeEach(()=>{
 calls=[];recordMode='ok';resetMode='ok';profileReply=profileFixture();
 globalThis.fetch=async(url,init={})=>{
  assert.equal(url,'/mcp');
  const body=JSON.parse(init.body);
  const name=body.params.name;
  calls.push({name,arguments:body.params.arguments,body});
  assert.equal(Object.hasOwn(body.params,'userId'),false);
  assert.equal(JSON.stringify(body).includes('"userId"'),false);
  if(name==='record_pronunciation_verdict'){
   if(recordMode==='deferred')return new Promise(resolve=>{recordMode=resolve;});
   if(recordMode==='denied')return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32003,message:'not registered'}}),{status:200,headers:{'Content-Type':'application/json'}});
   return mcpReply({saved:true});
  }
  if(name==='read_pronunciation_profile')return mcpReply(profileReply);
  if(name==='reset_pronunciation_profile'){
   if(resetMode==='fail')return new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{code:-32603,message:'failed'}}),{status:200,headers:{'Content-Type':'application/json'}});
   return mcpReply({reset:true});
  }
  throw Error('Unexpected tool '+name);
 };
});

test('three-state controls, catch-trial indistinguishability and verbatim tier sections',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture(),recordingId:'11111111-1111-4111-8111-111111111111'}));
 assert.match(text(),/20\.31 秒/);
 const cards=[...document.querySelectorAll('.pc-card')];
 assert.equal(cards.length,3,'only T3 and re-probed T2 are answerable');
 assert.equal(cards[0].outerHTML,cards[1].outerHTML,'expected==actual catch trial and real item render identically');
 assert.ok(!cards.some(card=>/DH\s*→\s*(?:D|DH)/.test(card.textContent??'')),'phone pairs are not rendered (they would expose catch trials)');
 assert.equal(cards[0].querySelectorAll('.pc-verdicts button').length,3);
 for(const label of ['确实读错','其实没错','不确定']) assert.ok(buttons(label,cards[0]).length,label);
 assert.ok(buttons('回听 the · 20.31 秒',cards[0]).length);
 assert.ok(buttons('播放标准发音',cards[0]).length);
 assert.ok(buttons('0.75× 慢速对比',cards[0]).length);
 assert.equal(document.querySelector('[data-tier="T2"] .pc-tier-text').textContent,'T2 服务器原文：你的历史里这一类常被确认，值得对比自听。');
 assert.equal(document.querySelector('[data-tier="T3"] .pc-tier-text').textContent,'T3 服务器原文：检测器提出一个候选，请回听后再判断。');
 const html=document.body.innerHTML;
 assert.doesNotMatch(html,/isCatchTrial|catch trial|对照项|控制项|catchTrial/i);
 assert.match(text(),/还没有你的个人发音画像/);
 assert.match(text(),/同一类别至少 3 次确认/);
 assert.doesNotMatch(text(),/3\s*[–-]\s*5/);
 assert.match(text(),/1\/3 次同类确认/);
 assert.match(text(),/2\/3 次同类确认/);
 assert.match(text(),/不是所有类别的总数/);
 assert.match(text(),/36 次停顿/);
 assert.match(text(),/65%/);
 assert.match(text(),/可能多计约 13 次/);
 const reProbe=cards.find(card=>card.textContent?.includes('think'));
 assert.match(reProbe.textContent,/已记录：确实读错/);
 assert.ok([...reProbe.querySelectorAll('.pc-verdicts button')].every(button=>button.disabled));
});

test('slow playback sets 0.75× on the canonical contrast audio',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture()}));
 const card=document.querySelector('.pc-card');
 const slow=buttons('0.75× 慢速对比',card)[0];
 assert.ok(slow);
 await click(slow);
 const audio=card.querySelector('.pc-canonical audio');
 assert.equal(audio.playbackRate,0.75);
});

test('a reliability line already present in the deterministic prose is not duplicated',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture(),feedbackText:'【T1 可靠性披露】本次检测到 36 个停顿。'}));
 assert.equal(document.querySelectorAll('.pc-reliability').length,0);
 assert.match(text(),/还没有你的个人发音画像/);
});

test('unsure is submitted explicitly, recorded, and does not change same-class progress',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture()}));
 const card=document.querySelector('.pc-card');
 await click(buttons('不确定',card)[0]);
 assert.equal(recordCalls().length,1);
 assert.deepEqual(recordCalls()[0].arguments,{candidateId:'c-real',verdict:'unsure'});
 assert.match(card.textContent,/已记录：不确定（不计入画像）/);
 assert.ok([...card.querySelectorAll('.pc-verdicts button')].every(button=>button.disabled));
 assert.match(text(),/1\/3 次同类确认/);
 assert.match(text(),/2\/3 次同类确认/);
 await click(buttons('其实没错',card)[0]);
 assert.equal(recordCalls().length,1,'an answered item cannot submit a second verdict');
});

test('rapid double click sends one verdict and prior answers stay locked',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture()}));
 recordMode='deferred';
 const card=document.querySelector('.pc-card');
 const confirm=buttons('确实读错',card)[0];
 await act(async()=>{confirm.click();confirm.click();});
 await flush();
 assert.equal(recordCalls().length,1,'in-flight guard prevents duplicate submissions');
 const resolve=recordMode;
 recordMode='ok';
 await act(async()=>resolve(mcpReply({saved:true})));
 await flush();
 assert.match(card.textContent,/已记录：确实读错/);
 await click(buttons('不确定',card)[0]);
 assert.equal(recordCalls().length,1);

 const prior=analysisFixture();
 prior.pronunciation.items=[{candidateId:'prior',word:'the',expected:'DH',actual:'D',atMs:1000,tier:'T3',priorVerdict:'rejected'}];
 await act(async()=>root.unmount());root=null;document.body.innerHTML='<div id="root"></div>';
 await render(createElement(PronunciationCoach,{analysis:prior}));
 const priorCard=document.querySelector('.pc-card');
 assert.match(priorCard.textContent,/已记录：其实没错/);
 assert.ok([...priorCard.querySelectorAll('.pc-verdicts button')].every(button=>button.disabled));
 assert.equal(recordCalls().length,1,'reflecting a prior answer does not re-submit');
});

test('a denied tool shows a retryable error and keeps the item answerable',async()=>{
 await render(createElement(PronunciationCoach,{analysis:analysisFixture()}));
 recordMode='denied';
 const card=document.querySelector('.pc-card');
 await click(buttons('确实读错',card)[0]);
 assert.match(card.textContent,/暂时无法保存，请重试/);
 assert.ok(buttons('确实读错',card)[0].disabled===false);
});

test('profile panel shows cold start, same-class progress, reliability, rate chart and reset semantics',async()=>{
 let managed=0;
 await render(createElement(PronunciationProfilePanel,{onManageRecordings:()=>{managed+=1;}}));
 assert.match(text(),/还没有你的个人发音画像/);
 assert.match(text(),/1\/3 次同类确认/);
 assert.match(text(),/2\/3 次同类确认/);
 assert.match(text(),/不是所有类别的总数/);
 assert.doesNotMatch(text(),/「其实没错」，已记录/);
 assert.match(text(),/36 次停顿/);
 assert.match(text(),/每分钟语音的候选数（展示策略不变量）/);
 assert.match(text(),/误差线表示该时间点候选发生率的置信区间/);
 assert.match(text(),/该指标按语音时长归一化/);
 const rows=[...document.querySelectorAll('.pc-table tbody tr')].map(row=>row.textContent);
 assert.ok(rows.some(row=>row.includes('DH→D')&&row.includes('2')));
 assert.equal(readCalls().length,1);
 assert.deepEqual(readCalls()[0].arguments,{});

 await click(buttons('重置个人发音画像')[0]);
 const dialog=document.querySelector('[role="dialog"]');
 assert.ok(dialog);
 assert.match(dialog.textContent,/这会清除你的发音画像和确认记录。/);
 assert.match(dialog.textContent,/不会删除你的录音或备份。/);
 assert.ok(buttons('前往「学习档案」管理录音',dialog).length);
 await click(buttons('前往「学习档案」管理录音',dialog)[0]);
 assert.equal(managed,1);
 await click(buttons('确认重置',dialog)[0]);
 assert.equal(resetCalls().length,1);
 assert.deepEqual(resetCalls()[0].arguments,{});
 assert.match(text(),/已重置个人发音画像。你的录音和备份未受影响。/);
 assert.match(text(),/还没有你的个人发音画像/);
 assert.equal(document.querySelector('[role="dialog"]'),null);
});

test('rejected verdicts are disclosed per class without counting toward confirmations',async()=>{
 const fixture=profileFixture();
 fixture.profileExists=true;
 fixture.classes=[
  {expected:'V',actual:'W',nConfirmed:0,nRejected:1,nUnsure:0,nShown:1,state:'CANDIDATE'},
  {expected:'ER',actual:'AH',nConfirmed:0,nRejected:0,nUnsure:0,nShown:1,state:'CANDIDATE'},
 ];
 profileReply=fixture;
 await render(createElement(PronunciationProfilePanel,{}));
 assert.match(text(),/0\/3 次同类确认/);
 assert.match(text(),/还需 3 次同类确认/);
 assert.match(text(),/另有 1 次「其实没错」，已记录，不计入确认进度。/);
 assert.equal((text().match(/「其实没错」，已记录/g)??[]).length,1,'only the class with rejections gets the line');
});

test('reset failure is reported and leaves the profile visible',async()=>{
 await render(createElement(PronunciationProfilePanel,{}));
 resetMode='fail';
 await click(buttons('重置个人发音画像')[0]);
 await click(buttons('确认重置')[0]);
 assert.match(text(),/暂时无法重置，请稍后重试/);
 assert.match(text(),/1\/3 次同类确认/);
});

test('missing confidence intervals are disclosed instead of drawn',async()=>{
 const fixture=profileFixture();
 fixture.progress=[{expected:'DH',actual:'D',points:[{label:'第 1 次',candidates:4,speechMinutes:2}]}];
 profileReply=fixture;
 await render(createElement(PronunciationProfilePanel,{}));
 assert.match(text(),/只显示点估计/);
 assert.match(text(),/不推测区间/);
 assert.ok([...document.querySelectorAll('.pc-table tbody tr')].some(row=>row.textContent?.includes('数据不足')));
 assert.equal(document.querySelectorAll('.pc-ci').length,0);
});

test('profile panel derives a per-minute curve from feedback when the tool has no series',async()=>{
 const fixture=profileFixture();
 fixture.progress=[];
 profileReply=fixture;
 const feedback=[
  {day:1,createdAt:'2026-11-01T01:00:00Z',analysis:{calibrated_prosody:{speech_duration_seconds:60},tier_assignment:{t2_items:[{expected_phone:'DH',actual_phone:'D'}]}}},
  {day:2,createdAt:'2026-11-02T01:00:00Z',analysis:{calibrated_prosody:{speech_duration_seconds:120},tier_assignment:{t2_items:[{expected_phone:'DH',actual_phone:'D'}]}}},
 ];
 await render(createElement(PronunciationProfilePanel,{feedback}));
 assert.match(text(),/每分钟语音的候选数（展示策略不变量）/);
 assert.match(text(),/由最近 12 次含声学分析的反馈/);
 assert.match(text(),/只显示点估计/);
 const rows=[...document.querySelectorAll('.pc-table tbody tr')].map(row=>row.textContent);
 assert.ok(rows.some(row=>row.includes('DH→D')&&row.includes('1')));
 assert.ok(rows.some(row=>row.includes('DH→D')&&row.includes('0.5')));
});

test('profile read failure is explicit and retryable',async()=>{
 const original=profileReply;
 let fail=true;
 globalThis.fetch=async(url,init={})=>{
  const body=JSON.parse(init.body);
  calls.push({name:body.params.name,arguments:body.params.arguments,body});
  if(fail)return new Response(JSON.stringify({error:'unavailable'}),{status:500});
  return mcpReply(original);
 };
 await render(createElement(PronunciationProfilePanel,{}));
 assert.match(text(),/暂时无法读取个人发音画像/);
 fail=false;
 await click(buttons('重试读取')[0]);
 assert.match(text(),/1\/3 次同类确认/);
});
// --- control-item disclosure ------------------------------------------------
// Controls are indistinguishable in the confirmation cards, so the disclosure
// may only report the aggregate consequence, never which item was a control.
test('control disclosure is silent before any control is answered', async () => {
 await render(createElement(ControlItemDisclosure,{controls:{shown:3,answered:0,confirmed:0,constantConfirmerFlag:false}}));
 assert.equal(text().trim(),'');
});

test('control disclosure reports counts without flagging a discriminating listener', async () => {
 await render(createElement(ControlItemDisclosure,{controls:{shown:6,answered:5,confirmed:1,constantConfirmerFlag:false}}));
 assert.match(text(),/已回答 5 个对照项/);
 assert.match(text(),/不计入类别进度/);
 assert.doesNotMatch(text(),/区分度不足/);
});

test('control disclosure warns a constant confirmer and never names the control word', async () => {
 await render(createElement(ControlItemDisclosure,{controls:{shown:6,answered:5,confirmed:5,constantConfirmerFlag:true}}));
 assert.match(text(),/确认结果区分度不足/);
 assert.match(text(),/5 个判为/);
 assert.match(text(),/不确定/);
 assert.doesNotMatch(text(),/DH|AH|expected|actual/);
});
