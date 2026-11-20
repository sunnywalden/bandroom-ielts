// Mounted production page: polling, exact attachment, recovery and draft safety.
import assert from 'node:assert/strict';
import {test,beforeEach,afterEach} from 'node:test';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {reviewAttempts} from '../app/feedback-model.ts';
const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
mkdirSync('.sites-runtime/tests',{recursive:true});
await wrangler('esbuild').build({entryPoints:['app/studio.tsx'],bundle:true,platform:'node',format:'esm',outfile:'.sites-runtime/tests/feedback-studio.mjs',packages:'external',loader:{'.css':'empty'}});
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example/',pretendToBeVisual:true});
for(const key of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','Event','MouseEvent','localStorage'])
 Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
window.scrollTo=()=>{};globalThis.IS_REACT_ACT_ENVIRONMENT=true;
// JSDOM does not implement media playback; these tests inspect saved attempts.
dom.window.HTMLMediaElement.prototype.pause=()=>{};
dom.window.HTMLMediaElement.prototype.load=()=>{};
dom.window.HTMLMediaElement.prototype.play=async()=>{};
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {default:Studio}=await import('../.sites-runtime/tests/feedback-studio.mjs');
const realInterval=globalThis.setInterval,realClear=globalThis.clearInterval;
let poll;
globalThis.setInterval=(fn,ms,...args)=>[3000,15000].includes(ms)?(poll=fn,'feedback-poll'):realInterval(fn,ms,...args);
globalThis.clearInterval=id=>id==='feedback-poll'?poll=undefined:realClear(id);
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
let root,state,revision,feedback,reviewLinks,reviewTasks,automation,calls,coachFault,stateFault,mcpCalls;
async function receipt(payload){
 if(!payload.submissionKey)return response(200,{revision});
 const id='v2:'+payload.submissionKey;
 let link=reviewLinks.find(link=>link.id===id);
 if(!link){
  const source=(await reviewAttempts(12,payload.state.entries[12])).at(-1);
  assert.ok(source);
  link={id,day:12,sourceId:source.id};reviewLinks.push(link);
 }
 return response(200,{revision,submissionKey:payload.submissionKey,attemptId:id,sourceId:link.sourceId});
}
const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(b=>label instanceof RegExp?label.test(b.textContent):b.textContent===label);
const flush=async()=>act(async()=>{await sleep(15)});
const click=async target=>{assert.ok(target);assert.equal(target.disabled,false);await act(async()=>target.click());await flush()};
const puts=()=>calls.filter(([url,init])=>url==='/api/state'&&init.method==='PUT');
async function mount(){root=createRoot(document.getElementById('root'));await act(async()=>root.render(createElement(Studio)));await flush();await click(button(state.stage==='speak'?'继续口语练习':'继续当前练习'));}
async function unmount(){if(root){await act(async()=>root.unmount());root=null}}
async function write(value){const el=document.querySelector('textarea');assert.ok(el);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))});await flush();}
async function tick(){
 if(poll)await act(async()=>poll());
 else await act(async()=>{window.dispatchEvent(new dom.window.Event('focus'))});
 await flush();
}
async function row(field,message){
 const attempt=(await reviewAttempts(12,state.entries[12])).find(a=>a.field===field);assert.ok(attempt);
 return {id:crypto.randomUUID(),day:12,stage:attempt.stage,attempt:reviewLinks.find(link=>link.sourceId===attempt.id)?.id??attempt.id,evidence:'Synthetic submitted evidence',feedback:message,createdAt:'2026-11-09T01:00:00Z'};
}
beforeEach(()=>{
 localStorage.clear();calls=[];mcpCalls=[];feedback=[];reviewLinks=[];reviewTasks=[];automation=undefined;coachFault=stateFault=null;revision=21;
 state={version:1,day:12,stage:'write',finished:false,completed:Array.from({length:11},(_,i)=>i+1),checked:{11:'2026-11-09'},started:{11:'2026-11-02',12:'2026-11-09'},exam:'未选择',practice:{},entries:{11:{speakingReview:'Preserved older feedback'},12:{writeOriginal:'Independent original answer.',writeCondition:'独立 · 未计时'}}};
 globalThis.fetch=async(url,init={})=>{
  calls.push([url,init]);
  if(url==='/mcp'){
   const body=JSON.parse(init.body);mcpCalls.push(body);
   return response(200,{jsonrpc:'2.0',id:body.id,result:{content:[{type:'text',text:JSON.stringify({saved:true})}]}});
  }
  if(url==='/api/review-tasks/takeover')return response(200,{claimed:true,taskId:'task-queued',fence:2,state:'running'});
  if(url==='/api/coach')return coachFault?coachFault(init):response(200,{account:'fixture-feedback-ui',extras:{},feedback:structuredClone(feedback),reviewLinks:structuredClone(reviewLinks),reviewTasks:structuredClone(reviewTasks),automation});
  if(url==='/api/state'&&!init.method)return response(200,{account:'fixture-feedback-ui',revision,state:structuredClone(state)});
  if(url==='/api/state'){
   if(stateFault)return stateFault(init);
   const payload=JSON.parse(init.body);state=payload.state;revision=payload.revision+1;return receipt(payload);
  }
  throw Error('Unexpected fixture request '+url);
 };
});
afterEach(async()=>{await unmount()});
test('delayed Work review arrives by polling at the original and preserves the revision draft',async()=>{
 await mount();assert.match(text(),/待在 Work 中发起/);
 await write('Unsaved revision that must survive feedback refresh.');
 feedback=[await row('writeOriginal','Return fixture correction for the original.')];
 await tick();
 assert.match(document.querySelector('[aria-label="写作首稿反馈"]').textContent,/Return fixture correction/);
 assert.equal(document.querySelector('textarea').value,'Unsaved revision that must survive feedback refresh.');
 assert.equal(puts().length,0);assert.equal(state.stage,'write');assert.equal(state.finished,false);
 await unmount();await mount();
 assert.match(text(),/Return fixture correction/);
 assert.equal(document.querySelector('textarea').value,'Unsaved revision that must survive feedback refresh.');
 assert.equal(puts().length,0);
});
test('failed sync retains prior review and retries; a slow request cannot overlap',async()=>{
 feedback=[await row('writeOriginal','Previously received feedback')];await mount();
 coachFault=()=>response(503,{error:'unavailable'});await tick();
 assert.match(text(),/反馈同步暂时失败/);assert.match(text(),/Previously received feedback/);
 let resolve;coachFault=()=>new Promise(r=>{resolve=r});
 await tick();const count=calls.filter(([u])=>u==='/api/coach').length;
 await tick();assert.equal(calls.filter(([u])=>u==='/api/coach').length,count);
 await act(async()=>resolve(response(200,{account:'fixture-feedback-ui',extras:{},feedback})));await flush();
 assert.ok(!text().includes('反馈同步暂时失败'));assert.equal(puts().length,0);
});
test('login expiry locks the page without erasing a draft; reconnect restores the same answer',async()=>{
 await mount();await write('Retain this draft through sign-in.');
 coachFault=()=>response(401,{error:'sign_in_required'});await tick();
 assert.match(text(),/登录学习空间/);assert.equal(poll,undefined);
 assert.equal(document.querySelector('.app-shell').hidden,true);
 coachFault=null;await click(button('重新读取进度'));
 assert.equal(document.querySelector('textarea').value,'Retain this draft through sign-in.');
 assert.equal(puts().length,0);
});
test('old or other-attempt feedback never attaches to the current original or revision',async()=>{
 state.entries[12].writeRevision='Different revision';state.entries[12].writeFocus='More specific';state.entries[12].writeDone='1';
 feedback=[await row('writeOriginal','Original-only correction'),await row('writeRevision','Revision-only correction')];
 feedback.push({...feedback[0],id:'legacy',attempt:'old descriptive label',feedback:'Historic review kept separately'});
 await mount();
 const original=document.querySelector('[aria-label="写作首稿反馈"]').textContent;
 const revision=document.querySelector('[aria-label="写作修订稿反馈"]').textContent;
 assert.match(original,/Original-only/);assert.ok(!original.includes('Revision-only'));
 assert.match(revision,/Revision-only/);assert.ok(!revision.includes('Original-only'));
 assert.ok(!original.includes('Historic review'));
 await click(button('学习档案'));
 assert.match(text(),/Historic review kept separately/);assert.equal(puts().length,0);
});
test('first-draft failure retains text; delayed duplicate clicks create only one save and no advance',async()=>{
 delete state.entries[12].writeOriginal;delete state.entries[12].writeCondition;
 await mount();const draft=Array.from({length:100},(_,i)=>'word'+i).join(' ');await write(draft);
 stateFault=()=>response(422,{error:'invalid_review_submission'});await click(button('提交并锁定首稿'));
 assert.equal(state.entries[12].writeOriginal,undefined);assert.equal(document.querySelector('textarea').value,draft);
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 const submit=button('提交并锁定首稿'),before=puts().length;
 await act(async()=>{submit.click();submit.click()});await flush();
 assert.equal(puts().length,before+1);assert.equal(state.entries[12].writeOriginal,undefined);
 assert.equal(document.querySelector('textarea').readOnly,true);
 state=payload.state;revision++;
 await act(async()=>resolve(await receipt(payload)));await flush();
 assert.equal(state.entries[12].writeOriginal,draft);assert.equal(state.stage,'write');assert.equal(state.finished,false);
 assert.match(text(),/已提交|正在核对批改队列/);
 assert.equal(reviewLinks.length,1);assert.match(reviewLinks[0].id,/^v2:/);assert.ok(poll,'a fresh submission starts polling for its task');
 stateFault=null;feedback=[await row('writeOriginal','Exact new attempt review from Work.')];await tick();
 assert.match(document.querySelector('[aria-label="写作首稿反馈"]').textContent,/Exact new attempt review/);
 assert.deepEqual(state.completed,Array.from({length:11},(_,i)=>i+1));
});
test('typing during a delayed draft save survives its acknowledgement and a page reload',async()=>{
 delete state.entries[12].writeOriginal;delete state.entries[12].writeCondition;
 await mount();await write('The draft sent to the server.');
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 await click(button('保存草稿'));
 assert.equal(document.querySelector('textarea').readOnly,false);
 await write('New edits made while the save is pending.');
 state=payload.state;revision++;
 await act(async()=>resolve(await receipt(payload)));await flush();
 assert.equal(state.entries[12].writeDraft,'The draft sent to the server.');
 assert.equal(document.querySelector('textarea').value,'New edits made while the save is pending.');
 await unmount();await mount();
 assert.equal(document.querySelector('textarea').value,'New edits made while the save is pending.');
 stateFault=null;await click(button('保存草稿'));
 assert.equal(state.entries[12].writeDraft,'New edits made while the save is pending.');
 // With no remaining local edits, an explicit refresh follows the saved cloud draft.
 state.entries[12].writeDraft='A newer cloud draft.';revision++;
 await unmount();await mount();
 assert.equal(document.querySelector('textarea').value,'A newer cloud draft.');
});
test('coach response from another account locks the page without displaying that feedback',async()=>{
 await mount();await write('Private draft from the original account.');
 const foreign=await row('writeOriginal','Other account secret');
 coachFault=()=>response(200,{account:'another-account',extras:{},feedback:[foreign]});
 await tick();
 assert.equal(document.querySelector('.app-shell').hidden,true);
 assert.equal(document.querySelector('.app-shell').hasAttribute('inert'),true);
 assert.ok(!text().includes('Other account secret'));
 assert.equal(puts().length,0);
 coachFault=null;await click(button('重新读取进度'));
 assert.equal(document.querySelector('.app-shell').hidden,false);
 assert.equal(document.querySelector('textarea').value,'Private draft from the original account.');
});
test('a late successful save cannot unlock an expired session',async()=>{
 await mount();await write('Draft saved just before session expiry.');
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 await click(button('保存草稿'));
 coachFault=()=>response(401,{error:'sign_in_required'});await tick();
 state=payload.state;revision++;
 await act(async()=>resolve(await receipt(payload)));await flush();
 assert.match(text(),/登录学习空间/);
 assert.equal(document.querySelector('.app-shell').hidden,true);
 const before=puts().length;
 await click(button('保存草稿'));assert.equal(puts().length,before);
 stateFault=coachFault=null;await click(button('重新读取进度'));
 assert.equal(document.querySelector('textarea').value,'Draft saved just before session expiry.');
 assert.equal(document.querySelector('.app-shell').hidden,false);
});
test('reflection draft survives reload and a submitted reflection stays authoritative',async()=>{
 state.stage='review';state.entries[12]={};
 await mount();await write('Practise one clear cause next time.');
 await unmount();await mount();
 assert.equal(document.querySelector('textarea').value,'Practise one clear cause next time.');
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 await click(button('保存复盘，查看批改入口'));
 assert.equal(document.querySelector('textarea').readOnly,true);
 state=payload.state;revision++;
 await act(async()=>resolve(await receipt(payload)));await flush();
 assert.equal(document.querySelector('textarea').value,state.entries[12].reviewMemo);
 assert.equal(state.finished,false);assert.equal(state.day,12);
 await unmount();await mount();
 assert.equal(document.querySelector('textarea').value,state.entries[12].reviewMemo);
 assert.equal(document.querySelector('textarea').readOnly,true);
});
test('immediate reading choice result and pending evidence review appear together',async()=>{
 state.stage='read';state.entries[12]={readQ0:'0',readQ0Correct:'0',readEvidence0:'A synthetic evidence sentence'};
 await mount();
 assert.match(text(),/答案 [ABC]/);assert.match(text(),/你写的证据说明将单独批改/);
 feedback=[await row('readQ0','Evidence correction from Work')];await tick();
 assert.match(document.querySelector('[aria-label="阅读第 1 题反馈"]').textContent,/Evidence correction from Work/);
 assert.equal(puts().length,0);
});
test('speaking self-review freezes while saving and stays for feedback until the learner explicitly continues',async()=>{
 state.stage='speak';state.entries[12]={speakingPhase:'review',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture Part 3',spoken:true}])};
 const part2=state.entries[12].speakingPart2;
 await mount();
 await act(async()=>document.querySelector('input[type="radio"]').click());await flush();
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 await click(button('保存自评，查看反馈'));
 assert.equal(document.querySelector('fieldset.sp-focus').disabled,true);
 state=payload.state;revision++;
 await act(async()=>resolve(await receipt(payload)));await flush();stateFault=null;
 assert.equal(state.stage,'speak');assert.equal(state.entries[12].speakingComplete,'yes');
 assert.match(document.querySelector('[aria-label="口语自评反馈"]').textContent,/已提交|正在核对批改队列/);
 feedback=[await row('speakingReview','Practise one cause and consequence.')];await tick();
 assert.match(document.querySelector('[aria-label="口语自评反馈"]').textContent,/Practise one cause/);
 assert.equal(puts().length,1);assert.equal(state.stage,'speak');
 await click(button('进入词汇'));
 assert.equal(state.stage,'vocab');assert.equal(state.day,12);assert.equal(state.finished,false);
 assert.equal(state.entries[12].speakingPart2,part2);assert.equal(puts().length,2);
});
test('failed feedback identification is explicit, retryable and never mislabels exact feedback as legacy',async t=>{
 feedback=[await row('writeOriginal','Exact review preserved after retry')];
 const digest=t.mock.method(crypto.subtle,'digest',()=>Promise.reject(Error('Fixture digest failure')));
 await mount();
 assert.match(text(),/暂时无法定位对应练习的反馈/);
 await click(button('学习档案'));
 assert.ok(!text().includes('其他已保存的教练评语'));
 digest.mock.restore();await click(button('重试定位反馈'));
 assert.match(document.querySelector('[aria-label="写作首稿反馈"]').textContent,/Exact review preserved after retry/);
 assert.ok(!text().includes('暂时无法定位对应练习的反馈'));assert.equal(puts().length,0);
});

test('queued task shows honest Work status and keeps the manual fallback',async()=>{
 state.entries[12].writeOriginal='Independent answer waiting for the queue.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 const link={id:'v2:queued-task',sourceId:source.id,day:12};
 reviewLinks=[link];
 reviewTasks=[{id:'task-queued',attemptId:link.id,kind:'text',state:'queued',stage:'read_input',nextAt:0,lastError:null,updatedAt:Date.now()}];
 await mount();
 const section=()=>document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section());
 assert.match(section().textContent,/等待 Work 领取/);
 assert.ok(!section().textContent.includes('可以关闭页面'));
 assert.ok(section().textContent.includes('复制本题批改请求'));
 await click(button('复制本题批改请求'));
 assert.ok(calls.some(([url])=>url==='/api/review-tasks/takeover'),'manual copy revokes the automatic claim');
 assert.match(section().textContent,/已接管/);
 reviewTasks=[{...reviewTasks[0],state:'completed'}];
 feedback=[{id:'task-feedback',day:12,stage:'write',attempt:link.id,evidence:'Automatic task evidence',feedback:'Automatic task correction',createdAt:'2026-11-09T01:00:00Z'}];
 await tick();
 assert.match(section().textContent,/Automatic task correction/);
 assert.match(section().textContent,/批改已返回/);
 assert.ok(!section().textContent.includes('复制本题批改请求'));
});

