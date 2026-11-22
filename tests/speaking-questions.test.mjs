import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUESTION_BY_ID, SPEAKING_QUESTIONS, TOPIC_LABELS, TOPICS, buildPlan, partAnswerField,
  partDuration, partLabel, questionById, questionsFor, reviewedFor, topicCount, topicForDay,
  topicLabel, validateQuestionBank,
} from '../app/speaking-questions.ts';

test('question bank is complete, original and internally linked',()=>{
  assert.deepEqual(validateQuestionBank(),[]);
  assert.equal(SPEAKING_QUESTIONS.length,96);
  assert.equal(topicCount(),12);
  assert.equal(TOPICS.length,12);
  assert.equal(QUESTION_BY_ID.size,96);
  assert.equal(new Set(SPEAKING_QUESTIONS.map(q=>q.id)).size,96);
  for(const question of SPEAKING_QUESTIONS){
    assert.equal(question.source,'authored');
    assert.equal(question.version,1);
    assert.ok(TOPIC_LABELS[question.topic]);
  }
  for(const part2 of questionsFor(2)){
    assert.equal(part2.bullets?.length,4);
    assert.equal(part2.linked?.length,4);
    for(const id of part2.linked??[]){
      const linked=questionById(id);
      assert.equal(linked?.part,3);
      assert.ok(linked.linked?.includes(part2.id));
    }
  }
  for(const part of [1,2,3])
    assert.equal(questionsFor(part).length,part===2?12:part===3?48:36);
});

test('bank validator reports tampering',()=>{
  const copy=structuredClone(SPEAKING_QUESTIONS);
  copy[0]={...copy[0],id:copy[1].id};
  copy[2]={...copy[2],source:'copied'};
  copy[3]={...copy[3],version:2};
  const errors=validateQuestionBank(copy);
  assert.ok(errors.some(e=>e.startsWith('duplicate id')));
  assert.ok(errors.some(e=>e.startsWith('not authored')));
  assert.ok(errors.some(e=>e.startsWith('bad version')));
  assert.ok(errors.some(e=>e.startsWith('unresolved link'))||errors.length>=3);
});

test('daily plan keeps two questions and prefers the lesson prompts',()=>{
  const plan=buildPlan({mode:'daily',day:12,speaking:'Describe a class you remember.',followup:'Why do people forget lessons?'});
  assert.equal(plan.mode,'daily');
  assert.equal(plan.topic,'study');
  assert.equal(plan.part1.length,2);
  assert.equal(plan.part2.prompt,'Describe a class you remember.');
  assert.equal(plan.part2.id,'lesson-12-p2');
  assert.equal(plan.part2.source,'authored');
  assert.equal(plan.part3.length,2);
  assert.equal(plan.part3[0].prompt,'Why do people forget lessons?');
  assert.equal(plan.part3[0].id,'lesson-12-p3-01');
  assert.equal(plan.part3[1].part,3);
  // The bank fills the second Part 3 slot and never duplicates the lesson prompt.
  assert.notEqual(plan.part3[1].prompt,plan.part3[0].prompt);
});

test('plan falls back to authored bank questions and honours an explicit Part 2 id',()=>{
  const plan=buildPlan({mode:'full',day:23});
  assert.equal(plan.part1.length,3);
  assert.equal(plan.part3.length,3);
  assert.equal(plan.part2.id,'p2-work-01');
  assert.equal(plan.part2.bullets?.length,4);
  assert.ok(plan.part3.every(q=>q.topic===plan.topic));
  const override=buildPlan({mode:'daily',day:12,speaking:'Lesson prompt',questionId:'p2-music-01'});
  assert.equal(override.part2.id,'p2-music-01');
  assert.equal(override.part2.prompt,'Describe a song or piece of music that means something to you.');
});

test('mock plan uses the bank end to end',()=>{
  const plan=buildPlan({mode:'mock',day:35,speaking:'Ignored lesson prompt',followup:'Ignored follow-up'});
  assert.equal(plan.mode,'mock');
  assert.equal(plan.part1.length,3);
  assert.equal(plan.part3.length,3);
  assert.ok(!plan.part3.some(q=>q.id.startsWith('lesson-')));
  assert.ok(plan.part2.id.startsWith('p2-'));
});

test('review policy, timing and labels',()=>{
  assert.equal(reviewedFor('daily',0),true);
  assert.equal(reviewedFor('daily',1),false);
  assert.equal(reviewedFor('full',0),true);
  assert.equal(reviewedFor('mock',2),true);
  assert.equal(partDuration(1),40);
  assert.equal(partDuration(2),120);
  assert.equal(partDuration(3),60);
  assert.equal(partAnswerField(1),'speakingPart1');
  assert.equal(partAnswerField(2),'speakingPart2');
  assert.equal(partAnswerField(3),'speakingFollowup');
  assert.equal(partLabel(2),'Part 2');
  assert.equal(topicForDay(11),'work');
  assert.equal(topicForDay(23),'work');
  assert.equal(topicForDay(12),'study');
  assert.equal(topicLabel('study'),'学习方式');
});
