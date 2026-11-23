// Session recorder contract: mic check, countdown, honest level verdicts,
// interruption handling and full keyboard operation. Synthetic media only.
import assert from 'node:assert/strict';
import {test,beforeEach,afterEach} from 'node:test';
import {JSDOM} from 'jsdom';
import {createRequire} from 'node:module';
import {mkdirSync} from 'node:fs';
import {setTimeout as sleep,setImmediate as tick} from 'node:timers/promises';

const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
mkdirSync('.sites-runtime/tests',{recursive:true});
await wrangler('esbuild').build({entryPoints:['app/speaking-recorder.tsx'],bundle:true,platform:'node',format:'esm',
  outfile:'.sites-runtime/tests/recorder.mjs',packages:'external',loader:{'.css':'empty'}});

const dom=new JSDOM('<div id="root"></div>',{url:'https://fixture.example/'});
for(const key of ['window','document','navigator','HTMLElement','Event','MouseEvent','KeyboardEvent','localStorage'])
  Object.defineProperty(globalThis,key,{configurable:true,value:dom.window[key]});
let urlCount=0;
URL.createObjectURL=()=>`blob:fixture-${++urlCount}`;
URL.revokeObjectURL=()=>{};
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const {createElement,act}=await import('react'),{createRoot}=await import('react-dom/client');
const {default:SessionRecorder}=await import('../.sites-runtime/tests/recorder.mjs');

// Deadlines are production values; shrink the 1s countdown, 3s level check and
// other short waits so tests stay fast. Longer safety timers (4s stop arming,
// 10s stop fallback, 30s getUserMedia timeout) keep their real duration.
const realTimeout=globalThis.setTimeout,realClearTimeout=globalThis.clearTimeout;
globalThis.setTimeout=(fn,ms,...args)=>realTimeout(fn,ms>=1000&&ms<=3000?30:ms,...args);
const raf=fn=>realTimeout(()=>fn(performance.now()),16);
globalThis.requestAnimationFrame=raf;globalThis.cancelAnimationFrame=id=>realClearTimeout(id);
globalThis.clearTimeout=realClearTimeout;

const flush=async(ms=16)=>act(async()=>{await sleep(ms);await tick()});
const text=()=>document.body.textContent??"";

function button(label){return [...document.querySelectorAll('button')].find(entry=>
  label instanceof RegExp?label.test(entry.textContent??""):entry.textContent===label)}
async function press(target){assert.ok(target,`target exists: ${target}`);await act(async()=>target.click());await flush()}
async function key(target,name,keyName,code){
  await act(async()=>{
    target.dispatchEvent(new dom.window.KeyboardEvent(name,{key:keyName,code:code??keyName,bubbles:true,cancelable:true}));
  });
  await flush();
}

let lastStream;
function makeTrack(){
  const track=new dom.window.EventTarget();
  track.stop=()=>{track.stopped=true};
  return track;
}
function makeStream(){
  const track=makeTrack();
  lastStream={track,getTracks:()=>[track]};
  return lastStream;
}
function recorderClass({pause=false}={}){
  return class Recorder{
    static isTypeSupported(type){return type==="audio/webm;codecs=opus"||type==="audio/mp4"}
    state="inactive";mimeType="audio/webm;codecs=opus";
    constructor(stream,options){Recorder.last=this;this.stream=stream;this.options=options}
    start(){this.state="recording"}
    stop(){
      if(this.state==="inactive")return;
      this.state="inactive";const rec=this;
      queueMicrotask(()=>{rec.ondataavailable?.({data:new Blob(["fixture-audio"],{type:rec.mimeType})});rec.onstop?.()});
    }
  };
}
function pausableRecorder(){
  const Base=recorderClass();
  Base.prototype.pause=function(){this.state="paused"};
  Base.prototype.resume=function(){this.state="recording"};
  return Base;
}
function audioContext(fill=0){
  return class Ctx{
    state="running";
    createMediaStreamSource(){return {connect(){}}}
    createAnalyser(){return {fftSize:1024,getFloatTimeDomainData(array){array.fill(fill)}}}
    resume(){return Promise.resolve()}
    close(){return Promise.resolve()}
  };
}

let root,props,stopRef,clips,modes,discards;
async function mount(patch={}){
  clips=[];modes=[];discards=[];lastStream=null;stopRef={current:null};
  props={limit:120,clip:null,disabled:false,practice:true,heading:"录下你的回答",stopRequestRef:stopRef,
    onClip:(blob,meta)=>clips.push({blob,meta}),onActive:mode=>modes.push(mode),onDiscard:()=>discards.push(1),...patch};
  root=createRoot(document.getElementById("root"));
  await act(async()=>root.render(createElement(SessionRecorder,props)));
  await flush(4);
}
async function unmount(){
  if(!root)return;
  await act(async()=>root.unmount());root=null;
  document.getElementById("root").replaceChildren();
}
async function beginRecording(){
  const mic=document.querySelector('[aria-label="开始录音"]');
  assert.ok(mic,"start button is present");
  await act(async()=>mic.click());
  await flush(180);
  assert.ok(document.querySelector('[aria-label="停止录音"]'),"recording started");
}
async function stopRecording(){
  const mic=document.querySelector('[aria-label="停止录音"]');
  assert.ok(mic,"stop button is present");
  await act(async()=>mic.click());
  await flush(60);
}