test('stale automation is labeled as disconnected in the queue',async()=>{
 state.entries[12].writeOriginal='Independent answer with a disconnected queue.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 const link={id:'v2:stale-task',sourceId:source.id,day:12};
 reviewLinks=[link];
 reviewTasks=[{id:'task-stale',attemptId:link.id,kind:'text',state:'queued',stage:'read_input',nextAt:0,lastError:null,updatedAt:Date.now()}];
 automation={connected:false,lastSuccessAt:null,nextExpectedAt:null,status:null};
 await mount();
 const section=document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section);
 assert.match(section.textContent,/自动批改当前未连接/);
 assert.ok(section.textContent.includes('复制本题批改请求'));
});
test('a dead running task is not shown as actively analyzing',async()=>{
 state.entries[12].writeOriginal='Independent answer left running by a dead worker.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 const link={id:'v2:dead-running',sourceId:source.id,day:12};
 reviewLinks=[link];
 reviewTasks=[{id:'task-dead',attemptId:link.id,kind:'text',state:'running',stage:'read_input',nextAt:0,lastError:null,updatedAt:Date.now()}];
 automation={connected:false,lastSuccessAt:null,nextExpectedAt:null,status:null};
 await mount();
 const section=document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section);
 assert.match(section.textContent,/连接已断开/);
 assert.ok(!section.textContent.includes('Work 正在分析'));
});
test('a completed task without feedback keeps reading and offers refresh',async()=>{
 state.entries[12].writeOriginal='Independent answer completed before feedback arrived.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 const link={id:'v2:completed-no-feedback',sourceId:source.id,day:12};
 reviewLinks=[link];
 reviewTasks=[{id:'task-completed',attemptId:link.id,kind:'text',state:'completed',stage:'finalize',nextAt:0,lastError:null,updatedAt:Date.now()}];
 await mount();
 const section=document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section);
 assert.match(section.textContent,/正在读取反馈/);
 assert.ok(button('重新读取反馈'));
 assert.ok(poll,'completed-without-feedback keeps polling');
 feedback=[await row('writeOriginal','Completed task correction')];await tick();
 assert.match(section.textContent,/Completed task correction/);
});

