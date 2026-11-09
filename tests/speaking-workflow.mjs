// Mounted React workflow, with synthetic microphone/network and isolated browser storage.
// Never connects to a deployed site or a real learner account.
import assert from 'node:assert/strict';
import {test,beforeEach,afterEach} from 'node:test';
import {JSDOM} from 'jsdom';
import {IDBFactory} from 'fake-indexeddb';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
const require=createRequire(import.meta.url), wrangler=createRequire(require.resolve('wrangler/package.json'));
mkdirSync('.sites-runtime/tests',{recursive:true});
await wrangler('esbuild').build({entryPoints:['app/studio.tsx'],bundle:true,platform:'node',format:'esm',
  outfile:'.sites-runtime/tests/studio.mjs',packages:'external',loader:{'.css':'empty'}});
const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example/'});
for(const key of ['window','document','navigator','HTMLElement','HTMLTextAreaElement','Event','MouseEvent','localStorage'])
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
window.scrollTo=()=>{};
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {default:Studio}=await import('../.sites-runtime/tests/studio.mjs');
const realTimeout=globalThis.setTimeout;
// Test the production deadlines without waiting tens of seconds per fault.
globalThis.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms>=2000?40:ms,...args);
const part2=JSON.stringify([{at:'2026-11-09T01:00:00.000Z',text:'Existing Part 2',spoken:true,audio:'11111111-1111-4111-8111-111111111111'}]);
let root,state,revision,calls,audioFault,stateFault,coachFault,pendingState;
let stopDelay=0,holdStop=false;
class Recorder {
  static isTypeSupported(){return true}
  state='inactive';mimeType='audio/webm';
  constructor(){Recorder.last=this}
  start(){this.state='recording'}
  stop(){assert.equal(this.state,'recording','stop called twice');this.state='inactive';if(!holdStop)realTimeout(()=>this.finish(),stopDelay)}
  finish(){this.ondataavailable?.({data:new Blob(['fixture audio'],{type:'audio/webm'})});this.onstop?.()}
}
const response=(status,data)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
const text=()=>document.body.textContent;
const button=label=>[...document.querySelectorAll('button')].find(b=>label instanceof RegExp?label.test(b.textContent):b.textContent===label);
const click=async target=>{assert.ok(target,'button exists');assert.equal(target.disabled,false,'button enabled');await act(async()=>target.click());await flush()};
const flush=async(ms=8)=>act(async()=>{await sleep(ms)});
async function mount(){root=createRoot(document.getElementById('root'));await act(async()=>root.render(createElement(Studio)));await flush();await click(button('继续口语练习'));}
async function unmount(){if(root){await act(async()=>root.unmount());root=null}}
async function record(){await click(document.querySelector('[aria-label="开始录音"]'));}
async function stop(){await click(document.querySelector('[aria-label="停止录音"]'));await flush(12)}
async function writeDraft(value){const area=document.querySelector('textarea');await act(async()=>{Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(area,value);area.dispatchEvent(new Event('input',{bubbles:true}))});}
function preserved(){assert.equal(state.day,12);assert.equal(state.stage,'speak');assert.equal(state.finished,false);assert.equal(state.entries[12].speakingPart2,part2);assert.deepEqual(state.completed,Array.from({length:11},(_,i)=>i+1));assert.equal(state.entries[11].speakingReview,'Earlier feedback');}
beforeEach(()=>{
  globalThis.indexedDB=new IDBFactory();localStorage.clear();globalThis.MediaRecorder=Recorder;
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[{stop(){}}]})}});
  revision=6;calls=[];audioFault=stateFault=coachFault=null;pendingState=null;stopDelay=0;holdStop=false;
  state={version:1,day:12,stage:'speak',finished:false,completed:Array.from({length:11},(_,i)=>i+1),checked:{11:'2026-11-09'},started:{11:'2026-11-02',12:'2026-11-09'},exam:'未选择',practice:{},entries:{11:{speakingReview:'Earlier feedback'},12:{speakingPart2:part2,speakingPhase:'followup'}}};
  globalThis.fetch=async(url,init={})=>{
    calls.push([url,init]);
    if(url==='/api/coach')return coachFault?coachFault():response(200,{account:'fixture-learner',extras:{},feedback:[]});
    if(url==='/api/state'&&!init.method)return response(200,{account:'fixture-learner',revision,state:structuredClone(state)});
    if(url==='/api/audio')return audioFault?audioFault(init):response(201,{id:init.headers['X-Bandroom-Attempt']});
    if(url==='/api/state'){
      if(stateFault)return stateFault(init);
      const payload=JSON.parse(init.body);state=payload.state;revision=payload.revision+1;return response(200,{revision});
    }
    throw Error('Unexpected fixture request '+url);
  };
});
afterEach(async()=>{await unmount()});
test('stop-and-submit finalizes audio exactly once and advances only on acknowledged save',async()=>{
  await mount();await writeDraft('A concrete reason');await record();stopDelay=12;
  stateFault=()=>new Promise(resolve=>{pendingState=resolve});
  const save=button('停止录音并保存回答');await act(async()=>{save.click();save.click()});await flush(20);
  assert.ok(!text().includes('SPEAKING REVIEW'));assert.equal(calls.filter(([u])=>u==='/api/audio').length,1);
  const puts=calls.filter(([u,o])=>u==='/api/state'&&o.method);assert.equal(puts.length,1);
  const payload=JSON.parse(puts[0][1].body);state=payload.state;revision++;
  await act(async()=>pendingState(response(200,{revision})));await flush();
  assert.match(text(),/SPEAKING REVIEW/);assert.equal(JSON.parse(state.entries[12].speakingFollowup).length,1);preserved();
});
test('blocked IndexedDB cannot permanently disable recording or submission',async()=>{
  globalThis.indexedDB={open:()=>({})};await mount();await flush(70);
  assert.equal(document.querySelector('[aria-label="开始录音"]').disabled,false);
  assert.match(text(),/本机.*不可用|本机.*超时/);
});
test('blocked draft write still permits upload while retaining the in-memory audio',async()=>{
  await mount();globalThis.indexedDB={open:()=>({})};await record();await stop();await flush(70);
  assert.ok(document.querySelector('audio[aria-label="试听本次录音"]'));
  assert.equal(button('保存回答，进入自评').disabled,false);
  await click(button('保存回答，进入自评'));await flush(70);assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('upload failure retains recording and typed draft across a page remount, then retries once',async()=>{
  await mount();await writeDraft('My unsent notes');await record();await stop();
  audioFault=()=>response(503,{error:'recordings_unavailable'});await click(button('保存回答，进入自评'));
  assert.ok(!state.entries[12].speakingFollowup);await unmount();await mount();
  assert.equal(document.querySelector('textarea').value,'My unsent notes');
  assert.ok(document.querySelector('audio[aria-label="试听本次录音"]'));
  audioFault=null;await click(button('保存回答，进入自评'));assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('upload timeout is bounded, explains the failure, and keeps the same attempt for retry',async()=>{
  await mount();await record();await stop();audioFault=()=>new Promise(()=>{});
  await click(button('保存回答，进入自评'));await flush(75);
  assert.equal(button('保存回答，进入自评').disabled,false);assert.match(text(),/超时/);
  const first=calls.find(([u])=>u==='/api/audio')[1].headers['X-Bandroom-Attempt'];
  audioFault=null;await click(button('保存回答，进入自评'));
  assert.equal(JSON.parse(state.entries[12].speakingFollowup)[0].audio,first);preserved();
});
test('login expiry locks access, retains the recording and restores it after authentication',async()=>{
  await mount();await writeDraft('Retain after auth expiry');await record();await stop();stateFault=()=>response(401,{error:'sign_in_required'});
  await click(button('保存回答，进入自评'));
  assert.ok(!state.entries[12].speakingFollowup);assert.match(text(),/登录已过期/);
  assert.equal(document.querySelector('.app-shell').hidden,true);
  const clip=document.querySelector('a[download]').href;preserved();
  stateFault=null;await click(button('重新读取进度'));
  assert.equal(document.querySelector('.app-shell').hidden,false);
  assert.equal(document.querySelector('a[download]').href,clip);
  assert.equal(document.querySelector('textarea').value,'Retain after auth expiry');
  await click(button('保存回答，进入自评'));assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('state timeout unlocks the UI, retains audio, and does not falsely advance',async()=>{
  await mount();await record();await stop();stateFault=()=>new Promise(()=>{});
  await click(button('保存回答，进入自评'));await flush(110);
  assert.equal(button('保存回答，进入自评').disabled,false);assert.ok(!state.entries[12].speakingFollowup);
  assert.match(text(),/尚未确认|超时/);assert.ok(document.querySelector('a[download]'));preserved();
});
test('concurrent state conflict retains draft and refresh recovers it without overwriting Part 2',async()=>{
  await mount();await writeDraft('Preserved concurrent draft');await record();await stop();stateFault=()=>response(409,{error:'revision_conflict'});
  await click(button('保存回答，进入自评'));assert.ok(!state.entries[12].speakingFollowup);
  stateFault=null;revision++;state.entries[12].speakingPart2Draft='Change from another tab';
  await click(button('重新读取'));await flush();assert.equal(document.querySelector('textarea').value,'Preserved concurrent draft');
  await click(button('保存回答，进入自评'));assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('malformed save acknowledgement never advances',async()=>{
  await mount();await record();await stop();stateFault=()=>response(200,{});
  await click(button('保存回答，进入自评'));assert.ok(!text().includes('SPEAKING REVIEW'));assert.ok(!state.entries[12].speakingFollowup);preserved();
});
test('a stalled coach request does not prevent answer saving',async()=>{
  coachFault=()=>new Promise(()=>{});await mount();await record();await stop();await click(button('保存回答，进入自评'));
  assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('delayed recorder stop disables duplicate stops and retains the resulting clip',async()=>{
  await mount();await record();holdStop=true;await click(document.querySelector('[aria-label="停止录音"]'));
  assert.equal(button('正在整理录音…')?.disabled,true);
  await act(async()=>Recorder.last.finish());await flush();assert.equal(button('保存回答，进入自评').disabled,false);
});
test('a lost commit response replays the identical request without uploading or appending twice',async()=>{
  await mount();await record();await stop();let first,puts=0;
  stateFault=async init=>{
    puts++;
    if(puts===1){first=init.body;const p=JSON.parse(first);state=p.state;revision++;throw Error('response lost')}
    assert.equal(init.body,first);return response(200,{revision});
  };
  await click(button('保存回答，进入自评'));
  assert.equal(puts,2);assert.equal(calls.filter(([u])=>u==='/api/audio').length,1);
  assert.equal(JSON.parse(state.entries[12].speakingFollowup).length,1);assert.match(text(),/SPEAKING REVIEW/);preserved();
});
for(const [status,error,message] of [[503,'unavailable',/503/],[422,'recording_not_found',/录音尚未在云端找到/],[422,'recording_question_mismatch',/录音与本题/]]){
  test(`state ${status}/${error} explains the cause and preserves the draft`,async()=>{
    await mount();await writeDraft('Keep this explanation');await record();await stop();stateFault=()=>response(status,{error});
    await click(button('保存回答，进入自评'));assert.match(text(),message);
    assert.equal(button('保存回答，进入自评').disabled,false);assert.ok(document.querySelector('a[download]'));
    assert.equal(document.querySelector('textarea').value,'Keep this explanation');assert.ok(!state.entries[12].speakingFollowup);preserved();
  });
}
test('an expired upload login retains audio and permits retry after reauthentication',async()=>{
  await mount();await record();await stop();audioFault=()=>response(401,{error:'sign_in_required'});
  await click(button('保存回答，进入自评'));assert.match(text(),/重新登录/);assert.ok(document.querySelector('a[download]'));
  assert.ok(!state.entries[12].speakingFollowup);audioFault=null;await click(button('保存回答，进入自评'));assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('a stalled response body is bounded as well as the initial network request',async()=>{
  await mount();await record();await stop();audioFault=async()=>({ok:true,status:201,json:()=>new Promise(()=>{})});
  await click(button('保存回答，进入自评'));await flush(75);assert.match(text(),/超时/);
  assert.equal(button('保存回答，进入自评').disabled,false);assert.ok(document.querySelector('a[download]'));preserved();
});
test('an unchanged revision cannot acknowledge a changed answer',async()=>{
  await mount();await record();await stop();stateFault=()=>response(200,{revision});await click(button('保存回答，进入自评'));
  assert.ok(!text().includes('SPEAKING REVIEW'));assert.match(text(),/尚未确认/);assert.ok(document.querySelector('a[download]'));preserved();
});
test('a missing stop event recovers partial audio without auto-submitting or accepting a late duplicate',async()=>{
  await mount();await record();holdStop=true;const old=Recorder.last;
  await act(async()=>old.ondataavailable({data:new Blob(['partial'],{type:'audio/webm'})}));
  await click(button('停止录音并保存回答'));await flush(75);
  assert.match(text(),/超时或中断/);assert.ok(document.querySelector('a[download]'));assert.equal(calls.filter(([u])=>u==='/api/audio').length,0);
  await record();await act(async()=>old.finish());assert.ok(document.querySelector('[aria-label="停止录音"]'));
  holdStop=false;await stop();await click(button('保存回答，进入自评'));assert.match(text(),/SPEAKING REVIEW/);preserved();
});
test('recorder errors with no subsequent stop cannot leave the controls stuck',async()=>{
  await mount();await record();await act(async()=>Recorder.last.onerror());await flush(75);
  assert.equal(document.querySelector('[aria-label="开始录音"]').disabled,false);
  assert.ok(!state.entries[12].speakingFollowup);preserved();
});
