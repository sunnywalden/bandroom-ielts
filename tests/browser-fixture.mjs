// Local-only acceptance harness. Runs the production UI, state/audio/coach
// handlers, real D1 migrations and R2 writes with an isolated synthetic account.
// No production URLs, credentials, bindings or learner data are used.
import {createRequire} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare}=wrangler('miniflare'),esbuild=wrangler('esbuild');
const client=await esbuild.build({stdin:{contents:`
import React from 'react';import {createRoot} from 'react-dom/client';import Studio from './app/studio.tsx';import './app/globals.css';
import Pronunciation from './app/pronunciation.tsx';import {pronunciations} from './app/pronunciations.ts';import './app/exercise.css';
// Feed a synthetic tone through the browser's REAL MediaRecorder. This avoids
// recording the operator's microphone or requiring microphone permissions.
const contexts=[];
Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{
 const context=new AudioContext(),oscillator=context.createOscillator(),out=context.createMediaStreamDestination();
 oscillator.connect(out);oscillator.start();await context.resume();contexts.push(context);return out.stream;
}}});
const actualFetch=window.fetch.bind(window);
const actualPlay=HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play=function(){
 const fault=document.querySelector('#fault').value;
 if(fault==='pronunciationError')return Promise.reject(new DOMException('Fixture playback failure','NotSupportedError'));
 if(fault==='pronunciationDelay')return new Promise(()=>{});
 return actualPlay.call(this).catch(error=>{
  document.querySelector('#evidence').textContent=JSON.stringify({mediaError:error.name,message:error.message});
  throw error;
 });
};
window.fetch=(url,init={})=>{const headers=new Headers(init.headers);headers.set('X-Fixture-Fault',document.querySelector('#fault').value);return actualFetch(url,{...init,headers})};
document.querySelector('#inspect').onclick=async()=>{const response=await actualFetch('/__fixture/status');document.querySelector('#evidence').textContent=JSON.stringify(await response.json(),null,2)};
document.querySelector('#coach-review').onclick=async()=>{const response=await actualFetch('/__fixture/coach',{method:'POST'});document.querySelector('#evidence').textContent=JSON.stringify(await response.json(),null,2)};
createRoot(document.querySelector('#root')).render(location.pathname==='/__fixture/pronunciations'
 ? <main className="ex-card"><h1>真人美音独立验收</h1>{[...Object.keys(pronunciations),'unlisted fixture word'].map(word=><section key={word}><h2>{word}</h2><Pronunciation word={word}/></section>)}</main>
 : <Studio/>);
`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,format:'esm',platform:'browser',write:false,outdir:'.sites-runtime/browser-fixture',loader:{'.css':'css'},define:{'process.env.NODE_ENV':'"production"'}});
const html=`<!doctype html><html lang="zh"><meta charset="utf-8"><title>Bandroom isolated acceptance</title><link rel="stylesheet" href="/fixture.css"><body>
<aside style="position:fixed;z-index:9999;bottom:0;right:0;max-width:520px;background:#fff3d5;padding:10px;border:2px solid #695322">
<strong>独立测试账号 · 虚构学习数据</strong><label>测试故障<select id="fault"><option value="none">正常</option><option value="upload503">上传失败 503</option><option value="state503">进度失败 503</option><option value="auth">登录过期</option><option value="delay">延迟保存</option></select></label>
<script>document.querySelector('#fault').insertAdjacentHTML('beforeend','<option value="pronunciationError">词典播放失败</option><option value="pronunciationDelay">词典加载超时</option>')</script>
<script>document.querySelector('#fault').insertAdjacentHTML('beforeend','<option value="coach503">反馈同步失败</option><option value="coachAuth">反馈登录过期</option><option value="coachDelay">反馈延迟</option>')</script>
<button id="coach-review">模拟 Work 返回批改</button><button id="inspect">刷新测试证据</button><pre id="evidence" style="max-height:180px;overflow:auto;font-size:10px"></pre></aside>
<div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
const worker=await esbuild.build({stdin:{contents:`
import {env} from 'cloudflare:workers';
import {GET as getState,PUT} from './app/api/state/route.ts';
import {GET as getAudio,POST} from './app/api/audio/route.ts';
import {GET as getCoach} from './app/api/coach/route.ts';
import {GET as getRecovery} from './app/api/audio/recovery/route.ts';
import {callCoach} from './lib/coach.ts';
export default {async fetch(request){
 const url=new URL(request.url),fault=request.headers.get('X-Fixture-Fault');
 if(url.pathname==='/'||url.pathname==='/__fixture/pronunciations')return new Response(env.HTML,{headers:{'Content-Type':'text/html'}});
 if(url.pathname==='/fixture.js')return new Response(env.JS,{headers:{'Content-Type':'text/javascript'}});
 if(url.pathname==='/fixture.css')return new Response(env.CSS,{headers:{'Content-Type':'text/css'}});
 if(url.pathname==='/api/state'){
  if(request.method==='GET')return getState();
  if(fault==='auth')return Response.json({error:'sign_in_required'},{status:401});
  if(fault==='state503')return Response.json({error:'fixture_unavailable'},{status:503});
  if(fault==='delay')await new Promise(r=>setTimeout(r,2000));
  return PUT(request);
 }
 if(url.pathname==='/api/audio'){
  if(request.method==='GET')return getAudio(request);
  if(fault==='upload503')return Response.json({error:'fixture_unavailable'},{status:503});
  return POST(request);
 }
 if(url.pathname==='/api/coach'){
  if(fault==='coach503')return Response.json({error:'fixture_unavailable'},{status:503});
  if(fault==='coachAuth')return Response.json({error:'sign_in_required'},{status:401});
  if(fault==='coachDelay')await new Promise(r=>setTimeout(r,2000));
  return getCoach();
 }
 if(url.pathname==='/__fixture/coach'&&request.method==='POST'){
  const result=await callCoach('fixture-browser-only','read_study_session',{day:12});
  if(result.isError)return Response.json(result,{status:400});
  const session=JSON.parse(result.content[0].text),attempt=session.reviewAttempts.find(a=>a.field==='writeOriginal');
  if(!attempt)return Response.json({error:'Submit a fixture original first'},{status:400});
  return Response.json(await callCoach('fixture-browser-only','add_coach_feedback',{day:12,stage:attempt.stage,attempt:attempt.id,
   evidence:'独立测试首稿：'+attempt.response,feedback:'独立测试批改：将 company need 改为 companies need，保持主谓一致；下一步补充一个具体例子。'}));
 }
 if(url.pathname==='/api/audio/recovery')return getRecovery(request);
 if(url.pathname==='/__fixture/status'){
  const state=await(await getState()).json(),objects=await env.BUCKET.list(),coach=await(await getCoach()).json();
  return Response.json({...state,feedback:coach.feedback,recordings:objects.objects.map(o=>({key:o.key,size:o.size,etag:o.etag}))});
 }
 return new Response('Not found',{status:404});
}}`,resolveDir:process.cwd()},bundle:true,format:'esm',write:false,platform:'browser',external:['cloudflare:workers'],plugins:[{name:'fixture-identity',setup(b){
 b.onResolve({filter:/^@\/app\/chatgpt-auth$/},()=>({path:'identity',namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export async function getChatGPTUser(){return {userId:"fixture-browser-only"}}'}));
}}]});
const mf=new Miniflare({host:'127.0.0.1',port:8788,cf:false,modules:true,script:worker.outputFiles[0].text,compatibilityDate:'2025-03-01',d1Databases:['DB'],r2Buckets:['BUCKET'],bindings:{HTML:html,JS:client.outputFiles.find(f=>f.path.endsWith('.js')).text,CSS:client.outputFiles.find(f=>f.path.endsWith('.css')).text}});
await mf.ready;
const db=await mf.getD1Database('DB');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort()){
 for(const statement of readFileSync('drizzle/'+file,'utf8').split(';').map(x=>x.replace(/--> statement-breakpoint/g,'').trim()).filter(Boolean))await db.prepare(statement).run();
}
const id='11111111-1111-4111-8111-111111111111',at=new Date().toISOString(),day=at.slice(0,10);
const state={version:1,day:12,stage:'speak',finished:false,completed:Array.from({length:11},(_,i)=>i+1),checked:{11:day},started:{11:day,12:day},exam:'未选择',practice:{},entries:{11:{speakingReview:'Preserved fixture feedback'},12:{speakingPart2:JSON.stringify([{at,text:'Preserved fixture Part 2',spoken:true,audio:id}]),speakingPart2Draft:'',speakingPhase:'followup'}}};
// Opt-in vocabulary entry point for UI acceptance without touching a learner account.
if(['vocab','write'].includes(process.env.BANDROOM_FIXTURE_STAGE)) {
 state.stage=process.env.BANDROOM_FIXTURE_STAGE;
 Object.assign(state.entries[12],{speakingPhase:'review',speakingComplete:'yes',speakingReview:'让时态前后一致',
  speakingFollowup:JSON.stringify([{at,text:'Synthetic fixture follow-up answer',spoken:true}])});
}
await db.prepare('INSERT INTO learner_states (user_id,revision,state) VALUES (?,?,?)').bind('fixture-browser-only',6,JSON.stringify(state)).run();
await db.prepare('INSERT INTO teacher_feedback (id,user_id,day,stage,attempt,evidence,feedback,created_at) VALUES (?,?,?,?,?,?,?,?)').bind('fixture-feedback','fixture-browser-only',11,'speak','fixture-earlier','Synthetic evidence','Preserved earlier coach feedback',at).run();
const sample=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.3','-c:a','libopus','-f','webm','pipe:1']);
const bucket=await mf.getR2Bucket('BUCKET');await bucket.put('speaking/fixture-browser-only/'+id,sample,{httpMetadata:{contentType:'audio/webm'},customMetadata:{purpose:'speaking',day:'12',phase:'part2'}});
console.log(JSON.stringify({url:String(await mf.ready),account:'fixture-browser-only',revision:6,part2:id,part2Bytes:sample.length}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await mf.dispose();process.exit(0)});
await new Promise(()=>{});