test('pronunciation hints stay hidden while the precision gate is not met',async()=>{
 state.entries[12].writeOriginal='Independent answer with a clear /s/ for think.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 feedback=[{id:'fb-acoustic',day:12,stage:'write',attempt:source.id,evidence:'Acoustic fixture',feedback:'注意 think 的词首音。',createdAt:'2026-11-09T01:00:00Z',analysis:{errors:[{wordIndex:0,phoneIndex:0,kind:'substitution',target:'TH',actual:'S',word:'think',startMs:1000,endMs:1100,probability:.92}]}}];
 await mount();
 const section=document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section);
 assert.equal(section.querySelectorAll('.af-error-card').length,0);
 assert.equal(section.querySelectorAll('[aria-label="实验性发音提示与回听"]').length,0);
 assert.match(section.textContent,/注意 think 的词首音/);
 assert.doesNotMatch(section.textContent,/θ/);
 assert.doesNotMatch(section.textContent,/92%/);
});

test('hidden pronunciation hints do not mount a recording player',async()=>{
 const audioId='22222222-2222-4222-8222-222222222222';
 state.stage='speak';
 state.entries[12]={speakingPhase:'review',speakingComplete:'yes',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true,audio:audioId}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture follow-up',spoken:true}])};
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='speakingPart2');
 assert.ok(source);
 feedback=[{id:'fb-speak',day:12,stage:'speak',attempt:source.id,evidence:'Acoustic speaking fixture',feedback:'回听这一处词首音。',createdAt:'2026-11-09T01:00:00Z',analysis:{errors:[{wordIndex:0,phoneIndex:0,kind:'substitution',target:'TH',actual:'S',word:'think',startMs:1000,endMs:1100,probability:.9}]}}];
 await mount();
 const section=document.querySelector('[aria-label="口语 Part 2 · 首次回答反馈"]');
 assert.ok(section);
 assert.equal(section.querySelectorAll('.af-error-card').length,0);
 assert.equal(section.querySelectorAll('[aria-label="实验性发音提示与回听"]').length,0);
 assert.equal(section.querySelectorAll('audio').length,0);
 assert.match(section.textContent,/回听这一处词首音/);
 assert.equal(puts().length,0);
});

