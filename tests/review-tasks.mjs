// Real SQLite queue semantics: atomic claim, fence, lease, checkpoints,
// retry, idempotent completion and owner isolation. No network, no production.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';

registerHooks({resolve(specifier,context,next){
  if(specifier==='@/db')return {url:'data:text/javascript,export function getDb(){throw new Error("not used")}',shortCircuit:true};
  return next(specifier,context);
}});

const sql=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));

function statement(query,args=[]){
  return {
    bind:(...values)=>statement(query,[...args,...values]),
    async first(){const s=sql.prepare(query);const row=s.all(...args)[0];return row?{...row}:null},
    async all(){const s=sql.prepare(query);return {results:s.all(...args).map(row=>({...row}))}},
    run(){const s=sql.prepare(query);const results=s.all(...args);return {results,meta:{changes:Number(sql.prepare("SELECT changes() AS n").get().n)}}},
  };
}
const d1={
  prepare:(query)=>statement(query),
  async batch(statements){
    sql.exec('BEGIN');
    try{const results=statements.map(statement=>statement.run());sql.exec('COMMIT');return results}
    catch(error){sql.exec('ROLLBACK');throw error}
  },
};

const {claimReviewTasks,renewReviewLease,saveReviewCheckpoint,readReviewCheckpoint,failReviewTask,completeReviewTask,
  claimManualReviewTask,findReviewTaskByAttempt,
  readReviewReceipt,listReviewTasks,recordAnalysisEvent,reportSchedulerHeartbeat,createReviewTaskStatement,
  ReviewTaskError}=await import('../lib/review-tasks.ts');

const owner='fixture-owner',other='fixture-other';
let checks=0;
function eq(actual,expected,label){assert.deepEqual(actual,expected,label);checks++}
function row(query,...args){const result=sql.prepare(query).get(...args);return result?{...result}:null}
function code(promise,expected,label){
  return promise.then(()=>assert.fail(label+' should reject'),error=>{
    assert.ok(error instanceof ReviewTaskError,label+' type');
    eq(error.code,expected,label);
  });
}
function insertJob({id=('v2:'+randomUUID()),userId=owner,day=12,attemptRevision=22}={}){
  const snapshot={sourceId:'v1:fixture',attempt:{id,day,field:'writeOriginal',index:0,stage:'write',title:'Fixture',kind:'subjective',response:'Fixture answer',conditions:'',evidence:''},context:{prompt:'Fixture prompt'}};
  sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,userId,day,randomUUID(),'a'.repeat(64),attemptRevision,JSON.stringify(snapshot),new Date().toISOString());
  return {id,day,attemptRevision,snapshot};
}
function insertTask(job,{taskId=randomUUID(),kind='text',recordingId=null,now=1_000_000}={}){
  const row={taskId,reviewJobId:job.id,userId:owner,kind,attemptId:job.id,day:job.day,attemptRevision:job.attemptRevision,recordingId,now};
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId,job.id,owner,kind,job.id,job.day,job.attemptRevision,recordingId,now,now,now);
  return row;
}
const feedback=(task,text='Correction')=>({id:'fb-'+task.taskId,day:task.day,stage:'write',attempt:task.attemptId,evidence:'Fixture evidence',feedback:text,analysis:{errors:[]}});
const output=(text='Correction')=>({feedback:text,errors:[]});
function reset(){sql.exec('DELETE FROM review_tasks; DELETE FROM review_jobs; DELETE FROM review_receipts; DELETE FROM teacher_feedback; DELETE FROM analysis_events; DELETE FROM scheduler_heartbeats; DELETE FROM automation_heartbeats; DELETE FROM learner_states;')}

// create task from a committed snapshot
{
  reset();
  const job=insertJob();
  await createReviewTaskStatement(d1,{taskId:'task-create',reviewJobId:job.id,userId:owner,kind:'text',attemptId:job.id,day:12,attemptRevision:22,now:1_000_000}).run();
  eq(row('SELECT state,stage,fence,attempts FROM review_tasks WHERE id=?','task-create'),{state:'queued',stage:'read_input',fence:0,attempts:0},'task created queued');
}

