// Grounded-prosody queue completion contract (iteration-31 rev3).
// Real SQLite + drizzle + fake R2; exercises the MCP complete_review_task
// grounded class: idempotent candidate issuance, prosody-only, wire validation,
// release gate, recording binding, owner isolation. No network.
// Run: node --experimental-strip-types tests/grounded-completion.mjs
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';

const sql=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));
function statement(query,args=[]){
  return {
    bind:(...values)=>statement(query,[...args,...values]),
    async first(){const s=sql.prepare(query);const row=s.all(...args)[0];return row?{...row}:null},
    async all(){const s=sql.prepare(query);return {results:s.all(...args).map(row=>({...row}))}},
    async run(){const s=sql.prepare(query);const results=s.all(...args);return {results,meta:{changes:Number(sql.prepare("SELECT changes() AS n").get().n)}}},
  };
}
const d1={prepare:(query)=>statement(query),async batch(statements){
  sql.exec('BEGIN');
  try{const results=[];for(const s of statements)results.push(await s.run());sql.exec('COMMIT');return results}
  catch(error){sql.exec('ROLLBACK');throw error}
}};
globalThis.testDb={$client:d1};
const digest=data=>createHash('sha256').update(data).digest('hex');
const recordingBytes=Buffer.from('grounded-fixture-audio-bytes-0123456789');
const source={sha256:digest(recordingBytes),bytes:recordingBytes.length};
const objects=new Map();
const metadata=data=>({size:data.length,customMetadata:{digest:digest(data)},httpMetadata:{contentType:'audio/webm'}});
globalThis.testBucket={
  async head(key){return objects.get(key)??null},
  async get(key){const o=objects.get(key);return o?{...o,arrayBuffer:async()=>Uint8Array.from(o.data).buffer,text:async()=>o.data.toString()}:null},
  async put(key,value,options){const data=Buffer.from(value);assert.equal(options.sha256,digest(data));if(objects.has(key))return null;const o={...metadata(data),...options,data};objects.set(key,o);return o},
};
globalThis.testEnv={BUCKET:globalThis.testBucket,ANALYSIS_SIGNING_KEY:'s'.repeat(32),
  GROUNDED_ANALYSIS_VERSION:'grounded-prosody-v1',GROUNDED_RELEASED_VERSIONS:'grounded-prosody-v1',
  BANDROOM_PUBLIC_ORIGIN:'https://fixture.example',BANDROOM_CONSENT_GATE:'off'};
registerHooks({resolve(specifier,context,next){
  if(specifier==='@/db')return {url:'data:text/javascript,export function getDb(){return globalThis.testDb};export function getTenantDb(){return globalThis.testDb};export function drizzleFromBinding(){return globalThis.testDb}',shortCircuit:true};
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.testEnv',shortCircuit:true};
  if(specifier==='@/app/chatgpt-auth')return {url:'data:text/javascript,export async function getChatGPTUser(){return globalThis.testUser}',shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,shortCircuit:true};
  if((specifier.startsWith('./')||specifier.startsWith('../'))&&!specifier.endsWith('.ts')&&context.parentURL?.endsWith('.ts'))
    return {url:new URL(specifier+'.ts',context.parentURL).href,shortCircuit:true};
  return next(specifier,context);
}});
const {callReviewTool}=await import('../lib/review-tools.ts');
const owner='grounded-owner',other='grounded-other';
let checks=0;
const eq=(a,e,l)=>{assert.deepEqual(a,e,l);checks++};
const text=r=>JSON.parse(r.content[0].text);
function reset(){sql.exec('DELETE FROM analysis_artifacts; DELETE FROM review_tasks; DELETE FROM review_jobs; DELETE FROM review_receipts; DELETE FROM teacher_feedback; DELETE FROM analysis_events; DELETE FROM calibration_candidates; DELETE FROM personal_calibration; DELETE FROM calibration_events; DELETE FROM learner_states;');objects.clear();}
function insertSpeakingJob({recordingId=randomUUID(),analysisVersion='grounded-prosody-v1',user=owner}={}){
  const jobId='v2:'+randomUUID();
  const snapshot={sourceId:'v1:fixture',attempt:{id:jobId,day:12,stage:'speak',title:'Speaking',kind:'subjective',response:'I think this is fine.',conditions:'',evidence:''},context:{prompt:'Describe a problem.'},recording:source};
  sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(jobId,user,12,randomUUID(),'a'.repeat(64),22,JSON.stringify(snapshot),new Date().toISOString());
  const created=Date.now();const taskId=randomUUID();
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,analysis_version,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId,jobId,user,'speaking',jobId,12,22,recordingId,analysisVersion,created,created,created);
  objects.set(`speaking/${user}/${recordingId}`,{...metadata(recordingBytes),data:recordingBytes});
  return {taskId,jobId,recordingId,snapshot};
}
// Claim (fence 1) then commit a decoded PCM checkpoint via the binary transfer.
// A2 integrity (recordingSha256-only): completion needs no decoded-PCM
// checkpoint, so the helper just claims the task and returns the fence. The
// decoded-checkpoint transfer (A1) is unavailable on .workers.dev
// (isCanonicalOrigin rejects it) — see CONTRACT_GATE.md.
async function claimTask(job){
  const claimed=text(await callReviewTool(owner,'claim_review_tasks',{limit:1}));
  return claimed.tasks[0].fence;
}
const commitDecode = claimTask;
const wireAnalysis=(candidates=[],extra={})=>({schema:'bandroom-grounded-analysis-v1',analysisVersion:'grounded-prosody-v1',
  detectorVersion:'det-v1',inventoryVersion:'inv-v1',speechSeconds:3.0,candidates,
  reliability:{pauseCount:2},calibrated_prosody:{pause_count:2,pause_seconds:1.8,speech_ratio:0.79},...extra});
