// Run: node --import ./scripts/sites-env.mjs tests/import-backup-direct.test.mjs --miniflare
// Exercises direct backup-v3 import: owner provenance, per-clip SHA-256,
// idempotent SQL, pending review_tasks rebuild, Miniflare D1/R2 apply, replay,
// and the mocked --execute wrangler path.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import http from 'node:http';

const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve('wrangler/package.json'));
const esbuild=wrangler('esbuild');
const root=process.cwd();
const tmp=await mkdtemp(join(tmpdir(),'bandroom-direct-import-'));
const runtimes=[];
let count=0;
const ok=(value)=>{assert.ok(value);count+=1;};
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);count+=1;};
const deepEqual=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);count+=1;};
const throws=(fn,pattern)=>{assert.throws(fn,pattern);count+=1;};

async function bundled(file){
  const out=join(tmp,file.split('/').at(-1).replace('.ts','.mjs'));
  await esbuild.build({entryPoints:[join(root,file)],outfile:out,bundle:true,format:'esm',platform:'node'});
  return import(pathToFileURL(out).href);
}
const sha256=(bytes)=>createHash('sha256').update(bytes instanceof ArrayBuffer?new Uint8Array(bytes):bytes).digest('hex');

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
    // Strip line comments before splitting on ';': migration prose contains
    // semicolons, and a comment-only fragment is not a runnable statement.
    const sqlText=body.split('\n').map(line=>{const at=line.indexOf('--');return at<0?line:line.slice(0,at);}).join('\n');
    for(const query of sqlText.split(';').map(part=>part.trim()).filter(Boolean)){
      await db.prepare(query).run();
    }
  }
  return files;
}

