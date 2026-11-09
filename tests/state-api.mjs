// Run from the checkout root: node tests/state-api.mjs (Node 24+).
// Real route handlers, Drizzle query compilation, migrations, and SQLite writes.
// Only the platform's authenticated identity and object-store boundary are simulated.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const base=pathToFileURL(process.cwd()+'/');
const sql=new DatabaseSync(':memory:');
for(const migration of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())
  sql.exec(readFileSync('drizzle/'+migration,'utf8'));
const clips=new Set(),identity=new AsyncLocalStorage();
globalThis.fixtureIdentity=identity;
globalThis.fixturePlatform={
  DB:{prepare(query){const statement=sql.prepare(query);statement.setReturnArrays(true);return {
    bind:(...args)=>({raw:async()=>statement.all(...args)})};}},
  BUCKET:{head:async key=>clips.has(key)?{size:44}:null}
};
registerHooks({resolve(specifier,ctx,next){
  const mock=source=>({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
  if(specifier==='cloudflare:workers')return mock('export const env=globalThis.fixturePlatform');
  if(specifier==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.fixtureIdentity.getStore()');
  if(ctx.parentURL && !ctx.parentURL.includes('/node_modules/') && (specifier.startsWith('@/')||specifier.startsWith('.'))){
    const url=specifier.startsWith('@/')?new URL(specifier.slice(2),base):new URL(specifier,ctx.parentURL);
    for(const suffix of ['.ts','/index.ts']) if(existsSync(fileURLToPath(url)+suffix))return {url:url.href+suffix,shortCircuit:true};
  }return next(specifier,ctx);
}});
const {GET,PUT}=await import('../app/api/state/route.ts');
const {initial,dayStamp}=await import('../app/ledger.ts');
const {getExercises}=await import('../app/curriculum.ts');
const {snapshotSchema}=await import('../app/api/state/transition.ts');
const origin='https://study.example',owner='learner-a',other='learner-b',now=dayStamp();
const get=async(id=owner)=>identity.run(id&&{userId:id},async()=>{const r=await GET();return [r.status,await r.json()]});
const put=async(revision,state,{actor=owner,header=actor,from=origin}={})=>
  identity.run(actor&&{userId:actor},async()=>{const r=await PUT(new Request(origin+'/api/state',{method:'PUT',
    headers:{'Content-Type':'application/json',Origin:from,'X-Bandroom-Account':header??''},body:JSON.stringify({revision,state})}));
    return [r.status,await r.json()];});
let checks=0;
function eq(actual,expected,context){assert.deepEqual(actual,expected,context);checks++}
let state=initial(),revision=0;
const edit=fn=>{const s=structuredClone(state);fn(s);return s;};
async function commit(fn){const next=edit(fn);const [status,data]=await put(revision,next);eq(status,200,JSON.stringify(data));eq(data.revision,revision+1);state=next;revision=data.revision;}
async function reject(fn,expected=422){const [status]=await put(revision,edit(fn));eq(status,expected)}
const withEntry=patch=>s=>{s.entries[s.day]={...s.entries[s.day],...patch}};
const mark=patch=>commit(withEntry(patch));
const advance=k=>commit(s=>{s.stage=k});
const finish=()=>commit(s=>{s.finished=true;s.completed.push(s.day);s.checked[s.day]=now;s.entries[s.day].reviewMemo='Reviewed.'});
const start=n=>commit(s=>{s.day=n;s.finished=false;s.stage='speak';s.started[n]=now});
const submitVoice=(k,options={})=>({[k]:JSON.stringify([{at:new Date().toISOString(),text:'Fixture response',spoken:true,...options}]),speakingPhase:k==='speakingPart2'?'followup':'review'});
eq((await get(null))[0],401);eq((await put(0,state,{actor:null}))[0],401);
eq(await get(),[200,{account:owner,revision:0,state:null}]);
eq((await put(0,state,{from:'https://elsewhere.example'}))[0],403);
eq((await put(0,state,{header:'different'}))[0],428);
await reject(s=>{s.stage='review'});await reject(s=>{s.fullTests={bad:true}});
await reject(s=>{s.reports={W1:{week:{}}}});
let a=edit(s=>{s.exam='Academic'}), b=edit(s=>{s.exam='General Training'});
const race=await Promise.all([put(0,a),put(0,b)]);eq(race.map(r=>r[0]).sort(),[200,409]);
state=race[0][0]===200?a:b;revision=1;
eq(await put(0,state),[200,{revision:1}]);eq((await get(other))[1].state,null);
eq((await put(1,state,{actor:other,header:owner}))[0],428);
const clip=randomUUID();clips.add('speaking/'+other+'/'+clip);
await reject(withEntry(submitVoice('speakingFollowup',{audio:clip})));
clips.add('speaking/'+owner+'/'+clip);
await mark(submitVoice('speakingFollowup',{audio:clip}));
await reject(withEntry({speakingFollowup:'[]'}));
await mark({speakingReview:'Learned why',speakingComplete:'yes'});
await advance('review');await finish();
eq((await get())[1].state.day,11);eq((await get())[1].state.finished,true);
await reject(s=>{s.day=13;s.stage='speak';s.finished=false;s.started[13]=now});
let preWrite=edit(s=>{s.practice.viable={date:now,count:1,lastCorrect:true}});
const duplicates=await Promise.all([put(revision,preWrite),put(revision,preWrite)]);
eq(duplicates,[[200,{revision:revision+1}],[200,{revision:revision+1}]]);state=preWrite;revision++;
eq((await put(revision,state))[1].revision,revision);
const test={id:randomUUID(),skill:'Listening',exam:'通用',date:now,source:'Fixture test',rater:'answer key',raw:38};
await commit(s=>{s.fullTests=[test]});await reject(s=>{s.fullTests=[]});await reject(s=>{s.fullTests[0].raw=40});
await reject(s=>{s.practice={}});
// Simulate reauthentication and an unrelated device saving after session expiry.
const unsaved=edit(s=>{s.exam='未选择'});
eq((await put(revision,unsaved,{actor:null}))[0],401);
const sameRevision=(await get())[1].revision;eq(sameRevision,revision);
eq((await put(revision,unsaved))[0],200);state=unsaved;revision++;
eq((await put(sameRevision,edit(s=>{s.exam='Academic'})))[0],409);
eq((await get())[1].state,state);
const fixture=getExercises(12);
const insertLesson=sql.prepare('INSERT INTO teacher_lessons (user_id,day,lesson) VALUES (?,?,?)');
for(let day=12;day<=62;day++){
  const lesson=getExercises(day)||fixture;
  if(day>=17){
    if(day===17){await reject(s=>{s.day=17;s.finished=false;s.stage='speak';s.started[17]=now});insertLesson.run(other,day,JSON.stringify(lesson));await reject(s=>{s.day=17;s.finished=false;s.stage='speak';s.started[17]=now});}
    insertLesson.run(owner,day,JSON.stringify(lesson));
  }
  await start(day);await reject(s=>{s.stage='listen'});
  await mark(submitVoice('speakingPart2'));await mark(submitVoice('speakingFollowup'));
  await mark({speakingComplete:'yes',speakingReview:'Reflect'});await advance('vocab');
  if(day===12)await reject(withEntry({vocabBatch:'2'}));
  await mark({vocabRecall:lesson.recall[1],vocabRecallCorrect:'1'});
  await mark({vocabBatch:'2'});await mark({vocabUse:'Fixture original sentence.',vocabDone:'1'});
  await advance('listen');
  for(const stage of ['listen','read']){
    const items=stage==='listen'?lesson.listening:lesson.reading;
    for(const i of [0,1]){
      const key=stage+'Q'+i, patch={[key]:String(items[i].answer),[key+'Correct']:'1',
        [stage+(stage==='listen'?'Mode':'Evidence')+i]:stage==='listen'?'首听一遍':'A passage detail.'};
      if(i===1){await mark({[stage+'Batch']:'2'});patch[stage+'Done']='1';}
      if(day===12)await reject(withEntry({...patch,[key+'Correct']:'0'}));
      await mark(patch);if(day===12)await reject(withEntry({[key]:String((items[i].answer+1)%3)}));
    }
    await advance(stage==='listen'?'read':'write');
  }
  await mark({writeDraft:'Scratch.'});await mark({writeDraft:'Updated scratch.'});
  await mark({writeOriginal:'First draft.',writeCondition:'独立 · 未计时'});
  if(day===12)await reject(withEntry({writeOriginal:'Replaced.'}));
  await mark({writeRevision:'Revised draft.',writeFocus:'Evidence',writeDone:'1'});
  await advance('review');await finish();
}
eq(state.completed.length,62);eq((await get())[1].state,state);eq((await get(other))[1].state,null);
eq(snapshotSchema.safeParse(state).success,true);
await reject(s=>{s.day=63;s.stage='speak';s.finished=false;s.started[63]=now});
console.log('state-api passed',checks,'assertions;',revision,'commits; built-in Day 12–16 + per-user fixture lessons Day 17–62');
sql.close();
