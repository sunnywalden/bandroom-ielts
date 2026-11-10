// MCP review tools against real SQLite: claim, checkpoint, completion,
// idempotency, owner isolation and refusal paths. No network.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';

const sql=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));

function statement(query,args=[]){
  return {
    bind:(...values)=>statement(query,[...args,...values]),
    async first(){const s=sql.prepare(query);const row=s.all(...args)[0];return row?{...row}:null},
    async all(){const s=sql.prepare(query);return {results:s.all(...args).map(row=>({...row}))}},
    async run(){const s=sql.prepare(query);const info=s.run(...args);return {meta:{changes:Number(info.changes)}}},
  };
}
const d1={prepare:(query)=>statement(query),async batch(statements){
  sql.exec('BEGIN');
  try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results}
  catch(error){sql.exec('ROLLBACK');throw error}
}};
globalThis.testDb={$client:d1};
registerHooks({resolve(specifier,context,next){
  if(specifier==='@/db')return {url:'data:text/javascript,export function getDb(){return globalThis.testDb}',shortCircuit:true};
  if(specifier.startsWith('./')&&!specifier.endsWith('.ts')&&context.parentURL?.endsWith('.ts'))
    return {url:new URL(specifier+'.ts',context.parentURL).href,shortCircuit:true};
  return next(specifier,context);
}});

const {callReviewTool,reviewTools}=await import('../lib/review-tools.ts');
const owner='tool-owner',other='tool-other';
let checks=0;
function eq(actual,expected,label){assert.deepEqual(actual,expected,label);checks++}
function text(result){return JSON.parse(result.content[0].text)}
function reset(){sql.exec('DELETE FROM review_tasks; DELETE FROM review_jobs; DELETE FROM review_receipts; DELETE FROM teacher_feedback; DELETE FROM analysis_events; DELETE FROM scheduler_heartbeats; DELETE FROM learner_states;')}
function insertJob({taskId=randomUUID(),kind='text',recordingId=null,stage='write'}={}){
  const jobId='v2:'+randomUUID();
  const snapshot={sourceId:'v1:fixture',attempt:{id:jobId,day:12,field:'writeOriginal',index:0,stage,title:'Fixture',kind:'subjective',response:'Fixture answer',conditions:'',evidence:''},context:{prompt:'Fixture prompt'}};
  sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(jobId,owner,12,randomUUID(),'a'.repeat(64),22,JSON.stringify(snapshot),new Date().toISOString());
  const created=Date.now();
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId,jobId,owner,kind,jobId,12,22,recordingId,created,created,created);
  return {taskId,jobId,snapshot};
}

reset();
const textJob=insertJob();
const tools=new Set(reviewTools.map(tool=>tool.name));
eq(tools.has('claim_review_tasks')&&tools.has('complete_review_task'),true,'tools exposed');

// claim returns task + immutable snapshot
const claimed=await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-1'});
eq(claimed.isError,undefined,'claim success');
const claimedBody=text(claimed);
eq(claimedBody.tasks.length,1,'one claimed');
const claimedTask=claimedBody.tasks[0];
eq([claimedTask.id,claimedTask.kind,claimedTask.fence,claimedTask.state],[textJob.taskId,'text',1,'running'],'claimed task shape');
eq(claimedTask.snapshot.attempt.id,textJob.jobId,'snapshot bound');
eq(text(await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-2'})).tasks.length,0,'no duplicate claim');

// checkpoint + renew
eq(text(await callReviewTool(owner,'renew_review_lease',{taskId:textJob.taskId,fence:1,extendMs:600_000})).leaseUntil>Date.now(),true,'renewed');
const checkpoint=text(await callReviewTool(owner,'save_review_checkpoint',{
  taskId:textJob.taskId,fence:1,analysisVersion:'analysis-v1',stage:'read_input',chunkIndex:0,
  inputSha256:'a'.repeat(64),artifactSha256:'b'.repeat(64),bytes:12,coverage:1,
}));
eq(checkpoint.saved,true,'checkpoint saved');

// text cannot claim acoustic evidence
const badText=await callReviewTool(owner,'complete_review_task',{
  taskId:textJob.taskId,fence:1,feedback:'Text correction',evidence:'Text evidence',
  analysis:{errors:[]},
});
eq(badText.isError,true,'text analysis rejected');
eq(text(badText).code ?? text(badText).error,'analysis_not_allowed','text analysis code');

// complete, replay, receipt, one feedback, learner state untouched
sql.prepare('INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)').run(owner,21,JSON.stringify({day:12,stage:'write',finished:false,completed:[1]}));
const completed=text(await callReviewTool(owner,'complete_review_task',{
  taskId:textJob.taskId,fence:1,feedback:'Text correction',evidence:'Text evidence',
}));
eq(typeof completed.receiptId,'string','receipt id');
eq(completed.duplicate,false,'first completion');
const replay=text(await callReviewTool(owner,'complete_review_task',{
  taskId:textJob.taskId,fence:1,feedback:'Text correction',evidence:'Text evidence',
}));
eq([replay.receiptId,replay.duplicate],[completed.receiptId,true],'replay same receipt');
const receipt=text(await callReviewTool(owner,'read_review_receipt',{taskId:textJob.taskId}));
eq(receipt.id,completed.receiptId,'read receipt');
eq(sql.prepare('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?').get(textJob.taskId).n,1,'one feedback');
eq(sql.prepare('SELECT COUNT(*) n FROM review_receipts WHERE task_id=?').get(textJob.taskId).n,1,'one receipt');
eq(sql.prepare('SELECT revision FROM learner_states WHERE user_id=?').get(owner).revision,21,'progress unchanged');

// owner isolation
eq((await callReviewTool(other,'read_review_receipt',{taskId:textJob.taskId})).content[0].text,'null','other receipt hidden');
const foreign=await callReviewTool(other,'complete_review_task',{taskId:textJob.taskId,fence:1,feedback:'Other',evidence:'Other'});
eq(foreign.isError,true,'other completion rejected');
eq(text(foreign).code ?? text(foreign).error,'task_not_found','other completion code');

// speaking requires analysis
reset();
const speakingJob=insertJob({kind:'speaking',recordingId:randomUUID(),stage:'speak'});
await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-speak'});
const missing=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
});
eq(missing.isError,true,'speaking missing analysis');
eq(text(missing).code ?? text(missing).error,'analysis_required','speaking analysis code');
const speaking=text(await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v1',recordingSha256:'c'.repeat(64),analysis:{errors:[]},
}));
eq(speaking.duplicate,false,'speaking completion');

// retry path + heartbeat
reset();
const retryJob=insertJob();
await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-retry'});
const retryAt=Date.now()+120_000;
const failed=text(await callReviewTool(owner,'fail_review_task',{
  taskId:retryJob.taskId,fence:1,code:'temporary_read_failure',retryable:true,nextAt:retryAt,
}));
eq([failed.state,failed.nextAt],['retry_wait',retryAt],'retry state');
eq((await callReviewTool(owner,'report_scheduler_heartbeat',{
  automationId:'Automation_fixture',generation:1,clientRunId:'run-1',status:'finished',startedAt:1,finishedAt:2,nextExpectedAt:3,
})).isError,undefined,'heartbeat');
eq((await callReviewTool(owner,'read_review_receipt',{taskId:retryJob.taskId})).content[0].text,'null','no receipt for retry');
eq((await callReviewTool(owner,'unknown_tool',{})).isError,true,'unknown tool');

console.log(JSON.stringify({suite:'review-tools',checks,passed:true}));