try{
  const {pack}=await bundled('lib/backup-format.ts');
  const direct=await import(pathToFileURL(join(root,'scripts/migrate/import-backup-direct.mjs')).href);
  const exportImport=await import(pathToFileURL(join(root,'scripts/migrate/export-import.mjs')).href);

  // --- Synthetic owner export ------------------------------------------------
  const uid='fixture-owner';
  const owner=sha256(Buffer.from(uid,'utf8'));
  const completedJobId='v2:'+randomUUID();
  const pendingJobId='v2:'+randomUUID();
  const recordingA=randomUUID();
  const recordingB=randomUUID();
  const wave=new Uint8Array(44+16);wave.set([82,73,70,70]);wave.set([87,65,86,69],8);
  const webm=new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3,4]);
  const shaA=sha256(wave),shaB=sha256(webm);
  const state={version:1,day:11,completed:Array.from({length:11},(_,i)=>i+1),stage:'review',finished:false,
    entries:{11:{speakingPart2:JSON.stringify([{at:'2026-11-09T01:00:00.000Z',spoken:true,text:'',audio:recordingA}])}},
    fullTests:[{audio:recordingB,source:'fixture full test'}],reports:{W1:{created:'fixture-report',week:{}}}};
  const completedSnapshot={sourceId:'v1:speakingPart2:0:'+'a'.repeat(64),
    attempt:{id:completedJobId,day:11,stage:'speak',recordingId:recordingA},context:{prompt:'Completed fixture'}};
  const pendingSnapshot={sourceId:'v1:speakingFollowup:0:'+'b'.repeat(64),
    attempt:{id:pendingJobId,day:11,stage:'speak',recordingId:recordingB},context:{prompt:'Pending fixture'}};
  const pronunciation={band:7,recordingId:recordingA,reviewedWholeClip:true,observation:'fixture',scope:'partial'};
  const analysis={errors:[]};
  const manifest={
    format:3,owner,created:'2026-11-14T00:00:00.000Z',state,revision:4,
    feedback:[{id:'feedback-complete',day:11,stage:'speak',attempt:completedJobId,
      evidence:"owner's audible fixture",feedback:'Completed fixture review',
      createdAt:'2026-11-09T01:02:00.000Z',pronunciation,analysis}],
    lessons:[{day:11,lesson:{theme:'fixture',words:[['word','释义','Example']]}}],
    reviewJobs:[
      {id:completedJobId,day:11,submissionKey:'completed-fixture',requestHash:'c'.repeat(64),
        revision:4,createdAt:'2026-11-09T01:00:00.000Z',snapshot:completedSnapshot},
      {id:pendingJobId,day:11,submissionKey:'pending-fixture',requestHash:'d'.repeat(64),
        revision:4,createdAt:'2026-11-09T01:03:00.000Z',snapshot:pendingSnapshot},
    ],
    audio:[
      {id:recordingA,size:wave.length,type:'audio/wav',hash:shaA,ticket:'fixture-ticket-a'},
      {id:recordingB,size:webm.length,type:'audio/webm',hash:shaB,ticket:'fixture-ticket-b'},
    ],
    local:[],
  };
  const archive=async(m,device,blobs)=>new Uint8Array(await pack({signed:{manifest:m,signature:'0'.repeat(64)},device},blobs).arrayBuffer());
  const backup=await archive(manifest,[],[new Blob([wave]),new Blob([webm])]);
  const backupPath=join(tmp,'fixture.bandroom');
  await writeFile(backupPath,Buffer.from(backup));

  // --- Dry-run artifacts -----------------------------------------------------
  const outDir=join(tmp,'out');
  const cli=spawnSync(process.execPath,[join(root,'scripts/migrate/import-backup-direct.mjs'),
    '--backup',backupPath,'--user-id',uid,'--out',outDir,'--now','1234567890'],{cwd:root,encoding:'utf8'});
  equal(cli.status,0,cli.stderr);
  const cliReport=JSON.parse(cli.stdout);
  equal(cliReport.out,outDir);
  equal(cliReport.execute,false);
  for(const name of ['import.sql','r2-upload.sh','report.json'])ok(existsSync(join(outDir,name)));
  ok(existsSync(join(outDir,'audio')));

  const report=JSON.parse(await readFile(join(outDir,'report.json'),'utf8'));
  equal(report.backup.format,3);
  equal(report.backup.owner.expected,owner);
  equal(report.backup.owner.actual,owner);
  equal(report.backup.owner.ok,true);
  equal(report.revision.backup,4);
  equal(report.revision.imported,5);
  equal(report.tables.learner_states,1);
  equal(report.tables.teacher_feedback,1);
  equal(report.tables.teacher_lessons,1);
  equal(report.tables.review_jobs,2);
  equal(report.tables.review_tasks,1);
  equal(report.rebuiltTasks.count,1);
  equal(report.rebuiltTasks.ids.length,1);
  equal(report.rebuiltTasks.ids[0],exportImport.deterministicUuid(`bandroom:migrate:review_task:${pendingJobId}`));
  equal(report.audio.length,2);
  for(const [index,clip] of report.audio.entries()){
    equal(clip.actualHash,index===0?shaA:shaB);
    equal(clip.declaredHash,clip.actualHash);
    ok(clip.key===`speaking/${encodeURIComponent(uid)}/${index===0?recordingA:recordingB}`);
  }
  equal(report.files.sql,'import.sql');
  equal(report.files.r2Script,'r2-upload.sh');

  const sql=await readFile(join(outDir,'import.sql'),'utf8');
  ok(sql.includes('ON CONFLICT DO NOTHING'));
  ok(sql.includes(`INSERT INTO learner_states`));
  ok(sql.includes(`('${uid}',5,`));
  ok(sql.includes('INSERT INTO teacher_feedback'));
  ok(sql.includes(`'Completed fixture review','2026-11-09T01:02:00.000Z',NULL,`));
  ok(sql.includes('INSERT INTO teacher_lessons'));
  ok(sql.includes('INSERT INTO review_jobs'));
  ok(sql.includes('INSERT INTO review_tasks'));
  ok(sql.includes(pendingJobId));
  ok(sql.includes(recordingB));
  ok(!sql.includes(`review_task_id=${JSON.stringify(report.rebuiltTasks.ids[0])}`));
  const audioA=await readFile(join(outDir,'audio',report.audio[0].file));
  equal(audioA.length,wave.length);
  equal(sha256(audioA),shaA);
  const r2Script=await readFile(join(outDir,'r2-upload.sh'),'utf8');
  ok(r2Script.includes(`speaking/${encodeURIComponent(uid)}/${recordingA}`));
  ok(r2Script.includes(`speaking/${encodeURIComponent(uid)}/${recordingB}`));
  ok(r2Script.includes('--content-type "audio/wav"'));
  ok(r2Script.includes('--remote'));
  ok(r2Script.includes('--force'));

  // --- Apply SQL + audio to Miniflare D1/R2 ---------------------------------
  const plan=direct.planDirectImport(Buffer.from(backup),{userId:uid,now:1234567890});
  equal(plan.statements.length,report.statements);
  equal(plan.audio.length,2);
  equal(plan.audio[0].kind,'cloud');
  equal(plan.audio[1].kind,'cloud');

  const target=await createRuntime();
  const migrationFiles=await applyMigrations(target.db);
  equal(migrationFiles.length,17);
  for(const statement of plan.statements)await target.db.prepare(statement).run();
  for(const item of plan.audio){
    await target.bucket.put(item.key,item.bytes,{httpMetadata:{contentType:item.type}});
  }

  const learner=await target.db.prepare('SELECT revision,state FROM learner_states WHERE user_id=?').bind(uid).first();
  equal(learner.revision,5);
  deepEqual(JSON.parse(learner.state),state);
  const feedback=await target.db.prepare('SELECT * FROM teacher_feedback WHERE id=?').bind('feedback-complete').first();
  equal(feedback.user_id,uid);
  equal(feedback.day,11);
  equal(feedback.stage,'speak');
  equal(feedback.attempt,completedJobId);
  equal(feedback.evidence,"owner's audible fixture");
  equal(feedback.review_task_id,null);
  deepEqual(JSON.parse(feedback.pronunciation),pronunciation);
  deepEqual(JSON.parse(feedback.analysis_json),analysis);
  const lesson=await target.db.prepare('SELECT * FROM teacher_lessons WHERE user_id=? AND day=?').bind(uid,11).first();
  deepEqual(JSON.parse(lesson.lesson),manifest.lessons[0].lesson);
  const jobs=await target.db.prepare('SELECT COUNT(*) AS count FROM review_jobs WHERE user_id=?').bind(uid).first();
  equal(Number(jobs.count),2);
  const job=await target.db.prepare('SELECT * FROM review_jobs WHERE id=?').bind(pendingJobId).first();
  deepEqual(JSON.parse(job.snapshot),pendingSnapshot);
  equal(job.request_hash,'d'.repeat(64));

  const rebuilt=await target.db.prepare('SELECT * FROM review_tasks WHERE review_job_id=?').bind(pendingJobId).first();
  equal(rebuilt.id,plan.summary.rebuiltTaskIds[0]);
  equal(rebuilt.attempt_id,pendingJobId);
  equal(rebuilt.recording_id,recordingB);
  equal(rebuilt.kind,'speaking');
  equal(rebuilt.state,'queued');
  equal(rebuilt.stage,'read_input');
  equal(rebuilt.next_at,1234567890);
  equal(rebuilt.analysis_version,null);
  const tasks=await target.db.prepare('SELECT COUNT(*) AS count FROM review_tasks').first();
  equal(Number(tasks.count),1);
  const completedTasks=await target.db.prepare('SELECT COUNT(*) AS count FROM review_tasks WHERE review_job_id=?').bind(completedJobId).first();
  equal(Number(completedTasks.count),0);

  for(const item of plan.audio){
    const stored=await target.bucket.get(item.key);
    equal(stored.size,item.size);
    equal(sha256(await stored.arrayBuffer()),item.declaredHash);
    equal(stored.httpMetadata.contentType,item.type);
  }

  // --- Idempotent replay -----------------------------------------------------
  const counts=async()=>({
    learner_states:Number((await target.db.prepare('SELECT COUNT(*) AS count FROM learner_states').first()).count),
    teacher_feedback:Number((await target.db.prepare('SELECT COUNT(*) AS count FROM teacher_feedback').first()).count),
    teacher_lessons:Number((await target.db.prepare('SELECT COUNT(*) AS count FROM teacher_lessons').first()).count),
    review_jobs:Number((await target.db.prepare('SELECT COUNT(*) AS count FROM review_jobs').first()).count),
    review_tasks:Number((await target.db.prepare('SELECT COUNT(*) AS count FROM review_tasks').first()).count),
  });
  const beforeReplay=await counts();
  deepEqual(beforeReplay,{learner_states:1,teacher_feedback:1,teacher_lessons:1,review_jobs:2,review_tasks:1});
  for(const statement of plan.statements)await target.db.prepare(statement).run();
  deepEqual(await counts(),beforeReplay);

  // --- Rejections ------------------------------------------------------------
  throws(()=>direct.planDirectImport(Buffer.from(backup),{userId:'fixture-other'}),/owner/);
  const badOwnerCli=spawnSync(process.execPath,[join(root,'scripts/migrate/import-backup-direct.mjs'),
    '--backup',backupPath,'--user-id','fixture-other','--out',join(tmp,'bad-owner')],{cwd:root,encoding:'utf8'});
  equal(badOwnerCli.status,1);
  ok(badOwnerCli.stderr.includes('owner'));
  const tampered=Buffer.from(backup);tampered[tampered.length-1]^=1;
  throws(()=>direct.planDirectImport(tampered,{userId:uid}),/SHA-256/);
  const badFormat=await archive({...structuredClone(manifest),format:5},[],[new Blob([wave]),new Blob([webm])]);
  throws(()=>direct.planDirectImport(Buffer.from(badFormat),{userId:uid}),/备份格式无效/);

  // Device blobs follow media blobs in unpack/pack order.
  const deviceId=randomUUID();
  const deviceManifest={...structuredClone(manifest),audio:[manifest.audio[0]],local:[deviceId]};
  const deviceClip={id:deviceId,size:wave.length,type:'audio/wav',hash:shaA};
  const deviceBackup=await archive(deviceManifest,[deviceClip],[new Blob([wave]),new Blob([wave])]);
  const devicePlan=direct.planDirectImport(Buffer.from(deviceBackup),{userId:uid,now:1});
  equal(devicePlan.audio.length,2);
  equal(devicePlan.audio[0].kind,'cloud');
  equal(devicePlan.audio[1].kind,'device');
  equal(devicePlan.audio[1].id,deviceId);
  ok(devicePlan.audio[1].key.endsWith(`/${deviceId}`));

  // --- Format 4 calibration import (FIX-16) ---------------------------------
  const calibrationCandidate=randomUUID();
  const calibrationManifest={...structuredClone(manifest),format:4,
    personalCalibration:[{expected:"TH",actual:"S",nConfirmed:1,nRejected:0,nUnsure:0,nShown:2,
      state:"CANDIDATE",ruleVersion:"r6-suppress-1",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",updatedAt:1700}],
    calibrationCandidates:[{candidateId:calibrationCandidate,attemptId:completedJobId,recordingId:recordingA,
      word:"think",expected:"TH",actual:"S",atMs:20310,detectorConfidence:.82,shownAt:1600,answeredAt:1650}],
    calibrationEvents:[{attemptId:completedJobId,candidateId:calibrationCandidate,expected:"TH",actual:"S",
      verdict:"confirmed",isCatchTrial:false,createdAt:1700}]};
  const calibrationBackup=await archive(calibrationManifest,[],[new Blob([wave]),new Blob([webm])]);
  const calibrationPlan=direct.planDirectImport(Buffer.from(calibrationBackup),{userId:uid,now:1234567890});
  equal(calibrationPlan.report.backup.format,4);
  equal(calibrationPlan.summary.tables.personal_calibration,1);
  equal(calibrationPlan.summary.tables.calibration_candidates,1);
  equal(calibrationPlan.summary.tables.calibration_events,1);
  ok(calibrationPlan.sql.includes("INSERT INTO personal_calibration"));
  ok(calibrationPlan.sql.includes("INSERT INTO calibration_candidates"));
  ok(calibrationPlan.sql.includes("INSERT INTO calibration_events"));
  for(const statement of calibrationPlan.statements)await target.db.prepare(statement).run();
  const importedProfile=await target.db.prepare("SELECT * FROM personal_calibration WHERE user_id=?").bind(uid).first();
  equal(importedProfile.expected,"TH");
  equal(importedProfile.n_shown,2);
  equal(importedProfile.detector_version,"detector-v1");
  const importedCandidate=await target.db.prepare("SELECT * FROM calibration_candidates WHERE candidate_id=?").bind(calibrationCandidate).first();
  equal(importedCandidate.attempt_id,completedJobId);
  equal(importedCandidate.user_id,uid);
  const importedEvent=await target.db.prepare("SELECT * FROM calibration_events WHERE candidate_id=?").bind(calibrationCandidate).first();
  equal(importedEvent.verdict,"confirmed");
  equal(importedEvent.is_catch_trial,0);
  for(const statement of calibrationPlan.statements)await target.db.prepare(statement).run();
  const calibrationCounts=await target.db.prepare(`SELECT
    (SELECT COUNT(*) FROM personal_calibration) AS p,
    (SELECT COUNT(*) FROM calibration_candidates) AS c,
    (SELECT COUNT(*) FROM calibration_events) AS e`).first();
  deepEqual({p:Number(calibrationCounts.p),c:Number(calibrationCounts.c),e:Number(calibrationCounts.e)},
    {p:1,c:1,e:1},"format-4 replay is idempotent");

  // --- --execute with injected spawnSync ------------------------------------
  const artifacts=direct.writeArtifacts(plan,join(tmp,'exec-out'),{bucket:'BUCKET'});
  const calls=[];
  const execution=direct.executeImport(plan,{database:'DB',bucket:'BUCKET',artifacts,
    spawn:(command,args)=>{calls.push(args);return {status:0};}});
  equal(execution.commands.length,3);
  ok(calls[0].includes('d1'));
  ok(calls[0].includes('execute'));
  ok(calls[0].includes('DB'));
  equal(calls[0][calls[0].indexOf('--file')+1],artifacts.sql);
  ok(calls[0].includes('--remote'));
  ok(calls[1].includes('r2')&&calls[1].includes('object')&&calls[1].includes('put'));
  ok(calls[1].includes(`BUCKET/speaking/${encodeURIComponent(uid)}/${recordingA}`));
  equal(calls[1][calls[1].indexOf('--content-type')+1],'audio/wav');
  equal(calls[1][calls[1].indexOf('--file')+1],join(artifacts.audioDir,plan.audio[0].file));
  ok(calls[2].includes(`BUCKET/speaking/${encodeURIComponent(uid)}/${recordingB}`));
  equal(calls[2][calls[2].indexOf('--content-type')+1],'audio/webm');
  throws(()=>direct.executeImport(plan,{database:'DB',bucket:'BUCKET',artifacts,
    spawn:()=>({status:1})}),/exit code 1/);
  throws(()=>direct.executeImport(plan,{database:'DB',artifacts}),/--bucket/);
  throws(()=>direct.executeImport(plan,{bucket:'BUCKET',artifacts}),/--database/);

  console.log(`PASS ${count} direct-import assertions · ${process.argv.includes('--miniflare')?'Miniflare D1 + R2':'SQLite + isolated R2 adapter'}`);
}finally{
  for(const runtime of runtimes)await runtime.dispose();
  await rm(tmp,{recursive:true,force:true});
}