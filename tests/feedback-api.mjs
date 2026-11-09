// Exact-attempt feedback against real SQLite and the production MCP/HTTP routes.
// Synthetic accounts only; no production access or external services.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/'),db=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+file,'utf8'));
globalThis.testCloud={DB:{prepare(q){const stmt=db.prepare(q);stmt.setReturnArrays(true);return {bind:(...v)=>({raw:async()=>stmt.all(...v),run:async()=>stmt.run(...v)})}}}};
globalThis.user={userId:'feedback-fixture'};
registerHooks({resolve(spec,ctx,next){
 const mock=src=>({url:'data:text/javascript,'+encodeURIComponent(src),shortCircuit:true});
 if(spec==='cloudflare:workers')return mock('export const env=globalThis.testCloud');
 if(spec==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.user');
 if(ctx.parentURL?.startsWith(root.href)&&!ctx.parentURL.includes('node_modules')){
  if(spec==='@/db')return {url:new URL('db/index.ts',root).href,shortCircuit:true};
  if(spec.startsWith('@/'))return {url:new URL(spec.slice(2)+'.ts',root).href,shortCircuit:true};
  if(spec.startsWith('.')&&!spec.endsWith('.ts'))return {url:new URL(spec+'.ts',ctx.parentURL).href,shortCircuit:true};
 }
 return next(spec,ctx);
}});
const load=p=>import(new URL(p,root));
const {reviewAttempts,feedbackFor}=await load('app/feedback-model.ts');
const {initial}=await load('app/ledger.ts'),{getExercises}=await load('app/curriculum.ts');
const mcp=await load('app/mcp/route.ts'),http=await load('app/api/coach/route.ts');
const state=initial();Object.assign(state,{day:12,stage:'write',finished:false,completed:[...state.completed,11],started:{...state.started,12:'2026-11-09'}});
state.entries[11]={speakingFollowup:JSON.stringify([{at:'2026-11-02T01:00:00Z',text:'Earlier day follow-up',spoken:true}])};
const audioId='11111111-1111-4111-8111-111111111111';
state.entries[12]={
 speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00Z',text:'My original answer',spoken:true,audio:audioId}]),
 speakingFollowup:JSON.stringify([{at:'2026-11-09T01:02:00Z',text:'My follow-up',spoken:true},{at:'2026-11-09T01:03:00Z',text:'My follow-up',spoken:true}]),
 speakingReview:'Give a concrete example',vocabRecall:'viable',vocabUse:'I take on a new responsibility.',
 listenQ0:'0',listenMode0:'首听一遍',readQ0:'1',readEvidence0:'A concrete sentence from the passage',
 writeOriginal:'Original fixture response',writeCondition:'独立 · 未计时',writeDraft:'private unfinished draft',
 writeRevision:'Revised fixture response',writeFocus:'Added a clear cause',reviewMemo:'Practise linking reasons to results'
};
const snapshot=JSON.stringify(state);
db.prepare('INSERT INTO learner_states (user_id,revision,state) VALUES (?,?,?)').run(user.userId,21,snapshot);
const rpc=async(name,args={})=>mcp.POST(new Request('https://fixture.example/mcp',{method:'POST',headers:{origin:'https://fixture.example','content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
const call=async(name,args)=>(await (await rpc(name,args)).json()).result;
const unpack=r=>{assert.ok(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text)};
let assertions=0;const check=()=>assertions++;
const attempts=await reviewAttempts(12,state.entries[12]);
assert.equal(attempts.length,11);assert.equal(new Set(attempts.map(a=>a.id)).size,11);check();
assert.deepEqual(await reviewAttempts(12,{...state.entries[12],writeDraft:'another unsaved draft',vocabUseDraft:'draft'}),attempts);check();
assert.ok(attempts.every(a=>a.id.length<=160&&!a.field.endsWith('Draft')));check();
const original=attempts.find(a=>a.field==='writeOriginal');
assert.notEqual((await reviewAttempts(11,state.entries[12])).find(a=>a.field==='writeOriginal').id,original.id);check();
assert.notEqual((await reviewAttempts(12,{...state.entries[12],writeOriginal:'changed'})).find(a=>a.field==='writeOriginal').id,original.id);check();
assert.notEqual((await reviewAttempts(12,{...state.entries[12],writeCondition:'有参考或获得提示'})).find(a=>a.field==='writeOriginal').id,original.id);check();
let session=unpack(await call('read_study_session',{day:12}));
assert.equal(session.reviewWorkflow.mode,'work_conversation');
assert.equal(session.reviewAttempts.find(a=>a.field==='writeOriginal').context.prompt,getExercises(12).writing);
assert.equal(session.reviewAttempts.find(a=>a.field==='listenQ0').status,'answer_key_checked');
assert.equal(session.reviewAttempts.find(a=>a.field==='readQ0').status,'awaiting_coach');check();
const feedback={day:12,stage:'write',attempt:original.id,evidence:'Fixture independent original response',feedback:'Explain one concrete consequence.'};
const duplicate=await Promise.all(Array.from({length:4},()=>call('add_coach_feedback',feedback)));
assert.equal(new Set(duplicate.map(r=>unpack(r).id)).size,1);check();
session=unpack(await call('read_study_session',{day:12}));
assert.equal(session.feedback.length,1);
assert.equal(session.reviewAttempts.find(a=>a.id===original.id).status,'reviewed');
assert.equal(session.reviewAttempts.find(a=>a.field==='writeRevision').status,'awaiting_coach');check();
const response=await http.GET();assert.equal(response.status,200);
assert.match(response.headers.get('Cache-Control'),/no-store/);
const coachResponse=await response.json();
assert.equal(coachResponse.account,user.userId);
assert.deepEqual(coachResponse.feedback,session.feedback);check();
assert.equal(feedbackFor(original,session.feedback).length,1);
assert.equal(feedbackFor(attempts.find(a=>a.field==='writeRevision'),session.feedback).length,0);check();
for(const patch of [
 {stage:'read'},{attempt:original.id.slice(0,-1)+(original.id.endsWith('a')?'b':'a')},
 {day:13},{recordingId:audioId},{attempt:'descriptive label bypass'},{attempt:'v2:unknown'},
 {stage:'speak',attempt:attempts.find(a=>a.field==='speakingFollowup').id,recordingId:audioId}
]){assert.equal((await call('add_coach_feedback',{...feedback,...patch})).isError,true);check();}
assert.equal((await call('read_study_session',{day:13})).isError,true);check();
// Selected historical day must use that day's question, not today's writing prompt.
const older=unpack(await call('read_study_session',{day:11}));
assert.equal(older.day,11);assert.ok(older.reviewAttempts[0].context.prompt);assert.notEqual(older.reviewAttempts[0].context.prompt,getExercises(12).followup);check();
const revisionAttempt=attempts.find(a=>a.field==='writeRevision');
const key='11111111-1111-4111-8111-111111111112', id='v2:'+key;
const frozen={sourceId:revisionAttempt.id,attempt:{...revisionAttempt,id,response:'Frozen fixture response'},context:{prompt:'Frozen prompt'}};
db.prepare('INSERT INTO review_jobs VALUES (?,?,?,?,?,?,?,?)').run(id,user.userId,12,key,'a'.repeat(64),21,JSON.stringify(frozen),'2026-11-09T01:00:00Z');
const exact=unpack(await call('read_study_session',{day:12,attemptId:id}));
assert.deepEqual(Object.keys(exact).sort(),['day','feedback','reviewAttempts']);
assert.equal(exact.reviewAttempts[0].response,'Frozen fixture response');
assert.equal(exact.reviewAttempts[0].context.prompt,'Frozen prompt');check();
assert.equal((await call('read_study_session',{day:11,attemptId:id})).isError,true);
assert.equal((await call('add_coach_feedback',{...feedback,attempt:revisionAttempt.id})).isError,true);check();
const fixedReview={...feedback,attempt:id,feedback:'First returned correction'};
const reviews=await Promise.all(Array.from({length:4},()=>call('add_coach_feedback',fixedReview)));
assert.ok(reviews.every(r=>unpack(r).id===id));
const replay=unpack(await call('add_coach_feedback',{...fixedReview,feedback:'Late duplicate'}));
assert.equal(replay.id,id);
assert.equal(unpack(await call('read_study_session',{day:12,attemptId:id})).feedback[0].feedback,'First returned correction');check();
const coach=await(await http.GET()).json();
assert.deepEqual(coach.reviewLinks,[{day:12,id,sourceId:revisionAttempt.id}]);check();
globalThis.user={userId:'other-fixture'};
assert.equal((await call('read_study_session',{day:12,attemptId:id})).isError,true);
assert.equal((await call('add_coach_feedback',fixedReview)).isError,true);check();
assert.deepEqual((await (await http.GET()).json()).feedback,[]);
assert.equal((await call('add_coach_feedback',feedback)).isError,true);check();
globalThis.user=null;
assert.equal((await http.GET()).status,401);assert.equal((await rpc('add_coach_feedback',feedback)).status,401);check();
const unchanged=db.prepare('SELECT revision,state FROM learner_states WHERE user_id=?').get('feedback-fixture');
assert.equal(unchanged.revision,21);assert.equal(unchanged.state,snapshot);
assert.equal(db.prepare('SELECT COUNT(*) n FROM teacher_feedback').get().n,2);check();
console.log(JSON.stringify({suite:'feedback-api',checks:assertions,passed:true,learnerStateUnchanged:true}));