test('score-first scorecard renders bands, honest statuses, transcript and drills',async()=>{
 const audioId='44444444-4444-4444-8444-444444444444';
 state.stage='speak';
 state.entries[12]={speakingPhase:'review',speakingComplete:'yes',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true,audio:audioId}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture follow-up',spoken:true}])};
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='speakingPart2');
 assert.ok(source);
 const words=[{word:"I've",start:2.8,end:4.2,probability:.62},{word:'seen',start:4.2,end:4.5,probability:.99},{word:'a',start:4.5,end:6.1,probability:.96},{word:'short',start:6.1,end:7.1,probability:.88},{word:'video',start:7.1,end:7.8,probability:.99}];
 const scorecard={schema:'bandroom-speaking-scorecard-v1',
  overall:{band:6.0,status:'reference',disclosure_zh:'参考估计：非官方雅思评分。',basis_zh:'四科参考估计均值'},
  criteria:[
   {key:'fluency_coherence',label_zh:'流利度与连贯性',band:6.5,status:'reference',disclosure_zh:'参考估计',evidence:{speech_ratio:.57,pause_count:22,pace_wpm:99,metrics_status:'calibrated'}},
   {key:'lexical_resource',label_zh:'词汇',band:6.0,status:'reference',disclosure_zh:'参考估计',evidence:{word_count:5,issues:[]}},
   {key:'grammar',label_zh:'语法',band:6.0,status:'reference',disclosure_zh:'参考估计',evidence:{error_count:1,issues:[{quote:"I've seen",fix:'I saw',reason_zh:'过去时',severity:'major'}]}},
   {key:'pronunciation',label_zh:'发音',band:null,status:'suggestive',disclosure_zh:'建议性反馈，不给发音分数',evidence:{self_listen_candidates:1}}],
  transcript:{source:'whisper-large-v3-turbo',status:'asr',words},
  drills:[{quote:"I've seen a short video",improved:'I watched a short clip.',focus_zh:'过去时'}],
  llm_status:'ok'};
 feedback=[{id:'fb-scorecard',day:12,stage:'speak',attempt:source.id,evidence:'Scorecard fixture',feedback:'一、评估：整体不错。',createdAt:'2026-11-09T01:00:00Z',analysis:{schema:'bandroom-grounded-analysis-v2',speechSeconds:33.4,items:[{candidateId:'cand-seen',word:'seen',expected:'N',actual:'NG',atMs:4570,detectorConfidence:.94,tier:'T3'}],transcript:words,scorecard}}];
 await mount();
 const section=document.querySelector('[aria-label="口语 Part 2 · 首次回答反馈"]');
 assert.ok(section);
 const card=section.querySelector('.ss-card');
 assert.ok(card);
 assert.match(card.textContent,/参考估计/);
 assert.match(card.textContent,/不评分/);
 assert.match(card.textContent,/I saw/);
 assert.match(card.textContent,/I watched a short clip\./);
 const wordButtons=card.querySelectorAll('.ss-word');
 assert.equal(wordButtons.length,5);
 assert.ok(card.querySelector('.ss-w-suggested'));
 assert.ok(card.querySelector('audio'));
 await act(async()=>{wordButtons[1].click();});
 assert.ok(card.querySelector('.ss-w-active'));
 // Self-listen verdict updates the transcript color in-session (red=confirmed).
 assert.ok(card.querySelector('.ss-w-suggested'));
 await act(async()=>{await button('确实读错').click();await flush();});
 assert.ok(card.querySelector('.ss-w-confirmed'),'transcript turns red after 确实读错');
 assert.ok(!card.querySelector('.ss-w-suggested'),'amber suggestion is replaced by the verdict');
 assert.equal(mcpCalls.at(-1).params.name,'record_pronunciation_verdict');
 assert.equal(puts().length,0);
});

