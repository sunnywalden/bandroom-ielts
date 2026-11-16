// Personal pronunciation calibration data layer (design rev2 §8/§9,
// FIX-15/16/17/22/28).
// Run: node --import ./scripts/sites-env.mjs tests/calibration.test.mjs --miniflare
//
// Covers: migration 0007, server-issued candidateIds, idempotent verdicts,
// forged/cross-user candidate rejection, concurrent increments, event-sourced
// counts, catch trials, SUPPRESSED derivation, detector-version fail-closed,
// reset scoping, cross-user isolation and the analysis_artifacts join.
import assert from "node:assert/strict";
import {createRequire} from "node:module";
import {readFile,mkdtemp,rm,readdir} from "node:fs/promises";
import {DatabaseSync} from "node:sqlite";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {createHash} from "node:crypto";
import http from "node:http";

const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve("wrangler/package.json"));
const esbuild=wrangler("esbuild");
const root=process.cwd();
const tmp=await mkdtemp(join(tmpdir(),"bandroom-calibration-"));
const runtimes=[];
let count=0;
const ok=(value,label)=>{assert.ok(value,label);count+=1;};
const equal=(actual,expected,label)=>{assert.equal(actual,expected,label);count+=1;};
const deepEqual=(actual,expected,label)=>{assert.deepEqual(actual,expected,label);count+=1;};

async function bundled(file){
  const out=join(tmp,file.split("/").at(-1).replace(".ts",".mjs"));
  await esbuild.build({entryPoints:[join(root,file)],outfile:out,bundle:true,format:"esm",platform:"node"});
  return import(pathToFileURL(out).href);
}
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");

async function createRuntime(){
  if(process.argv.includes("--miniflare")){
    const {Miniflare}=wrangler("miniflare");
    const script=`export default {async fetch(req,env){try{
      const x=await req.json();let result;
      if(x.op==='all')result=await env.DB.prepare(x.q).bind(...x.a).all();
      if(x.op==='run')result=await env.DB.prepare(x.q).bind(...x.a).run();
      if(x.op==='batch')result=await env.DB.batch(x.rows.map(s=>env.DB.prepare(s.q).bind(...s.a)));
      return Response.json(result);
    }catch(e){return Response.json({error:String(e)+' '+String(e.cause)},{status:500})}}}`;
    const mf=new Miniflare({host:"127.0.0.1",cf:false,modules:true,script,compatibilityDate:"2025-03-01",d1Databases:["DB"]});
    const url=await mf.ready;
    const rpc=body=>new Promise((resolve,reject)=>{
      const req=http.request(url,{method:"POST",headers:{"content-type":"application/json"}},r=>{
        let data="";r.on("data",c=>data+=c);r.on("end",()=>{try{const v=JSON.parse(data);if(r.statusCode!==200)reject(Error(v.error));else resolve(v);}catch(e){reject(e);}});
      });
      req.on("error",reject);req.end(JSON.stringify(body));
    });
    const stmt=(q,a=[])=>({q,a,bind:(...v)=>stmt(q,v),run:()=>rpc({op:"run",q,a}),all:()=>rpc({op:"all",q,a}),
      first:async()=>{const result=await rpc({op:"all",q,a});return result.results?.[0]??null;}});
    const adapter={db:{prepare:stmt,batch:rows=>rpc({op:"batch",rows:rows.map(({q,a})=>({q,a}))})},
      dispose:()=>mf.dispose()};
    runtimes.push(adapter);
    return adapter.db;
  }

  const sql=new DatabaseSync(":memory:");
  const prepare=(query,args=[])=>({
    q:query,a:args,bind:(...values)=>prepare(query,values),
    run:()=>{const result=sql.prepare(query).run(...args);return {meta:{changes:Number(result.changes)}};},
    all:()=>({results:sql.prepare(query).all(...args)}),
    first:()=>sql.prepare(query).get(...args)??null,
  });
  const db={
    prepare,
    batch:async statements=>{
      sql.exec("BEGIN");
      try{
        // Calibration batches contain writes only, so run() returns the
        // per-statement change count that idempotency detection needs.
        const result=statements.map(statement=>statement.run());
        sql.exec("COMMIT");
        return result;
      }catch(e){sql.exec("ROLLBACK");throw e;}
    },
    close:()=>sql.close(),
  };
  runtimes.push({db,dispose:async()=>sql.close()});
  return db;
}

