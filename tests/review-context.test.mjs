// The frozen review context is everything the coach sees besides the attempt.
// For multiple-choice questions the saved response is only an option index, so
// the context must say what that index means; otherwise the coach critiques a
// bare "1" as a too-short essay and cannot check the answer (owner deviation
// report, Day 14 reading Q1/Q2, 2026-11-23).
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';

registerHooks({resolve(specifier,context,next){
  if(specifier.startsWith('@/'))return {url:new URL('../'+specifier.slice(2)+'.ts',import.meta.url).href,shortCircuit:true};
  if((specifier.startsWith('./')||specifier.startsWith('../'))&&!specifier.endsWith('.ts')&&context.parentURL?.endsWith('.ts'))
    return {url:new URL(specifier+'.ts',context.parentURL).href,shortCircuit:true};
  return next(specifier,context);
}});

const {reviewContext}=await import('../lib/review-context.ts');
const {getExercises}=await import('../app/curriculum.ts');

const lesson=getExercises(14);
const attempt=(field,stage,response)=>({
  id:'a',day:14,field,index:0,stage,title:'t',kind:'subjective',response,conditions:'',evidence:'one sentence',
});
const option=(item,i)=>({index:i,letter:'ABC'[i],text:item.choices[i]});

test('reading context keeps the passage and question and decodes the option index',()=>{
  const item=lesson.reading[1];
  const context=reviewContext(attempt('readQ1','read','2'),lesson);
  assert.equal(context.passage,lesson.passage);
  assert.equal(context.prompt,item.prompt);
  assert.deepEqual(context.choices,item.choices);
  assert.equal(context.answer,item.answer);
  assert.equal(context.responseKind,'multiple_choice_option_index');
  assert.deepEqual(context.learnerChoice,option(item,2));
  assert.deepEqual(context.correctChoice,option(item,item.answer));
  assert.equal(context.isCorrect,item.answer===2);
});

test('both reading questions decode against their own item',()=>{
  for(const index of [0,1]){
    const item=lesson.reading[index];
    for(const picked of [0,1,2]){
      const context=reviewContext(attempt('readQ'+index,'read',String(picked)),lesson);
      assert.deepEqual(context.learnerChoice,option(item,picked));
      assert.equal(context.isCorrect,picked===item.answer);
    }
  }
});

test('listening context decodes the option index and keeps its source link',()=>{
  const item=lesson.listening[0];
  const context=reviewContext(attempt('listenQ0','listen','1'),lesson);
  assert.match(context.source,/learnenglish\.britishcouncil\.org/);
  assert.equal(context.responseKind,'multiple_choice_option_index');
  assert.deepEqual(context.learnerChoice,option(item,1));
  assert.equal(context.isCorrect,item.answer===1);
});

test('an unusable response is reported as unknown, never guessed',()=>{
  for(const response of ['','abc','7','-1','1.5']){
    const context=reviewContext(attempt('readQ0','read',response),lesson);
    assert.equal(context.learnerChoice,null,JSON.stringify(response));
    assert.equal(context.isCorrect,null,JSON.stringify(response));
    assert.equal(context.passage,lesson.passage);
  }
});

test('free-text fields keep their existing context shape',()=>{
  assert.deepEqual(reviewContext(attempt('speakingPart2','speak','x'),lesson),{prompt:lesson.speaking});
  assert.deepEqual(reviewContext(attempt('vocabRecall','vocab','x'),lesson),{prompt:lesson.recall[0],answer:lesson.recall[1]});
  assert.equal(reviewContext(attempt('readQ0','read','0'),undefined).scope!==undefined,true);
});
