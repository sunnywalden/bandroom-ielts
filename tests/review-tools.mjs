// MCP review tools against real SQLite: claim, checkpoint, completion,
// idempotency, owner isolation and refusal paths. No network.
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
const recordingBytes=Buffer.from('0123456789abcdef');
const bundleBytes=Buffer.from('analysis-bundle');
const bundleManifest={version:'v1',bundleSha256:'e'.repeat(64),bytes:bundleBytes.length};
globalThis.testBucket={
  async head(key){const size=key.endsWith('manifest.json')?JSON.stringify(bundleManifest).length:key.includes('bundle.tar.zst')?bundleBytes.length:recordingBytes.length;return {size,customMetadata:{digest:'c'.repeat(64)},httpMetadata:{contentType:'audio/webm'}}},
  async get(key,options){
    if(key.endsWith('manifest.json'))return {text:async()=>JSON.stringify(bundleManifest)};
    const source=key.includes('bundle.tar.zst')?bundleBytes:recordingBytes;
    const offset=options?.range?.offset??0,length=options?.range?.length??source.length;
    const slice=source.subarray(offset,offset+length);
    return {arrayBuffer:async()=>slice.buffer.slice(slice.byteOffset,slice.byteOffset+slice.byteLength),body:new Response(slice).body};
  },
};
globalThis.testEnv={BUCKET:globalThis.testBucket,ANALYSIS_SIGNING_KEY:'s'.repeat(32),ANALYSIS_BUNDLE_VERSION:'v1',ANALYSIS_RELEASED_VERSIONS:'analysis-v1',BANDROOM_PUBLIC_ORIGIN:'https://fixture.example',BANDROOM_CONSENT_GATE:'off'};
registerHooks({resolve(specifier,context,next){
  if(specifier==='@/db')return {url:'data:text/javascript,export function getDb(){return globalThis.testDb}',shortCircuit:true};
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env=globalThis.testEnv',shortCircuit:true};
  if(specifier==='@/app/chatgpt-auth')return {url:'data:text/javascript,export async function getChatGPTUser(){return globalThis.testUser}',shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,shortCircuit:true};
  if((specifier.startsWith('./')||specifier.startsWith('../'))&&!specifier.endsWith('.ts')&&context.parentURL?.endsWith('.ts'))
    return {url:new URL(specifier+'.ts',context.parentURL).href,shortCircuit:true};
  return next(specifier,context);
}});

