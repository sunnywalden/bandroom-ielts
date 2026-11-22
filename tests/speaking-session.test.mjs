import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import test from 'node:test';
registerHooks({resolve(specifier,ctx,next){
  if(ctx.parentURL?.endsWith('/app/speaking-session.ts')&&specifier==='./speaking-questions')
    return {url:new URL('../app/speaking-questions.ts',import.meta.url).href,shortCircuit:true};
  return next(specifier,ctx);
}});
const {
  answer, answerField, answerPart, begin, createSession, expired, parseSession, pause, phaseFor,
  phasePart, questionFor, remainingSeconds, restart, resume, serializeSession, sessionComplete,
  sessionReviewReady, startPart2,
}=await import('../app/speaking-session.ts');

const q=(id,part,prompt=id)=>({id,part,topic:'work',prompt,source:'authored',version:1});
const plan={mode:'full',day:12,topic:'work',
  part1:[q('p1-work-01',1),q('p1-work-02',1),q('p1-work-03',1)],
  part2:q('p2-work-01',2),
  part3:[q('p3-work-01',3),q('p3-work-02',3),q('p3-work-03',3)]};

test('session walks intro → parts → review → done with real deadlines',()=>{
  let s=createSession('full',1000,'session-1');
  assert.deepEqual({phase:s.phase,qIndex:s.qIndex,timed:s.timed,deadlineAt:s.deadlineAt},
    {phase:'intro',qIndex:0,timed:false,deadlineAt:null});
  s=begin(s,plan,2000);
  assert.equal(s.phase,'part1');
  assert.equal(s.deadlineAt,2000+40_000);
  assert.equal(questionFor(s,plan).id,'p1-work-01');
  s=answer(s,plan,3000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['part1',1,43_000]);
  s=answer(s,plan,4000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['part1',2,44_000]);
  s=answer(s,plan,5000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['prep',0,65_000]);
  assert.equal(questionFor(s,plan),null);
  s=startPart2(s,6000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['part2',0,126_000]);
  assert.equal(questionFor(s,plan).id,'p2-work-01');
  s=answer(s,plan,7000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['part3',0,67_000]);
  assert.equal(questionFor(s,plan).id,'p3-work-01');
  s=answer(s,plan,8000);
  assert.deepEqual([s.phase,s.qIndex],['part3',1]);
  s=answer(s,plan,9000);
  s=answer(s,plan,10000);
  assert.deepEqual([s.phase,s.deadlineAt],['review',null]);
  assert.equal(sessionReviewReady(s),true);
  assert.equal(sessionComplete(s),false);
  s=answer(s,plan,11000);
  assert.equal(s.phase,'done');
  assert.equal(sessionComplete(s),true);
});

test('a day without Part 1 goes straight from intro to preparation',()=>{
  const short={...plan,part1:[]};
  const s=begin(createSession('daily',0,'d'),short,1000);
  assert.deepEqual([s.phase,s.qIndex,s.deadlineAt],['prep',0,61_000]);
});

test('countdown tolerates pause and resumes by extending the deadline',()=>{
  let s=begin(createSession('daily',0,'p'),plan,1000);
  assert.equal(remainingSeconds(s,21_000),20);
  s=pause(s,21_000);
  assert.equal(s.pausedAt,21_000);
  assert.equal(remainingSeconds(s,120_000),20);
  assert.equal(expired(s,120_000),false);
  s=resume(s,31_000);
  assert.equal(s.pausedAt,undefined);
  assert.equal(s.pausedMs,10_000);
  assert.equal(s.deadlineAt,51_000);
  assert.equal(remainingSeconds(s,31_000),20);
  assert.equal(expired(s,51_001),true);
});

test('mock cannot pause; the accessibility exception marks the attempt untimed',()=>{
  const base=begin(createSession('mock',0,'m'),plan,0);
  assert.equal(base.timed,true);
  assert.deepEqual(pause(base,1000),base);
  const accessible=pause(base,1000,{accessible:true});
  assert.equal(accessible.pausedAt,1000);
  assert.equal(accessible.timed,false);
  // A timed daily session may pause for any reason and stays untimed throughout.
  const daily=pause(begin(createSession('daily',0,'d'),plan,0),1000);
  assert.equal(daily.pausedAt,1000);
  assert.equal(daily.timed,false);
});

test('session persistence round-trips and rejects malformed state',()=>{
  const s=begin(createSession('full',0,'round'),plan,5000);
  assert.deepEqual(parseSession(serializeSession(s)),s);
  assert.equal(parseSession(undefined),null);
  assert.equal(parseSession(''),null);
  assert.equal(parseSession('{'),null);
  assert.equal(parseSession(JSON.stringify({...s,id:''})),null);
  assert.equal(parseSession(JSON.stringify({...s,phase:'middle'})),null);
  assert.equal(parseSession(JSON.stringify({...s,mode:'exam'})),null);
  assert.equal(parseSession(JSON.stringify({...s,qIndex:-1})),null);
});

test('legacy phase falls back only when no session exists',()=>{
  assert.deepEqual(phaseFor(undefined,'followup'),{phase:'part3',qIndex:0,mode:null,legacy:true});
  assert.deepEqual(phaseFor(undefined,'part2'),{phase:'part2',qIndex:0,mode:null,legacy:true});
  assert.deepEqual(phaseFor(undefined,'review'),{phase:'review',qIndex:0,mode:null,legacy:true});
  const raw=serializeSession(answer(begin(createSession('daily',0,'live'),plan,0),plan,1));
  const state=phaseFor(raw,'followup');
  assert.equal(state.legacy,false);
  assert.equal(state.mode,'daily');
  assert.equal(state.phase,'part1');
  assert.equal(state.qIndex,1);
});

test('restart returns to the first question and part helpers stay aligned',()=>{
  const done=answer({...createSession('daily',0,'r'),phase:'part1',qIndex:2,deadlineAt:5},plan,10);
  assert.equal(done.phase,'prep');
  const fresh=restart(done,plan,20);
  assert.deepEqual([fresh.phase,fresh.qIndex,fresh.pausedMs],['part1',0,0]);
  assert.equal(answerField({...fresh,phase:'part1'}),'speakingPart1');
  assert.equal(answerField({...fresh,phase:'part2'}),'speakingPart2');
  assert.equal(answerField({...fresh,phase:'part3'}),'speakingFollowup');
  assert.equal(answerField({...fresh,phase:'prep'}),null);
  assert.equal(answerPart({...fresh,phase:'part3'}),3);
  assert.equal(phasePart('review'),null);
});
