// node --import ./scripts/sites-env.mjs tests/recording-recovery.mjs
// Exercise actual audio upload handlers and R2 conditional writes in an isolated worker.
import assert from "node:assert/strict";
import http from "node:http";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
const require=createRequire(import.meta.url);
const wrangler=createRequire(require.resolve("wrangler/package.json"));
const {Miniflare}=wrangler("miniflare"), esbuild=wrangler("esbuild");
const {outputFiles}=await esbuild.build({stdin:{contents:`
import {env} from 'cloudflare:workers';
import {POST} from './app/api/audio/route.ts';
import {listRecoverable} from './lib/recording-recovery.ts';
export default {async fetch(req){
  const url=new URL(req.url);
  if(url.pathname==='/upload')return POST(req);
  if(url.pathname==='/inspect'){
    const {user,ledger,phase}=await req.json();
    return Response.json(await listRecoverable(env.BUCKET,user,ledger,12,phase));
  }
  return new Response(null,{status:404});
}}`,resolveDir:process.cwd()},bundle:true,format:'esm',write:false,platform:'browser',external:['cloudflare:workers'],
plugins:[{name:'identity',setup(b){b.onResolve({filter:/^@\/app\/chatgpt-auth$/},()=>({path:'identity',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export async function getChatGPTUser(){return {userId:"fixture-alice"}}'}));}}]});
const mf=new Miniflare({host:'127.0.0.1',cf:false,modules:true,script:outputFiles[0].text,compatibilityDate:'2025-03-01',r2Buckets:['BUCKET']});
try{
 const url=await mf.ready;
 const post=(path,headers,bytes)=>new Promise((resolve,reject)=>{const req=http.request(new URL(path,url),{method:'POST',headers,agent:false},r=>{
   let data='';r.on('data',x=>data+=x);r.on('end',()=>{try{resolve({status:r.statusCode,data:JSON.parse(data)})}catch{reject(Error(data))}})});req.on('error',reject);req.end(bytes);});
 const sample=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=330:duration=0.2','-c:a','libopus','-f','webm','pipe:1']);
 const base={'Content-Type':'audio/webm','X-Bandroom-Account':'fixture-alice'};
 const put=(h,b=sample)=>post('/upload',{...base,...h},b);
 const tags=(id,phase='followup',day='12')=>({'X-Bandroom-Day':day,'X-Bandroom-Phase':phase,'X-Bandroom-Attempt':id});
 const id=crypto.randomUUID(),h=tags(id);
 assert.equal((await put({...h,'X-Bandroom-Day':'12x'})).status,400);
 assert.equal((await put({...h,'X-Bandroom-Account':'wrong'})).status,428);
 const pair=await Promise.all([put(h),put(h)]);
 assert.deepEqual(pair.map(p=>p.status).sort(),[200,201]);
 assert.ok(pair.every(p=>p.data.id===id));
 const changed=Buffer.from(sample);changed[changed.length-1]^=1;
 assert.equal((await put(h,changed)).status,409);
 assert.equal((await put(tags(id,'part2'))).status,409);
 const prior=crypto.randomUUID();
 await put(tags(prior,'part2'));
 const legacy=(await put({})).data.id;
 const used=(await put({})).data.id;
 await put({'X-Bandroom-Purpose':'assessment'});
 await put(tags(crypto.randomUUID(),'part2','13'));
 const now=new Date(),day=now.toISOString().slice(0,10);
 const e={speakingPhase:'followup',speakingPart2:JSON.stringify([{audio:prior,at:now.toISOString()}])};
 const ledger={day:12,stage:'speak',finished:false,started:{12:day},entries:{12:e},fullTests:[{audio:used}]};
 const inspect=async(user,l=ledger)=> (await post('/inspect',{'Content-Type':'application/json'},JSON.stringify({user,ledger:l,phase:'followup'}))).data;
 const listed=await inspect('fixture-alice');
 assert.equal(listed.complete,true);
 assert.deepEqual(listed.items.map(x=>[x.id,x.match]).sort(),[[id,'question'],[legacy,'time-only']].sort());
 assert.deepEqual((await inspect('fixture-bob')).items,[]);
 assert.deepEqual((await inspect('fixture-alice',{...ledger,finished:true})).items,[]);
 assert.deepEqual((await inspect('fixture-alice',{...ledger,entries:{12:{...e,speakingPhase:'review'}}})).items,[]);
 const saved=await inspect('fixture-alice',{...ledger,entries:{12:{...e,speakingFollowup:JSON.stringify([{audio:id}])}}});
 assert.deepEqual(saved.items.map(x=>x.id),[legacy]);
 console.log('PASS: recording recovery, actual isolated R2; duplicate upload race, mismatched retries, question metadata, legacy confirmation, history/assessment/account isolation.');
}finally{await mf.dispose();}
