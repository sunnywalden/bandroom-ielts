// Run: node --import ./scripts/sites-env.mjs tests/migration.test.mjs --miniflare
// Exercises the hosting override, own-deploy dry run, the one-time migration
// endpoint, six-table export/import, task rebuild, review_task_id backfill and
// the post-migration verification checklist.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdir,mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import http from 'node:http';

const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve('wrangler/package.json'));
const esbuild=wrangler('esbuild');
const root=process.cwd();
const tmp=await mkdtemp(join(tmpdir(),'bandroom-migration-'));
const runtimes=[];
let count=0;
const ok=(value)=>{assert.ok(value);count+=1;};
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);count+=1;};

async function bundled(file,plugins=[]){
  const out=join(tmp,file.split('/').at(-1).replace('.ts','.mjs'));
  await esbuild.build({entryPoints:[join(root,file)],outfile:out,bundle:true,format:'esm',platform:'node',plugins});
  return import(pathToFileURL(out).href);
}
const sha256=(bytes)=>createHash('sha256').update(bytes).digest('hex');

async function createRuntime(){
  if(process.argv.includes('--miniflare')){
    const {Miniflare}=wrangler('miniflare');
    const script=`export default {async fetch(req,env){try{
      const x=await req.json();let result;
      if(x.op==='all')result=await env.DB.prepare(x.q).bind(...x.a).all();
      if(x.op==='run')result=await env.DB.prepare(x.q).bind(...x.a).run();
      if(x.op==='batch')result=await env.DB.batch(x.rows.map(s=>env.DB.prepare(s.q).bind(...s.a)));
      if(x.op==='put')result=!!(await env.BUCKET.put(x.key,new Uint8Array(x.b),x.options));
      if(x.op==='get'){const o=await env.BUCKET.get(x.key);result=o?{b:Array.from(new Uint8Array(await o.arrayBuffer())),size:o.size,etag:o.etag,httpMetadata:o.httpMetadata,customMetadata:o.customMetadata}:null}
      if(x.op==='delete'){await env.BUCKET.delete(x.key);result=true}
      if(x.op==='list'){const o=await env.BUCKET.list({limit:x.limit??1000,...(x.cursor?{cursor:x.cursor}:{})});result={objects:o.objects.map(v=>({key:v.key,size:v.size,etag:v.etag})),truncated:o.truncated,cursor:o.cursor}}
      return Response.json(result);
    }catch(e){return Response.json({error:String(e)+' '+String(e.cause)},{status:500})}}}`;
    const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script,compatibilityDate:'2025-03-01',d1Databases:['DB'],r2Buckets:['BUCKET']});
    const url=await mf.ready;
    const rpc=body=>new Promise((resolve,reject)=>{
      const req=http.request(url,{method:'POST',headers:{'content-type':'application/json'}},r=>{
        let data='';r.on('data',c=>data+=c);r.on('end',()=>{try{const v=JSON.parse(data);if(r.statusCode!==200)reject(Error(v.error));else resolve(v);}catch(e){reject(e);}});
      });
      req.on('error',reject);req.end(JSON.stringify(body));
    });
    const stmt=(q,a=[])=>({q,a,bind:(...v)=>stmt(q,v),run:()=>rpc({op:'run',q,a}),all:()=>rpc({op:'all',q,a}),
      first:async()=>{const result=await rpc({op:'all',q,a});return result.results?.[0]??null;}});
    const adapter={
      db:{prepare:stmt,batch:rows=>rpc({op:'batch',rows:rows.map(({q,a})=>({q,a}))})},
      bucket:{
        put:(key,b,options={})=>rpc({op:'put',key,b:Array.from(b),options}),
        delete:key=>rpc({op:'delete',key}),
        list:async({cursor,limit=1000}={})=>rpc({op:'list',cursor,limit}),
        get:async key=>{const result=await rpc({op:'get',key});return result?{...result,body:{cancel:async()=>{}},arrayBuffer:async()=>new Uint8Array(result.b).buffer}:null;},
      },
      dispose:()=>mf.dispose(),
    };
    runtimes.push(adapter);
    return adapter;
  }

  const sql=new DatabaseSync(':memory:');
  const prepare=(query,args=[])=>({
    q:query,a:args,bind:(...values)=>prepare(query,values),
    run:()=>sql.prepare(query).run(...args),
    all:()=>({results:sql.prepare(query).all(...args)}),
    first:()=>sql.prepare(query).get(...args)??null,
  });
  const objects=new Map();
  const adapter={
    db:{
      prepare,
      batch:async statements=>{
        sql.exec('BEGIN');
        try{const result=statements.map(s=>s.all());sql.exec('COMMIT');return result;}
        catch(e){sql.exec('ROLLBACK');throw e;}
      },
    },
    bucket:{
      async get(key){
        const file=objects.get(key);
        return file?{size:file.bytes.byteLength,arrayBuffer:async()=>file.bytes.slice().buffer,
          httpMetadata:file.httpMetadata,customMetadata:file.customMetadata,etag:file.etag,body:{cancel:async()=>{}}}:null;
      },
      async put(key,bytes,options={}){
        if(options.onlyIf?.etagDoesNotMatch==='*'&&objects.has(key))return null;
        const copy=new Uint8Array(bytes);
        if(options.sha256&&sha256(copy)!==options.sha256)throw Error('bad checksum');
        objects.set(key,{bytes:copy.slice(),httpMetadata:options.httpMetadata,customMetadata:options.customMetadata,etag:createHash('md5').update(copy).digest('hex')});
        return {size:copy.byteLength};
      },
      async delete(key){objects.delete(key);},
      async list({cursor,limit=1000}={}){
        const keys=[...objects.keys()].sort();
        const start=cursor?Number(cursor):0;
        const slice=keys.slice(start,start+limit);
        return {objects:slice.map(key=>({key,size:objects.get(key).bytes.byteLength,etag:objects.get(key).etag})),
          truncated:start+limit<keys.length,cursor:String(start+limit)};
      },
    },
    dispose:async()=>sql.close(),
  };
  runtimes.push(adapter);
  return adapter;
}

