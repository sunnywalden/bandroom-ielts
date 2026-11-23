import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPARE_DISCLOSURE, DRILL_TAKE_SESSION_CAP, addDrillTake, compareAttempts, comparisonKey,
  drillKey, drillTakes, feedbackByAttempt, latestTakeFor, legacyPromptTitle, legacyQuestionKey, rateDrillTake, sameQuestion,
  sideFromFeedback, splitSameQuestion,
} from '../app/speaking-compare.ts';

const criterion=(key,label,extra={})=>({key,label_zh:label,band:null,status:'reference',disclosure_zh:'',...extra});
const card=(speech,pause,wpm,grammar,lexical)=>({
  schema:'bandroom-speaking-scorecard-v1',
  overall:{band:null,status:'reference',disclosure_zh:'',basis_zh:''},
  criteria:[
    criterion('fluency','流利度',{evidence:{metrics_status:'calibrated',speech_ratio:speech,long_pause_ratio:pause,wpm}}),
    criterion('grammar','语法',{evidence:{issues:Array.from({length:grammar},(_,i)=>({quote:'q'+i,fix:'f'+i}))}}),
    criterion('lexical','词汇',{evidence:{issues:Array.from({length:lexical},(_,i)=>({quote:'w'+i,suggestion:'s'+i}))}}),
    criterion('pronunciation','发音',{band:null,status:'asr'}),
  ],
});
const analysis=(confirmed=0)=>({items:[
  ...Array.from({length:confirmed},(_,i)=>({word:'w'+i,verdict:'confirmed'})),
  {word:'catch',verdict:'confirmed',isCatchTrial:true},
  {word:'miss',verdict:'pending'},
]});

test('same-question comparison reports calibrated and reference rows without a pronunciation band',()=>{
  const result=compareAttempts({
    left:{attemptId:'a',scorecard:card(0.5,0.2,110,3,1),analysis:analysis(1)},
    right:{attemptId:'b',scorecard:card(0.6,0.1,125,1,2),analysis:analysis(3)},
  });
  assert.equal(result.matched,true);
  assert.equal(result.disclosure,COMPARE_DISCLOSURE);
  const byKey=Object.fromEntries(result.rows.map(row=>[row.key,row]));
  assert.equal(byKey.speech_ratio.status,'calibrated');
  assert.equal(byKey.speech_ratio.left,'50%');
  assert.equal(byKey.speech_ratio.right,'60%');
  assert.equal(byKey.speech_ratio.delta,'+10 个百分点');
  assert.equal(byKey.long_pause_ratio.delta,'-10 个百分点');
  assert.equal(byKey.wpm.status,'reference');
  assert.equal(byKey.grammar_issues.status,'reference');
  assert.equal(byKey.grammar_issues.left,'3');
  assert.equal(byKey.lexical_issues.right,'2');
  assert.equal(byKey.self_listen_words.status,'suggestive');
  assert.equal(byKey.self_listen_words.left,'1');
  assert.equal(byKey.self_listen_words.right,'3');
  assert.ok(!result.rows.some(row=>/pronunciation|发音/.test(row.key+row.label_zh)));
  assert.ok(result.rows.every(row=>!('band' in row)));
});

test('uncalibrated fluency is never compared numerically',()=>{
  const left=card(0.5,0.2,0,0,0);
  left.criteria[0]={...left.criteria[0],evidence:{speech_ratio:0.5,long_pause_ratio:0.2}};
  const result=compareAttempts({left:{attemptId:'a',scorecard:left},right:{attemptId:'b',scorecard:card(0.6,0.1,0,0,0)}});
  assert.ok(!result.rows.some(row=>row.key==='speech_ratio'));
  assert.ok(!result.rows.some(row=>row.key==='long_pause_ratio'));
});

test('comparison requires a scorecard on both sides',()=>{
  assert.deepEqual(compareAttempts({left:{attemptId:'a'},right:{attemptId:'b',scorecard:card(.5,.1,0,0,0)}}),
    {matched:false,reason:'两次作答中至少一次还没有可对比的评分卡。',rows:[],disclosure:COMPARE_DISCLOSURE});
});

test('legacy and question-id schemes never mix',()=>{
  assert.equal(legacyQuestionKey(12,' Describe a job '),legacyQuestionKey(12,'describe a job'));
  assert.notEqual(legacyQuestionKey(12,'describe a job'),legacyQuestionKey(13,'describe a job'));
  const legacy={day:12,prompt:'Describe a job'};
  const v2a={day:12,prompt:'Describe a job',questionId:'p2-work-01'};
  const v2b={day:12,prompt:'Different text',questionId:'p2-work-01'};
  assert.equal(comparisonKey(v2a).scheme,'v2');
  assert.equal(comparisonKey(v2a).key,'q:p2-work-01');
  assert.equal(sameQuestion(legacy,{...legacy}),true);
  assert.equal(sameQuestion(v2a,v2b),true);
  assert.equal(sameQuestion(legacy,v2a),false);
  assert.equal(sameQuestion(v2a,{...v2a,questionId:'p2-work-02'}),false);
  const rejected=splitSameQuestion({left:legacy,right:v2a,leftSide:{attemptId:'a'},rightSide:{attemptId:'b'}});
  assert.equal(rejected.matched,false);
  assert.match(rejected.reason,/不是同一道题/);
});