// claim, no duplicate concurrent claim, renew and stale fence
{
  reset();
  const job=insertJob(),task=insertTask(job);
  const [claimed]=await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  eq(claimed.id,task.taskId,'claimed task');
  eq([claimed.fence,claimed.attempts,claimed.state],[1,1,'running'],'fence/attempts');
  eq(await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-2'}),[],'lease prevents duplicate claim');
  const renewed=await renewReviewLease(d1,owner,task.taskId,1,{now:1_000_000,extendMs:600_000});
  eq(renewed.leaseUntil,1_600_000,'renewed lease');
  eq((await renewReviewLease(d1,owner,task.taskId,1,{now:1_000_001,extendMs:30_000})).leaseUntil,
    1_600_000,'shorter heartbeat cannot reduce the current lease');
  await code(renewReviewLease(d1,owner,task.taskId,9,{now:1_000_000}),'stale_lease','old fence renew');
  await code(saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:9,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'a',bytes:10}),'stale_lease','old fence checkpoint');
}

// checkpoint dedupe, conflict, version consistency, retry and budget
{
  reset();
  const job=insertJob(),task=insertTask(job);
  await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  const first=await saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'a',bytes:10,coverage:.25,now:1_000_000});
  eq(first,{saved:true,duplicate:false,checkpointSha256:'a'},'checkpoint saved');
  const duplicate=await saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'a',bytes:10,now:1_000_000});
  eq(duplicate.duplicate,true,'same artifact duplicate');
  await code(saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'b',bytes:10,now:1_000_000}),'artifact_conflict','different artifact');
  await code(saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:1,analysisVersion:'v2',stage:'decode',chunkIndex:1,inputSha256:'i',artifactSha256:'c',bytes:10,now:1_000_000}),'analysis_version_mismatch','mixed version');
  const failed=await failReviewTask(d1,owner,{taskId:task.taskId,fence:1,code:'temporary_read_failure',retryable:true,now:1_000_000});
  eq([failed.state,failed.nextAt],[ 'retry_wait',1_300_000],'retry wait'); // default 5 min
  eq(failed.retryEpoch,1,'retry epoch increments');
  eq(await claimReviewTasks(d1,owner,{now:1_100_000,limit:1,clientRunId:'run-2'}),[],'not due yet');
  const [retried]=await claimReviewTasks(d1,owner,{now:1_300_000,limit:1,clientRunId:'run-2'});
  eq([retried.fence,retried.attempts,retried.state],[2,2,'running'],'retry claim');
  sql.prepare('UPDATE review_tasks SET attempts=4 WHERE id=?').run(task.taskId);
  const exhausted=await failReviewTask(d1,owner,{taskId:task.taskId,fence:2,code:'another',retryable:true,now:1_400_000});
  eq(exhausted.attempts,4,'attempts retained');
  eq(await claimReviewTasks(d1,owner,{now:2_000_000,limit:1,clientRunId:'run-3'}),[],'budget prevents claim');
  eq(row('SELECT state,last_error FROM review_tasks WHERE id=?',task.taskId),{state:'needs_attention',last_error:'processing_budget_exhausted'},'budget state');
}

