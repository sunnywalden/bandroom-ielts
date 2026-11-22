import assert from 'node:assert/strict';
import test from 'node:test';
import {reviewAttempts} from '../app/feedback-model.ts';

// Golden digests were produced by the pre-redesign identity builder
// (JSON.stringify over day,field,index,stage,response,conditions,evidence,
// [recordingId],at,localOnly). They pin the byte order: any future refactor
// that reorders or spreads optional fields breaks this test, not saved ids.
const LEGACY_PART2='b734ac3df0b30d49e56f71074eea4319623cb12983235831639ec8efbf6e4ea6';
const LEGACY_FOLLOWUP='ce1658d1e709861dda44b6716a7d9dd222deda9557f23007feddc3cc64350f18';
const V2_FOLLOWUP='73b9c485a2b927c32665a9f9f2be6cd921b86df36f6d4aa5332a1e7054e14ae0';
const RECORDING='8f14e45f-ceea-467f-a8f0-9d9b3a9d1a11';

const row=(overrides={})=>JSON.stringify([{
  at:'2026-11-20T00:00:00.000Z',text:'hello world',spoken:true,...overrides,
}]);

test('legacy attempt ids stay byte-identical',async()=>{
  const attempts=await reviewAttempts(12,{
    speakingPart2:row(),
    speakingFollowup:JSON.stringify([{
      at:'2026-11-20T00:01:00.000Z',text:'follow up',spoken:true,audio:RECORDING,
    }]),
  });
  const part2=attempts.find(a=>a.field==='speakingPart2');
  const followup=attempts.find(a=>a.field==='speakingFollowup');
  assert.equal(part2.id,`v1:speakingPart2:0:${LEGACY_PART2}`);
  assert.equal(part2.title,'口语 Part 2 · 首次回答');
  assert.equal(followup.id,`v1:speakingFollowup:0:${LEGACY_FOLLOWUP}`);
  assert.equal(followup.title,'口语 Part 3 · 首次回答');
  assert.equal(followup.recordingId,RECORDING);
});

test('v2 identity adds questionId and part in a fixed position; seq/mode/notes/reviewed never hash',async()=>{
  const base={at:'2026-11-20T00:01:00.000Z',text:'follow up',spoken:true,audio:RECORDING,questionId:'p3-work-02',part:3};
  const bare=await reviewAttempts(12,{speakingFollowup:JSON.stringify([base])});
  const padded=await reviewAttempts(12,{speakingFollowup:JSON.stringify([{
    ...base,seq:7,mode:'daily',notes:'note',reviewed:true,
  }])});
  assert.equal(bare[0].id,`v1:speakingFollowup:0:${V2_FOLLOWUP}`);
  assert.equal(padded[0].id,bare[0].id);
  assert.equal(bare[0].title,'口语 Part 3 · 第 1 题');
  assert.equal(bare[0].questionId,'p3-work-02');
  assert.equal(bare[0].part,3);
});

test('a different question id yields a different attempt id',async()=>{
  const one=await reviewAttempts(12,{speakingFollowup:JSON.stringify([{at:'a',text:'x',spoken:true,questionId:'p3-work-01',part:3}])});
  const two=await reviewAttempts(12,{speakingFollowup:JSON.stringify([{at:'a',text:'x',spoken:true,questionId:'p3-work-02',part:3}])});
  assert.notEqual(one[0].id,two[0].id);
  assert.equal(one[0].index,0);
  assert.equal(two[0].index,0);
});

test('unreviewed practice questions do not become review tasks',async()=>{
  const attempts=await reviewAttempts(12,{speakingFollowup:JSON.stringify([
    {at:'2026-11-20T00:00:00.000Z',text:'reviewed',spoken:true,questionId:'p3-work-01',part:3,reviewed:true},
    {at:'2026-11-20T00:01:00.000Z',text:'practice only',spoken:true,questionId:'p3-work-02',part:3,reviewed:false},
  ])});
  assert.equal(attempts.length,1);
  assert.equal(attempts[0].response,'reviewed');
});

test('Part 1 warm-ups are persisted for resume but never reviewed',async()=>{
  const attempts=await reviewAttempts(12,{speakingPart1:row({questionId:'p1-work-01',part:1})});
  assert.equal(attempts.length,0);
});

test('mock attempts enter review only after the mock is complete',async()=>{
  const mock=JSON.stringify([
    {at:'2026-11-20T00:00:00.000Z',text:'part two answer',spoken:true,questionId:'p2-work-01',part:2,seq:0,mode:'mock'},
    {at:'2026-11-20T00:05:00.000Z',text:'part three answer',spoken:true,questionId:'p3-work-03',part:3,seq:2,mode:'mock'},
  ]);
  const pending=await reviewAttempts(12,{speakingMock:mock});
  assert.equal(pending.filter(a=>a.field==='speakingMock').length,0);
  const done=await reviewAttempts(12,{speakingMock:mock,speakingMockComplete:'yes'});
  const rows=done.filter(a=>a.field==='speakingMock');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(a=>a.title),['练习模考 · Part 2 · 第 1 题','练习模考 · Part 3 · 第 3 题']);
  assert.ok(rows.every(a=>a.mode==='mock'));
  // The mock keeps its own field so it can never be mistaken for a daily row.
  assert.ok(!done.some(a=>a.field==='speakingPart2'&&a.response==='part two answer'));
});