test('drill replay locates the FULL quote, not a first-word prefix',async()=>{
 const audioId='55555555-5555-4555-8555-555555555555';
 state.stage='speak';
 state.entries[12]={speakingPhase:'review',speakingComplete:'yes',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true,audio:audioId}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture follow-up',spoken:true}])};
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='speakingPart2');
 assert.ok(source);
 // "is" appears before "I went": a prefix match would play the wrong segment.
 const words=[{word:'is',start:.5,end:.8,probability:.9},{word:'a',start:.9,end:1.1,probability:.9},
  {word:'short',start:1.2,end:1.6,probability:.9},{word:'video',start:1.7,end:2.1,probability:.9},
  {word:'I',start:4.0,end:4.2,probability:.9},{word:'went',start:4.3,end:4.8,probability:.9},
  {word:'there',start:4.9,end:5.3,probability:.9},{word:'last',start:5.4,end:5.7,probability:.9}];
 const scorecard={schema:'bandroom-speaking-scorecard-v1',
  overall:{band:6,status:'reference',disclosure_zh:'参考估计',basis_zh:'流利度与连贯性参考估计均值'},
  criteria:[{key:'fluency_coherence',label_zh:'流利度与连贯性',band:6,status:'reference',disclosure_zh:'参考估计',evidence:{}}],
  drills:[{quote:'I went there',improved:'I went there last year.',focus_zh:'过去时',
    contrast_audio:{status:'ok',url:'https://tts.example/expired.mp3'}}],llm_status:'ok'};
 feedback=[{id:'fb-drill',day:12,stage:'speak',attempt:source.id,evidence:'Drill fixture',feedback:'一、评估：继续。',createdAt:'2026-11-09T01:00:00Z',
  analysis:{schema:'bandroom-grounded-analysis-v2',speechSeconds:10,items:[],transcript:words,scorecard}}];
 await mount();
 const section=document.querySelector('[aria-label="口语 Part 2 · 首次回答反馈"]');
 const drill=section.querySelector('.ss-drill');
 assert.ok(drill);
 // Clip player window: start-500ms .. end+500ms of words[4..6] = 3.5–5.8s.
 assert.match(drill.textContent,/第 3\.5–5\.8 秒/);
 // An expired TTS link must degrade to the fallback, not a broken player.
 const tts=drill.querySelector('audio');
 assert.ok(tts);
 tts.dispatchEvent(new dom.window.Event('error'));
 await flush();
 assert.match(drill.textContent,/示范音频暂不可用/);
});

