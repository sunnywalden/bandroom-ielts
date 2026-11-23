// Exact-attempt feedback against real SQLite and the production MCP/HTTP routes.
// Synthetic accounts only; no production access or external services.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const root=pathToFileURL(process.cwd()+'/'),db=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+file,'utf8'));
globalThis.testCloud={DB:{
 prepare(q){
  const raw=db.prepare(q);raw.setReturnArrays(true);
  const normal=db.prepare(q);
  return {bind:(...v)=>({
   raw:async()=>raw.all(...v),
   all:async()=>({results:normal.all(...v)}),
   first:async()=>normal.get(...v),
   run:async()=>raw.run(...v),
  })}
 },
 async batch(statements){
  const results=[];db.exec('BEGIN');
  try{for(const statement of statements)results.push(await statement.run());db.exec('COMMIT');return results}
  catch(error){db.exec('ROLLBACK');throw error}
 },
}};
// Minimal in-memory R2 so a grounded speaking review can resolve its recording.
const r2Objects=new Map();
globalThis.testCloud.BUCKET={
 async head(key){const body=r2Objects.get(key);
  return body?{size:body.length,etag:'fixture-etag',httpMetadata:{contentType:'audio/webm'}}:null},
 async get(key){const body=r2Objects.get(key);
  return body?{size:body.length,etag:'fixture-etag',httpMetadata:{contentType:'audio/webm'},
   arrayBuffer:async()=>body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength)}:null},
 async put(key,body){r2Objects.set(key,new Uint8Array(body))},
};
globalThis.user={userId:'feedback-fixture'};
globalThis.testCloud.BANDROOM_CONSENT_GATE='off'; // fixture: consent tested separately
globalThis.testCloud.BANDROOM_QUOTA_GATE='off'; // fixture: quota tested separately
registerHooks({resolve(spec,ctx,next){
 const mock=src=>({url:'data:text/javascript,'+encodeURIComponent(src),shortCircuit:true});
 if(spec==='cloudflare:workers')return mock('export const env=globalThis.testCloud');
 if(spec==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.user; export const getAuthContext=async()=>({user:globalThis.user,scope:globalThis.authScope??"owner",identityType:"mock"})');
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
const reviewIds=reviews.map(result=>unpack(result).id);
assert.ok(reviewIds.every(value=>value===reviewIds[0]&&value.startsWith('rt:')),'concurrent manual reviews share one task result');check();
const replay=await call('add_coach_feedback',{...fixedReview,feedback:'Late duplicate'});
assert.equal(replay.isError,true);check();
assert.equal(unpack(await call('read_study_session',{day:12,attemptId:id})).feedback[0].feedback,'First returned correction');check();
const coach=await(await http.GET()).json();
assert.deepEqual(coach.reviewLinks,[{day:12,id,sourceId:revisionAttempt.id}]);check();
// A v2 submission with a queued task uses the same fence/receipt transaction
// for manual feedback; a second different result is rejected.
const taskKey='11111111-1111-4111-8111-111111111113',taskId='v2:'+taskKey;
const taskSnapshot={sourceId:revisionAttempt.id,attempt:{...revisionAttempt,id:taskId,response:'Manual task response'},context:{prompt:'Manual task prompt'}};
db.prepare('INSERT INTO review_jobs VALUES (?,?,?,?,?,?,?,?)').run(taskId,user.userId,12,taskKey,'c'.repeat(64),21,JSON.stringify(taskSnapshot),'2026-11-09T01:00:00Z');
db.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,fence,attempts,next_at,created_at,updated_at)
 VALUES (?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`).run('manual-task',taskId,user.userId,'text',taskId,12,21,Date.now(),Date.now(),Date.now());
const manualFeedback={day:12,stage:'write',attempt:taskId,evidence:'Manual evidence',feedback:'Manual correction'};
const manual=unpack(await call('add_coach_feedback',manualFeedback));
assert.equal(manual.id,'rt:manual-task');check();
assert.ok(manual.receiptId);check();
const manualReplay=unpack(await call('add_coach_feedback',manualFeedback));
assert.equal(manualReplay.receiptId,manual.receiptId);check();
assert.equal(manualReplay.duplicate,true);check();
assert.equal((await call('add_coach_feedback',{...manualFeedback,feedback:'Different manual correction'})).isError,true);check();
assert.equal(db.prepare('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?').get('manual-task').n,1);check();
assert.equal(db.prepare('SELECT state FROM review_tasks WHERE id=?').get('manual-task').state,'completed');check();
assert.match(db.prepare('SELECT output_sha256_v2 AS digest FROM review_receipts WHERE task_id=?').get('manual-task').digest,/^[a-f0-9]{64}$/);check();
// rev2 calibration transport, SUCCESS path. The earlier groundedAnalysis tests
// only covered rejection, which is why a second defect survived delivery: the
// enriched analysis was passed in `output` (hashed into the receipt) but not in
// `feedback`, so teacher_feedback.analysis_json stayed null and the UI could
// never obtain a candidateId. The owner could not answer, so the loop was inert.
const speakKey='11111111-1111-4111-8111-111111111114',speakTaskId='v2:'+speakKey;
const speakRecording=audioId;
const speakSnapshot={sourceId:revisionAttempt.id,attempt:{...revisionAttempt,id:speakTaskId,stage:'speak',recordingId:speakRecording,response:'Spoken fixture response'},context:{prompt:'Spoken prompt'}};
db.prepare('INSERT INTO review_jobs VALUES (?,?,?,?,?,?,?,?)').run(speakTaskId,user.userId,12,speakKey,'d'.repeat(64),21,JSON.stringify(speakSnapshot),'2026-11-09T01:00:00Z');
db.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,fence,attempts,next_at,created_at,updated_at,recording_id)
 VALUES (?,?,?,?,?,?,?,'speak','queued',0,0,?,?,?,?)`).run('speak-task',speakTaskId,user.userId,'speaking',speakTaskId,12,21,Date.now(),Date.now(),Date.now(),speakRecording);
const groundedAnalysis={detectorVersion:'detector-v1',inventoryVersion:'arpabet-v1',speechSeconds:58.5,
  candidates:[{word:'they',expected:'DH',actual:'D',atMs:5210,detectorConfidence:.91,tier:'T3'},
              {word:'have',expected:'HH',actual:'HV',atMs:54790,detectorConfidence:.84,tier:'T2'}]};
await globalThis.testCloud.BUCKET.put(`speaking/${encodeURIComponent(user.userId)}/${speakRecording}`,new Uint8Array([1,2,3,4]));
const speakFeedback={day:12,stage:'speak',attempt:speakTaskId,evidence:'Spoken fixture response — 已校准停顿证据',
  feedback:'Grounded fixture correction',recordingId:speakRecording,groundedAnalysis};
const speakSaved=unpack(await call('add_coach_feedback',speakFeedback));
assert.ok(speakSaved.receiptId,'grounded speaking feedback saves a receipt');check();
const issued=db.prepare('SELECT candidate_id,expected,actual FROM calibration_candidates WHERE attempt_id=? ORDER BY at_ms').all(speakTaskId);
assert.equal(issued.length,2,'server issues one candidateId per transported candidate');check();
const storedRaw=db.prepare('SELECT analysis_json AS a FROM teacher_feedback WHERE review_task_id=?').get('speak-task').a;
assert.ok(storedRaw,'analysis_json must be persisted, not merely hashed into the receipt');check();
const stored=JSON.parse(storedRaw);
assert.equal(stored.items.length,2);check();
assert.ok(stored.items.every(i=>i.candidateId&&i.tier==='T3'),'every stored item is T3 with a server id');check();
assert.deepEqual(stored.items.map(i=>i.candidateId),issued.map(r=>r.candidate_id));check();
assert.equal(stored.items[1].requestedTier,'T2','requested tier is preserved but never asserted');check();
const sessionSpeak=unpack(await call('read_study_session',{day:12,attemptId:speakTaskId}));
assert.ok(sessionSpeak.feedback[0].analysis,'the UI must receive the analysis carrying candidateIds');check();
assert.equal(sessionSpeak.feedback[0].analysis.items.length,2);check();
// Legacy v1 speaking attempts have no review task and take the direct-insert
// path. Day 12 production submissions are v1, so this path must persist the
// analysis too — otherwise candidates are issued but the UI can never see them.
const legacySpeak=attempts.find(a=>a.field==='speakingPart2');
assert.ok(legacySpeak&&legacySpeak.recordingId===audioId,'fixture has a v1 speaking attempt');check();
const legacySaved=unpack(await call('add_coach_feedback',{day:12,stage:'speak',attempt:legacySpeak.id,
  evidence:'Spoken fixture response — 已校准停顿证据',feedback:'Legacy grounded correction',
  recordingId:audioId,groundedAnalysis}));
assert.ok(legacySaved.saved);check();
const legacyRaw=db.prepare('SELECT analysis_json AS a FROM teacher_feedback WHERE attempt=?').get(legacySpeak.id).a;
assert.ok(legacyRaw,'legacy v1 path must persist analysis_json as well');check();
const legacyStored=JSON.parse(legacyRaw);
assert.equal(legacyStored.items.length,2);check();
assert.ok(legacyStored.items.every(i=>i.candidateId&&i.tier==='T3'));check();
const legacySession=unpack(await call('read_study_session',{day:12,attemptId:legacySpeak.id}));
assert.ok(legacySession.feedback[0].analysis,'UI receives candidateIds for v1 attempts too');check();
// Scorecard v2 transport (speaking redesign): transcript + scorecard persist
// through the real Zod schema and read path; the server rejects a scorecard
// that scores pronunciation while the assertion gates are unmet.
const v2Key='11111111-1111-4111-8111-111111111115',v2TaskId='v2:'+v2Key;
const v2Snapshot={sourceId:revisionAttempt.id,attempt:{...revisionAttempt,id:v2TaskId,stage:'speak',recordingId:speakRecording,response:'Spoken fixture response'},context:{prompt:'Spoken prompt'}};
db.prepare('INSERT INTO review_jobs VALUES (?,?,?,?,?,?,?,?)').run(v2TaskId,user.userId,12,v2Key,'e'.repeat(64),21,JSON.stringify(v2Snapshot),'2026-11-09T01:00:00Z');
db.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,fence,attempts,next_at,created_at,updated_at,recording_id)
 VALUES (?,?,?,?,?,?,?,'speak','queued',0,0,?,?,?,?)`).run('scorecard-task',v2TaskId,user.userId,'speaking',v2TaskId,12,21,Date.now(),Date.now(),Date.now(),speakRecording);
const transcript=[{word:'they',start:5.2,end:5.4,probability:.91},{word:'have',start:54.7,end:55.0,probability:.8}];
const scorecard={schema:'bandroom-speaking-scorecard-v1',
 overall:{band:6,status:'reference',disclosure_zh:'参考估计：非官方雅思评分。',basis_zh:'四科参考估计均值'},
 criteria:[
  {key:'fluency_coherence',label_zh:'流利度与连贯性',band:6.5,status:'reference',disclosure_zh:'参考估计',evidence:{speech_ratio:.57}},
  {key:'grammar',label_zh:'语法',band:6,status:'reference',disclosure_zh:'参考估计',evidence:{issues:[]}},
  {key:'pronunciation',label_zh:'发音',band:null,status:'suggestive',disclosure_zh:'建议性，不评分',evidence:{}}],
 drills:[{quote:'they have',improved:'They have got it.',focus_zh:'连读'}],llm_status:'ok'};
const v2Saved=unpack(await call('add_coach_feedback',{...speakFeedback,attempt:v2TaskId,
  groundedAnalysis:{...groundedAnalysis,transcript,scorecard}}));
assert.ok(v2Saved.receiptId,'scorecard v2 save returns a receipt');check();
const v2Stored=JSON.parse(db.prepare('SELECT analysis_json AS a FROM teacher_feedback WHERE review_task_id=?').get('scorecard-task').a);
assert.equal(v2Stored.schema,'bandroom-grounded-analysis-v2');check();
assert.equal(v2Stored.transcript.length,2,'transcript persisted for the interactive UI');check();
assert.equal(v2Stored.scorecard.schema,'bandroom-speaking-scorecard-v1');check();
const scoredPronunciation={...scorecard,criteria:scorecard.criteria.map(c=>c.key==='pronunciation'?{...c,band:6}:c)};
const rejectedScorecard=await call('add_coach_feedback',{...speakFeedback,attempt:v2TaskId,
  groundedAnalysis:{...groundedAnalysis,scorecard:scoredPronunciation}});
assert.equal(rejectedScorecard.isError,true,'a pronunciation band is rejected while gates are unmet');check();
// The learner answers the self-listen card; the coach read path must decorate
// the stored items with the verdict so transcript colors survive a reload.
const scorecardCandidate=v2Stored.items[0].candidateId;
const verdictSaved=unpack(await call('record_pronunciation_verdict',{candidateId:scorecardCandidate,verdict:'confirmed'}));
assert.equal(verdictSaved.saved,true);check();
const decorated=(await(await http.GET()).json()).feedback.find(row=>row.attempt===v2TaskId);
assert.equal(decorated.analysis.items[0].priorVerdict,'confirmed','reads() decorates items with recorded verdicts');check();
const heartbeat=(status,startedAt,lastSuccessAt,nextExpectedAt)=>db.prepare(`INSERT OR REPLACE INTO automation_heartbeats
 (user_id,automation_id,generation,client_run_id,started_at,finished_at,last_success_at,next_expected_at,status,detail)
 VALUES (?,?,?,?,?,?,?,?,?,?)`).run(user.userId,'Automation_fixture',1,'run-heartbeat',startedAt,null,lastSuccessAt,nextExpectedAt,status,null);
heartbeat('started',Date.now(),null,null);
assert.equal((await(await http.GET()).json()).automation.connected,true);check();
heartbeat('failed',Date.now(),null,null);
assert.equal((await(await http.GET()).json()).automation.connected,false);check();
heartbeat('finished',Date.now()-3*60*60_000,Date.now()-3*60*60_000,Date.now()+60*60_000);
assert.equal((await(await http.GET()).json()).automation.connected,true);check();
// Phase 1: writing cards surface as `writing` (never as acoustic `analysis`),
// and quick checks are reported separately from feedback, links and tasks.
{
  const uid=user.userId,now=new Date().toISOString();
  const cardsJson=JSON.stringify({schema:'bandroom-writing-feedback-v1',mode:'cards',issues:[],summary:{priorities:[],next_step_zh:'x'}});
  db.prepare(`INSERT INTO teacher_feedback(id,user_id,day,stage,attempt,evidence,feedback,analysis_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('wf-cards',uid,12,'write','v2:cards-attempt','e','f',cardsJson,now);
  const rcSnapshot=JSON.stringify({sourceId:'recheck:wf-cards:i1:1',attempt:{id:'v2:rc-fixture',day:12,field:'writeRecheck',index:0,stage:'write',title:'单项快检',kind:'subjective',response:'r',conditions:'',evidence:''},
    context:{baseFeedbackId:'wf-cards',issue:{id:'i1'}}});
  db.prepare(`INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run('v2:rc-fixture',uid,12,'recheck:wf-cards:1','a'.repeat(64),1,rcSnapshot,now);
  db.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'read_input','completed',1,1,?,?,?)`).run('task-rc-fixture','v2:rc-fixture',uid,'text','v2:rc-fixture',12,1,Date.now(),Date.now(),Date.now());
  db.prepare(`INSERT INTO teacher_feedback(id,user_id,day,stage,attempt,evidence,feedback,analysis_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
    .run('wf-rc',uid,12,'write','v2:rc-fixture','e','f',JSON.stringify({schema:'bandroom-writing-feedback-v1',mode:'recheck',baseFeedbackId:'wf-cards',issue:'i1',result:'partial',evidence_quote:'r',why_zh:'好一些。',adjusted:false}),now);
  const coach=await(await http.GET()).json();
  const cardsRow=coach.feedback.find(f=>f.id==='wf-cards');
  assert.equal(cardsRow.writing.mode,'cards');assert.equal(cardsRow.analysis,undefined,'writing never renders as acoustic analysis');check();
  assert.equal(coach.feedback.some(f=>f.id==='wf-rc'),false,'quick-check verdicts are not general feedback');check();
  assert.equal(coach.reviewLinks.some(l=>l.id==='v2:rc-fixture'),false,'quick checks are not review links');check();
  assert.equal(coach.reviewTasks.some(t=>t.attemptId==='v2:rc-fixture'),false,'quick checks never reach the inbox');check();
  assert.deepEqual(coach.rechecks.map(r=>[r.issue,r.state,r.result,r.baseFeedbackId]),[['i1','completed','partial','wf-cards']]);check();
  for(const table of ['teacher_feedback WHERE id IN (\'wf-cards\',\'wf-rc\')','review_tasks WHERE id=\'task-rc-fixture\'','review_jobs WHERE id=\'v2:rc-fixture\''])
    db.prepare('DELETE FROM '+table).run();
}
// D4: only the coach-runner service writes the tenant-neutral heartbeat, and
// every tenant reads it (previously other tenants were always "disconnected").
const svcRows=()=>db.prepare('SELECT COUNT(*) n FROM service_heartbeats').get().n;
const svcBeat={automationId:'bandroom-coach-runner',generation:1,clientRunId:'run-svc',status:'started',startedAt:Date.now(),nextExpectedAt:Date.now()+60_000};
unpack(await call('report_scheduler_heartbeat',svcBeat));
assert.equal(svcRows(),0,'an owner-scope heartbeat never writes the shared service row');check();
globalThis.user={userId:'runner-fixture'};globalThis.authScope='coach-runner';
unpack(await call('report_scheduler_heartbeat',svcBeat));
assert.equal(svcRows(),1,'the runner service writes the shared service row');check();
globalThis.authScope=undefined;globalThis.user={userId:'tenant-without-heartbeat'};
const otherAutomation=(await(await http.GET()).json()).automation;
assert.equal(otherAutomation.connected,true,'a tenant with no own heartbeat sees the connected runner');check();
assert.equal(otherAutomation.nextExpectedAt,svcBeat.nextExpectedAt);check();
db.prepare("UPDATE service_heartbeats SET status='failed', updated_at=?").run(Date.now());
assert.equal((await(await http.GET()).json()).automation.connected,false,'a failed service heartbeat reads as disconnected');check();
db.prepare('DELETE FROM service_heartbeats').run();
globalThis.user={userId:'feedback-fixture'};
globalThis.user={userId:'other-fixture'};
assert.equal((await call('read_study_session',{day:12,attemptId:id})).isError,true);
assert.equal((await call('add_coach_feedback',fixedReview)).isError,true);check();
assert.deepEqual((await (await http.GET()).json()).feedback,[]);
assert.equal((await call('add_coach_feedback',feedback)).isError,true);check();
globalThis.user=null;
assert.equal((await http.GET()).status,401);assert.equal((await rpc('add_coach_feedback',feedback)).status,401);check();
const unchanged=db.prepare('SELECT revision,state FROM learner_states WHERE user_id=?').get('feedback-fixture');
assert.equal(unchanged.revision,21);assert.equal(unchanged.state,snapshot);
assert.equal(db.prepare('SELECT COUNT(*) n FROM teacher_feedback').get().n,6,'one extra row: scorecard v2 save');check();
console.log(JSON.stringify({suite:'feedback-api',checks:assertions,passed:true,learnerStateUnchanged:true}));
