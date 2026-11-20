// Cross-tenant runner claim (rev2 §7): claimNextReviewTask selects the next due
// task ACROSS tenants and returns the row's own userId (server-derived).
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import {registerHooks} from "node:module";
import {randomUUID} from "node:crypto";

registerHooks({resolve(s,ctx,next){if(s==='@/db')return {url:'data:text/javascript,export function getDb(){throw new Error("not used")}',shortCircuit:true};return next(s,ctx)}});
const sql=new DatabaseSync(':memory:');
for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+f,'utf8'));
function stmt(q,a=[]){return{bind:(...v)=>stmt(q,[...a,...v]),async first(){const r=sql.prepare(q).all(...a)[0];return r?{...r}:null},async all(){return{results:sql.prepare(q).all(...a).map(r=>({...r}))}},run(){sql.prepare(q).all(...a);return{meta:{changes:Number(sql.prepare('SELECT changes() n').get().n)}}}}}
const d1={prepare:q=>stmt(q)};
const {claimNextReviewTask}=await import('../lib/review-tasks.ts');
let checks=0;const eq=(a,b,l)=>{assert.deepEqual(a,b,l);checks++};
function jobFor(userId,day=12){const id='v2:'+randomUUID();const snap={sourceId:'v1:x',attempt:{id,day,field:'writeOriginal',index:0,stage:'write',title:'t',kind:'subjective',response:'r',conditions:'',evidence:''},context:{prompt:'p'}};sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,userId,day,randomUUID(),'a'.repeat(64),22,JSON.stringify(snap),'2026-11-01T00:00:00Z');return{id,day}}
function taskFor(job,userId,nextAt){const taskId=randomUUID();sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,stage,state,fence,attempts,next_at,created_at,updated_at) VALUES (?,?,?,'text',?,?,?,NULL,'read_input','queued',0,0,?,?,?)`).run(taskId,job.id,userId,job.id,job.day,22,nextAt,nextAt,nextAt);return taskId}
try{
  const now=1_000_000_000;
  const aJob=jobFor('tenant-a'), bJob=jobFor('tenant-b');
  const aTask=taskFor(aJob,'tenant-a',now-10), bTask=taskFor(bJob,'tenant-b',now-5);
  // earliest next_at first (tenant-a), and userId is the ROW's tenant
  const first=await claimNextReviewTask(d1,{now,clientRunId:'r1'});
  eq(first.id,aTask,'claims earliest due task across tenants');
  eq(first.userId,'tenant-a','returns the task row tenant, not a caller identity');
  eq(first.fence,1,'fence incremented');
  const second=await claimNextReviewTask(d1,{now,clientRunId:'r1'});
  eq(second.id,bTask,'claims the other tenant next');
  eq(second.userId,'tenant-b','second tenant userId');
  const none=await claimNextReviewTask(d1,{now,clientRunId:'r1'});
  eq(none,null,'queue empty');
  // claimed tasks are running with a lease
  const row=sql.prepare('SELECT state,lease_until,claimed_by FROM review_tasks WHERE id=?').get(aTask);
  eq(row.state,'running','state running');eq(row.claimed_by,'r1','claimed_by recorded');
  console.log(`PASS ${checks} claim-any assertions`);
}catch(e){console.error('FAIL',e);process.exitCode=1}