test('a superseded word play does not show an error hint',async()=>{
 const audioId='66666666-6666-4666-8666-666666666666';
 state.stage='speak';
 state.entries[12]={speakingPhase:'review',speakingComplete:'yes',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true,audio:audioId}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture follow-up',spoken:true}])};
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='speakingPart2');
 assert.ok(source);
 const words=[{word:'one',start:1,end:1.4,probability:.9},{word:'two',start:1.5,end:1.9,probability:.9}];
 const scorecard={schema:'bandroom-speaking-scorecard-v1',
  overall:{band:6,status:'reference',disclosure_zh:'参考估计',basis_zh:'流利度与连贯性参考估计均值'},
  criteria:[{key:'fluency_coherence',label_zh:'流利度与连贯性',band:6,status:'reference',disclosure_zh:'参考估计',evidence:{}}],
  drills:[],llm_status:'ok'};
 feedback=[{id:'fb-play',day:12,stage:'speak',attempt:source.id,evidence:'Play fixture',feedback:'一、评估：继续。',createdAt:'2026-11-09T01:00:00Z',
  analysis:{schema:'bandroom-grounded-analysis-v2',speechSeconds:5,items:[],transcript:words,scorecard}}];
 const realPlay=dom.window.HTMLMediaElement.prototype.play;
 dom.window.HTMLMediaElement.prototype.play=async()=>{const error=new Error('superseded');error.name='AbortError';throw error;};
 try{
  await mount();
  const card=document.querySelector('[aria-label="口语 Part 2 · 首次回答反馈"] .ss-card');
  assert.ok(card);
  const buttons=card.querySelectorAll('.ss-word');
  await act(async()=>{buttons[0].click();});
  await act(async()=>{buttons[1].click();});
  await flush();
  assert.doesNotMatch(card.textContent,/原录音暂时无法播放/);
 }finally{dom.window.HTMLMediaElement.prototype.play=realPlay;}
});