// A failed pointer write rolls back the artifact. Replays preserve the latest
// pointer and a new lease can recover both the latest and an earlier chunk.
{
  reset();
  const task=insertTask(insertJob());
  const now=1_000_000;
  const key={taskId:task.taskId,fence:1,now};
  const first={...key,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'input',artifactSha256:'first',bytes:10,payload:{offset:10}};
  await claimReviewTasks(d1,owner,{now,limit:1,clientRunId:'run-a'});
  eq(await readReviewCheckpoint(d1,owner,key),null,'empty checkpoint');
  sql.exec("CREATE TRIGGER interrupt_pointer BEFORE UPDATE OF checkpoint_sha256 ON review_tasks BEGIN SELECT RAISE(ABORT,'interrupted'); END");
  await assert.rejects(saveReviewCheckpoint(d1,owner,first),/interrupted/);
  sql.exec('DROP TRIGGER interrupt_pointer');
  eq(row('SELECT COUNT(*) n FROM analysis_artifacts WHERE task_id=?',task.taskId).n,0,'atomic rollback removes artifact');
  const concurrent=await Promise.all([saveReviewCheckpoint(d1,owner,first),saveReviewCheckpoint(d1,owner,first)]);
  eq(concurrent.map(result=>result.duplicate),[false,true],'concurrent replay creates one artifact');
  const second={...first,chunkIndex:1,artifactSha256:'second',payload:{offset:20}};
  await saveReviewCheckpoint(d1,owner,second);
  eq((await saveReviewCheckpoint(d1,owner,first)).checkpointSha256,'second','old duplicate does not regress pointer');
  await code(saveReviewCheckpoint(d1,owner,{...first,bytes:11}),'artifact_conflict','wrong size');
  await code(saveReviewCheckpoint(d1,owner,{...first,inputSha256:'different'}),'artifact_conflict','wrong input hash');
  await code(saveReviewCheckpoint(d1,owner,{...first,payload:{offset:99}}),'artifact_conflict','wrong payload under same hash');
  await code(saveReviewCheckpoint(d1,owner,{...first,objectRef:'other'}),'artifact_conflict','wrong object reference under same hash');
  await code(readReviewCheckpoint(d1,other,key),'stale_lease','checkpoint owner isolation');
  const later=1_300_001;
  await code(failReviewTask(d1,owner,{...key,now:later,code:'too_late',retryable:true}),'stale_lease','expired run cannot fail task');
  await claimReviewTasks(d1,owner,{now:later,limit:1,clientRunId:'run-b'});
  await code(readReviewCheckpoint(d1,owner,{...key,now:later}),'stale_lease','old fence cannot read checkpoint');
  const resumed={...key,fence:2,now:later};
  eq((await readReviewCheckpoint(d1,owner,resumed)).payload,{offset:20},'new run resumes latest checkpoint');
  eq((await readReviewCheckpoint(d1,owner,{...resumed,stage:'decode',chunkIndex:0})).payload,{offset:10},'new run can read earlier chunk');
  sql.prepare('UPDATE review_tasks SET checkpoint_sha256=NULL, analysis_version=NULL WHERE id=?').run(task.taskId);
  eq(await saveReviewCheckpoint(d1,owner,{...second,...resumed}),{saved:true,duplicate:true,checkpointSha256:'second'},'matching replay repairs legacy partial write');
}

// expiry reclaim and completion idempotency/conflict
{
  reset();
  const job=insertJob(),task=insertTask(job);
  const [first]=await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  const [second]=await claimReviewTasks(d1,owner,{now:1_300_001,limit:1,clientRunId:'run-2'});
  eq([first.fence,second.fence],[1,2],'expired lease reclaimed');
  await code(saveReviewCheckpoint(d1,owner,{taskId:task.taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'a',bytes:10}),'stale_lease','old run cannot checkpoint');
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:2,output:output(),feedback:{...feedback(task),attempt:'wrong'},receipt:{},now:1_300_002}),'attempt_mismatch','wrong attempt');
  const completed=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:2,output:output(),feedback:feedback(task),receipt:{analysisVersion:'v1'},now:1_300_002});
  eq(completed.duplicate,false,'first completion');
  eq(completed.receipt.attemptId,task.attemptId,'receipt attempt');
  const replay=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:2,output:output(),feedback:feedback(task),receipt:{analysisVersion:'v1'},now:1_300_003});
  eq(replay.duplicate,true,'duplicate completion');
  eq(replay.receipt.id,completed.receipt.id,'same receipt');
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:2,output:output('Different'),feedback:feedback(task,'Different'),receipt:{analysisVersion:'v1'}}),'receipt_conflict','different completion');
  eq((await readReviewReceipt(d1,owner,task.taskId)).id,completed.receipt.id,'read receipt');
  eq(await readReviewReceipt(d1,other,task.taskId),null,'owner receipt isolation');
  eq((await listReviewTasks(d1,owner)).find(x=>x.id===task.taskId).state,'completed','task completed');
  eq(row('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?',task.taskId).n,1,'one feedback');
  eq(row('SELECT COUNT(*) n FROM review_receipts WHERE task_id=?',task.taskId).n,1,'one receipt');
  await code(renewReviewLease(d1,owner,task.taskId,2,{now:1_300_002}),'stale_lease','lease released after completion');
}