const cand=(over={})=>({word:'think',expected:'DH',actual:'D',atMs:2000,detectorConfidence:0.7,tier:'T3',...over});
const completeArgs=(job,fence,analysis,over={})=>({taskId:job.taskId,fence,feedback:'一、评估：仅依据已校准韵律。二、精确引文：“I think this is fine”。三、建议改写：保持原句。四、修改原因：2.00 秒处停顿。五、下一步：压缩停顿。',
  evidence:'录音 '+job.recordingId+'；已校准韵律证据：停顿 1 个。',analysisVersion:'grounded-prosody-v1',recordingSha256:source.sha256,analysis,...over});
const candidateRows=job=>sql.prepare('SELECT candidate_id,expected,actual FROM calibration_candidates WHERE attempt_id=?').all(job.jobId);
const profileRow=()=>sql.prepare('SELECT n_shown FROM personal_calibration WHERE expected=? AND actual=?').get('DH','D');

// ① grounded e2e completion: receipt + items with server-issued candidateId, tier T3.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=text(await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()]))));
  assert.ok(res.receiptId,'grounded receipt issued');
  eq(res.duplicate,false,'first completion not duplicate');
  const rows=candidateRows(job);
  eq(rows.length,1,'one candidate row issued');
  const fb=sql.prepare('SELECT analysis_json FROM teacher_feedback WHERE id=?').get('rt:'+job.taskId);
  const stored=JSON.parse(fb.analysis_json);
  eq(stored.schema,'bandroom-grounded-analysis-v1','stored schema');
  eq(stored.items.length,1,'stored items');
  eq(stored.items[0].tier,'T3','tier forced T3');
  eq(stored.items[0].candidateId,rows[0].candidate_id,'candidateId matches issued row');
  eq(stored.items[0].isCatchTrial,false,'non-catch');
  assert.ok(stored.calibrated_prosody.pause_count===2,'prosody evidence stored');
  eq(profileRow().n_shown,1,'n_shown incremented once');
}
// ② duplicate complete: identical IDs, no new rows, no n_shown inflation (U-BL-1).
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const args=completeArgs(job,fence,wireAnalysis([cand()]));
  const first=text(await callReviewTool(owner,'complete_review_task',args));
  const rowsAfterFirst=candidateRows(job).map(r=>r.candidate_id);
  const shownAfterFirst=profileRow().n_shown;
  const replay=text(await callReviewTool(owner,'complete_review_task',args));
  eq(replay.duplicate,true,'replay is duplicate not conflict');
  eq(replay.receiptId,first.receiptId,'same receipt');
  eq(candidateRows(job).map(r=>r.candidate_id),rowsAfterFirst,'candidate IDs unchanged on replay');
  eq(candidateRows(job).length,1,'no duplicate candidate rows');
  eq(profileRow().n_shown,shownAfterFirst,'n_shown not inflated on replay');
}
// ③ prosody-only (items:[]): completes, no candidate rows (U-MJ-1 / Z-6).
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=text(await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([]))));
  assert.ok(res.receiptId,'prosody-only receipt');
  eq(candidateRows(job).length,0,'no candidate rows for empty candidates');
  const stored=JSON.parse(sql.prepare('SELECT analysis_json FROM teacher_feedback WHERE id=?').get('rt:'+job.taskId).analysis_json);
  eq(stored.items,[],'stored items empty');
}
// ④ wire validation: client candidateId rejected (U-BL-3).
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const bad=wireAnalysis([{...cand(),candidateId:'client-minted'}]);
  const res=await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,bad));
  eq(res.isError,true,'client candidateId rejected');
  eq(text(res).error,'invalid_analysis','candidateId rejection code');
}
// ⑤ wire validation: unknown field rejected.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()],{pronunciationBand:6.5})));
  eq(res.isError,true,'unknown field rejected');
  eq(text(res).error,'invalid_analysis','unknown field code');
}
// ⑥ release gate: GROUNDED_RELEASED_VERSIONS unset -> analysis_not_released.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const saved=globalThis.testEnv.GROUNDED_RELEASED_VERSIONS;
  delete globalThis.testEnv.GROUNDED_RELEASED_VERSIONS;
  const res=await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()])));
  eq(res.isError,true,'unreleased grounded version rejected');
  eq(text(res).error,'analysis_not_released','release gate code');
  globalThis.testEnv.GROUNDED_RELEASED_VERSIONS=saved;
}
// ⑦ recording digest mismatch rejected.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()]),{recordingSha256:'e'.repeat(64)}));
  eq(res.isError,true,'recording mismatch rejected');
  eq(text(res).error,'recording_mismatch','recording mismatch code');
}
// ⑧ owner isolation: another tenant cannot complete the owner's task (U-BL-2 scope).
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=await callReviewTool(other,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()])));
  eq(res.isError,true,'foreign tenant cannot complete');
  eq(text(res).error,'task_not_found','foreign completion scoped to owner');
}
// ⑨ catch trial: actual forced to expected, isCatchTrial true, no profile row.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const res=text(await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand({expected:'DH',actual:'DH',catchTrial:true})]))));
  assert.ok(res.receiptId,'catch trial completes');
  const stored=JSON.parse(sql.prepare('SELECT analysis_json FROM teacher_feedback WHERE id=?').get('rt:'+job.taskId).analysis_json);
  eq(stored.items[0].isCatchTrial,true,'catch trial flagged');
  eq(sql.prepare('SELECT COUNT(*) n FROM personal_calibration').get().n,0,'catch trial writes no profile row');
}
// ⑩ security: altered replay on a completed task must NOT mutate calibration.
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  const first=text(await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()]))));
  const rowsBefore=candidateRows(job).map(r=>r.candidate_id);
  const shownBefore=profileRow().n_shown;
  // Different candidates + different feedback on the already-completed task.
  const altered=completeArgs(job,fence,wireAnalysis([cand({word:'other',expected:'TH',actual:'T',atMs:3000}),cand({word:'more',expected:'S',actual:'Z',atMs:4000})]),{feedback:'一、评估： altered。二、精确引文：“I think this is fine”。三、建议改写：无。四、修改原因：无。五、下一步：无。'});
  const replay=text(await callReviewTool(owner,'complete_review_task',altered));
  eq(replay.duplicate,true,'altered replay returns stored duplicate');
  eq(replay.receiptId,first.receiptId,'original receipt unchanged');
  eq(candidateRows(job).map(r=>r.candidate_id),rowsBefore,'no new candidate rows from altered replay');
  eq(profileRow().n_shown,shownBefore,'n_shown not inflated by altered replay');
  eq(sql.prepare('SELECT COUNT(*) n FROM calibration_candidates WHERE attempt_id=?').get(job.jobId).n,1,'still exactly one candidate row');
}
// ⑪ fail-closed: snapshot lacking recording digest -> recording_unbound (no skip).
reset();
{
  const job=insertSpeakingJob();
  const fence=await commitDecode(job);
  // strip the recording identity from the frozen snapshot
  const row=sql.prepare('SELECT snapshot FROM review_jobs WHERE id=?').get(job.jobId);
  const snap=JSON.parse(row.snapshot); delete snap.recording;
  sql.prepare('UPDATE review_jobs SET snapshot=? WHERE id=?').run(JSON.stringify(snap), job.jobId);
  const res=await callReviewTool(owner,'complete_review_task',completeArgs(job,fence,wireAnalysis([cand()])));
  eq(res.isError,true,'absent snapshot recording rejected');
  eq(text(res).error,'recording_unbound','recording_unbound code');
  eq(sql.prepare('SELECT COUNT(*) n FROM calibration_candidates WHERE attempt_id=?').get(job.jobId).n,0,'no candidate rows on unbound snapshot');
}
console.log(JSON.stringify({suite:'grounded-completion',checks,passed:true}));