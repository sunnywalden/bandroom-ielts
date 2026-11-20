// Write-side cross-tenant isolation matrix (rev2 S11). Two tenants share one
// SQLite DB; a foreign tenant must never mutate or read the victim's rows.
import assert from "node:assert/strict";
import {DatabaseSync} from "node:sqlite";
import {readFileSync,readdirSync} from "node:fs";
import {registerHooks} from "node:module";
import {randomUUID} from "node:crypto";

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
const {assertTenantPredicate}=await import('../lib/tenant-db.ts');
// Guard every statement the production functions execute: if any tenant query
// lacks a user_id predicate, the tripwire throws and the test fails.
const d1={prepare:(query)=>{assertTenantPredicate(query);return statement(query)},async batch(statements){sql.exec('BEGIN');try{const r=statements.map(s=>s.run());sql.exec('COMMIT');return r}catch(e){sql.exec('ROLLBACK');throw e}}};

const {claimReviewTasks,saveReviewCheckpoint,readReviewCheckpoint,completeReviewTask,ReviewTaskError}=await import('../lib/review-tasks.ts');
const owner='tenant-owner', other='tenant-other';
let checks=0;
const eq=(a,b,l)=>{assert.deepEqual(a,b,l);checks++};
const row=(q,...a)=>{const r=sql.prepare(q).get(...a);return r?{...r}:null};

function insertJob({userId,day=12}={}){
  const id='v2:'+randomUUID();
  const snapshot={sourceId:'v1:fixture',attempt:{id,day,field:'writeOriginal',index:0,stage:'write',title:'Fixture',kind:'subjective',response:'Fixture answer',conditions:'',evidence:''},context:{prompt:'Fixture prompt'}};
  sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(id,userId,day,randomUUID(),'a'.repeat(64),22,JSON.stringify(snapshot),new Date().toISOString());
  return {id,day};
}
function insertTask(job,userId){
  const taskId=randomUUID();
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,'text',?,?,?,NULL,'read_input','queued',0,0,?,?,?)`)
    .run(taskId,job.id,userId,job.id,job.day,22,1_000_000,1_000_000,1_000_000);
  return taskId;
}
const feedback=(taskId,attempt)=>({id:'fb-'+taskId,day:12,stage:'write',attempt,evidence:'e',feedback:'f',analysis:{errors:[]}});

try{
  // Victim tenant owns a running task (claimed by its own runner).
  const job=insertJob({userId:owner});
  const taskId=insertTask(job,owner);
  const claimed=await claimReviewTasks(d1,owner,{now:1_000_000,limit:1,clientRunId:'owner-run'});
  eq(claimed.length,1,'owner claims its task');
  eq(row('SELECT state FROM review_tasks WHERE id=? AND user_id=?',taskId,owner).state,'running','owner task running');

  const attack=async(fn)=>{try{await fn()}catch(e){assert.ok(e instanceof ReviewTaskError || e instanceof Error)}};

  // 1. Foreign user cannot write a checkpoint to the owner's task.
  await attack(()=>saveReviewCheckpoint(d1,other,{taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'x',bytes:10,now:1_000_000}));
  eq(row('SELECT COUNT(*) n FROM analysis_artifacts WHERE task_id=?',taskId).n,0,'no artifact created for victim');
  eq(row('SELECT checkpoint_sha256 AS c FROM review_tasks WHERE id=?',taskId).c,null,'victim checkpoint untouched');
  eq(row('SELECT state FROM review_tasks WHERE id=?',taskId).state,'running','victim state untouched');

  // 2. Foreign user cannot read the victim's checkpoint.
  let readThrew=false;
  try{await readReviewCheckpoint(d1,other,{taskId,fence:1,stage:'decode',chunkIndex:0})}catch{readThrew=true}
  eq(readThrew,true,'foreign checkpoint read refused');

  // 3. Foreign user cannot complete the victim's task.
  const attempt='attempt-owner';
  await attack(()=>completeReviewTask(d1,other,{taskId,fence:1,output:{feedback:'x',errors:[]},feedback:feedback(taskId,attempt),receipt:{},now:1_000_000}));
  eq(row('SELECT COUNT(*) n FROM teacher_feedback WHERE review_task_id=?',taskId).n,0,'no feedback written for victim');
  eq(row('SELECT COUNT(*) n FROM review_receipts WHERE task_id=?',taskId).n,0,'no receipt written for victim');
  eq(row('SELECT state FROM review_tasks WHERE id=?',taskId).state,'running','victim task not completed by foreign');

  // 4. The owner can still operate its own task (control: no false lockout).
  const ok=await saveReviewCheckpoint(d1,owner,{taskId,fence:1,analysisVersion:'v1',stage:'decode',chunkIndex:0,inputSha256:'i',artifactSha256:'y',bytes:10,now:1_100_000});
  eq(row('SELECT COUNT(*) n FROM analysis_artifacts WHERE task_id=?',taskId).n,1,'owner writes own checkpoint');
  assert.ok(ok && ok.checkpointSha256,'owner checkpoint committed');checks++;

  console.log(`PASS ${checks} tenant-isolation assertions`);
}catch(error){console.error('FAIL',error);process.exitCode=1}