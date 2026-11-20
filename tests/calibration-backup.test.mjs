// Backup format 4 (design rev2 §8/FIX-16).
// Run: node --import ./scripts/sites-env.mjs tests/calibration-backup.test.mjs --miniflare
//
// Proves:
//  - a profile/candidates/events survive an export -> unpack -> restore round-trip;
//  - an older format-3 backup still imports into an empty target;
//  - a format-3 backup cannot silently erase an existing calibration profile;
//  - format 5 is rejected.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile,mkdtemp,rm,readdir} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {createHmac,randomBytes} from "node:crypto";
import http from "node:http";

const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve("wrangler/package.json"));
const esbuild=wrangler("esbuild");
const root=process.cwd();
const tmp=await mkdtemp(join(tmpdir(),"bandroom-calibration-backup-"));
const runtimes=[];
let count=0;
const ok=(value,label)=>{assert.ok(value,label);count+=1;};
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);count+=1;};
const deepEqual=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);count+=1;};
const denied=async(fn,status)=>{await assert.rejects(fn,error=>error.status===status);count+=1;};

async function bundled(file){
  const out=join(tmp,file.split("/").at(-1).replace(".ts",".mjs"));
  await esbuild.build({entryPoints:[join(root,file)],outfile:out,bundle:true,format:"esm",platform:"node"});
  return import(pathToFileURL(out).href);
}

async function createRuntime(){
  if(process.argv.includes("--miniflare")){
    const {Miniflare}=wrangler("miniflare");
    const script=`export default {async fetch(req,env){try{
      const x=await req.json();let result;
      if(x.op==='all')result=await env.DB.prepare(x.q).bind(...x.a).all();
      if(x.op==='run')result=await env.DB.prepare(x.q).bind(...x.a).run();
      if(x.op==='batch')result=await env.DB.batch(x.rows.map(s=>env.DB.prepare(s.q).bind(...s.a)));
      if(x.op==='put')result=!!(await env.BUCKET.put(x.key,new Uint8Array(x.b),x.options));
      if(x.op==='get'){const o=await env.BUCKET.get(x.key);result=o?{b:Array.from(new Uint8Array(await o.arrayBuffer())),size:o.size,etag:o.etag,httpMetadata:o.httpMetadata,customMetadata:o.customMetadata}:null}
      return Response.json(result);
    }catch(e){return Response.json({error:String(e)+' '+String(e.cause)},{status:500})}}}`;
    const mf=new Miniflare({host:"127.0.0.1",cf:false,modules:true,script,compatibilityDate:"2025-03-01",d1Databases:["DB"],r2Buckets:["BUCKET"]});
    const url=await mf.ready;
    const rpc=body=>new Promise((resolve,reject)=>{
      const req=http.request(url,{method:"POST",headers:{"content-type":"application/json"}},r=>{
        let data="";r.on("data",c=>data+=c);r.on("end",()=>{try{const v=JSON.parse(data);if(r.statusCode!==200)reject(Error(v.error));else resolve(v);}catch(e){reject(e);}});
      });
      req.on("error",reject);req.end(JSON.stringify(body));
    });
    const stmt=(q,a=[])=>({q,a,bind:(...v)=>stmt(q,v),run:()=>rpc({op:"run",q,a}),all:()=>rpc({op:"all",q,a}),
      first:async()=>{const result=await rpc({op:"all",q,a});return result.results?.[0]??null;}});
    const adapter={
      db:{prepare:stmt,batch:rows=>rpc({op:"batch",rows:rows.map(({q,a})=>({q,a}))})},
      bucket:{put:(key,b,options={})=>rpc({op:"put",key,b:Array.from(b),options}),
        get:async key=>{const result=await rpc({op:"get",key});return result?{...result,body:{cancel:async()=>{}},arrayBuffer:async()=>new Uint8Array(result.b).buffer}:null;}},
      dispose:()=>mf.dispose(),
    };
    runtimes.push(adapter);
    return adapter;
  }
  const sql=new DatabaseSync(":memory:");
  const prepare=(query,args=[])=>({
    q:query,a:args,bind:(...values)=>prepare(query,values),
    run:()=>sql.prepare(query).run(...args),
    all:()=>({results:sql.prepare(query).all(...args)}),
    first:()=>sql.prepare(query).get(...args)??null,
  });
  const objects=new Map();
  const adapter={
    db:{prepare,batch:async statements=>{
      sql.exec("BEGIN");
      try{const results=statements.map(statement=>({results:statement.all().results??[]}));sql.exec("COMMIT");return results;}
      catch(e){sql.exec("ROLLBACK");throw e;}
    }},
    bucket:{
      async put(key,bytes){objects.set(key,{bytes:new Uint8Array(bytes)});return {size:bytes.byteLength};},
      async get(key){const file=objects.get(key);return file?{size:file.bytes.byteLength,arrayBuffer:async()=>file.bytes.slice().buffer,
        httpMetadata:{},customMetadata:{},body:{cancel:async()=>{}}}:null;},
    },
    dispose:async()=>sql.close(),
  };
  runtimes.push(adapter);
  return adapter;
}