test('legacy attempt ordinals never split one question into two (prod day-14 regression)',()=>{
  // Production archive: "口语 Part 3 · 首次回答" and "口语 Part 3 · 重答 1"
  // answered the same follow-up question but hashed to different keys.
  const first={day:14,prompt:legacyPromptTitle('口语 Part 3 · 首次回答')};
  const redo={day:14,prompt:legacyPromptTitle('口语 Part 3 · 重答 1')};
  assert.equal(sameQuestion(first,redo),true);
  const part2First={day:14,prompt:legacyPromptTitle('口语 Part 2 · 首次回答')};
  const part2Redo={day:14,prompt:legacyPromptTitle('口语 Part 2 · 重答 2')};
  assert.equal(sameQuestion(part2First,part2Redo),true);
  assert.equal(sameQuestion(first,part2First),false,'different parts stay apart');
  // Session-era numbered titles keep their question number: two different
  // Part 3 questions must not compare even without a questionId.
  const q1={day:14,prompt:legacyPromptTitle('口语 Part 3 · 第 1 题')};
  const q2={day:14,prompt:legacyPromptTitle('口语 Part 3 · 第 2 题')};
  assert.equal(sameQuestion(q1,q2),false);
});

test('drill takes cap per drill and per session, evicting the oldest',()=>{
  const key=drillKey('attempt-1','I goes home','I go home');
  assert.equal(key,drillKey('attempt-1','I goes home','I go home'));
  assert.notEqual(key,drillKey('attempt-2','I goes home','I go home'));
  let raw=undefined;
  for(let i=0;i<3;i++){
    const result=addDrillTake(raw,{drillKey:key,attemptId:'attempt-1',at:new Date(1000+i).toISOString(),audio:'a'+i});
    assert.equal(result.added,true);
    raw=result.value;
  }
  const fourth=addDrillTake(raw,{drillKey:key,attemptId:'attempt-1',at:new Date(2000).toISOString(),audio:'a4'});
  assert.equal(fourth.added,false);
  assert.equal(fourth.reason,'drill_cap');
  assert.equal(drillTakes(raw).length,3);
  assert.equal(latestTakeFor(raw,key).audio,'a2');
  // Fill the session with distinct drills; the oldest take is evicted.
  for(let i=0;i<DRILL_TAKE_SESSION_CAP+1;i++){
    const other=drillKey('attempt-'+i,'q','fix');
    raw=addDrillTake(raw,{drillKey:other,attemptId:'attempt-'+i,at:new Date(10_000+i).toISOString(),audio:'s'+i}).value;
  }
  assert.equal(drillTakes(raw).length,DRILL_TAKE_SESSION_CAP);
  assert.ok(!drillTakes(raw).some(take=>take.audio==='a0'));
});

test('self-rating marks only the latest take and never invents one',()=>{
  const key=drillKey('attempt-1','I go to school','I went to school');
  let raw=JSON.stringify({version:1,takes:[]});
  for(let i=0;i<2;i++)
    raw=addDrillTake(raw,{drillKey:key,attemptId:'attempt-1',at:new Date(1000+i).toISOString(),audio:'a'+i}).value;
  const rated=rateDrillTake(raw,key,'used');
  assert.equal(rated.changed,true);
  const takes=drillTakes(rated.value);
  assert.equal(takes[0].selfRating,undefined);
  assert.equal(takes[1].selfRating,'used');
  assert.equal(latestTakeFor(rated.value,key).selfRating,'used');
  // Re-rating the same value is a no-op so nothing is written needlessly.
  assert.equal(rateDrillTake(rated.value,key,'used').changed,false);
  // A key with no take cannot acquire a rating.
  const missing=rateDrillTake(rated.value,drillKey('attempt-2','x','y'),'used');
  assert.equal(missing.changed,false);
  assert.deepEqual(drillTakes(missing.value),takes);
});

test('feedback lookup picks the latest row and respects the day',()=>{
  const feedback=[
    {id:'f1',day:12,stage:'speak',attempt:'a',evidence:'',feedback:'old',createdAt:'2026-11-20T00:00:00.000Z',analysis:{scorecard:card(.5,.1,0,0,0)}},
    {id:'f2',day:12,stage:'speak',attempt:'a',evidence:'',feedback:'new',createdAt:'2026-11-21T00:00:00.000Z',analysis:{scorecard:card(.6,.1,0,0,0)}},
  ];
  assert.equal(feedbackByAttempt(feedback,'a').id,'f2');
  assert.equal(feedbackByAttempt(feedback,'missing'),undefined);
  assert.equal(sideFromFeedback(feedback,'a',12).scorecard,feedback[1].analysis.scorecard);
  assert.equal(sideFromFeedback(feedback,'a',13),null);
});