test('additions are hidden by the precision-first display',async()=>{
 const audioId='33333333-3333-4333-8333-333333333333';
 state.stage='speak';
 state.entries[12]={speakingPhase:'review',speakingComplete:'yes',
  speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'Fixture Part 2',spoken:true,audio:audioId}]),
  speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'Fixture follow-up',spoken:true}])};
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='speakingPart2');
 assert.ok(source);
 const first={wordIndex:0,phoneIndex:1,kind:'addition',target:'∅',actual:'AH',word:'think',startMs:1000,endMs:1080};
 const second={...first,gapOccurrence:1,startMs:2500,endMs:2570};
 feedback=[{id:'fb-repeated',day:12,stage:'speak',attempt:source.id,evidence:'Acoustic fixture',
  feedback:'回听两处添音。',createdAt:'2026-11-09T01:00:00Z',analysis:{errors:[first,second]}}];
 await mount();
 const section=document.querySelector('[aria-label="口语 Part 2 · 首次回答反馈"]');
 assert.ok(section);
 assert.equal(section.querySelectorAll('.af-error-card').length,0);
 assert.equal(section.querySelectorAll('[aria-label="实验性发音提示与回听"]').length,0);
 assert.match(section.textContent,/回听两处添音/);
 assert.equal(puts().length,0);
});