async function applyMigrations(db){
  const files=(await readdir(join(root,"drizzle"))).filter(file=>file.endsWith(".sql")).sort();
  for(const file of files){
    const body=await readFile(join(root,"drizzle",file),"utf8");
    // Strip line comments before splitting on ';': migration prose contains
    // semicolons, and a comment-only fragment is not a runnable statement.
    const sqlText=body.split("\n").map(line=>{const at=line.indexOf("--");return at<0?line:line.slice(0,at);}).join("\n");
    for(const query of sqlText.split(";").map(part=>part.trim()).filter(Boolean)){
      await db.prepare(query).run();
    }
  }
}
function canonical(value){
  if(!value||typeof value!=="object")return JSON.stringify(value);
  if(Array.isArray(value))return "["+value.map(canonical).join(",")+"]";
  return "{"+Object.keys(value).sort().map(key=>JSON.stringify(key)+":"+canonical(value[key])).join(",")+"}";
}
const signManifest=(key,manifest)=>createHmac("sha256",Buffer.from(key,"hex"))
  .update("manifest\n"+canonical(manifest)).digest("hex");

try{
  const {exportBackup,restoreBackup}=await bundled("lib/backup.ts");
  const {pack,unpack}=await bundled("lib/backup-format.ts");
  const secret=randomBytes(32).toString("hex");
  const uid="fixture-owner";
  const source=await createRuntime();
  const target=await createRuntime();
  const legacySource=await createRuntime();
  const legacyTarget=await createRuntime();
  for(const runtime of [source,target,legacySource,legacyTarget]) await applyMigrations(runtime.db);

  const state={version:1,day:11,completed:[11],stage:"review",finished:false,entries:{},fullTests:[],reports:{}};
  await source.db.prepare("INSERT INTO learner_states VALUES(?,?,?)").bind(uid,4,JSON.stringify(state)).run();
  await source.db.prepare(`INSERT INTO personal_calibration
    (user_id,expected,actual,n_confirmed,n_rejected,n_unsure,n_shown,state,rule_version,detector_version,inventory_version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(uid,"TH","S",2,0,0,3,"CANDIDATE","r6-suppress-1","detector-v1","arpabet-v1",1700).run();
  await source.db.prepare(`INSERT INTO personal_calibration
    (user_id,expected,actual,n_confirmed,n_rejected,n_unsure,n_shown,state,rule_version,detector_version,inventory_version,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind(uid,"DH","D",0,2,0,2,"SUPPRESSED","r6-suppress-1","detector-v1","arpabet-v1",1800).run();
  const candidateA=crypto.randomUUID(),candidateB=crypto.randomUUID();
  await source.db.prepare(`INSERT INTO calibration_candidates
    (candidate_id,user_id,attempt_id,recording_id,word,expected,actual,at_ms,detector_confidence,shown_at,answered_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(candidateA,uid,"attempt-1","rec-1","think","TH","S",20310,.82,1600,1650).run();
  await source.db.prepare(`INSERT INTO calibration_candidates
    (candidate_id,user_id,attempt_id,recording_id,word,expected,actual,at_ms,detector_confidence,shown_at,answered_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(candidateB,uid,"attempt-1","rec-1","the","DH","D",30110,.77,1601,1651).run();
  await source.db.prepare(`INSERT INTO calibration_events
    (user_id,attempt_id,candidate_id,expected,actual,verdict,is_catch_trial,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(uid,"attempt-1",candidateA,"TH","S","confirmed",0,1700).run();
  await source.db.prepare(`INSERT INTO calibration_events
    (user_id,attempt_id,candidate_id,expected,actual,verdict,is_catch_trial,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind(uid,"attempt-1",candidateB,"DH","D","rejected",0,1800).run();

  // --- format 4 export/unpack ----------------------------------------------
  const signed=await exportBackup(source.db,source.bucket,uid,secret,new Date("2026-11-15T00:00:00.000Z"));
  equal(signed.manifest.format,4,"profile promotes the export to format 4");
  equal(signed.manifest.personalCalibration.length,2);
  equal(signed.manifest.calibrationCandidates.length,2);
  equal(signed.manifest.calibrationEvents.length,2);
  equal(Object.hasOwn(signed.manifest,"reviewJobs"),true,"format 4 carries reviewJobs");
  const archive=pack({signed,device:[]},[]);
  const unpacked=await unpack(archive);
  equal(unpacked.header.signed.manifest.format,4);
  equal(unpacked.header.signed.manifest.personalCalibration.length,2);

  // --- restore round-trip ---------------------------------------------------
  const plan=await restoreBackup(target.db,target.bucket,uid,secret,signed,false);
  equal(plan.personalCalibration,2);
  equal(plan.calibrationCandidates,2);
  equal(plan.calibrationEvents,2);
  const restored=await restoreBackup(target.db,target.bucket,uid,secret,signed,true);
  equal(restored.personalCalibration,2);
  const roundTrip=await exportBackup(target.db,target.bucket,uid,secret);
  equal(roundTrip.manifest.format,4);
  deepEqual(roundTrip.manifest.personalCalibration,signed.manifest.personalCalibration,"profile survives round-trip");
  deepEqual(roundTrip.manifest.calibrationCandidates,signed.manifest.calibrationCandidates,"candidates survive round-trip");
  deepEqual(roundTrip.manifest.calibrationEvents,signed.manifest.calibrationEvents,"events survive round-trip");
  const replay=await restoreBackup(target.db,target.bucket,uid,secret,signed,true);
  equal(replay.personalCalibration,0,"idempotent restore");
  equal(replay.calibrationCandidates,0);
  equal(replay.calibrationEvents,0);

  // --- format 3 still imports into an empty target --------------------------
  await legacySource.db.prepare("INSERT INTO learner_states VALUES(?,?,?)").bind(uid,2,JSON.stringify(state)).run();
  await legacySource.db.prepare("INSERT INTO teacher_lessons VALUES(?,?,?)").bind(uid,11,JSON.stringify({theme:"legacy"})).run();
  await legacySource.db.prepare(`INSERT INTO teacher_feedback
    (id,user_id,day,stage,attempt,evidence,feedback,created_at,pronunciation,analysis_json)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind("legacy-feedback",uid,11,"speak","legacy-attempt","evidence","feedback",
      "2026-11-14T00:00:00.000Z",null,JSON.stringify({errors:[]})).run();
  const legacy=await exportBackup(legacySource.db,legacySource.bucket,uid,secret,new Date("2026-11-14T00:00:00.000Z"));
  equal(legacy.manifest.format,3,"format-3 backup without calibration");
  ok(!Object.hasOwn(legacy.manifest,"personalCalibration"),"legacy export omits calibration");
  const legacyRestore=await restoreBackup(legacyTarget.db,legacyTarget.bucket,uid,secret,legacy,true);
  equal(legacyRestore.lessons,1);
  equal(legacyRestore.feedback,1);
  equal(legacyRestore.personalCalibration,0);
  const legacyProfile=await legacyTarget.db.prepare("SELECT COUNT(*) AS n FROM personal_calibration").first();
  equal(Number(legacyProfile.n),0);

  // A format-3 backup cannot silently erase an existing profile.
  const legacyAgainstProfile=structuredClone(signed);
  legacyAgainstProfile.manifest.format=3;
  delete legacyAgainstProfile.manifest.personalCalibration;
  delete legacyAgainstProfile.manifest.calibrationCandidates;
  delete legacyAgainstProfile.manifest.calibrationEvents;
  legacyAgainstProfile.signature=signManifest(secret,legacyAgainstProfile.manifest);
  await denied(()=>restoreBackup(target.db,target.bucket,uid,secret,legacyAgainstProfile,false),409);

  // --- version rejection ----------------------------------------------------
  const future=structuredClone(signed);
  future.manifest.format=5;
  future.signature=signManifest(secret,future.manifest);
  await denied(()=>restoreBackup(target.db,target.bucket,uid,secret,future,true),422);

  console.log(`PASS ${count} calibration-backup assertions · ${process.argv.includes("--miniflare")?"Miniflare D1 + R2":"SQLite + isolated R2 adapter"}`);
}finally{
  for(const runtime of runtimes)await runtime.dispose();
  await rm(tmp,{recursive:true,force:true});
}