// owner isolation, events and heartbeat
{
  reset();
  const job=insertJob(),task=insertTask(job);
  await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  eq(await claimReviewTasks(d1,other,{now:1_000_000,limit:1,clientRunId:'other'}),[],'other owner sees no task');
  await code(completeReviewTask(d1,other,{taskId:task.taskId,fence:1,output:output(),feedback:feedback(task),receipt:{}}),'task_not_found','other owner cannot complete');
  await recordAnalysisEvent(d1,{taskId:task.taskId,fence:1,event:'claim_review_tasks',outcome:'ok',clientRunId:'run-1',at:1_000_000});
  await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:1,clientRunId:'run-1',status:'finished',startedAt:990_000,finishedAt:1_010_000,nextExpectedAt:4_600_000,now:1_010_000,ownerUserId:owner});
  eq(row('SELECT event,outcome FROM analysis_events WHERE task_id=?',task.taskId),{event:'claim_review_tasks',outcome:'ok'},'event recorded');
  eq(row('SELECT status,last_success_at FROM automation_heartbeats WHERE user_id=? AND automation_id=?',owner,'Automation_fixture'),{status:'finished',last_success_at:1_010_000},'heartbeat');
  await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:2,clientRunId:'run-2',status:'failed',startedAt:1_020_000,now:1_020_000,ownerUserId:owner});
  await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:1,clientRunId:'run-old',status:'finished',startedAt:980_000,now:1_030_000,ownerUserId:owner});
  eq(row('SELECT generation,status,user_id FROM automation_heartbeats WHERE user_id=? AND automation_id=?',owner,'Automation_fixture'),
    {generation:2,status:'failed',user_id:owner},'older heartbeat cannot overwrite a newer generation');
  // A recreated automation may reset its generation; a newer startedAt may
  // take over, and its matching finished heartbeat is accepted.
  eq((await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:0,clientRunId:'run-reset',status:'started',startedAt:1_040_000,now:1_040_000,ownerUserId:owner})).updated,true,'reset start accepted');
  eq((await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:0,clientRunId:'run-reset',status:'finished',startedAt:1_040_000,finishedAt:1_050_000,now:1_050_000,ownerUserId:owner})).updated,true,'reset finish accepted');
  eq(row('SELECT generation,status FROM automation_heartbeats WHERE user_id=? AND automation_id=?',owner,'Automation_fixture'),
    {generation:0,status:'finished'},'reset generation stored');
  await reportSchedulerHeartbeat(d1,{automationId:'Automation_fixture',generation:1,clientRunId:'run-other',status:'started',startedAt:1_060_000,now:1_060_000,ownerUserId:other});
  eq(row('SELECT COUNT(*) n FROM automation_heartbeats WHERE automation_id=?','Automation_fixture').n,2,'heartbeats are scoped per owner');
  eq(row('SELECT generation FROM automation_heartbeats WHERE user_id=? AND automation_id=?',owner,'Automation_fixture').generation,0,'other owner cannot overwrite');
}

// completion never writes learner progress
{
  reset();
  sql.prepare('INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)').run(owner,21,JSON.stringify({day:12,stage:'write',finished:false,completed:[1],entries:{12:{}}}));
  const job=insertJob({attemptRevision:23}),task=insertTask(job);
  await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  await completeReviewTask(d1,owner,{taskId:task.taskId,fence:1,output:output(),feedback:feedback(task),receipt:{},now:1_000_001});
  eq(row('SELECT revision,state FROM learner_states WHERE user_id=?',owner),{revision:21,state:JSON.stringify({day:12,stage:'write',finished:false,completed:[1],entries:{12:{}}})},'learner state unchanged');
}