test('tiered pronunciation evidence renders confirmation and submits one verdict',async()=>{
 state.entries[12].writeOriginal='Independent answer with tiered pronunciation evidence.';
 const source=(await reviewAttempts(12,state.entries[12])).find(a=>a.field==='writeOriginal');
 assert.ok(source);
 const t3='六、建议自听对比（非错误断言）：\n1. 在 20.31 秒处的 the，可对比标准读音自听判断。';
 const t2='【T2 历史确认】\n1. 你在 8.10 秒处的 think：这一类常被读成 /d/。';
 const reliability='【T1 可靠性披露】本次检测到 36 次停顿，该计数仅供参考。';
 feedback=[{id:'fb-tier',day:12,stage:'write',attempt:source.id,evidence:'Tiered fixture',
  feedback:`T1 韵律建议。\n${t3}\n七、你的发音画像（建议性质）：\n本画像只记录检测器提出的类别。\n${t2}\n${reliability}`,
  createdAt:'2026-11-09T01:00:00Z',analysis:{pronunciation:{
   items:[{candidateId:'c-tier',word:'the',expected:'DH',actual:'D',atMs:20310,tier:'T3',isCatchTrial:false,detectorConfidence:0.64}],
   reliability:{pauseCount:36,pausePrecision:0.65},
   profile:{exists:false,classes:[]},
  }}}];
 await mount();
 const section=document.querySelector('[aria-label="写作首稿反馈"]');
 assert.ok(section);
 assert.match(section.textContent,/20\.31 秒/);
 assert.match(section.textContent,/还没有你的个人发音画像/);
 assert.match(section.textContent,/36 次停顿/);
 assert.match(section.textContent,/确实读错/);
 const prose=section.querySelector('.pc-prose');
 assert.ok(prose);
 assert.ok(!prose.querySelector('p').textContent.includes('六、建议自听对比'));
 assert.equal(section.querySelector('[data-tier="T3"] .pc-tier-text').textContent,t3);
 assert.equal(section.querySelector('[data-tier="T2"] .pc-tier-text').textContent,t2);
 assert.equal(section.querySelector('[data-tier="reliability"] .pc-tier-text').textContent,reliability);
 assert.equal(section.querySelectorAll('.pc-reliability').length,0,'prose reliability is not duplicated');
 const card=section.querySelector('.pc-card');
 assert.ok(card);
 await click(button('不确定'));
 assert.equal(mcpCalls.length,1);
 assert.equal(mcpCalls[0].params.name,'record_pronunciation_verdict');
 assert.deepEqual(mcpCalls[0].params.arguments,{candidateId:'c-tier',verdict:'unsure'});
 assert.match(card.textContent,/已记录：不确定（不计入画像）/);
 assert.equal(puts().length,0);
});
