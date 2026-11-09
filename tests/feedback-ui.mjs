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
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {default:Studio}=await import('../.sites-runtime/tests/feedback-studio.mjs');
const realInterval=globalThis.setInterval,realClear=globalThis.clearInterval;
let poll;
globalThis.setInterval=(fn,ms,...args)=>ms===10000?(poll=fn,'feedback-poll'):realInterval(fn,ms,...args);
globalThis.clearInterval=id=>id==='feedback-poll'?poll=undefined:realClear(id);
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
let root,state,revision,feedback,calls,coachFault,stateFault;
const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(b=>label instanceof RegExp?label.test(b.textContent):b.textContent===label);
const flush=async()=>act(async()=>{await sleep(15)});
const click=async target=>{assert.ok(target);assert.equal(target.disabled,false);await act(async()=>target.click());await flush()};
const puts=()=>calls.filter(([url,init])=>url==='/api/state'&&init.method==='PUT');
async function mount(){root=createRoot(document.getElementById('root'));await act(async()=>root.render(createElement(Studio)));await flush();await click(button(state.stage==='speak'?'继续口语练习':'继续当前练习'));}
async function unmount(){if(root){await act(async()=>root.unmount());root=null}}
async function write(value){const el=document.querySelector('textarea');assert.ok(el);await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}))});await flush();}
async function tick(){assert.ok(poll);await act(async()=>poll());await flush();}
async function row(field,message){
 const attempt=(await reviewAttempts(12,state.entries[12])).find(a=>a.field===field);assert.ok(attempt);
 return {id:crypto.randomUUID(),day:12,stage:attempt.stage,attempt:attempt.id,evidence:'Synthetic submitted evidence',feedback:message,createdAt:'2026-11-09T01:00:00Z'};
}
beforeEach(()=>{
 localStorage.clear();calls=[];feedback=[];coachFault=stateFault=null;revision=21;
 state={version:1,day:12,stage:'write',finished:false,completed:Array.from({length:11},(_,i)=>i+1),checked:{11:'2026-11-09'},started:{11:'2026-11-02',12:'2026-11-09'},exam:'未选择',practice:{},entries:{11:{speakingReview:'Preserved older feedback'},12:{writeOriginal:'Independent original answer.',writeCondition:'独立 · 未计时'}}};
 globalThis.fetch=async(url,init={})=>{
  calls.push([url,init]);
  if(url==='/api/coach')return coachFault?coachFault(init):response(200,{account:'fixture-feedback-ui',extras:{},feedback:structuredClone(feedback)});
  if(url==='/api/state'&&!init.method)return response(200,{account:'fixture-feedback-ui',revision,state:structuredClone(state)});
  if(url==='/api/state'){
   if(stateFault)return stateFault(init);
   const payload=JSON.parse(init.body);state=payload.state;revision=payload.revision+1;return response(200,{revision});
  }
  throw Error('Unexpected fixture request '+url);
 };
});
afterEach(async()=>{await unmount()});
test('delayed Work review arrives by polling at the original and preserves the revision draft',async()=>{
 await mount();assert.match(text(),/等待 Work 教练/);
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
 stateFault=()=>response(503,{error:'unavailable'});await click(button('提交并锁定首稿'));
 assert.equal(state.entries[12].writeOriginal,undefined);assert.equal(document.querySelector('textarea').value,draft);
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 const submit=button('提交并锁定首稿'),before=puts().length;
 await act(async()=>{submit.click();submit.click()});await flush();
 assert.equal(puts().length,before+1);assert.equal(state.entries[12].writeOriginal,undefined);
 assert.equal(document.querySelector('textarea').readOnly,true);
 state=payload.state;revision++;
 await act(async()=>resolve(response(200,{revision})));await flush();
 assert.equal(state.entries[12].writeOriginal,draft);assert.equal(state.stage,'write');assert.equal(state.finished,false);
 assert.match(text(),/等待 Work 教练/);assert.deepEqual(state.completed,Array.from({length:11},(_,i)=>i+1));
});
test('typing during a delayed draft save survives its acknowledgement and a page reload',async()=>{
 delete state.entries[12].writeOriginal;delete state.entries[12].writeCondition;
 await mount();await write('The draft sent to the server.');
 let resolve,payload;stateFault=init=>{payload=JSON.parse(init.body);return new Promise(r=>{resolve=r})};
 await click(button('保存草稿'));
 assert.equal(document.querySelector('textarea').readOnly,false);
 await write('New edits made while the save is pending.');
 state=payload.state;revision++;
 await act(async()=>resolve(response(200,{revision})));await flush();
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
 await act(async()=>resolve(response(200,{revision})));await flush();
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
 await click(button('保存复盘，交给 Work 教练'));
 assert.equal(document.querySelector('textarea').readOnly,true);
 state=payload.state;revision++;
 await act(async()=>resolve(response(200,{revision})));await flush();
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
 await act(async()=>resolve(response(200,{revision})));await flush();stateFault=null;
 assert.equal(state.stage,'speak');assert.equal(state.entries[12].speakingComplete,'yes');
 assert.match(document.querySelector('[aria-label="口语自评反馈"]').textContent,/等待 Work 教练/);
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
