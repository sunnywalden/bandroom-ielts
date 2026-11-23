// Run from the checkout root: node tests/state-submission-scope.mjs (Node 24+).
// Regression for a browser-walkthrough bug (Day 12 daily mode): appending an
// UNREVIEWED extra-practice Part 3 answer, or a mock answer, touches a review
// field without adding a reviewable subjective answer. Those writes must be
// plain checkpoints — a review submission requires exactly one new reviewable
// answer, so the client only attaches a submission key when one is added
// (feedback-model.addsReviewableAnswer). Real route + in-memory D1.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readFileSync,readdirSync,existsSync} from 'node:fs';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';

const base=pathToFileURL(process.cwd()+'/');
const sql=new DatabaseSync(':memory:');
for(const migration of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())
  sql.exec(readFileSync('drizzle/'+migration,'utf8'));
const clips=new Set(),identity=new AsyncLocalStorage();
globalThis.fixtureIdentity=identity;
globalThis.fixturePlatform={
  DB:{prepare(query){const statement=sql.prepare(query);statement.setReturnArrays(true);return {
    bind:(...args)=>({raw:async()=>statement.all(...args),execute:()=>statement.all(...args)})};},
    async batch(commands){
      sql.exec('BEGIN');
      try{const results=commands.map(c=>c.execute());sql.exec('COMMIT');return results;}
      catch(error){sql.exec('ROLLBACK');throw error;}
    }},
  BUCKET:{head:async key=>clips.has(key)?{size:44}:null}
};
globalThis.fixturePlatform.BANDROOM_CONSENT_GATE='off';
globalThis.fixturePlatform.BANDROOM_QUOTA_GATE='off';
registerHooks({resolve(specifier,ctx,next){
  const mock=source=>({url:'data:text/javascript,'+encodeURIComponent(source),shortCircuit:true});
  if(specifier==='cloudflare:workers')return mock('export const env=globalThis.fixturePlatform');
  if(specifier==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.fixtureIdentity.getStore()');
  if(ctx.parentURL && !ctx.parentURL.includes('/node_modules/') && (specifier.startsWith('@/')||specifier.startsWith('.'))){
    const url=specifier.startsWith('@/')?new URL(specifier.slice(2),base):new URL(specifier,ctx.parentURL);
    for(const suffix of ['.ts','/index.ts']) if(existsSync(fileURLToPath(url)+suffix))return {url:url.href+suffix,shortCircuit:true};
  }return next(specifier,ctx);
}});
const {PUT}=await import('../app/api/state/route.ts');
const {initial,dayStamp}=await import('../app/ledger.ts');
const {addsReviewableAnswer}=await import('../app/feedback-model.ts');

const origin='https://study.example',owner='session-learner',now=dayStamp();
const put=async(revision,state,submissionKey)=>
  identity.run({userId:owner},async()=>{const r=await PUT(new Request(origin+'/api/state',{method:'PUT',
    headers:{'Content-Type':'application/json',Origin:origin,'X-Bandroom-Account':owner},
    body:JSON.stringify({revision,state,submissionKey})}));
    return [r.status,await r.json()];});

let checks=0;
const eq=(actual,expected,context)=>{assert.deepEqual(actual,expected,context);checks++};
let state=initial(),revision=0;
const edit=fn=>{const s=structuredClone(state);fn(s);return s};
const withEntry=patch=>s=>{s.entries[s.day]={...s.entries[s.day],...patch}};
async function commit(fn){const next=edit(fn);const [status,data]=await put(revision,next);eq(status,200,JSON.stringify(data));state=next;revision=data.revision;}
const mark=patch=>commit(withEntry(patch));
const submitVoice=k=>({[k]:JSON.stringify([{at:new Date().toISOString(),text:'Fixture response',spoken:true}]),speakingPhase:k==='speakingPart2'?'followup':'review'});

// Client rule mirrors the server's reviewability rule.
const reviewedRow={at:new Date().toISOString(),text:'First',spoken:true,part:3,seq:0,mode:'daily',reviewed:true,questionId:'lesson-12-p3-01'};
const extraRow={at:new Date().toISOString(),text:'Extra',spoken:true,part:3,seq:1,mode:'daily',reviewed:false,questionId:'lesson-12-p3-02'};
const one=JSON.stringify([reviewedRow]),two=JSON.stringify([reviewedRow,extraRow]);
eq(addsReviewableAnswer('speakingFollowup',one),true,'a reviewed Part 3 answer warrants a submission');
eq(addsReviewableAnswer('speakingFollowup',two),false,'extra practice adds no reviewable answer');
eq(addsReviewableAnswer('speakingFollowup',JSON.stringify([{...reviewedRow,reviewed:false}])),false);
eq(addsReviewableAnswer('speakingFollowup',JSON.stringify([{at:new Date().toISOString(),text:'Legacy',spoken:true}])),true,'legacy rows stay reviewable');
eq(addsReviewableAnswer('speakingMock',JSON.stringify([{at:new Date().toISOString(),text:'Mock',spoken:true,mode:'mock'}])),false,'mock never counts as a submission');
eq(addsReviewableAnswer('speakingPart2',one),true);
eq(addsReviewableAnswer('speakingFollowup','not-json'),false,'malformed field adds nothing');
// Cap eviction appends a new last row: a reviewed answer still gets a task even
// when the evicted oldest row was also reviewed (a count-based check misses it).
const evict=JSON.stringify([extraRow,{...reviewedRow,questionId:'lesson-12-p3-new'}]);
eq(addsReviewableAnswer('speakingFollowup',evict),true,'eviction with a new reviewed answer still submits');

// Server contract on the fresh in-progress day (initial state is Day 11 speak).
await mark(submitVoice('speakingPart2'));
const tasksBefore=sql.prepare('SELECT COUNT(*) n FROM review_tasks').get().n;
// Reviewed Part 3 Q1 through the submission path creates exactly one new task.
const q1=edit(withEntry({speakingFollowup:one,speakingPhase:'review'}));
const key1=randomUUID();
eq((await put(revision,q1,key1))[0],200,'reviewed Part 3 answer is a valid submission');
state=q1;revision++;
eq(sql.prepare('SELECT COUNT(*) n FROM review_tasks').get().n,tasksBefore+1);
// Extra-practice Q2 as a plain checkpoint succeeds and creates no new task.
const q2=edit(withEntry({speakingFollowup:two}));
eq((await put(revision,q2))[0],200,'extra practice saves as a plain checkpoint');
state=q2;revision++;
eq(sql.prepare('SELECT COUNT(*) n FROM review_tasks').get().n,tasksBefore+1,'extra practice creates no review task');
// The bug the client fix avoids: the same write carrying a submission key.
const retry=await put(revision-1,q2,randomUUID());
eq(retry[0],409,'stale replay with a key conflicts');
const divergent=edit(withEntry({speakingFollowup:two,speakingPhase:'review'}));
eq((await put(revision,divergent,randomUUID()))[0],422,'a submission with no new reviewable answer is rejected');
// Mock answers are plain checkpoints too, and complete the mock on their own.
const mockRow={at:new Date().toISOString(),text:'Mock answer',spoken:true,part:1,seq:0,mode:'mock',questionId:'p1-mock-01'};
await mark({speakingMock:JSON.stringify([mockRow])});
eq(sql.prepare('SELECT COUNT(*) n FROM review_tasks').get().n,tasksBefore+1,'mock answer creates no submission task');
await mark({speakingMockComplete:'yes'});
const mockComplete=edit(withEntry({speakingMockComplete:'yes'}));
eq((await put(revision,mockComplete,randomUUID()))[0],422,'mock completion is not a daily review submission');

console.log('state-submission-scope passed',checks,'assertions');
sql.close();