async function applyMigrations(db){
  const files=(await readdir(join(root,"drizzle"))).filter(file=>file.endsWith(".sql")).sort();
  for(const file of files){
    const body=await readFile(join(root,"drizzle",file),"utf8");
    for(const query of body.split(";").map(part=>part.replaceAll("--> statement-breakpoint","").trim()).filter(Boolean)){
      await db.prepare(query).run();
    }
  }
  return files;
}

try{
  const calibration=await bundled("lib/calibration.ts");
  const isolation=await bundled("lib/analysis-isolation.ts");
  const {
    issueCalibrationCandidates, recordCalibrationVerdict, readCalibrationProfile,
    resetCalibrationProfile, callCalibrationTool, calibrationTools, CalibrationError,
  }=calibration;

  const db=await createRuntime();
  const migrationFiles=await applyMigrations(db);
  equal(migrationFiles.length,8,"eight migrations");
  equal(migrationFiles.at(-1),"0007_slimy_boomerang.sql");
  // The new objects are present and the migration is additive.
  for(const table of ["personal_calibration","calibration_candidates","calibration_events"]){
    const row=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(table).first();
    equal(row?.name,table,`table ${table}`);
  }
  const profilePk=await db.prepare("PRAGMA table_info(personal_calibration)").all();
  deepEqual(profilePk.results.filter(c=>c.pk>0).map(c=>c.name).sort(),["actual","expected","user_id"],"profile PK");
  const eventIndexes=(await db.prepare("PRAGMA index_list(calibration_events)").all()).results.map(r=>r.name);
  ok(eventIndexes.includes("calibration_events_candidate"),"idempotency index");
  ok(eventIndexes.includes("calibration_events_profile"),"profile index");

  const userA="owner-a", userB="owner-b";
  const issue=(userId,extra={})=>issueCalibrationCandidates(db,userId,{
    attemptId:"attempt-1",recordingId:"rec-1",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[
      {word:"think",expected:"TH",actual:"S",atMs:20310,detectorConfidence:.82,...extra},
      {word:"the",expected:"DH",actual:"D",atMs:30110,detectorConfidence:.77},
      {word:"the",expected:"DH",actual:"DH",atMs:41100,detectorConfidence:.91,catchTrial:true},
    ],
  });

  // --- issuance -------------------------------------------------------------
  const issued=await issue(userA);
  equal(issued.candidateIds.length,3);
  ok(issued.candidateIds.every(id=>/^[0-9a-f-]{36}$/.test(id)),"server-issued UUIDs");
  const profileAfterIssuance=await readCalibrationProfile(db,userA);
  equal(profileAfterIssuance.rows.length,2,"two real categories");
  equal(profileAfterIssuance.totals.nShown,2,"nShown excludes catch trial");
  equal(profileAfterIssuance.rows.find(r=>r.expected==="TH").nShown,1);
  equal(profileAfterIssuance.rows.find(r=>r.expected==="TH").state,"CANDIDATE");
  equal(profileAfterIssuance.notes.trustPromotion,"disabled-pending-v3");
  const catchCandidate=await db.prepare("SELECT expected,actual FROM calibration_candidates WHERE candidate_id=?")
    .bind(issued.candidateIds[2]).first();
  equal(catchCandidate.expected,"DH");equal(catchCandidate.actual,"DH","catch trial stored as expected===actual");

  // A second detector version cannot silently relabel the same profile.
  await assert.rejects(()=>issueCalibrationCandidates(db,userA,{
    attemptId:"attempt-2",recordingId:"rec-2",detectorVersion:"detector-v2",inventoryVersion:"arpabet-v1",
    candidates:[{word:"think",expected:"TH",actual:"S",atMs:1,detectorConfidence:.5}],
  }),error=>error instanceof CalibrationError&&error.code==="detector_version_mismatch");

  // --- idempotent verdict ---------------------------------------------------
  const [thinkId,,catchId]=issued.candidateIds;
  const first=await recordCalibrationVerdict(db,userA,{candidateId:thinkId,verdict:"confirmed"});
  equal(first.duplicate,false);equal(first.verdict,"confirmed");
  equal(first.profile.nConfirmed,1);equal(first.profile.nShown,1,"verdict does not re-increment nShown");
  equal(first.isCatchTrial,false);
  const replay=await recordCalibrationVerdict(db,userA,{candidateId:thinkId,verdict:"confirmed"});
  equal(replay.duplicate,true,"replay is a duplicate");
  equal(replay.profile.nConfirmed,1,"duplicate does not double-count");
  const eventCount=await db.prepare("SELECT COUNT(*) AS n FROM calibration_events WHERE user_id=?").bind(userA).first();
  equal(Number(eventCount.n),1);
  // A replayed call with a different verdict keeps the original answer.
  const conflicting=await recordCalibrationVerdict(db,userA,{candidateId:thinkId,verdict:"rejected"});
  equal(conflicting.duplicate,true);
  equal(conflicting.verdict,"confirmed","first verdict wins");
  equal((await readCalibrationProfile(db,userA)).rows.find(r=>r.expected==="TH").nConfirmed,1);
  // answeredAt is set exactly once.
  const answered=await db.prepare("SELECT answered_at AS a FROM calibration_candidates WHERE candidate_id=?").bind(thinkId).first();
  ok(Number.isFinite(answered.a));

  // --- forged / other-user candidateId -------------------------------------
  await assert.rejects(()=>recordCalibrationVerdict(db,userA,{candidateId:crypto.randomUUID(),verdict:"confirmed"}),
    error=>error instanceof CalibrationError&&error.code==="candidate_not_found");
  const userBIssue=await issue(userB);
  const userBCandidate=userBIssue.candidateIds[0];
  await assert.rejects(()=>recordCalibrationVerdict(db,userA,{candidateId:userBCandidate,verdict:"confirmed"}),
    error=>error instanceof CalibrationError&&error.code==="candidate_not_found");
  const userBProfile=await readCalibrationProfile(db,userB);
  equal(userBProfile.totals.nConfirmed,0,"A cannot write B's profile");

  // --- catch trial ----------------------------------------------------------
  const catchVerdict=await recordCalibrationVerdict(db,userA,{candidateId:catchId,verdict:"rejected"});
  equal(catchVerdict.isCatchTrial,true);
  equal(catchVerdict.profile,null,"catch trial has no profile row");
  equal(catchVerdict.event.isCatchTrial,true);
  const profileAfterCatch=await readCalibrationProfile(db,userA);
  equal(profileAfterCatch.totals.nRejected,0,"catch trial excluded from counts");
  equal(profileAfterCatch.totals.nShown,2);
  equal(profileAfterCatch.catchTrials.shown,1,"control issuance is surfaced");
  equal(profileAfterCatch.catchTrials.rejected,1,"control verdict is surfaced");
  equal(profileAfterCatch.catchTrials.constantConfirmerFlag,false,"one control cannot flag");

  // --- constant-confirmer detection -----------------------------------------
  // A catch trial has expected===actual, so confirming it is definitionally
  // non-discriminating. Without this signal a user who confirms everything
  // would build a profile that looks confident but carries no information.
  const controls=(n,offset)=>Array.from({length:n},(_,i)=>({
    word:"control",expected:"AH",actual:"AH",atMs:1000*(i+offset),detectorConfidence:.95,catchTrial:true}));
  const confirmer="owner-confirmer";
  const confirmerIssue=await issueCalibrationCandidates(db,confirmer,{
    attemptId:"attempt-ctrl",recordingId:"rec-ctrl",detectorVersion:"detector-v1",
    inventoryVersion:"arpabet-v1",candidates:controls(6,1)});
  const beforeAnswer=await readCalibrationProfile(db,confirmer);
  equal(beforeAnswer.catchTrials.shown,6);
  equal(beforeAnswer.catchTrials.answered,0);
  equal(beforeAnswer.catchTrials.confirmRate,null,"no rate before any answer");
  equal(beforeAnswer.catchTrials.constantConfirmerFlag,false);
  for(const id of confirmerIssue.candidateIds.slice(0,5))
    await recordCalibrationVerdict(db,confirmer,{candidateId:id,verdict:"confirmed"});
  const flagged=await readCalibrationProfile(db,confirmer);
  equal(flagged.catchTrials.answered,5);
  equal(flagged.catchTrials.confirmRate,1);
  equal(flagged.catchTrials.constantConfirmerFlag,true,"five confirmed controls flag the listener");
  equal(flagged.totals.categories,0,"controls never create profile categories");
  equal(flagged.notes.trustPromotion,"disabled-pending-v3","flag does not enable promotion");

  const discriminator="owner-discriminator";
  const discIssue=await issueCalibrationCandidates(db,discriminator,{
    attemptId:"attempt-ctrl2",recordingId:"rec-ctrl2",detectorVersion:"detector-v1",
    inventoryVersion:"arpabet-v1",candidates:controls(6,1)});
  for(const id of discIssue.candidateIds.slice(0,5))
    await recordCalibrationVerdict(db,discriminator,{candidateId:id,verdict:"rejected"});
  const clean=await readCalibrationProfile(db,discriminator);
  equal(clean.catchTrials.confirmRate,0);
  equal(clean.catchTrials.constantConfirmerFlag,false,"rejecting controls is discriminating");

  const partial="owner-partial";
  const partialIssue=await issueCalibrationCandidates(db,partial,{
    attemptId:"attempt-ctrl3",recordingId:"rec-ctrl3",detectorVersion:"detector-v1",
    inventoryVersion:"arpabet-v1",candidates:controls(6,1)});
  for(const id of partialIssue.candidateIds.slice(0,4))
    await recordCalibrationVerdict(db,partial,{candidateId:id,verdict:"confirmed"});
  const tooFew=await readCalibrationProfile(db,partial);
  equal(tooFew.catchTrials.answered,4);
  equal(tooFew.catchTrials.constantConfirmerFlag,false,"below the frozen minimum, no flag");

  // --- concurrent distinct verdicts for one category ------------------------
  const concurrentIssue=await issueCalibrationCandidates(db,userA,{
    attemptId:"attempt-3",recordingId:"rec-3",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[
      {word:"the",expected:"DH",actual:"D",atMs:5000,detectorConfidence:.7},
      {word:"the",expected:"DH",actual:"D",atMs:9000,detectorConfidence:.6},
    ],
  });
  const [c1,c2]=concurrentIssue.candidateIds;
  const results=await Promise.all([
    recordCalibrationVerdict(db,userA,{candidateId:c1,verdict:"confirmed"}),
    recordCalibrationVerdict(db,userA,{candidateId:c2,verdict:"confirmed"}),
  ]);
  ok(results.every(result=>result.saved));
  const dh=await db.prepare("SELECT n_confirmed AS n,n_shown AS shown FROM personal_calibration WHERE user_id=? AND expected='DH' AND actual='D'")
    .bind(userA).first();
  equal(Number(dh.n),2,"concurrent verdicts both counted");
  equal(Number(dh.shown),3,"all three DH->D candidates counted as shown");

  // --- concurrent replay of the SAME verdict --------------------------------
  const replayIssue=await issueCalibrationCandidates(db,userA,{
    attemptId:"attempt-5",recordingId:"rec-5",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[{word:"ship",expected:"SH",actual:"S",atMs:1000,detectorConfidence:.5}],
  });
  const replayCandidate=replayIssue.candidateIds[0];
  const [sameA,sameB]=await Promise.all([
    recordCalibrationVerdict(db,userA,{candidateId:replayCandidate,verdict:"confirmed"}),
    recordCalibrationVerdict(db,userA,{candidateId:replayCandidate,verdict:"confirmed"}),
  ]);
  equal([sameA.duplicate,sameB.duplicate].filter(Boolean).length,1,"exactly one concurrent replay is a duplicate");
  const sh=await db.prepare("SELECT n_confirmed AS n FROM personal_calibration WHERE user_id=? AND expected='SH' AND actual='S'")
    .bind(userA).first();
  equal(Number(sh.n),1,"concurrent duplicate counted once");
  const shEvents=await db.prepare("SELECT COUNT(*) AS n FROM calibration_events WHERE candidate_id=?").bind(replayCandidate).first();
  equal(Number(shEvents.n),1,"one event row");

  // --- SUPPRESSED rule (R6: r > c and r >= 2) -------------------------------
  const rejectIssue=await issueCalibrationCandidates(db,userA,{
    attemptId:"attempt-4",recordingId:"rec-4",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[
      {word:"this",expected:"TH",actual:"D",atMs:1000,detectorConfidence:.5},
      {word:"this",expected:"TH",actual:"D",atMs:2000,detectorConfidence:.5},
    ],
  });
  for(const candidateId of rejectIssue.candidateIds){
    await recordCalibrationVerdict(db,userA,{candidateId,verdict:"rejected"});
  }
  const suppressed=(await readCalibrationProfile(db,userA)).rows.find(r=>r.expected==="TH"&&r.actual==="D");
  equal(suppressed.state,"SUPPRESSED");
  equal(suppressed.nRejected,2);

  // --- FIX-14: user-level SUPPRESSED cap (<=50% of shown categories) ---------
  // Four observed categories; three satisfy R6. floor(4/2)=2 may stay
  // SUPPRESSED, so the worst-ranked third must revert to CANDIDATE. The cap is
  // a GLOBAL property, enforced in the same batch as the per-category rebuild.
  const userCap="owner-cap";
  const capClasses=[["AA","AE"],["EH","IY"],["IH","IY"],["UH","UW"]];
  const capIssue=await issueCalibrationCandidates(db,userCap,{
    attemptId:"cap-1",recordingId:"rec-cap",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:capClasses.flatMap(([e,a],i)=>[
      {word:`w${i}a`,expected:e,actual:a,atMs:1000+i*100,detectorConfidence:.5},
      {word:`w${i}b`,expected:e,actual:a,atMs:2000+i*100,detectorConfidence:.5},
    ]),
  });
  equal(capIssue.candidateIds.length,8,"four classes x two candidates");
  // Reject both candidates of the first three classes; leave the fourth alone.
  for(const cid of capIssue.candidateIds.slice(0,6)){
    await recordCalibrationVerdict(db,userCap,{candidateId:cid,verdict:"rejected"});
  }
  const capProfile=await readCalibrationProfile(db,userCap);
  equal(capProfile.rows.length,4,"four observed categories");
  const capSuppressed=capProfile.rows.filter(r=>r.state==="SUPPRESSED");
  equal(capSuppressed.length,2,"cap holds: floor(4/2)=2 SUPPRESSED, third reverted");
  equal(capProfile.rows.filter(r=>r.state==="CANDIDATE").length,2,"two CANDIDATE");
  // Determinism: the two kept must be the worst by posterior then n_rejected.
  // All three have identical counts (c=0,r=2), so the tie-break is expected/actual ASC.
  deepEqual(capSuppressed.map(r=>`${r.expected}>${r.actual}`).sort(),["AA>AE","EH>IY"],
    "tie-break is deterministic (expected/actual ASC)");
  // A lone observed category can never be suppressed: floor(1/2)=0.
  const userSolo="owner-solo";
  const soloIssue=await issueCalibrationCandidates(db,userSolo,{
    attemptId:"solo-1",recordingId:"rec-solo",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[
      {word:"s1",expected:"Z",actual:"S",atMs:1000,detectorConfidence:.5},
      {word:"s2",expected:"Z",actual:"S",atMs:2000,detectorConfidence:.5},
    ],
  });
  for(const cid of soloIssue.candidateIds){
    await recordCalibrationVerdict(db,userSolo,{candidateId:cid,verdict:"rejected"});
  }
  const soloProfile=await readCalibrationProfile(db,userSolo);
  equal(soloProfile.rows.length,1);
  equal(soloProfile.rows[0].state,"CANDIDATE","lone category cannot be suppressed (floor(1/2)=0)");
  equal(soloProfile.rows[0].nRejected,2,"R6 counts still recorded even when the cap binds");

  // --- tool handler ---------------------------------------------------------
  const toolResult=await callCalibrationTool(db,userA,"read_pronunciation_profile",{});
  const toolPayload=JSON.parse(toolResult.content[0].text);
  equal(toolPayload.totals.categories,toolPayload.rows.length);
  deepEqual(toolPayload.classes,toolPayload.rows,"UI classes alias mirrors rows");
  const userIdInjection=await callCalibrationTool(db,userA,"record_pronunciation_verdict",
    {candidateId:thinkId,verdict:"confirmed",userId:userB});
  equal(userIdInjection.isError,true,"strict schema rejects a client userId");
  ok(userIdInjection.content[0].text.includes("invalid_input"));
  const unknown=await callCalibrationTool(db,userA,"not_a_calibration_tool",{});
  equal(unknown.isError,true);
  const names=calibrationTools.map(tool=>tool.name);
  deepEqual(names,["record_pronunciation_verdict","read_pronunciation_profile","reset_pronunciation_profile"]);
  for(const tool of calibrationTools){
    ok(!("userId" in tool.inputSchema.properties),`${tool.name} has no userId input`);
  }
  equal(calibrationTools.find(t=>t.name==="reset_pronunciation_profile").annotations.destructiveHint,true);
  equal(calibrationTools.find(t=>t.name==="read_pronunciation_profile").annotations.readOnlyHint,true);

  // --- cross-user isolation and scoped reset ---------------------------------
  const beforeResetB=await readCalibrationProfile(db,userB);
  const resetA=await resetCalibrationProfile(db,userA);
  ok(resetA.deleted.events>=7,"event rows deleted");ok(resetA.deleted.candidates>=8,"candidate rows deleted");
  equal(resetA.deleted.profileRows,4,"profile rows deleted");
  ok(resetA.retained.includes("r2_recordings")&&resetA.retained.includes("backups"));
  const afterResetA=await readCalibrationProfile(db,userA);
  equal(afterResetA.rows.length,0);
  for(const table of ["personal_calibration","calibration_candidates","calibration_events"]){
    const row=await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).bind(userA).first();
    equal(Number(row.n),0,`reset clears ${table}`);
  }
  const afterResetB=await readCalibrationProfile(db,userB);
  deepEqual(afterResetB,beforeResetB,"reset leaves the other user untouched");
  const candidatesB=await db.prepare("SELECT COUNT(*) AS n FROM calibration_candidates WHERE user_id=?").bind(userB).first();
  ok(Number(candidatesB.n)>0);

  // --- analysis_artifacts isolation (FIX-22 / MJ-19) ------------------------
  const now=123456;
  await db.prepare(`INSERT INTO review_jobs(id,user_id,day,submission_key,request_hash,revision,snapshot,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).bind("job-b",userB,12,"s","h",1,"{}",now).run();
  await db.prepare(`INSERT INTO review_tasks(id,review_job_id,user_id,kind,attempt_id,day,attempt_revision,stage,state,next_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).bind("task-b","job-b",userB,"speaking","attempt-b",12,1,"decode","queued",now,now,now).run();
  await db.prepare(`INSERT INTO analysis_artifacts(task_id,stage,chunk_index,analyzer_version,input_sha256,artifact_sha256,bytes,object_ref,payload_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).bind("task-b","decode",0,"v1",sha256(Buffer.from("in")),sha256(Buffer.from("out")),4,null,JSON.stringify({ok:true}),now).run();
  const artifactsA=await isolation.readAnalysisArtifactsForUser(db,userA,"task-b");
  equal(artifactsA.length,0,"A cannot read B's artifacts");
  const artifactsB=await isolation.readAnalysisArtifactsForUser(db,userB,"task-b");
  equal(artifactsB.length,1,"B can read its own artifact");
  equal(await isolation.taskBelongsToUser(db,userA,"task-b"),false);
  equal(await isolation.taskBelongsToUser(db,userB,"task-b"),true);

  // --- MCP dispatch through the real callCoach switch ------------------------
  const coachOut=join(tmp,"coach.mjs");
  await esbuild.build({entryPoints:[join(root,"lib/coach.ts")],outfile:coachOut,bundle:true,format:"esm",platform:"node",
    plugins:[
      {name:"mock-cloudflare",setup(build){
        build.onResolve({filter:/^cloudflare:workers$/},()=>({path:"env",namespace:"cf-mock"}));
        build.onLoad({filter:/.*/,namespace:"cf-mock"},()=>({contents:"export const env=globalThis.__calEnv??{};"}));
      }},
      {name:"mock-db",setup(build){
        build.onResolve({filter:/^@\/db$/},()=>({path:"db",namespace:"db-mock"}));
        build.onLoad({filter:/.*/,namespace:"db-mock"},()=>({contents:"export function getDb(){return globalThis.__calDrizzle}"}));
      }},
    ]});
  const coach=await import(pathToFileURL(coachOut).href);
  globalThis.__calEnv={};globalThis.__calDrizzle={$client:db};
  const mcpIssue=await issueCalibrationCandidates(db,userA,{
    attemptId:"attempt-mcp",recordingId:"rec-mcp",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[{word:"this",expected:"TH",actual:"Z",atMs:1000,detectorConfidence:.5}],
  });
  const mcpRecord=await coach.callCoach(userA,"record_pronunciation_verdict",
    {candidateId:mcpIssue.candidateIds[0],verdict:"unsure"});
  const mcpRecordPayload=JSON.parse(mcpRecord.content[0].text);
  equal(mcpRecordPayload.saved,true,"callCoach dispatches the calibration tool");
  equal(mcpRecordPayload.verdict,"unsure");
  equal(mcpRecordPayload.profile.nUnsure,1);
  const mcpProfile=await coach.callCoach(userA,"read_pronunciation_profile",{});
  const mcpProfilePayload=JSON.parse(mcpProfile.content[0].text);
  ok(mcpProfilePayload.classes.length>0,"profile is reachable through callCoach");
  const injectedViaMcp=await coach.callCoach(userA,"record_pronunciation_verdict",
    {candidateId:mcpIssue.candidateIds[0],verdict:"unsure",userId:userB});
  equal(injectedViaMcp.isError,true,"callCoach rejects a client-supplied userId");
  ok(injectedViaMcp.content[0].text.includes("invalid_input"));

  // --- FIX-6: groundedAnalysis transport (contract amendment) ---------------
  // The runner must not be able to supply candidateIds, and grounded analysis
  // must require a speaking attempt with a recording.
  const gaBase={detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",speechSeconds:60,
    candidates:[{word:"the",expected:"DH",actual:"D",atMs:20310,detectorConfidence:.77,tier:"T3"}]};
  const gaNoRecording=await coach.callCoach(userA,"add_coach_feedback",
    {day:12,stage:"speak",attempt:"v2:speak:0:x",feedback:"f",evidence:"e",groundedAnalysis:gaBase});
  equal(gaNoRecording.isError,true,"groundedAnalysis without recordingId is rejected");
  const gaTextStage=await coach.callCoach(userA,"add_coach_feedback",
    {day:12,stage:"write",attempt:"v2:write:0:x",feedback:"f",evidence:"e",
     recordingId:"00000000-0000-4000-8000-000000000001",groundedAnalysis:gaBase});
  equal(gaTextStage.isError,true,"groundedAnalysis on a text stage is rejected");
  const gaForgedId=await coach.callCoach(userA,"add_coach_feedback",
    {day:12,stage:"speak",attempt:"v2:speak:0:x",feedback:"f",evidence:"e",
     recordingId:"00000000-0000-4000-8000-000000000001",
     groundedAnalysis:{...gaBase,candidates:[{...gaBase.candidates[0],candidateId:"forged"}]}});
  equal(gaForgedId.isError,true,"strictObject rejects a runner-supplied candidateId");
  const gaTooMany=await coach.callCoach(userA,"add_coach_feedback",
    {day:12,stage:"speak",attempt:"v2:speak:0:x",feedback:"f",evidence:"e",
     recordingId:"00000000-0000-4000-8000-000000000001",
     groundedAnalysis:{...gaBase,candidates:Array.from({length:25},()=>gaBase.candidates[0])}});
  equal(gaTooMany.isError,true,"candidate array is bounded at 24");
  const gaBadTier=await coach.callCoach(userA,"add_coach_feedback",
    {day:12,stage:"speak",attempt:"v2:speak:0:x",feedback:"f",evidence:"e",
     recordingId:"00000000-0000-4000-8000-000000000001",
     groundedAnalysis:{...gaBase,candidates:[{...gaBase.candidates[0],tier:"T1"}]}});
  equal(gaBadTier.isError,true,"tier enum rejects T1 (only T2/T3 are transportable)");

  // --- reset racing a verdict cannot leave an orphan event or zero row ------
  const raceUser="owner-race";
  const raceIssue=await issueCalibrationCandidates(db,raceUser,{
    attemptId:"attempt-race",recordingId:"rec-race",detectorVersion:"detector-v1",inventoryVersion:"arpabet-v1",
    candidates:[{word:"the",expected:"DH",actual:"D",atMs:1000,detectorConfidence:.5}],
  });
  const raceId=raceIssue.candidateIds[0];
  const racingDb={
    prepare:db.prepare.bind(db),
    batch:async statements=>{
      // Simulate a reset committing between the pre-read and the verdict batch.
      await db.prepare("DELETE FROM calibration_events WHERE user_id=?").bind(raceUser).run();
      await db.prepare("DELETE FROM calibration_candidates WHERE user_id=?").bind(raceUser).run();
      await db.prepare("DELETE FROM personal_calibration WHERE user_id=?").bind(raceUser).run();
      return db.batch(statements);
    },
  };
  await assert.rejects(()=>recordCalibrationVerdict(racingDb,raceUser,{candidateId:raceId,verdict:"confirmed"}),
    error=>error instanceof CalibrationError&&error.code==="event_write_failed");
  for(const table of ["personal_calibration","calibration_candidates","calibration_events"]){
    const row=await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).bind(raceUser).first();
    equal(Number(row.n),0,`racing reset leaves no ${table} row`);
  }

  console.log(`PASS ${count} calibration assertions · ${process.argv.includes("--miniflare")?"Miniflare D1":"SQLite"}`);
}finally{
  for(const runtime of runtimes)await runtime.dispose();
  await rm(tmp,{recursive:true,force:true});
}