// manual takeover: one formal result, v2 receipt binds pronunciation
{
  reset();
  const job=insertJob(),task=insertTask(job);
  eq((await findReviewTaskByAttempt(d1,owner,job.id)).id,task.taskId,'find task by exact attempt');
  eq(await findReviewTaskByAttempt(d1,other,job.id),null,'attempt lookup is owner scoped');
  const claimed=await claimManualReviewTask(d1,owner,task.taskId,{now:1_000_000,nonce:'manual-1'});
  eq([claimed.state,claimed.claimKind,claimed.fence,claimed.attempts],['running','manual',1,0],'manual claim');
  eq(claimed.claimedClientRunId,'manual:manual-1','manual claim identity');
  const recordingId=crypto.randomUUID();
  const pronunciation={band:7,reviewedWholeClip:true,observation:'fixture',recordingId,scope:'partial'};
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation},receipt:{},now:1_000_001,
    manualGrantSha256:'0'.repeat(64)}),'manual_grant_invalid','wrong manual grant');
  const first=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation},receipt:{},now:1_000_001,
    manualGrantSha256:claimed.manualGrantSha256??undefined});
  eq(first.duplicate,false,'manual first completion');
  assert.ok(typeof first.receipt.outputSha256V2==='string'&&first.receipt.outputSha256V2.length===64,'v2 receipt digest');checks++;
  const replay=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation},receipt:{},now:1_000_002,
    manualGrantSha256:claimed.manualGrantSha256??undefined});
  eq(replay.duplicate,true,'same manual output replays');
  eq(replay.receipt.id,first.receipt.id,'same manual receipt');
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation:{...pronunciation,band:6.5}},receipt:{},now:1_000_003,
    manualGrantSha256:claimed.manualGrantSha256??undefined}),
    'receipt_conflict','different pronunciation cannot reuse receipt');
  eq(await claimManualReviewTask(d1,owner,task.taskId,{now:1_000_002}),null,'completed task cannot be reclaimed');
  eq(row('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?',task.taskId).n,1,'one manual feedback');
  // Pre-upgrade receipts have no v2 digest; pronunciation still must match the
  // stored feedback row rather than being silently replaced.
  sql.prepare('UPDATE review_receipts SET output_sha256_v2=NULL WHERE task_id=?').run(task.taskId);
  const legacySame=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation},receipt:{},now:1_000_004,
    manualGrantSha256:claimed.manualGrantSha256??undefined});
  eq(legacySame.duplicate,true,'legacy receipt replays the same pronunciation');
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:claimed.fence,
    output:{...output(),analysis:null},feedback:{...feedback(task),pronunciation:{...pronunciation,band:6.5}},receipt:{},now:1_000_005,
    manualGrantSha256:claimed.manualGrantSha256??undefined}),
    'receipt_conflict','legacy receipt rejects a changed pronunciation');
}

// manual takeover revokes a live automatic lease
{
  reset();
  const job=insertJob(),task=insertTask(job);
  const [automatic]=await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'run-1'});
  eq(automatic.fence,1,'automatic fence');
  const manual=await claimManualReviewTask(d1,owner,task.taskId,{now:1_000_010,nonce:'takeover'});
  eq(manual.fence,2,'takeover fence');
  await code(completeReviewTask(d1,owner,{taskId:task.taskId,fence:1,output:output(),feedback:feedback(task),receipt:{},now:1_000_011}),
    'stale_lease','old automatic fence rejected');
  const done=await completeReviewTask(d1,owner,{taskId:task.taskId,fence:2,output:output(),feedback:feedback(task),receipt:{},now:1_000_011,
    manualGrantSha256:manual.manualGrantSha256??undefined});
  eq(done.duplicate,false,'manual completion wins');
  eq(row('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?',task.taskId).n,1,'one result after takeover');
}

console.log(JSON.stringify({suite:'review-tasks',checks,passed:true}));