const {callReviewTool,reviewTools}=await import('../lib/review-tools.ts');
const {POST:takeoverPost}=await import('../app/api/review-tasks/takeover/route.ts');
const {GET:bundleGet}=await import('../app/api/analysis-bundle/route.ts');
const {GET:transferGet,PUT:transferPut}=await import('../app/api/review-transfer/route.ts');
const owner='tool-owner',other='tool-other';
let checks=0;
function eq(actual,expected,label){assert.deepEqual(actual,expected,label);checks++}
function text(result){return JSON.parse(result.content[0].text)}
function reset(){sql.exec('DELETE FROM analysis_artifacts; DELETE FROM review_tasks; DELETE FROM review_jobs; DELETE FROM review_receipts; DELETE FROM teacher_feedback; DELETE FROM analysis_events; DELETE FROM scheduler_heartbeats; DELETE FROM automation_heartbeats; DELETE FROM learner_states;')}
function insertJob({taskId=randomUUID(),kind='text',recordingId=null,recording,analysisVersion=null,stage='write'}={}){
  const jobId='v2:'+randomUUID();
  const snapshot={sourceId:'v1:fixture',attempt:{id:jobId,day:12,field:'writeOriginal',index:0,stage,title:'Fixture',kind:'subjective',response:'Fixture answer',conditions:'',evidence:''},context:{prompt:'Fixture prompt'}};
  if(recording) snapshot.recording=recording;
  sql.prepare('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)')
    .run(jobId,owner,12,randomUUID(),'a'.repeat(64),22,JSON.stringify(snapshot),new Date().toISOString());
  const created=Date.now();
  sql.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,analysis_version,stage,state,fence,attempts,next_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'read_input','queued',0,0,?,?,?)`)
    .run(taskId,jobId,owner,kind,jobId,12,22,recordingId,analysisVersion,created,created,created);
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
const restored=text(await callReviewTool(owner,'read_review_checkpoint',{taskId:textJob.taskId,fence:1}));
eq(restored.checkpoint.artifactSha256,'b'.repeat(64),'checkpoint readback digest');
await assert.rejects(callReviewTool(owner,'read_review_checkpoint',{taskId:textJob.taskId,fence:1,stage:'read_input'}),/Provide both stage and chunkIndex/);
const checkpointTrace=sql.prepare("SELECT client_run_id,metadata_json FROM analysis_events WHERE task_id=? AND event='read_review_checkpoint'").get(textJob.taskId);
eq([checkpointTrace.client_run_id,JSON.parse(checkpointTrace.metadata_json).artifactSha256],['run-1','b'.repeat(64)],'checkpoint event bound to claim');

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
const receipt=text(await callReviewTool(owner,'read_review_receipt',{taskId:textJob.taskId,clientRunId:'readback-run'}));
eq(receipt.id,completed.receiptId,'read receipt');
eq(sql.prepare("SELECT client_run_id FROM analysis_events WHERE task_id=? AND event='read_review_receipt'").get(textJob.taskId).client_run_id,'readback-run','explicit receipt run correlation');
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
const grant=text(await callReviewTool(owner,'get_analysis_bundle',{taskId:speakingJob.taskId,fence:1}));
eq([grant.version,grant.bytes],[ 'v1',bundleBytes.length],'bundle grant');
const bundleUrl=new URL(grant.url);
const full=await bundleGet(new Request(bundleUrl));
eq(full.status,200,'bundle download');
eq(await full.text(),'analysis-bundle','bundle body');
const ranged=await bundleGet(new Request(bundleUrl,{headers:{Range:'bytes=0-3'}}));
eq(ranged.status,206,'bundle range status');eq(await ranged.text(),'anal','bundle range body');
eq((await bundleGet(new Request(bundleUrl,{headers:{Origin:'https://evil.example'}}))).status,403,'bundle origin rejected');
eq((await bundleGet(new Request('https://fixture.example/api/analysis-bundle?token=abc.def'))).status,403,'invalid token rejected');
// H20: redemption re-checks live task/tenant state, not just the signed token.
const claimedLease=sql.prepare('SELECT lease_until FROM review_tasks WHERE id=?').get(speakingJob.taskId).lease_until;
sql.prepare('UPDATE review_tasks SET lease_until=? WHERE id=?').run(Date.now()-1,speakingJob.taskId);
eq((await bundleGet(new Request(bundleUrl))).status,403,'expired task lease rejects bundle token');
sql.prepare('UPDATE review_tasks SET lease_until=? WHERE id=?').run(claimedLease,speakingJob.taskId);
eq((await bundleGet(new Request(bundleUrl))).status,200,'live lease still downloads');
sql.prepare('UPDATE review_tasks SET fence=fence+1 WHERE id=?').run(speakingJob.taskId);
eq((await bundleGet(new Request(bundleUrl))).status,403,'reclaimed fence rejects bundle token');
sql.prepare('UPDATE review_tasks SET fence=fence-1 WHERE id=?').run(speakingJob.taskId);
const stamp=Date.now();
sql.prepare(`INSERT INTO users
  (user_id,idp_iss,idp_sub,email_normalized,role,status,revocation_epoch,created_at,updated_at)
  VALUES (?,?,?,?,?,?,?,?,?)`).run(owner,'issuer',owner,`${owner}@example.test`,'learner','suspended',0,stamp,stamp);
eq((await bundleGet(new Request(bundleUrl))).status,403,'suspended tenant rejects bundle token');
sql.prepare('DELETE FROM users WHERE user_id=?').run(owner);
eq((await bundleGet(new Request(bundleUrl))).status,200,'active tenant still downloads');
globalThis.testEnv.ANALYSIS_SIGNING_KEY='';
globalThis.testEnv.ANALYSIS_SIGNING_KEY='';
const unsigned=await callReviewTool(owner,'get_analysis_bundle',{taskId:speakingJob.taskId,fence:1});
eq(unsigned.isError,true,'missing signing key');eq(text(unsigned).error,'bundle_signing_unavailable','signing error code');
globalThis.testEnv.ANALYSIS_SIGNING_KEY='s'.repeat(32);
const chunk=text(await callReviewTool(owner,'read_review_recording',{taskId:speakingJob.taskId,fence:1,offset:0,length:4}));
eq([chunk.offset,chunk.length,chunk.total,chunk.nextOffset],[0,4,16,4],'recording range');
eq(chunk.base64,Buffer.from('0123').toString('base64'),'recording base64');
eq(chunk.sha256,'c'.repeat(64),'recording digest');
const readRange={taskId:speakingJob.taskId,fence:1,offset:4,length:4};
const originalGet=globalThis.testBucket.get;
globalThis.testBucket.get=async()=>({arrayBuffer:async()=>new ArrayBuffer(1)});
eq(text(await callReviewTool(owner,'read_review_recording',readRange)),{error:'recording_range_truncated',retryable:true},'reject truncated storage response');
globalThis.testBucket.get=async()=>{throw new Error('R2 transient error');};
eq(text(await callReviewTool(owner,'read_review_recording',readRange)),{error:'recording_read_failed',retryable:true},'classify transient storage response');
globalThis.testBucket.get=originalGet;
eq(text(await callReviewTool(owner,'read_review_recording',readRange)).base64,Buffer.from('4567').toString('base64'),'retry same range');
const reads=sql.prepare("SELECT client_run_id,outcome,metadata_json FROM analysis_events WHERE task_id=? AND event='read_review_recording' ORDER BY id").all(speakingJob.taskId);
eq(reads.map(row=>[row.client_run_id,row.outcome,JSON.parse(row.metadata_json).offset]),[
  ['run-speak','ok',0],['run-speak','error',4],['run-speak','error',4],['run-speak','ok',4],
],'range attempts correlated to exact claim');
eq((await callReviewTool(owner,'read_review_recording',{taskId:speakingJob.taskId,fence:2,offset:0,length:4})).isError,true,'stale fence recording');
eq((await callReviewTool(other,'read_review_recording',{taskId:speakingJob.taskId,fence:1,offset:0,length:4})).isError,true,'other owner recording');
const missing=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
});
eq(missing.isError,true,'speaking missing analysis');
eq(text(missing).code ?? text(missing).error,'analysis_required','speaking analysis code');
const baseAnalysis={schemaVersion:1,analysisVersion:'analysis-v1',inputSha256:'c'.repeat(64),
  decoded:{sampleRateHz:16000,sampleCount:16000},coverage:{analyzedSamples:[[0,16000]],fraction:1},state:'completed',errors:[]};
const unreleased=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v2',recordingSha256:'c'.repeat(64),
  analysis:{...baseAnalysis,analysisVersion:'analysis-v2'},
});
eq(unreleased.isError,true,'unreleased analysis rejected');eq(text(unreleased).error,'analysis_not_released','release gate code');
const wrongRecording=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v1',recordingSha256:'e'.repeat(64),
  analysis:{...baseAnalysis,inputSha256:'e'.repeat(64)},
});
eq(wrongRecording.isError,true,'wrong recording rejected');eq(text(wrongRecording).error,'recording_mismatch','recording digest code');
const invalidCoverage=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v1',recordingSha256:'c'.repeat(64),
  analysis:{...baseAnalysis,coverage:{analyzedSamples:[[0,8000]],fraction:0.5}},
});
eq(invalidCoverage.isError,true,'incomplete coverage rejected');eq(text(invalidCoverage).error,'invalid_analysis','coverage error code');
const blockedAnalysis=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v1',recordingSha256:'c'.repeat(64),
  analysis:{...baseAnalysis,state:'blocked',reason:'qualified_analyzer_unavailable'},
});
eq(blockedAnalysis.isError,true,'blocked analysis rejected');eq(text(blockedAnalysis).error,'invalid_analysis','blocked analysis code');
const noCheckpoint=await callReviewTool(owner,'complete_review_task',{
  taskId:speakingJob.taskId,fence:1,feedback:'Speech',evidence:'Speech',
  analysisVersion:'analysis-v1',recordingSha256:'c'.repeat(64),analysis:baseAnalysis,
});
eq(text(noCheckpoint).error,'checkpoint_missing','speaking completion requires a committed PCM object');

// Binary transport with independently hashed synthetic bytes and three leases.
{
reset();
const digest=data=>createHash('sha256').update(data).digest('hex');
const source={sha256:digest(recordingBytes),bytes:recordingBytes.length};
const recordingId=randomUUID();
const transferJob=insertJob({kind:'speaking',recordingId,recording:source,analysisVersion:'analysis-v1',stage:'speak'});
const sourceKey=`speaking/${owner}/${recordingId}`;
const objects=new Map();
const metadata=data=>({size:data.length,customMetadata:{digest:digest(data)},httpMetadata:{contentType:'audio/wav'}});
objects.set(sourceKey,{...metadata(recordingBytes),data:recordingBytes});
const bundle=Buffer.from('isolated test bundle');
const bundleSha256=digest(bundle);
const runtimeBundleSha256='f'.repeat(64);
globalThis.testEnv.ANALYSIS_RUNTIME_BUNDLE_SHA256=runtimeBundleSha256;
const bundleManifest=Buffer.from(JSON.stringify({version:'analysis-v1',bundleSha256,bytes:bundle.length}));
objects.set('analysis/analysis-v1/manifest.json',{...metadata(bundleManifest),data:bundleManifest});
objects.set('analysis/analysis-v1/bundle.tar.zst',{...metadata(bundle),data:bundle});
let failOriginalRead=true;
let failAcousticRead=false;
globalThis.testEnv.BUCKET={
  async head(key){return objects.get(key)??null},
  async get(key){
    if(key===sourceKey&&failOriginalRead)throw new Error('R2 read temporarily unavailable');
    if(key===firstChunkKey&&failAcousticRead)throw new Error('R2 checkpoint read temporarily unavailable');
    const object=objects.get(key);
    return object?{...object,arrayBuffer:async()=>Uint8Array.from(object.data).buffer,
      text:async()=>object.data.toString()}:null;
  },
  async put(key,value,options){
    const data=Buffer.from(value);
    assert.equal(options.sha256,digest(data));
    assert.equal(options.onlyIf.etagDoesNotMatch,'*');
    if(objects.has(key))return null;
    const object={...metadata(data),...options,data};
    objects.set(key,object);
    return object;
  },
};
const transferGrant=async(fence,action,fields={},user=owner)=>text(await callReviewTool(user,'get_review_transfer',{
  taskId:transferJob.taskId,fence,action,...fields,
}));
function transferRequest(grant,body,headers={}){
  return new Request(grant.url,{
    method:grant.method,body,headers:{Authorization:grant.authorization,...headers},
  });
}
const pcm=Buffer.alloc(32_000);
const manifest={
  format:'bandroom-decode-v1',analysisVersion:'analysis-v1',inputSha256:source.sha256,inputBytes:source.bytes,
  container:'wav',codec:'pcm_s16le',sourceRateHz:16000,sourceChannels:1,containerDurationMs:1000,primingMs:null,
  pcm:{encoding:'s16le',rateHz:16000,channels:1,sampleCount:16000,sha256:digest(pcm)},
  mediaTime:{originMs:0,samplesPerSecond:16000},
};
function encodeArtifact(manifest,body){
  const json=Buffer.from(JSON.stringify(manifest));
  const length=Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([length,json,body]);
}
function encodeAcoustic(manifest,body){
  const ordered=Object.fromEntries(Object.keys(manifest).sort().map(key=>[key,manifest[key]]));
  return encodeArtifact(ordered,body);
}
const decoded=encodeArtifact(manifest,pcm);
const decodedFields={artifactSha256:digest(decoded),bytes:decoded.length};
const features=Buffer.alloc(49*768*4);
const acousticHeader={
  format:'bandroom-acoustic-chunk-v1',chunkIndex:0,previousSha256:decodedFields.artifactSha256,
  decodeSha256:decodedFields.artifactSha256,bundleSha256:runtimeBundleSha256,configSha256:'a'.repeat(64),featuresSha256:digest(features),
};
const firstChunk=encodeAcoustic(acousticHeader,features);
const firstChunkSha256=digest(firstChunk);
const firstChunkKey=`review-checkpoints/${owner}/${transferJob.taskId}/${firstChunkSha256}`;
const secondHeader={...acousticHeader,chunkIndex:1,previousSha256:firstChunkSha256};
const secondChunk=encodeAcoustic(secondHeader,features);
const grantForChunk=(fence,chunkIndex,data)=>transferGrant(fence,'save_acoustic',{
  chunkIndex,artifactSha256:digest(data),bytes:data.length,
});
await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-a'});
eq((await transferGrant(1,'read_recording',{},other)).error,'task_not_found','binary grant is owner isolated');
const firstRead=await transferGrant(1,'read_recording');
eq(firstRead.input,source,'original grant binds actual SHA and length');
const readError=await transferGet(transferRequest(firstRead));
eq([readError.status,await readError.json()],[503,{error:'recording_read_failed',retryable:true}],'binary read failure');
const retry=text(await callReviewTool(owner,'fail_review_task',{
  taskId:transferJob.taskId,fence:1,code:'recording_read_failed',retryable:true,nextAt:Date.now()-1,
}));
eq(retry.state,'retry_wait','read failure schedules persistent retry');
const secondClaim=text(await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-b'})).tasks[0];
eq([secondClaim.id,secondClaim.fence],[transferJob.taskId,2],'new run reclaims same task');
eq((await transferGet(transferRequest(firstRead))).status,409,'previous grant invalid after reclaim');

const firstSource=objects.get(sourceKey);
objects.set(sourceKey,{...metadata(Buffer.from('replacement')),data:Buffer.from('replacement')});
eq((await transferGrant(2,'read_recording')).error,'recording_changed','grant checks frozen snapshot identity');
objects.set(sourceKey,firstSource);
const nextRead=await transferGrant(2,'read_recording');
eq((await transferGet(transferRequest(nextRead,undefined,{Origin:'https://evil.example'}))).status,403,'cross-origin binary request refused');
eq((await transferGet(new Request(nextRead.url))).status,403,'missing binary grant refused');
failOriginalRead=false;
objects.set(sourceKey,{...firstSource,data:Buffer.alloc(recordingBytes.length)});
eq((await transferGet(transferRequest(nextRead))).status,422,'object bytes must match stored digest');
objects.set(sourceKey,firstSource);
const original=await transferGet(transferRequest(nextRead));
eq([original.status,original.headers.get('X-Bandroom-SHA256'),Buffer.from(await original.arrayBuffer())],
  [200,source.sha256,recordingBytes],'full original binary transfer');

const save=await transferGrant(2,'save_decode',decodedFields);
const tampered=Buffer.from(decoded);
tampered[tampered.length-1]^=1;
eq((await transferPut(transferRequest(save,tampered))).status,422,'authorized digest rejects tampered PCM');
const wrongTimeline=encodeArtifact({...manifest,mediaTime:{originMs:20,samplesPerSecond:16000}},pcm);
const wrongGrant=await transferGrant(2,'save_decode',{artifactSha256:digest(wrongTimeline),bytes:wrongTimeline.length});
eq((await transferPut(transferRequest(wrongGrant,wrongTimeline))).status,422,'invalid media timeline cannot commit');
eq((await transferGrant(2,'read_decode')).error,'checkpoint_missing','failed writes leave no checkpoint');
const saved=await transferPut(transferRequest(save,decoded));
eq([saved.status,(await saved.json()).checkpointSha256],[201,decodedFields.artifactSha256],'decoded PCM stored and committed');
const decodeReplay=await transferPut(transferRequest(save,decoded));
eq([decodeReplay.status,(await decodeReplay.json()).duplicate],[200,true],'identical checkpoint replay is idempotent');
const otherDecoded=encodeArtifact({...manifest,containerDurationMs:null},pcm);
const conflict=await transferGrant(2,'save_decode',{artifactSha256:digest(otherDecoded),bytes:otherDecoded.length});
eq((await transferPut(transferRequest(conflict,otherDecoded))).status,409,'conflicting checkpoint cannot overwrite');

eq((await grantForChunk(2,1,secondChunk)).error,'checkpoint_missing','cannot skip the first acoustic chunk');
eq((await grantForChunk(2,2,secondChunk)).error,'invalid_acoustic_checkpoint','chunk must be within canonical timeline');
delete globalThis.testEnv.ANALYSIS_RUNTIME_BUNDLE_SHA256;
eq(await grantForChunk(2,0,firstChunk),{error:'transfer_unconfigured'},
  'missing runtime bundle digest refuses the first acoustic grant');
globalThis.testEnv.ANALYSIS_RUNTIME_BUNDLE_SHA256=runtimeBundleSha256;
const analysisBound=encodeAcoustic({...acousticHeader,bundleSha256},features);
eq((await transferPut(transferRequest(await grantForChunk(2,0,analysisBound),analysisBound))).status,422,
  'analysis bundle digest cannot bind an acoustic chunk');
for(const [data,message] of [
  [encodeAcoustic({...acousticHeader,decodeSha256:'e'.repeat(64)},features),'chunk must bind the committed decode'],
  [encodeAcoustic({...acousticHeader,bundleSha256:'e'.repeat(64)},features),'first chunk must bind the task bundle'],
  [encodeAcoustic(acousticHeader,features.subarray(4)),'chunk must have exact feature geometry'],
  [encodeArtifact(acousticHeader,features),'a manifest that the Python runner cannot restore is refused'],
]){
  const bad=await grantForChunk(2,0,data);
  const rejected=await transferPut(transferRequest(bad,data));
  eq([rejected.status,(await rejected.json()).error],[422,'invalid_acoustic_checkpoint'],message);
}
const firstChunkGrant=await grantForChunk(2,0,firstChunk);
const firstCheckpoint=await transferPut(transferRequest(firstChunkGrant,firstChunk));
eq([firstCheckpoint.status,(await firstCheckpoint.json()).checkpointSha256],[201,firstChunkSha256],
  'first acoustic chunk is durably committed');

sql.prepare('UPDATE review_tasks SET lease_until=? WHERE id=?').run(Date.now()-1,transferJob.taskId);
const thirdClaim=text(await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'run-c'})).tasks[0];
eq([thirdClaim.id,thirdClaim.fence,thirdClaim.stage,thirdClaim.checkpointSha256],
  [transferJob.taskId,3,'acoustic',firstChunkSha256],'next run reclaims committed acoustic checkpoint');
eq((await transferPut(transferRequest(save,decoded))).status,409,'interrupted lease cannot overwrite checkpoint');
eq((await transferPut(transferRequest(firstChunkGrant,firstChunk))).status,409,'stale acoustic write grant is rejected');
const readAcoustic=await transferGrant(3,'read_acoustic',{chunkIndex:0});
failAcousticRead=true;
const readAcousticError=await transferGet(transferRequest(readAcoustic));
eq([readAcousticError.status,await readAcousticError.json()],
  [503,{error:'transfer_storage_unavailable',retryable:true}],'private checkpoint read is retryable');
failAcousticRead=false;
const acousticBytes=await transferGet(transferRequest(readAcoustic));
eq([acousticBytes.status,acousticBytes.headers.get('X-Bandroom-SHA256'),Buffer.from(await acousticBytes.arrayBuffer())],
  [200,firstChunkSha256,firstChunk],'fresh lease reads exact committed acoustic features');
for(const [header,message] of [
  [{...secondHeader,previousSha256:'e'.repeat(64)},'second chunk must bind its predecessor'],
  [{...secondHeader,configSha256:'e'.repeat(64)},'second chunk must use the same runtime configuration'],
]){
  const data=encodeAcoustic(header,features);
  const rejected=await transferPut(transferRequest(await grantForChunk(3,1,data),data));
  eq([rejected.status,(await rejected.json()).error],[422,'invalid_acoustic_checkpoint'],message);
}
const secondGrant=await grantForChunk(3,1,secondChunk);
const alternative=encodeAcoustic({...secondHeader,featuresSha256:digest(Buffer.alloc(features.length,1))},
  Buffer.alloc(features.length,1));
const alternativeGrant=await grantForChunk(3,1,alternative);
const secondCheckpoint=await transferPut(transferRequest(secondGrant,secondChunk));
eq([secondCheckpoint.status,(await secondCheckpoint.json()).checkpointSha256],[201,digest(secondChunk)],
  'fresh lease advances acoustic checkpoint');
eq((await transferPut(transferRequest(alternativeGrant,alternative))).status,409,
  'competing valid grant cannot replace the committed chunk');
const replayFirst=await transferPut(transferRequest(await grantForChunk(3,0,firstChunk),firstChunk));
eq([replayFirst.status,await replayFirst.json()],
  [200,{saved:true,duplicate:true,checkpointSha256:digest(secondChunk)}],'earlier replay cannot roll back the pointer');
const firstAddition={kind:'addition',wordIndex:0,phoneIndex:1,target:'∅',actual:'AH',startMs:100,endMs:170};
const secondAddition={...firstAddition,gapOccurrence:1,startMs:230,endMs:290};
const analysis={...baseAnalysis,inputSha256:source.sha256,inputBytes:source.bytes,errors:[firstAddition,secondAddition]};
const pronunciation={band:7,reviewedWholeClip:true,observation:'Synthetic heard fixture',recordingId};
const completion={taskId:transferJob.taskId,fence:3,feedback:'Synthetic test feedback',evidence:'Synthetic test',
  analysisVersion:'analysis-v1',recordingSha256:source.sha256,analysis,pronunciation};
eq(text(await callReviewTool(owner,'complete_review_task',{...completion,
  pronunciation:{...pronunciation,recordingId:randomUUID()}})).error,'recording_mismatch',
  'pronunciation must bind the task recording');
eq(text(await callReviewTool(owner,'complete_review_task',completion)).error,'checkpoint_not_read','new lease must read committed bytes');
failOriginalRead=true;
const restoredGrant=await transferGrant(3,'read_decode');
const restoredBytes=await transferGet(transferRequest(restoredGrant));
eq([restoredBytes.status,Buffer.from(await restoredBytes.arrayBuffer())],[200,decoded],'fresh lease restores PCM without rereading source');
const wrongCount={...analysis,decoded:{...analysis.decoded,sampleCount:8000},coverage:{analyzedSamples:[[0,8000]],fraction:1}};
eq(text(await callReviewTool(owner,'complete_review_task',{...completion,analysis:wrongCount})).error,'invalid_analysis','final result must use committed timeline');
for(const [errors,message] of [
  [[firstAddition,{...secondAddition,gapOccurrence:0}],'duplicate occurrence rejected'],
  [[firstAddition,{...secondAddition,startMs:150}],'overlapping addition rejected'],
  [[{...firstAddition,gapOccurrence:2},secondAddition],'out-of-order occurrence rejected'],
  [[{...secondAddition,gapOccurrence:0.5}],'fractional occurrence rejected'],
  [[{kind:'deletion',wordIndex:0,phoneIndex:1,target:'T',actual:'∅',anchorMs:210,gapOccurrence:0}],'occurrence on deletion rejected'],
]){
  const invalid=await callReviewTool(owner,'complete_review_task',{...completion,analysis:{...analysis,errors}});
  eq(text(invalid).error,'invalid_analysis',message);
}
const learnerState={day:12,stage:'write',completed:[11],entries:{12:{speakingPart2:'preserved recording reference'}}};
sql.prepare('INSERT INTO learner_states(user_id,revision,state) VALUES (?,?,?)').run(owner,24,JSON.stringify(learnerState));
const completed=text(await callReviewTool(owner,'complete_review_task',completion));
eq(completed.duplicate,false,'speaking result committed');
const receipt=text(await callReviewTool(owner,'read_review_receipt',{taskId:transferJob.taskId}));
eq([receipt.id,receipt.attemptId,receipt.fence,receipt.recordingSha256],[completed.receiptId,transferJob.jobId,3,source.sha256],
  'receipt is bound to the exact attempt, recording and current fence');
const feedbackRow=sql.prepare('SELECT attempt,analysis_json,pronunciation FROM teacher_feedback WHERE review_task_id=?').get(transferJob.taskId);
const savedPronunciation=JSON.parse(feedbackRow.pronunciation);
eq([feedbackRow.attempt,JSON.parse(feedbackRow.analysis_json).errors],[transferJob.jobId,[firstAddition,secondAddition]],
  'both additions and their timestamps are attached to the original attempt');
eq([savedPronunciation.band,savedPronunciation.recordingId,savedPronunciation.scope],[7,recordingId,'partial'],
  'pronunciation is bound to the listening recording');
const learnerRow=sql.prepare('SELECT revision,state FROM learner_states WHERE user_id=?').get(owner);
eq([learnerRow.revision,JSON.parse(learnerRow.state)],[24,learnerState],'feedback did not change learner state');
objects.delete(sourceKey);
const completionReplay=text(await callReviewTool(owner,'complete_review_task',completion));
eq([completionReplay.duplicate,completionReplay.receiptId],[true,completed.receiptId],'completion replay does not need recording storage');
eq(text(await callReviewTool(owner,'complete_review_task',{...completion,
  pronunciation:{...pronunciation,band:6.5}})).error,'receipt_conflict',
  'v2 receipt binds pronunciation, not only text evidence');
const textPronJob=insertJob();
const pronTasks=text(await callReviewTool(owner,'claim_review_tasks',{limit:3,clientRunId:'run-pron-text'})).tasks;
const textPronTask=pronTasks.find(task=>task.id===textPronJob.taskId);
eq(Boolean(textPronTask),true,'text task claimed for pronunciation refusal');
eq(text(await callReviewTool(owner,'complete_review_task',{taskId:textPronJob.taskId,fence:textPronTask.fence,
  feedback:'Text',evidence:'Text',pronunciation})).error,'pronunciation_not_allowed','text task cannot claim pronunciation');
const transferRuns=sql.prepare(`SELECT client_run_id,event FROM analysis_events WHERE task_id=?
  AND stage IN ('read_input','decode')
  AND outcome IN ('ok','error') AND event IN ('read_review_recording','save_review_checkpoint','read_review_checkpoint')
  ORDER BY id`).all(transferJob.taskId);
eq(transferRuns.map(row=>[row.client_run_id,row.event]).filter(row=>row[0]!==null),[
  ['run-a','read_review_recording'],['run-a','read_review_recording'],['run-b','read_review_recording'],['run-b','read_review_recording'],
  ['run-b','save_review_checkpoint'],['run-b','save_review_checkpoint'],['run-b','save_review_checkpoint'],
  ['run-b','save_review_checkpoint'],['run-b','save_review_checkpoint'],['run-c','read_review_checkpoint'],
],'binary transfers are correlated to each claim');
globalThis.testEnv.BUCKET=globalThis.testBucket;
delete globalThis.testEnv.ANALYSIS_RUNTIME_BUNDLE_SHA256;
}

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
eq(sql.prepare('SELECT user_id FROM automation_heartbeats WHERE automation_id=?').get('Automation_fixture').user_id,owner,'heartbeat is owner scoped');
eq((await callReviewTool(owner,'read_review_receipt',{taskId:retryJob.taskId})).content[0].text,'null','no receipt for retry');
eq((await callReviewTool(owner,'unknown_tool',{})).isError,true,'unknown tool');

// manual takeover route revokes an automatic claim before copying a request
reset();
const takeoverJob=insertJob();
globalThis.testUser={userId:owner};
const takeoverRequest=body=>new Request('https://fixture.example/api/review-tasks/takeover',{method:'POST',
  headers:{origin:'https://fixture.example','content-type':'application/json'},body:JSON.stringify(body)});
globalThis.testUser=null;
eq((await takeoverPost(takeoverRequest({attemptId:takeoverJob.jobId}))).status,401,'takeover requires sign-in');
const foreignTakeover=new Request('https://fixture.example/api/review-tasks/takeover',{method:'POST',
  headers:{origin:'https://evil.test','content-type':'application/json'},body:JSON.stringify({attemptId:takeoverJob.jobId})});
eq((await takeoverPost(foreignTakeover)).status,403,'takeover rejects foreign origin');
globalThis.testUser={userId:owner};
const takeover=await takeoverPost(takeoverRequest({attemptId:takeoverJob.jobId}));
eq(takeover.status,200,'takeover succeeds');
const takeoverBody=await takeover.json();
eq([takeoverBody.claimed,takeoverBody.state],[true,'running'],'takeover claims the task');
eq(sql.prepare('SELECT claim_kind FROM review_tasks WHERE id=?').get(takeoverJob.taskId).claim_kind,'manual','takeover records a manual claim');
eq(await callReviewTool(owner,'claim_review_tasks',{limit:1,clientRunId:'auto-after-takeover'}).then(text).then(v=>v.tasks.length),0,'automatic claim cannot follow takeover');
globalThis.testUser=null;
console.log(JSON.stringify({suite:'review-tools',checks,passed:true}));