beforeEach(()=>{
  localStorage.clear();
  globalThis.MediaRecorder=recorderClass();
  window.AudioContext=undefined;
  Object.defineProperty(navigator,"mediaDevices",{configurable:true,value:{
    getUserMedia:async()=>makeStream(),
    enumerateDevices:async()=>[
      {kind:"audioinput",deviceId:"mic-1",label:"内置麦克风"},
      {kind:"audioinput",deviceId:"mic-2",label:"耳机麦克风"},
      {kind:"videoinput",deviceId:"cam-1",label:"Camera"},
    ],
  }});
  Object.defineProperty(navigator,"wakeLock",{configurable:true,value:undefined});
});
afterEach(async()=>{await unmount()});

test("unsupported browsers are blocked with an explanation",async()=>{
  globalThis.MediaRecorder=undefined;
  await mount();
  assert.match(text(),/这个浏览器不能录音/);
  assert.equal(document.querySelector('[aria-label="开始录音"]').disabled,true);
});

test("permission denial is explained and the check panel stays available",async()=>{
  navigator.mediaDevices.getUserMedia=async()=>{const error=Error("denied");error.name="NotAllowedError";throw error};
  await mount();
  await act(async()=>document.querySelector('[aria-label="开始录音"]').click());
  await flush(40);
  assert.match(text(),/麦克风权限被拒绝/);
  assert.match(text(),/默认麦克风（授权后可以切换设备）/);
  assert.ok(button("允许麦克风并检查"));
  assert.equal(clips.length,0);
});

test("mic check lists devices, reuses the stored device and starts recording",async()=>{
  await mount();
  await act(async()=>document.querySelector('[aria-label="开始录音"]').click());
  await flush(70);
  assert.match(text(),/先检查麦克风/);
  const select=document.querySelector(".sp-mic-check select");
  assert.ok(select,"device select appears after permission is granted");
  assert.deepEqual([...select.options].map(option=>option.textContent),["默认麦克风","内置麦克风","耳机麦克风"]);
  assert.match(text(),/浏览器未提供电平检测/);
  await press(button("使用此麦克风开始录音"));
  await flush(180);
  assert.ok(document.querySelector('[aria-label="停止录音"]'));
  assert.equal(localStorage.getItem("bandroom-mic-device"),"default");
  assert.ok(modes.includes("waiting")&&modes.includes("recording"));
});

test("the countdown can be cancelled without recording anything",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();
  await act(async()=>document.querySelector('[aria-label="开始录音"]').click());
  await flush(4);
  assert.match(text(),/即将开始录音/);
  await press(button("取消（Esc）"));
  await flush(160);
  assert.match(text(),/已取消录音倒计时/);
  assert.equal(document.querySelector('[aria-label="停止录音"]'),null);
  assert.equal(clips.length,0);
});

test("pause is offered only when MediaRecorder really supports it",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  globalThis.MediaRecorder=recorderClass();
  await mount();await beginRecording();
  assert.equal(button("暂停录音"),undefined);
  assert.match(text(),/此浏览器不支持录音暂停/);
  await stopRecording();await unmount();

  globalThis.MediaRecorder=pausableRecorder();
  await mount();await beginRecording();
  await press(button("暂停录音"));
  assert.equal(MediaRecorder.last.state,"paused");
  assert.match(text(),/录音已暂停/);
  await press(button("继续录音"));
  assert.equal(MediaRecorder.last.state,"recording");
  await stopRecording();
});

test("the last-seconds warning appears and the take auto-stops at the limit",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  const realNow=Date.now;let offset=0;Date.now=()=>realNow()+offset;
  try{
    await mount({limit:5});await beginRecording();
    offset=2500;await flush(260);
    assert.match(text(),/还剩 3 秒/);
    offset=6000;await flush(260);
    assert.equal(document.querySelector('[aria-label="停止录音"]'),null);
    assert.equal(clips.length,1);
    assert.ok(clips[0].meta.durationMs>=5900,`duration ${clips[0].meta.durationMs}`);
    assert.equal(clips[0].meta.incomplete,false);
  }finally{Date.now=realNow}
});

test("silent takes are labelled as a device estimate, never a calibrated score",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  window.AudioContext=audioContext(0);
  await mount();await beginRecording();
  await flush(300);
  await stopRecording();
  assert.equal(clips.length,1);
  assert.equal(clips[0].meta.metered,true);
  assert.equal(clips[0].meta.silent,true);
  assert.match(text(),/大部分静音：设备电平估算，非校准指标/);
});

