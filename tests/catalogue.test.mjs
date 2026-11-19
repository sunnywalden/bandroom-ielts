import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { getExercises, hasLesson, registerExtraLessons, sourceUrl } from '../app/curriculum.ts';
import { budgets, initial, oldResults, writings } from '../app/ledger.ts';
import { targets, overallTarget } from '../app/goals.ts';

test('targets and historical results use separate data', () => {
  assert.deepEqual(targets,{Listening:8.5,Reading:9,Writing:8.5,Speaking:7.5});
  assert.equal(Math.round(Object.values(targets).reduce((n,v)=>n+v,0)/2)/2,overallTarget);
  assert.deepEqual(oldResults[10].slice(-2).map(r=>r[1]),['4/10','5.5/10']);
  assert.notEqual(writings[11][0],writings[11][1]);
});
test('every prepared exercise and both budget profiles', () => {
  const seenAudio=new Set(), seenTopics=new Set();
  const player=readFileSync(new URL('../app/listening-player.tsx',import.meta.url),'utf8');
  for(let day=12;day<=16;day++){
    const lesson=getExercises(day);
    assert.ok(hasLesson(day)); assert.equal(lesson.words.length,3);
    for(const w of lesson.words){assert.equal(w.length,3); assert.ok(w.every(Boolean))}
    for(const k of ['phrases','collocations']){assert.equal(lesson[k].length,2);assert.ok(lesson[k].every(p=>p.length===2&&p.every(Boolean)))}
    assert.equal(lesson.recall.length,2); assert.ok(lesson.recall.every(Boolean));
    assert.equal(new URL(sourceUrl(lesson)).hostname,'learnenglish.britishcouncil.org');
    assert.ok(player.includes('"'+lesson.slug+'"'));
    for(const field of ['theme','speaking','followup','passage','writing','edit','use'])assert.ok(lesson[field].trim());
    for(const quiz of [lesson.listening,lesson.reading]){
      assert.equal(quiz.length,2);
      for(const q of quiz){assert.equal(new Set(q.choices).size,3);assert.ok(q.choices[q.answer]);assert.ok(q.why.trim()&&q.prompt.trim())}
    }
    seenAudio.add(lesson.slug);seenTopics.add(lesson.theme);
    for(const date of ['2026-11-09','2026-11-14']){
      const b=budgets(day,date,lesson.fullEssay);
      assert.ok(Object.values(b).reduce((n,v)=>n+v,0)<=120);
      assert.equal(b.speak,date.endsWith('09')?20:30);
      if(lesson.fullEssay)assert.ok(b.write>=40);
    }
  }
  assert.equal(seenAudio.size,5);assert.equal(seenTopics.size,5);
});
test('all 46 adaptive slots can take a coach-authored pack without opening or completing a Day',()=>{
  const fixture=structuredClone(getExercises(12));
  const extras=Object.fromEntries(Array.from({length:46},(_,i)=>[17+i,{...fixture,theme:'Fixture '+(17+i)}]));
  const before=initial();
  registerExtraLessons(extras);
  for(let day=17;day<=62;day++){assert.ok(hasLesson(day));assert.equal(getExercises(day).theme,'Fixture '+day)}
  registerExtraLessons({});
  assert.equal(hasLesson(17),false);assert.equal(hasLesson(63),false);assert.deepEqual(initial(),before);
});
