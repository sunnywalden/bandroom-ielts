// Regression: the browser pronunciation client must call the route that
// actually exists. Rev2 shipped the client against '/api/mcp', a path no
// commit ever mounted (the MCP route is app/mcp/route.ts -> '/mcp'); the UI
// tests mocked fetch at the wrong path and asserted it, so CI stayed green
// while the profile panel 404/500'd in production.
//
// This test wires the REAL client (app/pronunciation-coach-client.ts) to the
// REAL route handler (app/mcp/route.ts) through a path-dispatching router mock
// that 404s unknown paths exactly like the Next.js router. A client pointing
// at a non-existent path fails here; no fetch URL is hardcoded in a mock.
// Run from the repository root: node tests/pronunciation-client-route.mjs
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const root=pathToFileURL(process.cwd()+'/');
const sql=new DatabaseSync(':memory:');
for(const file of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())sql.exec(readFileSync('drizzle/'+file,'utf8'));

// D1 binding shape used by lib/calibration.ts through reviewTaskDb().
const prepare=(query,args=[])=>({
  bind:(...values)=>prepare(query,values),
  run:async()=>{const r=sql.prepare(query).run(...args);return {meta:{changes:Number(r.changes)}};},
  all:async()=>({results:sql.prepare(query).all(...args)}),
  first:async()=>sql.prepare(query).get(...args)??null,
});
globalThis.testCloud={
  DB:{prepare,batch:async statements=>{
    sql.exec('BEGIN');
    try{const results=[];for(const statement of statements)results.push(await statement.run());sql.exec('COMMIT');return results;}
    catch(e){sql.exec('ROLLBACK');throw e;}
  }},
  BUCKET:{async put(){return null},async head(){return null},async get(){return null}},
  BANDROOM_CONSENT_GATE:'off',BANDROOM_QUOTA_GATE:'off', // fixture: gates tested separately
};
globalThis.user=null;
registerHooks({resolve(spec,ctx,next){
  const mock=src=>({url:'data:text/javascript,'+encodeURIComponent(src),shortCircuit:true});
  if(spec==='cloudflare:workers')return mock('export const env=globalThis.testCloud');
  if(spec==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.user; export const getAuthContext=async()=>({user:globalThis.user,scope:"owner",identityType:"mock"})');
  if(ctx.parentURL?.startsWith(root.href)&&!ctx.parentURL.includes('node_modules')){
    if(spec==='@/db')return {url:new URL('db/index.ts',root).href,shortCircuit:true};
    if(spec.startsWith('@/'))return {url:new URL(spec.slice(2)+'.ts',root).href,shortCircuit:true};
    if(spec.startsWith('.')&&!spec.endsWith('.ts'))return {url:new URL(spec+'.ts',ctx.parentURL).href,shortCircuit:true};
  }
  return next(spec,ctx);
}});
const load=p=>import(new URL(p,root));
const mcp=await load('app/mcp/route.ts');
const client=await load('app/pronunciation-coach-client.ts');
const {issueCalibrationCandidates}=await load('lib/calibration.ts');

// Path-dispatching router: only mounted paths reach a handler, everything
// else is a 404 like the Next.js App Router. This is the regression gate.
const routes={'/mcp':mcp.POST};
const seen=[];
const fetchImpl=async(url,init={})=>{
  seen.push(url);
  const handler=routes[url];
  if(!handler)return new Response('not found',{status:404});
  return handler(new Request('https://study.example'+url,{
    method:init.method,
    headers:{...init.headers,origin:'https://study.example'},
    body:init.body,
  }));
};

globalThis.user={userId:'test/alice'};
const issued=await issueCalibrationCandidates(globalThis.testCloud.DB,'test/alice',{
  attemptId:'attempt-1',recordingId:'rec-1',
  detectorVersion:'detector-test',inventoryVersion:'arpabet-v1',
  candidates:[
    {word:'the',expected:'DH',actual:'D',atMs:1000,detectorConfidence:0.64},
    {word:'then',expected:'DH',actual:'DH',atMs:2000,detectorConfidence:0.9},
  ],
});
// Input order is preserved: [0] = real DH->D, [1] = catch trial DH->DH.
const [realId,controlId]=issued.candidateIds;
assert.ok(realId&&controlId,'server issued one real candidate and one catch trial');

// Read through the real route: cold-ish profile with one shown category.
const profile=await client.readPronunciationProfile(fetchImpl);
assert.equal(profile.classes.length,1);
assert.equal(profile.classes[0].nShown,1);
assert.equal(profile.catchTrials.shown,1);
assert.equal(profile.notes.trustPromotion,'retired-structurally-unreachable');

// Verdicts round-trip browser -> route -> D1 and rebuild counts from events.
await client.recordPronunciationVerdict(realId,'confirmed',fetchImpl);
await client.recordPronunciationVerdict(controlId,'confirmed',fetchImpl);
const after=await client.readPronunciationProfile(fetchImpl);
assert.equal(after.classes[0].nConfirmed,1,'real confirmation counts');
assert.equal(after.catchTrials.answered,1,'catch trial answer recorded');
assert.equal(after.catchTrials.confirmed,1);
assert.equal(after.totals.nConfirmed,1,'catch trials stay out of category counts');

// Reset is owner-scoped and leaves the route usable afterwards.
const reset=await client.resetPronunciationProfile(fetchImpl);
assert.equal(reset.deleted.profileRows,1);
const empty=await client.readPronunciationProfile(fetchImpl);
assert.equal(empty.classes.length,0);
assert.equal(empty.catchTrials.shown,0);

// Every request went to the mounted MCP path, with no userId in the payload.
assert.ok(seen.length>=5);
for(const url of seen)assert.equal(url,'/mcp');
assert.ok(!JSON.stringify(seen).includes('userId'));
console.log(`pronunciation-client-route: ${seen.length} real-route calls OK`);
