// Run from the repository root: node tests/coach-audio.mjs (Node 24+, ffmpeg).
// Real SQLite, real FFmpeg media, a per-test private object store; no account or network calls.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {DatabaseSync} from 'node:sqlite'
import {registerHooks} from 'node:module'
import {readFileSync,readdirSync} from 'node:fs'
import {pathToFileURL} from 'node:url'

const root=pathToFileURL(process.cwd()+'/'), db=new DatabaseSync(':memory:')
for(const sql of readdirSync('drizzle').filter(x=>x.endsWith('.sql')).sort())db.exec(readFileSync('drizzle/'+sql,'utf8'))
const media=new Map()
globalThis.testCloud={
  DB:{prepare(q){const stmt=db.prepare(q);stmt.setReturnArrays(true);return {bind:(...v)=>({raw:async()=>stmt.all(...v),run:async()=>stmt.run(...v)})}}},
  BUCKET:{
    async put(key,b,meta){
      if(meta.onlyIf?.etagDoesNotMatch==='*'&&media.has(key))return null;
      const file={bytes:Buffer.from(b),httpMetadata:meta.httpMetadata,customMetadata:meta.customMetadata,etag:'test-etag',size:b.length};
      media.set(key,file);return file;
    },
    async head(key){return media.get(key)||null},
    async get(key,opts){const f=media.get(key);if(!f)return null
      let b=f.bytes;const range=opts?.range;if(range)b=b.subarray(range.offset,range.offset+range.length)
      return {...f,body:new Blob([b]).stream(),arrayBuffer:async()=>b.buffer.slice(b.byteOffset,b.byteOffset+b.length)}},
  }
}
globalThis.user=null
registerHooks({resolve(spec,ctx,next){
  const mock=src=>({url:'data:text/javascript,'+encodeURIComponent(src),shortCircuit:true})
  if(spec==='cloudflare:workers')return mock('export const env=globalThis.testCloud')
  if(spec==='@/app/chatgpt-auth')return mock('export const getChatGPTUser=async()=>globalThis.user')
  if(ctx.parentURL?.startsWith(root.href)&&!ctx.parentURL.includes('node_modules')){
    if(spec==='@/db')return {url:new URL('db/index.ts',root).href,shortCircuit:true}
    if(spec.startsWith('@/'))return {url:new URL(spec.slice(2)+'.ts',root).href,shortCircuit:true}
    if(spec.startsWith('.')&&!spec.endsWith('.ts'))return {url:new URL(spec+'.ts',ctx.parentURL).href,shortCircuit:true}
  }
  return next(spec,ctx)
}})
const load=p=>import(new URL(p,root))
const audio=await load('app/api/audio/route.ts'), mcp=await load('app/mcp/route.ts'), read=await load('app/api/coach/route.ts')
const {getExercises}=await load('app/curriculum.ts'),{initial}=await load('app/ledger.ts')
const url='https://study.example', ctx='https://other.example'
const req=(path,method,headers,body)=>new Request(url+path,{method,headers,body})
const rpc=(method,params,origin=url)=>mcp.POST(req('/mcp','POST',{origin,'content-type':'application/json'},JSON.stringify({jsonrpc:'2.0',id:17,method,params})))
const call=async(name,args={})=>(await (await rpc('tools/call',{name,arguments:args})).json()).result
const result=r=>{assert.ok(!r.isError,r.content?.[0]?.text?.slice(0,300));return JSON.parse(r.content[0].text)}
const up=(bytes,type,origin=url,account=globalThis.user?.userId??'')=>audio.POST(req('/api/audio','POST',{origin,'content-type':type,'X-Bandroom-Account':account},bytes))
const play=(id,range)=>audio.GET(req('/api/audio?id='+encodeURIComponent(id),'GET',range?{range}:{}))
const readAudio=(id,details={},day=11)=>call('read_speaking_recording',{day,recordingId:id,...details})
const clip=(codec,format,extra=[])=>execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-c:a',codec,...extra,'-f',format,'pipe:1'])
const samples=[
  ['audio/webm;codecs=opus',clip('libopus','webm')],
  ['audio/ogg',clip('libopus','ogg')],
  ['audio/mp4',clip('aac','mp4',['-movflags','frag_keyframe+empty_moov'])],
  ['audio/wav',clip('pcm_s16le','wav')],
]
assert.equal((await up(...samples[0].toReversed())).status,401)
assert.equal((await play(crypto.randomUUID())).status,401)
assert.equal((await rpc('tools/call',{name:'read_study_session'})).status,401)
globalThis.user={userId:'test/alice'}
assert.equal((await rpc('tools/list',{},ctx)).status,403)
const listing=(await (await rpc('tools/list')).json()).result.tools
const schema=listing.find(t=>t.name==='publish_lesson').inputSchema.properties.lesson.properties
assert.equal(schema.listening.items.type,'object');assert.equal(schema.words.items.type,'object');assert.equal(schema.words.minItems,3)
assert.equal(schema.listening.items.properties.choices.items.type,'string');assert.equal(schema.recall.type,'object')
assert.ok(!JSON.stringify(schema).includes('prefixItems'))
const form=lesson=>({...lesson,words:lesson.words.map(([term,meaning,example])=>({term,meaning,example})),phrases:lesson.phrases.map(([term,meaning])=>({term,meaning})),collocations:lesson.collocations.map(([term,meaning])=>({term,meaning})),recall:{prompt:lesson.recall[0],answer:lesson.recall[1]}})
const lesson=getExercises(12), release={day:17,lesson:form(lesson)}
assert.equal((await call('publish_lesson',{...release,lesson:{...release.lesson,slug:'https://bad.example'}})).isError,true)
assert.equal((await call('publish_lesson',{...release,lesson:{...release.lesson,words:[]}})).isError,true)
assert.equal(result(await call('publish_lesson',release)).day,17)
assert.equal(result(await call('publish_lesson',{day:17,lesson})).alreadySaved,true)
assert.equal((await call('publish_lesson',{...release,lesson:{...release.lesson,theme:'changed'}})).isError,true)
assert.deepEqual((await (await read.GET()).json()).extras['17'],lesson)
assert.equal(result(await call('read_study_session')).nextTask,"Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?")
assert.equal((await up(samples[0][1],samples[0][0],ctx)).status,403)
assert.equal((await up(samples[0][1],samples[0][0],url,'another-user')).status,428); assert.equal(media.size,0)
assert.equal((await up(samples[0][1],'text/html')).status,415)
assert.equal((await up(Buffer.from([0x1a,0x45,0xdf,0xa3]),'audio/webm')).status,415)
assert.equal((await up(samples[0][1],'audio/ogg')).status,415)
assert.equal((await up(new Uint8Array(12*1024*1024+1),'audio/webm')).status,413)
let webm
for(const [type,bytes] of samples){
  const uploaded=await up(bytes,type);assert.equal(uploaded.status,201);const {id}=await uploaded.json()
  if(type.startsWith('audio/webm'))webm=id
  const full=await play(id);assert.equal(full.status,200);assert.equal(full.headers.get('content-type'),type.split(';')[0])
  assert.deepEqual(Buffer.from(await full.arrayBuffer()),bytes)
  const r=await play(id,'bytes=3-9');assert.equal(r.status,206);assert.deepEqual(Buffer.from(await r.arrayBuffer()),bytes.subarray(3,10))
  const tail=await play(id,'bytes=-5');assert.equal(tail.headers.get('content-range'),`bytes ${bytes.length-5}-${bytes.length-1}/${bytes.length}`)
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()),bytes.subarray(-5))
  assert.equal((await play(id,'bytes=0-0,3-4')).status,416)
  assert.equal((await play(id,'bytes='+bytes.length+'-')).status,416)
  assert.equal((await play(id,'bytes=-0')).status,416)
}
assert.equal((await readAudio(webm)).isError,true) // uploading alone never grants coach access
const state=initial(), attempt={at:'2026-11-09T00:00:00.000Z',text:'',spoken:true,audio:webm}
state.entries[11]={speakingFollowup:JSON.stringify([attempt])}
const insert=db.prepare('INSERT INTO learner_states(user_id,revision,state) VALUES (?,1,?)')
insert.run('test/alice',JSON.stringify(state))
assert.equal((await readAudio(webm,{},10)).isError,true)
const info=result(await readAudio(webm,{mode:'metadata'}));assert.equal(info.size,samples[0][1].length);assert.equal(info.mimeType,'audio/webm')
const audible=(await readAudio(webm)).content.find(c=>c.type==='audio')
assert.equal(audible.mimeType,'audio/webm');assert.deepEqual(Buffer.from(audible.data,'base64'),samples[0][1])
assert.equal(result(await call('read_recording_bytes',{day:11,recordingId:webm,offset:0,length:7})).length,7)
const byteParts=[]
for(let offset=0;offset!==null;){
  const part=result(await readAudio(webm,{mode:'bytes',offset,length:4096}))
  assert.equal(part.offset,offset);assert.equal(Buffer.from(part.base64,'base64').length,part.length)
  byteParts.push(Buffer.from(part.base64,'base64'));offset=part.nextOffset
}
assert.deepEqual(Buffer.concat(byteParts),samples[0][1])
const pcm=execFileSync('ffmpeg',['-v','error','-i','pipe:0','-f','s16le','-ar','16000','-ac','1','pipe:1'],{input:Buffer.concat(byteParts)})
assert.ok(pcm.length>=30000&&pcm.some(v=>v!==0))
assert.equal((await readAudio(webm,{mode:'bytes',offset:info.size})).isError,true)
assert.equal((await readAudio(webm,{mode:'bytes',length:24577})).isError,true)
const submittedAttempt=result(await call('read_study_session')).reviewAttempts.find(a=>a.recordingId===webm)
assert.ok(submittedAttempt)
const review={day:11,stage:'speak',attempt:submittedAttempt.id,recordingId:webm,evidence:'Isolated synthetic audio transport fixture.',feedback:'Check complete clause usage.'}
assert.equal((await call('add_coach_feedback',{...review,attempt:'integration fixture'})).isError,true)
assert.equal((await call('add_coach_feedback',{...review,day:9,recordingId:undefined})).isError,true)
const first=result(await call('add_coach_feedback',review)), second=result(await call('add_coach_feedback',review))
assert.equal(first.id,second.id)
const after=result(await call('read_study_session'));assert.equal(after.revision,1);assert.deepEqual(after.entry,state.entries[11]);assert.equal(after.feedback.length,1);assert.ok(after.feedback[0].evidence.includes(webm))
assert.equal((await call('add_coach_feedback',{...review,recordingId:crypto.randomUUID()})).isError,true)
const syntheticRating={band:6.5,reviewedWholeClip:true,observation:'TEST ONLY: fixture for the audible vowel and word-stress observation field.'}
const rated={...review,pronunciation:syntheticRating}
assert.equal((await call('add_coach_feedback',{...rated,recordingId:undefined})).isError,true)
assert.equal((await call('add_coach_feedback',{...rated,pronunciation:{...syntheticRating,reviewedWholeClip:false}})).isError,true)
assert.equal((await call('add_coach_feedback',{...rated,pronunciation:{...syntheticRating,band:6.3}})).isError,true)
assert.equal((await call('add_coach_feedback',{...rated,pronunciation:{...syntheticRating,observation:''}})).isError,true)
assert.equal((await call('add_coach_feedback',{...review,recordingId:undefined,feedback:'发音暂定 7.0 分'})).isError,true)
assert.equal((await call('add_coach_feedback',{...rated,feedback:'Overall speaking band 7.0'})).isError,true)
const ratedId=result(await call('add_coach_feedback',rated)).id
assert.equal(ratedId,result(await call('add_coach_feedback',rated)).id)
const ratedRow=result(await call('read_study_session')).feedback.find(f=>f.id===ratedId)
assert.deepEqual(ratedRow.pronunciation,{...syntheticRating,recordingId:webm,scope:'partial'})
assert.match(ratedRow.evidence,/发音专项暂定 6.5/);assert.match(ratedRow.evidence,/word-stress/)
assert.deepEqual((await (await read.GET()).json()).feedback.find(f=>f.id===ratedRow.id),ratedRow)