test("audible takes report detected speech without inventing a score",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  window.AudioContext=audioContext(0.2);
  await mount();await beginRecording();
  await flush(300);
  await stopRecording();
  assert.equal(clips[0].meta.silent,false);
  assert.match(text(),/检测到语音：设备电平估算，非校准指标/);
  assert.doesNotMatch(text(),/\b[0-9](\.[0-9])?\s*分/);
});

test("a track that ends keeps the partial take and labels it incomplete",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();await beginRecording();
  await act(async()=>lastStream.track.dispatchEvent(new dom.window.Event("ended")));
  await flush(80);
  assert.equal(clips.length,1);
  assert.equal(clips[0].meta.incomplete,true);
  assert.equal(clips[0].meta.interrupted,true);
  assert.match(text(),/录音可能不完整/);
});

test("an access lock stops the in-progress take",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();await beginRecording();
  await act(async()=>window.dispatchEvent(new dom.window.CustomEvent("bandroom:access-locked")));
  await flush(80);
  assert.equal(document.querySelector('[aria-label="停止录音"]'),null);
  assert.equal(clips.length,1);
  assert.equal(clips[0].meta.incomplete,true,"an early stop keeps the partial take labelled");
  assert.match(text(),/录音可能不完整|已放弃/);
});

test("Space starts, arms a stop and confirms with a second press",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();
  const mic=document.querySelector('[aria-label="开始录音"]');
  await act(async()=>{mic.focus();mic.dispatchEvent(new dom.window.KeyboardEvent("keydown",{key:" ",bubbles:true,cancelable:true}))});
  await flush(180);
  assert.ok(document.querySelector('[aria-label="停止录音"]'));
  const stop=document.querySelector('[aria-label="停止录音"]');
  await key(stop,"keydown"," ");
  assert.match(text(),/再按一次空格或回车确认停止/);
  assert.equal(clips.length,0,"first press only arms the stop");
  await key(stop,"keydown"," ");
  await flush(40);
  assert.equal(clips.length,1);
});

test("Escape confirms before discarding a live take",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();await beginRecording();
  await key(window,"keydown","Escape");
  assert.match(text(),/放弃本次录音？/);
  await press(button("继续录音"));
  assert.ok(document.querySelector('[aria-label="停止录音"]'),"recording continues");
  await key(window,"keydown","Escape");
  await press(button("放弃本次录音"));
  await flush(60);
  assert.equal(clips.length,0);
  assert.match(text(),/已放弃这次录音/);
  assert.equal(document.querySelector('[aria-label="开始录音"]')!==null,true);
});

test("re-recording a finished take discards it and restarts the countdown",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();await beginRecording();await stopRecording();
  assert.equal(clips.length,1);
  await press(button("重新录制"));
  await flush(120);
  assert.equal(discards.length,1);
  assert.match(text(),/即将开始录音/);
});

test("a wake-lock fallback instruction is shown when the API is missing",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();await beginRecording();
  assert.match(text(),/请保持屏幕常亮/);
  await stopRecording();
});

test("the wake lock is requested inside the start gesture when available",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  let requests=0;
  Object.defineProperty(navigator,"wakeLock",{configurable:true,value:{request:async()=>{requests++;return {release:async()=>{},addEventListener(){}}}}});
  await mount();await beginRecording();
  assert.equal(requests,1);
  assert.doesNotMatch(text(),/请保持屏幕常亮/);
  await stopRecording();
});

test("the take summary survives parent clip adoption and a second take (browser regression)",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  window.AudioContext=audioContext(0.2);
  await mount();await beginRecording();await stopRecording();
  assert.equal(clips.length,1);
  // The parent adopts the take as the current clip, as SessionTask.keep does.
  await act(async()=>root.render(createElement(SessionRecorder,{...props,clip:clips[0].blob})));
  await flush();
  assert.match(text(),/检测到语音：设备电平估算，非校准指标/);
  // A second take must not be cleared by the previous clip's clipSeen flag.
  await beginRecording();await stopRecording();
  assert.equal(clips.length,2);
  assert.match(text(),/本次录音/);
  assert.match(text(),/检测到语音：设备电平估算，非校准指标/);
});

test("microphone status is announced and the button exposes its state",async()=>{
  localStorage.setItem("bandroom-mic-device","default");
  await mount();
  const mic=document.querySelector('[aria-label="开始录音"]');
  assert.equal(mic.getAttribute("aria-pressed"),"false");
  assert.equal(mic.getAttribute("aria-describedby"),"sp-rec-status");
  const live=document.querySelector(".sp-sr");
  assert.equal(live.getAttribute("aria-live"),"polite");
  await beginRecording();
  assert.equal(document.querySelector('[aria-label="停止录音"]').getAttribute("aria-pressed"),"true");
  assert.match(document.querySelector(".sp-sr").textContent,/录音开始/);
});