async function applyMigrations(db){
  const files=(await readdir(join(root,'drizzle'))).filter(file=>file.endsWith('.sql')).sort();
  for(const file of files){
    const body=await readFile(join(root,'drizzle',file),'utf8');
    for(const query of body.split(';').map(part=>part.replaceAll('--> statement-breakpoint','').trim()).filter(Boolean)){
      await db.prepare(query).run();
    }
  }
  return files;
}

function jsonResponse(response,status){equal(response.status,status);return response.json();}

try{
  const [backupModule,formatModule]=await Promise.all([
    bundled('lib/backup.ts'),
    bundled('lib/backup-format.ts'),
  ]);
  const {exportBackup,restoreBackup,restoreAudio}=backupModule;
  const {hash}=formatModule;

  // Offline export (rev2 S4): the Worker no longer exposes /api/migrate; the
  // snapshot comes from the shared server module, invoked offline.
  const {exportMigrationSnapshot}=await bundled('lib/migrate-export.ts');

  const plugin=await bundled('scripts/vite/sites-vite-plugin.ts');
  const exportImport=await import(pathToFileURL(join(root,'scripts/migrate/export-import.mjs')).href);
  const verify=await import(pathToFileURL(join(root,'scripts/migrate/verify-migration.mjs')).href);

  // --- Hosting override -----------------------------------------------------
  equal(plugin.readHostingConfig(root).d1,'DB');
  equal(plugin.readHostingConfig(root).r2,'BUCKET');
  const overrideFile=join(tmp,'hosting-own.json');
  await writeFile(overrideFile,JSON.stringify({d1:'OWN_DB',r2:'OWN_BUCKET',project_id:'self-hosted'}));
  process.env.BANDROOM_HOSTING_CONFIG=overrideFile;
  try{
    equal(plugin.hostingConfigPath(root),overrideFile);
    equal(plugin.readHostingConfig(root).d1,'OWN_DB');
    equal(plugin.readHostingConfig(root).r2,'OWN_BUCKET');
  }finally{delete process.env.BANDROOM_HOSTING_CONFIG;}
  const viteText=await readFile(join(root,'vite.config.ts'),'utf8');
  ok(viteText.includes('readHostingConfig'));
  ok(!viteText.includes('import hostingConfig from'));

  // --- own-deploy dry run ---------------------------------------------------
  const deployFixture=join(tmp,'deploy');
  await mkdir(join(deployFixture,'server'),{recursive:true});
  await mkdir(join(deployFixture,'client'),{recursive:true});
  const baseWrangler={
    name:'site-creator-vinext-starter',main:'index.js',assets:{directory:'../client'},
    compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],
    r2_buckets:[{binding:'BUCKET',bucket_name:'site-creator-r2'}],
    d1_databases:[{binding:'DB',database_name:'site-creator-d1',database_id:'00000000-0000-4000-8000-000000000000'}],
  };
  await writeFile(join(deployFixture,'server','wrangler.json'),JSON.stringify(baseWrangler));
  await writeFile(join(deployFixture,'server','index.js'),'export default {};\n');
  const ownDeploy=join(root,'scripts/own-deploy.mjs');
  const d1Id=crypto.randomUUID();
  const dryRun=spawnSync(process.execPath,[ownDeploy,'--dry-run','--dist',join(deployFixture,'server'),
    '--name','bandroom-qa-test','--domain','bandroom.test','--d1-name','d1-test','--d1-id',d1Id,'--r2','r2-test'],
    {cwd:root,encoding:'utf8'});
  equal(dryRun.status,0,dryRun.stderr);
  const plan=JSON.parse(dryRun.stdout);
  ok(plan.dryRun);
  equal(plan.config.workers_dev,false);
  equal(plan.config.preview_urls,false);
  equal(plan.config.main,'index.js');
  equal(plan.config.assets.directory,'../client');
  equal(plan.config.name,'bandroom-qa-test');
  equal(plan.config.d1_databases[0].database_name,'d1-test');
  equal(plan.config.d1_databases[0].database_id,d1Id);
  equal(plan.config.d1_databases[0].migrations_dir,join(root,'drizzle'));
  equal(plan.config.r2_buckets[0].bucket_name,'r2-test');
  equal(plan.config.routes[0].pattern,'bandroom.test');
  equal(plan.migrations.length,11);
  equal(plan.migrations[0],'0000_left_logan.sql');
  equal(plan.migrations.at(-1),'0010_claim_any_index.sql');
  ok(plan.configPath.startsWith(join(deployFixture,'server')));
  ok(existsSync(plan.configPath));
  equal(JSON.parse(await readFile(plan.configPath,'utf8')).workers_dev,false);
  const cleanEnv={...process.env};
  for(const name of ['BANDROOM_D1_DATABASE_ID','BANDROOM_DOMAIN','BANDROOM_WORKER_NAME','BANDROOM_D1_DATABASE_NAME','BANDROOM_R2_BUCKET_NAME']) delete cleanEnv[name];
  const missingId=spawnSync(process.execPath,[ownDeploy,'--skip-migrations','--skip-schema-check','--skip-deploy',
    '--dist',join(deployFixture,'server'),'--name','bandroom-qa-test','--domain','bandroom.test'],
    {cwd:root,encoding:'utf8',env:cleanEnv});
  ok(missingId.status!==0);
  ok(missingId.stderr.includes('BANDROOM_D1_DATABASE_ID'));

  // --- Fixtures -------------------------------------------------------------
  const source=await createRuntime();
  const target=await createRuntime();
  await applyMigrations(source.db);
  const migrationFiles=await applyMigrations(target.db);
  equal(migrationFiles.length,11);

  const uid='fixture-owner';
  const completedJobId='v2:'+crypto.randomUUID();
  const pendingJobId='v2:'+crypto.randomUUID();
  const recordingA=crypto.randomUUID();
  const recordingB=crypto.randomUUID();
  const taskA='task-complete';
  const receiptA='receipt-complete';
  const feedbackA='feedback-complete';
  const secret=randomBytes(32).toString('hex');
  const wave=new Uint8Array(44+16);wave.set([82,73,70,70]);wave.set([87,65,86,69],8);
  const webm=new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4]);
  const shaA=await hash(wave),shaB=await hash(webm);
  const keyA=`speaking/${encodeURIComponent(uid)}/${recordingA}`;
  const keyB=`speaking/${encodeURIComponent(uid)}/${recordingB}`;

  const state={version:1,day:11,completed:Array.from({length:11},(_,i)=>i+1),stage:'review',finished:false,
    entries:{11:{speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00.000Z',spoken:true,text:'',audio:recordingA}])}},
    fullTests:[],reports:{W1:{created:'fixture-report',week:{}}}};
  const snapshotA={sourceId:'v1:speakingPart2:0:'+'a'.repeat(64),attempt:{id:completedJobId,day:11,stage:'speak',recordingId:recordingA},context:{prompt:'Completed fixture'}};
  const snapshotB={sourceId:'v1:speakingFollowup:0:'+'b'.repeat(64),attempt:{id:pendingJobId,day:11,stage:'speak',recordingId:recordingB},context:{prompt:'Pending fixture'}};

  await source.db.prepare('INSERT INTO learner_states VALUES(?,?,?)').bind(uid,4,JSON.stringify(state)).run();
  await source.db.prepare('INSERT INTO teacher_lessons VALUES(?,?,?)').bind(uid,11,JSON.stringify({theme:'fixture'})).run();
  await source.db.prepare(`INSERT INTO teacher_feedback
    (id,user_id,day,stage,attempt,evidence,feedback,created_at,pronunciation,analysis_json,review_task_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).bind(feedbackA,uid,11,'speak',completedJobId,
      "owner's audible fixture",'Completed fixture review','2026-11-09T01:02:00.000Z',null,JSON.stringify({errors:[]})).run();
  const insertJob=source.db.prepare(`INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at)
    VALUES(?,?,?,?,?,?,?,?)`);
  await insertJob.bind(completedJobId,uid,11,crypto.randomUUID(),'c'.repeat(64),4,JSON.stringify(snapshotA),'2026-11-09T01:00:00.000Z').run();
  await insertJob.bind(pendingJobId,uid,11,crypto.randomUUID(),'d'.repeat(64),4,JSON.stringify(snapshotB),'2026-11-09T01:03:00.000Z').run();
  await source.db.prepare(`INSERT INTO review_tasks
    (id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,recording_id,stage,state,fence,attempts,
     claim_kind,notification_epoch,retry_epoch,next_at,analysis_version,receipt_id,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(taskA,completedJobId,uid,'speaking',completedJobId,11,4,recordingA,
      'acoustic','completed',2,1,'auto',0,0,1000,'fixture-v1',receiptA,1000,2000).run();
  await source.db.prepare(`INSERT INTO review_receipts
    (id,task_id,user_id,attempt_id,attempt_revision,recording_sha256,analysis_version,fence,feedback_id,
     output_sha256,output_sha256_v2,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(receiptA,taskA,uid,completedJobId,4,shaA,'fixture-v1',2,feedbackA,
      'e'.repeat(64),'f'.repeat(64),JSON.stringify({source:'auto'}),2000).run();
  await source.db.prepare(`INSERT INTO analysis_artifacts
    (task_id,stage,chunk_index,analyzer_version,input_sha256,artifact_sha256,bytes,object_ref,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(taskA,'decode',0,'fixture-v1','1'.repeat(64),'2'.repeat(64),128,null,
      JSON.stringify({format:'bandroom-decode-v1'}),1500).run();
  const insertEvent=source.db.prepare(`INSERT INTO analysis_events
    (id,at,task_id,fence,event,stage,outcome,client_run_id,request_id,metadata_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  await insertEvent.bind(1,1500,taskA,2,'claim_review_tasks',null,'ok','run-1',null,JSON.stringify({})).run();
  await insertEvent.bind(2,2000,taskA,2,'complete_review_task',null,'ok','run-1',null,JSON.stringify({})).run();
  await source.db.prepare(`INSERT INTO scheduler_heartbeats
    (automation_id,owner_user_id,generation,client_run_id,started_at,finished_at,last_success_at,next_expected_at,status,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind('fixture-auto',uid,2,'run-1',1000,2000,2000,1300000,'finished',"owner's run").run();
  await source.db.prepare(`INSERT INTO automation_heartbeats
    (user_id,automation_id,generation,client_run_id,started_at,finished_at,last_success_at,next_expected_at,status,detail)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(uid,'fixture-auto',2,'run-1',1000,2000,2000,1300000,'finished',"owner's run").run();
  await source.bucket.put(keyA,wave,{httpMetadata:{contentType:'audio/wav'},customMetadata:{purpose:'speaking',day:'11',phase:'part2',digest:shaA}});
  await source.bucket.put(keyB,webm,{httpMetadata:{contentType:'audio/webm'},customMetadata:{purpose:'speaking',day:'11',phase:'followup',digest:shaB}});

  const fetchSnapshot=async(runtime)=>exportMigrationSnapshot(runtime.db,runtime.bucket);

  // --- Ten-table export completeness ---------------------------------------
  const sourceSnapshot=await fetchSnapshot(source);
  equal(sourceSnapshot.format,'bandroom.migration-export.v1');
  const expectedCounts={learner_states:1,teacher_feedback:1,teacher_lessons:1,review_jobs:2,review_tasks:1,
    review_receipts:1,analysis_artifacts:1,analysis_events:2,scheduler_heartbeats:1,automation_heartbeats:1};
  for(const [name,expected] of Object.entries(expectedCounts)){
    ok(Array.isArray(sourceSnapshot.tables[name].rows));
    equal(sourceSnapshot.tables[name].count,expected,name);
  }
  equal(sourceSnapshot.r2.count,2);
  equal(sourceSnapshot.r2.objects.length,2);
  ok(sourceSnapshot.notices.some((notice)=>notice.includes('offline')));

  // --- Backup v3 + empty-target restore ------------------------------------
  const signed=await exportBackup(source.db,source.bucket,uid,secret);
  equal(signed.manifest.format,3);
  equal(signed.manifest.audio.length,2);
  equal(signed.manifest.reviewJobs.length,2);
  for(const clip of signed.manifest.audio){
    await restoreAudio(target.bucket,uid,secret,clip,clip.id===recordingA?wave:webm);
  }
  await restoreBackup(target.db,target.bucket,uid,secret,signed,true);
  const restoredRevision=await target.db.prepare('SELECT revision FROM learner_states WHERE user_id=?').bind(uid).first();
  equal(restoredRevision.revision,5);

  // --- Six-table import, task rebuild, backfill ----------------------------
  const {sql,statements,summary}=exportImport.buildImportSql(sourceSnapshot,{now:1234567890});
  equal(summary.tables.review_tasks,1);
  equal(summary.tables.review_receipts,1);
  equal(summary.tables.analysis_artifacts,1);
  equal(summary.tables.analysis_events,2);
  equal(summary.tables.scheduler_heartbeats,1);
  equal(summary.tables.automation_heartbeats,1);
  equal(summary.rebuiltTasks,1);
  equal(summary.backfilledFeedback,1);
  ok(sql.includes('ON CONFLICT DO NOTHING'));
  ok(sql.includes('UPDATE teacher_feedback SET review_task_id='));
  for(const statement of statements) await target.db.prepare(statement).run();

  const targetCounts={};
  for(const name of Object.keys(expectedCounts)){
    const row=await target.db.prepare(`SELECT COUNT(*) AS count FROM ${name}`).first();
    targetCounts[name]=Number(row.count);
  }
  equal(targetCounts.review_tasks,2);
  equal(targetCounts.review_receipts,1);
  equal(targetCounts.analysis_artifacts,1);
  equal(targetCounts.analysis_events,2);
  equal(targetCounts.scheduler_heartbeats,1);
  equal(targetCounts.automation_heartbeats,1);
  const backfill=await target.db.prepare('SELECT review_task_id FROM teacher_feedback WHERE id=?').bind(feedbackA).first();
  equal(backfill.review_task_id,taskA);
  const rebuilt=await target.db.prepare('SELECT * FROM review_tasks WHERE review_job_id=?').bind(pendingJobId).first();
  equal(rebuilt.attempt_id,pendingJobId);
  equal(rebuilt.recording_id,recordingB);
  equal(rebuilt.kind,'speaking');
  equal(rebuilt.state,'queued');
  equal(rebuilt.next_at,1234567890);
  equal(rebuilt.analysis_version,null);
  const heartbeat=await target.db.prepare('SELECT detail FROM automation_heartbeats WHERE user_id=? AND automation_id=?').bind(uid,'fixture-auto').first();
  equal(heartbeat.detail,"owner's run");
  // Idempotent replay.
  for(const statement of statements) await target.db.prepare(statement).run();
  const afterReplay=await target.db.prepare('SELECT COUNT(*) AS count FROM review_tasks').first();
  equal(Number(afterReplay.count),2);

  // --- Verification checklist ----------------------------------------------
  const targetSnapshot=await fetchSnapshot(target);
  equal(targetSnapshot.r2.count,2);
  const frozenManifest={bundleSha256:'3'.repeat(64),runtimeSha256:'4'.repeat(64)};
  const shaByKey={[keyA]:shaA,[keyB]:shaB};
  const result=verify.verifyMigration({backup:signed,source:sourceSnapshot,target:targetSnapshot,
    shaByKey,frozenManifest,bundleSha:frozenManifest.bundleSha256,runtimeSha:frozenManifest.runtimeSha256});
  if(!result.ok)process.stderr.write(JSON.stringify(result.checks.filter(entry=>!entry.ok),null,2)+'\n');
  ok(result.ok);
  ok(result.checks.some(entry=>entry.name==='learner table learner_states'&&entry.ok));
  ok(result.checks.some(entry=>entry.name==='restore revision'&&entry.ok));
  ok(result.checks.some(entry=>entry.name===`recording ${recordingA}`&&entry.ok));
  ok(result.checks.some(entry=>entry.name===`receipt ${receiptA} outputSha256`&&entry.ok));
  ok(result.checks.some(entry=>entry.name==='pending jobs have review_tasks'&&entry.ok));
  ok(result.checks.some(entry=>entry.name==='analysis bundle SHA'&&entry.ok));
  ok(result.checks.some(entry=>entry.name==='runtime bundle SHA'&&entry.ok));
  ok(result.checks.every(entry=>entry.name.startsWith('learner table')||entry.ok));

  const tamperedRevision=structuredClone(targetSnapshot);
  tamperedRevision.tables.learner_states.rows[0].revision=4;
  const badRevision=verify.verifyMigration({backup:signed,source:sourceSnapshot,target:tamperedRevision,
    shaByKey,frozenManifest,bundleSha:frozenManifest.bundleSha256,runtimeSha:frozenManifest.runtimeSha256});
  ok(!badRevision.ok);
  ok(badRevision.checks.some(entry=>entry.name==='restore revision'&&!entry.ok));

  const tamperedReceipt=structuredClone(targetSnapshot);
  tamperedReceipt.tables.review_receipts.rows[0].output_sha256='0'.repeat(64);
  const badReceipt=verify.verifyMigration({backup:signed,source:sourceSnapshot,target:tamperedReceipt,
    shaByKey,frozenManifest,bundleSha:frozenManifest.bundleSha256,runtimeSha:frozenManifest.runtimeSha256});
  ok(!badReceipt.ok);
  ok(badReceipt.checks.some(entry=>entry.name.startsWith('receipt ')&&!entry.ok));

  const missingSha=verify.verifyMigration({backup:signed,source:sourceSnapshot,target:targetSnapshot,
    shaByKey:{},frozenManifest,bundleSha:frozenManifest.bundleSha256,runtimeSha:frozenManifest.runtimeSha256});
  ok(!missingSha.ok);
  ok(missingSha.checks.some(entry=>entry.name===`recording ${recordingA}`&&!entry.ok));

  // --- verify CLI -----------------------------------------------------------
  const sourceFile=join(tmp,'source.json'),targetFile=join(tmp,'target.json'),backupFile=join(tmp,'backup.json');
  const shaFile=join(tmp,'sha.json'),frozenFile=join(tmp,'frozen.json');
  await writeFile(sourceFile,JSON.stringify(sourceSnapshot));
  await writeFile(targetFile,JSON.stringify(targetSnapshot));
  await writeFile(backupFile,JSON.stringify(signed));
  await writeFile(shaFile,JSON.stringify(shaByKey));
  await writeFile(frozenFile,JSON.stringify(frozenManifest));
  const verifyScript=join(root,'scripts/migrate/verify-migration.mjs');
  const cliArgs=['--backup',backupFile,'--source',sourceFile,'--target',targetFile,'--sha-map',shaFile,
    '--frozen-manifest',frozenFile,'--bundle-sha',frozenManifest.bundleSha256,'--runtime-sha',frozenManifest.runtimeSha256];
  const cliPass=spawnSync(process.execPath,[verifyScript,...cliArgs],{cwd:root,encoding:'utf8'});
  equal(cliPass.status,0,cliPass.stderr);
  ok(cliPass.stdout.includes('checks passed'));
  ok(cliPass.stdout.includes('PASS restore revision'));
  const tamperedFile=join(tmp,'target-bad.json');
  await writeFile(tamperedFile,JSON.stringify(tamperedRevision));
  const cliFail=spawnSync(process.execPath,[verifyScript,'--backup',backupFile,'--source',sourceFile,
    '--target',tamperedFile,'--sha-map',shaFile,'--frozen-manifest',frozenFile,
    '--bundle-sha',frozenManifest.bundleSha256,'--runtime-sha',frozenManifest.runtimeSha256],{cwd:root,encoding:'utf8'});
  equal(cliFail.status,1);
  ok(cliFail.stdout.includes('FAIL restore revision'));

  console.log(`PASS ${count} migration assertions · ${process.argv.includes('--miniflare')?'Miniflare D1 + R2':'SQLite + isolated R2 adapter'}`);
}finally{
  for(const runtime of runtimes)await runtime.dispose();
  await rm(tmp,{recursive:true,force:true});
}