assert.equal((await call('add_coach_feedback',{...review,day:12})).isError,true)
const large=Buffer.alloc(3*1024*1024);await testCloud.BUCKET.put('speaking/test%2Falice/'+webm,large,{httpMetadata:{contentType:'audio/wav'}})
assert.equal(result(await readAudio(webm)).size,large.length)
const end=result(await readAudio(webm,{mode:'bytes',offset:large.length-5}));assert.equal(end.nextOffset,null);assert.equal(end.length,5)
globalThis.user={userId:'other'}
assert.equal((await play(webm)).status,404);assert.equal((await readAudio(webm)).isError,true)
insert.run('other',JSON.stringify(state));assert.equal((await readAudio(webm,{mode:'bytes'})).isError,true) // forged cross-user ID still denied
assert.deepEqual((await (await read.GET()).json()).feedback,[])
// Exercise the two separate speaking submissions with actual uploaded, playable blobs.
// The UI saves an empty transcript, moves Part 2 to the follow-up, then opens self-review.
{
  const checkpoints=await load('app/api/state/route.ts'), account='day12/fixture';
  globalThis.user={userId:account};
  const starting=initial();
  Object.assign(starting,{day:12,stage:'speak',completed:[...starting.completed,11],started:{...starting.started,12:'2026-11-09'},checked:{...starting.checked,11:'2026-11-09'}});
  insert.run(account,JSON.stringify(starting));
  const fetchState=async()=>(await checkpoints.GET()).json();
  const send=async(revision,state)=>checkpoints.PUT(req('/api/state','PUT',{'content-type':'application/json',origin:url,'X-Bandroom-Account':account},JSON.stringify({revision,state})));
  let committed=await fetchState();
  let part2;
  for(const [idx,key,phase] of [[0,'speakingPart2','followup'],[1,'speakingFollowup','review']]){
    const [type,bytes]=samples[idx], context={origin:url,'content-type':type,'X-Bandroom-Account':account,
      'X-Bandroom-Day':'12','X-Bandroom-Phase':idx?'followup':'part2','X-Bandroom-Attempt':crypto.randomUUID()};
    const created=await audio.POST(req('/api/audio','POST',context,bytes));
    assert.equal(created.status,201);
    const {id}=await created.json(),next=structuredClone(committed.state);
    const retry=await audio.POST(req('/api/audio','POST',context,bytes));
    assert.equal(retry.status,200);assert.deepEqual(await retry.json(),{id});

    const answer={at:new Date().toISOString(),text:'',spoken:true,audio:id};
    next.entries[12]={...next.entries[12],[key]:JSON.stringify([answer]),[key+'Draft']:'',speakingPhase:phase};
    const mismatch=structuredClone(next);
    mismatch.entries[12].speakingPhase=idx?'followup':'review';
    assert.equal((await send(committed.revision,mismatch)).status,422);
    if(idx){
      // It is not safe to adopt the already-saved Part 2 recording as evidence of the follow-up.
      const reused=structuredClone(next);
      reused.entries[12][key]=JSON.stringify([{...answer,audio:part2}]);
      assert.equal((await send(committed.revision,reused)).status,422);
    }
    const foreign=structuredClone(next), foreignId=crypto.randomUUID();
    await testCloud.BUCKET.put('speaking/'+encodeURIComponent(account)+'/'+foreignId,bytes,{httpMetadata:{contentType:type.split(';')[0]},customMetadata:{purpose:'speaking',phase:idx?'followup':'part2',day:'13'}});
    foreign.entries[12][key]=JSON.stringify([{...answer,audio:foreignId}]);
    assert.equal((await send(committed.revision,foreign)).status,422);
    const prior=committed.revision;
    assert.equal((await send(prior,next)).status,200);
    assert.equal((await send(prior,next)).status,200); // same response lost and retried
    committed=await fetchState();
    assert.equal(committed.revision,prior+1);
    assert.deepEqual(committed.state.entries[12],next.entries[12]);
    const session=result(await call('read_study_session',{day:12}));
    assert.equal(session.entry.speakingPhase,phase);
    assert.equal(session.nextTask,idx?'Choose one speaking improvement to take into the next answer.':lesson.followup);
    assert.equal(committed.state.stage,'speak');assert.equal(committed.state.finished,false);
    assert.deepEqual(Buffer.from(await (await play(id)).arrayBuffer()),bytes);
    if(!idx)part2=id;else assert.notEqual(id,part2);
  }
  assert.deepEqual(Buffer.from(await (await play(part2)).arrayBuffer()),samples[0][1]);
}
globalThis.user=null;assert.equal((await rpc('tools/call',{name:'read_speaking_recording',arguments:{day:11,recordingId:webm}})).status,401)
console.log('PASS: 4 FFmpeg codecs; range, size, auth and account boundaries; byte-perfect private chunk reconstruction and PCM decode; coach assessment append/read/replay; plugin lesson schema, compatibility and publishing duplicate protection.')
