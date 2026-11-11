// Run node tests/backup.mjs. --miniflare exercises the local D1 and R2 bindings in workerd.
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm,readdir} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import http from 'node:http';
const require=createRequire(import.meta.url),wrangler=createRequire(require.resolve('wrangler/package.json'));
const esbuild=wrangler('esbuild'),tmp=await mkdtemp(join(tmpdir(),'bandroom-backup-'));
async function bundled(file,plugins=[]){const out=join(tmp,file.split('/').at(-1).replace('.ts','.mjs'));await esbuild.build({entryPoints:[file],outfile:out,bundle:true,format:'esm',platform:'node',plugins});return import(out);}
const {prepareBackup,downloadBackup,exportBackup,restoreBackup,restoreAudio,sealDevice,verifyDevice}=await bundled('lib/backup.ts');
const {pack,unpack,hash}=await bundled('lib/backup-format.ts');
let mf,sql;
function sqliteD1(){
 sql=new DatabaseSync(':memory:');
 const prepare=(query,args=[])=>({bind:(...values)=>prepare(query,values),run:()=>sql.prepare(query).run(...args),all:()=>sql.prepare(query).all(...args)});
 return {prepare,batch:async statements=>{sql.exec('BEGIN');try{const result=statements.map(s=>({results:s.all()}));sql.exec('COMMIT');return result;}catch(e){sql.exec('ROLLBACK');throw e;}}};
}
function isolatedBucket(){
 const objects=new Map();
 return {async get(key){const f=objects.get(key);return f?{size:f.bytes.byteLength,arrayBuffer:async()=>f.bytes.slice().buffer,httpMetadata:f.httpMetadata,body:{cancel:async()=>{}}}:null;},
 async put(key,bytes,options={}){if(options.onlyIf?.etagDoesNotMatch==='*'&&objects.has(key))return null;
    const b=new Uint8Array(bytes);if(options.sha256&&await hash(b)!==options.sha256)throw Error('bad checksum');
    objects.set(key,{bytes:b.slice(),httpMetadata:options.httpMetadata});return {size:b.byteLength};},async delete(key){objects.delete(key)}};
}
let db,bucket,count=0;
const ok=x=>{assert.ok(x);count++};
const denied=async(fn,status)=>{await assert.rejects(fn,e=>e.status===status);count++;};
try{
 if(process.argv.includes('--miniflare')){
   const {Miniflare}=wrangler('miniflare');
   // Use a localhost-only synthetic worker. Every operation reaches actual Miniflare D1/R2 bindings.
   const script=`export default {async fetch(req,env){try{
     const x=await req.json();let result;
     if(x.op==='batch')result=await env.DB.batch(x.rows.map(s=>env.DB.prepare(s.q).bind(...s.a)));
     if(x.op==='run')result=await env.DB.prepare(x.q).bind(...x.a).run();
     if(x.op==='put')result=!!(await env.BUCKET.put(x.key,new Uint8Array(x.b),x.options));
     if(x.op==='get'){const o=await env.BUCKET.get(x.key);result=o?{b:Array.from(new Uint8Array(await o.arrayBuffer())),size:o.size,httpMetadata:o.httpMetadata}:null}
     if(x.op==='delete'){await env.BUCKET.delete(x.key);result=true}
     return Response.json(result);
   }catch(e){return Response.json({error:String(e)+' '+String(e.cause)},{status:500})}}}`;
   mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script,compatibilityDate:'2025-03-01',d1Databases:['DB'],r2Buckets:['BUCKET']});
   const url=await mf.ready;
   const rpc=body=>new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{'content-type':'application/json'}},r=>{
     let data='';r.on('data',c=>data+=c);r.on('end',()=>{try{const v=JSON.parse(data);if(r.statusCode!==200)reject(Error(v.error));else resolve(v);}catch(e){reject(e)}});
   });req.on('error',reject);req.end(JSON.stringify(body));});
   const stmt=(q,a=[])=>({q,a,bind:(...v)=>stmt(q,v),run:()=>rpc({op:'run',q,a})});
   db={prepare:stmt,batch:rows=>rpc({op:'batch',rows:rows.map(({q,a})=>({q,a}))})};
   bucket={put:(key,b,options={})=>rpc({op:'put',key,b:Array.from(b),options}),delete:key=>rpc({op:'delete',key}),get:async key=>{
     const result=await rpc({op:'get',key});return result?{...result,body:{cancel:async()=>{}},arrayBuffer:async()=>new Uint8Array(result.b).buffer}:null;
   }};
 } else{db=sqliteD1();bucket=isolatedBucket();}
 const run=async(q,...params)=>await db.prepare(q).bind(...params).run();
 for(const migration of (await readdir('drizzle')).filter(f=>f.endsWith('.sql')).sort()){const body=await readFile('drizzle/'+migration,'utf8');for(const q of body.split(';').map(s=>s.replaceAll('--> statement-breakpoint','').trim()).filter(Boolean))await run(q);}
 if(mf){
   const {saveReviewCheckpoint}=await bundled('lib/review-tasks.ts',[{name:'isolated-db',setup(build){
     build.onResolve({filter:/^@\/db$/},()=>({path:'db',namespace:'isolated-db'}));
     build.onLoad({filter:/^db$/,namespace:'isolated-db'},()=>({contents:"export function getDb(){throw new Error('Use the explicit test binding')}"}));
   }}]);
   await run('INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at) VALUES (?,?,?,?,?,?,?,?)','checkpoint-job','checkpoint-owner',12,'fixture','fixture',1,'{}','fixture');
   await run(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,fence,attempts,lease_until,next_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,'read_input','running',1,1,2000,1000,1000,1000)`,'checkpoint-task','checkpoint-job','checkpoint-owner','speaking','checkpoint-attempt',12,1);
   const checkpoint={taskId:'checkpoint-task',fence:1,now:1000,analysisVersion:'fixture',stage:'decode',chunkIndex:0,inputSha256:'input',artifactSha256:'first',bytes:16};
   const save=fields=>saveReviewCheckpoint(db,'checkpoint-owner',{...checkpoint,...fields});
   await run("CREATE TRIGGER fail_pointer BEFORE UPDATE OF checkpoint_sha256 ON review_tasks BEGIN SELECT RAISE(ABORT,'checkpoint interrupted'); END");
   await assert.rejects(save({}),/checkpoint interrupted/);
   const result=await run("SELECT COUNT(*) AS count FROM analysis_artifacts WHERE task_id='checkpoint-task'");
   ok(result.results[0].count===0);
   await run('DROP TRIGGER fail_pointer');
   const concurrent=await Promise.all([save({}),save({})]);
   ok(concurrent.filter(result=>result.duplicate).length===1);
   ok((await save({chunkIndex:1,artifactSha256:'second'})).checkpointSha256==='second');
   ok((await save({})).checkpointSha256==='second');
 }
 const uid='fixture-owner',other='fixture-other',secret=randomBytes(32).toString('hex');
 const clip1=crypto.randomUUID(),clip2=crypto.randomUUID(),dev=crypto.randomUUID();
 const wave=new Uint8Array(44+16);wave.set([82,73,70,70]);wave.set([87,65,86,69],8);const webm=new Uint8Array([0x1a,0x45,0xdf,0xa3,1,2,3]);
 const data={version:1,day:11,completed:Array.from({length:11},(_,i)=>i+1),stage:'review',finished:true,checked:{11:'2026-11-09'},started:{11:'2026-11-02'},exam:'Academic',practice:{},reports:{W1:{created:'fixture-report',week:{}}},fullTests:[{audio:clip2,source:'fixture full test'}],entries:{11:{speakingFollowup:JSON.stringify([{at:'2026-11-09T01:00:00.000Z',spoken:true,text:'',audio:clip1},{at:'2026-11-09T01:02:00.000Z',spoken:true,text:'',local:dev}])}}};
 const addr=id=>'speaking/'+encodeURIComponent(uid)+'/'+id;
 await run('INSERT INTO learner_states VALUES(?,?,?)',uid,4,JSON.stringify(data));
 await run('INSERT INTO learner_states VALUES(?,?,?)',other,5,JSON.stringify({other:true}));
 await run('INSERT INTO teacher_lessons VALUES(?,?,?)',uid,17,JSON.stringify({theme:'fixture',words:[['word','释义','Example']]}));
 await run('INSERT INTO teacher_feedback(id,user_id,day,stage,attempt,evidence,feedback,created_at,pronunciation) VALUES(?,?,?,?,?,?,?,?,?)','fixture-a',uid,11,'speak','first attempt','audible fixture','review','2026-11-09T01:00:00.000Z',JSON.stringify({band:7,recordingId:clip1,reviewedWholeClip:true,observation:'fixture',scope:'partial'}));
 await bucket.put(addr(clip1),wave,{httpMetadata:{contentType:'audio/wav'}});
 await bucket.put(addr(clip2),webm,{httpMetadata:{contentType:'audio/webm'}});
 const legacy=await exportBackup(db,bucket,uid,secret);
 ok(legacy.manifest.format===1);
 const jobKey=crypto.randomUUID(),jobId='v2:'+jobKey;
 const frozen={sourceId:'v1:speakingFollowup:0:'+'a'.repeat(64),attempt:{id:jobId,day:11,recordingId:clip1},context:{prompt:'Fixture question'}};
 await run('INSERT INTO review_jobs VALUES(?,?,?,?,?,?,?,?)',jobId,uid,11,jobKey,'b'.repeat(64),4,JSON.stringify(frozen),'2026-11-09T01:00:00.000Z');
 const signed=await exportBackup(db,bucket,uid,secret),m=signed.manifest;
 ok(m.format===2&&m.reviewJobs[0].id===jobId);
 ok(m.audio.length===2&&m.feedback.length===1&&m.lessons[0].day===17&&m.local[0]===dev&&m.state.reports.W1);
 const device=[{id:dev,size:wave.length,type:'audio/wav',hash:await hash(wave)}];
 const header={signed,device,deviceSeal:await sealDevice(uid,secret,signed,device)};await verifyDevice(uid,secret,header);count++;
 await denied(()=>verifyDevice(uid,secret,{...header,device:[{...device[0],hash:'0'.repeat(64)}]}),422);
 await denied(()=>verifyDevice(other,secret,header),403);
 const archive=pack(header,[...m.audio.map(c=>new Blob([c.id===clip1?wave:webm])),new Blob([wave])]);
 const recovered=await unpack(archive);ok(recovered.blobs.length===3&&recovered.header.signed.manifest.state.fullTests[0].source==='fixture full test');
 await assert.rejects(()=>unpack(archive.slice(0,archive.size-1)));count++;
 const corrupted=new Uint8Array(await archive.arrayBuffer());corrupted[corrupted.length-1]^=1;await assert.rejects(()=>unpack(new Blob([corrupted])));count++;
 await denied(()=>restoreBackup(db,bucket,other,secret,signed,true),403);
 await denied(()=>restoreBackup(db,bucket,uid,randomBytes(32).toString('hex'),signed,true),422);
 await denied(()=>restoreAudio(bucket,other,secret,m.audio[0],m.audio[0].id===clip1?wave:webm),422);
 const edited=structuredClone(signed);edited.manifest.state.day=62;await denied(()=>restoreBackup(db,bucket,uid,secret,edited,true),422);
 const removed=structuredClone(signed);removed.manifest.audio=[];await denied(()=>restoreBackup(db,bucket,uid,secret,removed,true),422);
 await run('DELETE FROM learner_states WHERE user_id=?',uid);await run('DELETE FROM teacher_feedback WHERE user_id=?',uid);await run('DELETE FROM teacher_lessons WHERE user_id=?',uid);
 await run('DELETE FROM review_jobs WHERE user_id=?',uid);
 await bucket.delete(addr(clip1));await bucket.delete(addr(clip2));
 const plan=await restoreBackup(db,bucket,uid,secret,signed,false);ok((await restoreBackup(db,bucket,uid,secret,legacy,false)).reviewJobs===0);ok(plan.reviewJobs===1&&plan.missing.length===2&&plan.stateToAdd&&plan.feedback===1&&plan.lessons===1);
 await denied(()=>restoreBackup(db,bucket,uid,secret,signed,true),409);
 for(const [i,c] of m.audio.entries())await restoreAudio(bucket,uid,secret,c,new Uint8Array(await recovered.blobs[i].arrayBuffer()));
 await restoreBackup(db,bucket,uid,secret,signed,true);
 const restored=(await exportBackup(db,bucket,uid,secret)).manifest;
 ok(JSON.stringify(restored.reviewJobs)===JSON.stringify(m.reviewJobs));
 ok(restored.feedback[0].pronunciation.band===7);ok(restored.revision===5);ok(JSON.stringify(restored.state)===JSON.stringify(m.state));ok(JSON.stringify(restored.feedback)===JSON.stringify(m.feedback));ok(JSON.stringify(restored.lessons)===JSON.stringify(m.lessons));ok(JSON.stringify(restored.audio)===JSON.stringify(m.audio));
 const duplicate=await restoreBackup(db,bucket,uid,secret,signed,true);ok(!duplicate.stateToAdd&&duplicate.reviewJobs===0&&duplicate.lessons===0&&duplicate.feedback===0&&duplicate.missing.length===0);
 await run('DELETE FROM teacher_feedback WHERE user_id=?',uid);await restoreBackup(db,bucket,uid,secret,signed,true);
 ok((await exportBackup(db,bucket,uid,secret)).manifest.feedback[0].feedback==='review');
 await bucket.put(addr(clip1),webm,{httpMetadata:{contentType:'audio/webm'}});
 await denied(()=>restoreAudio(bucket,uid,secret,m.audio.find(c=>c.id===clip1),wave),409);
 await denied(()=>restoreBackup(db,bucket,uid,secret,signed,true),409);
 await bucket.delete(addr(clip1));await denied(()=>exportBackup(db,bucket,uid,secret),409);
 await restoreAudio(bucket,uid,secret,m.audio.find(c=>c.id===clip1),wave);
 // Simulate another device changing state between preflight and the single transactional batch.
 let intercepted=false;
 const racing={prepare:db.prepare.bind(db),batch:async statements=>{if(!intercepted&&statements.length===1){intercepted=true;await run('UPDATE learner_states SET revision=revision+1 WHERE user_id=?',uid);}return db.batch(statements);}};
 await denied(()=>restoreBackup(racing,bucket,uid,secret,signed,true),409);
 await run('UPDATE learner_states SET state=? WHERE user_id=?',JSON.stringify({...data,day:12}),uid);
 await denied(()=>restoreBackup(db,bucket,uid,secret,signed,true),409);
 ok((await exportBackup(db,bucket,other,secret)).manifest.state.other===true);
 // Real HTTP route + account-gating middleware. Only hosted identity/env binding injection is replaced in this isolated test.
 const routePath=join(tmp,'download-route.mjs');
 await esbuild.build({entryPoints:['app/api/backup/download/route.ts'],outfile:routePath,bundle:true,format:'esm',platform:'node',
   plugins:[{name:'test-identity',setup(build){
     build.onResolve({filter:/^cloudflare:workers$|^@\/app\/chatgpt-auth$/},args=>({path:args.path,namespace:'fixture'}));
     build.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path==='cloudflare:workers'
       ?'export const env=globalThis.__backupEnv;':'export async function getChatGPTUser(){return globalThis.__backupUser ? {userId:globalThis.__backupUser}:null}'}));
   }}]});
 globalThis.__backupEnv={DB:db,BUCKET:bucket,BANDROOM_BACKUP_KEY:secret};const {GET}=await import(routePath);
 ok(!('downloadReceipt' in await prepareBackup(db,bucket,uid,secret))); // device-only copy must be assembled on its originating device
 const cloudOnly=structuredClone(data);cloudOnly.entries[11].speakingFollowup=JSON.stringify(JSON.parse(data.entries[11].speakingFollowup).slice(0,1));
 await run('UPDATE learner_states SET state=? WHERE user_id=?',JSON.stringify(cloudOnly),uid);
 const prepared=await prepareBackup(db,bucket,uid,secret),receipt=prepared.downloadReceipt;
 const attachment=(token=receipt,origin)=>GET(new Request('https://fixture.test/api/backup/download?receipt='+encodeURIComponent(token),{headers:origin?{Origin:origin}:{}}));
 globalThis.__backupUser=null;ok((await attachment()).status===401);
 globalThis.__backupUser=other;ok((await attachment()).status===403);
 globalThis.__backupUser=uid;ok((await attachment(receipt,'https://wrong.test')).status===403);
 ok((await attachment(receipt.slice(0,-1)+(receipt.endsWith('a')?'b':'a'))).status===403);
 await denied(()=>downloadBackup(db,bucket,uid,secret,receipt,Date.parse(prepared.manifest.created)+900001),410);
 const response=await attachment();ok(response.status===200&&response.headers.get('cache-control')==='private, no-store'&&response.headers.get('content-disposition').startsWith('attachment; filename="Bandroom-'));
 const actual=await response.blob();ok(actual.size===Number(response.headers.get('content-length')));const delivered=await unpack(actual);
 ok(delivered.header.signed.signature===prepared.signature&&delivered.blobs.length===2&&delivered.header.signed.manifest.feedback[0].pronunciation.band===7);
 await run('UPDATE learner_states SET revision=revision+1 WHERE user_id=?',uid);ok((await attachment()).status===409);
 globalThis.__backupUser='empty-learner';const emptyTicket=(await prepareBackup(db,bucket,'empty-learner',secret)).downloadReceipt;
 ok((await unpack(await (await attachment(emptyTicket)).blob())).blobs.length===0);
 console.log('PASS '+count+' backup assertions · '+(mf?'Miniflare D1 + R2':'SQLite + isolated R2 adapter'));
}finally{if(mf)await mf.dispose();sql?.close();await rm(tmp,{recursive:true,force:true});}
