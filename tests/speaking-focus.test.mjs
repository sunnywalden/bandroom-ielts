import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FOCUS_HISTORY_LIMIT, activeFocus, focusEvidence, focusFromFeedback, focusId, focusSuggestions, mergeFocus,
  parseFocus, serializeFocus, setFocusStatus,
} from '../app/speaking-focus.ts';

const criterion=(key,label,evidence={})=>({key,label_zh:label,band:null,status:'reference',disclosure_zh:'',evidence});
const card=(parts={})=>({
  schema:'bandroom-speaking-scorecard-v1',
  overall:{band:null,status:'reference',disclosure_zh:'',basis_zh:''},
  criteria:[
    ...(parts.fluency?[criterion('fluency','流利度',parts.fluency)]:[]),
    ...(parts.grammar?[criterion('grammar','语法',{issues:parts.grammar})]:[]),
    ...(parts.lexical?[criterion('lexical','词汇',{issues:parts.lexical})]:[]),
  ],
  drills:parts.drills??[],
});
const fb=(analysis,{day=12,attempt='a1',createdAt='2026-11-20T00:00:00.000Z',id='f1'}={})=>({
  id,day,stage:'speak',attempt,evidence:'',feedback:'',createdAt,analysis,
});
const word=(word,extra={})=>({word,...extra});

test('self-listening confirmation outranks every other signal and skips catch trials',()=>{
  const focus=focusFromFeedback(12,[fb({
    scorecard:card({grammar:[{quote:'I goes',fix:'I go',severity:'major'}]}),
    items:[
      word('think',{verdict:'confirmed'}),
      word('think',{verdict:'confirmed',isCatchTrial:true}),
      word('three',{answeredVerdict:'confirmed'}),
      word('pending',{verdict:'pending'}),
    ],
  })]);
  assert.equal(focus.kind,'pronunciation');
  assert.match(focus.text_zh,/把这 2 个词放慢读一遍/);
  assert.match(focus.text_zh,/「think」、「three」/);
  assert.ok(!focus.text_zh.includes('catch'));
  assert.deepEqual(focus.source,{attemptId:'a1',quote:'think、three'});
  assert.equal(focus.status,'active');
});

test('catch-trial-only confirmation does not create a pronunciation focus',()=>{
  const focus=focusFromFeedback(12,[fb({
    scorecard:card({}),
    items:[word('think',{verdict:'confirmed',isCatchTrial:true})],
  })]);
  assert.equal(focus.kind,'topic');
});

test('a major issue with a verified fix becomes the grammar focus',()=>{
  const focus=focusFromFeedback(12,[fb({
    scorecard:card({grammar:[
      {quote:'minor one',fix:'minor fix',severity:'minor'},
      {quote:'I goes home',fix:'I go home',severity:'major'},
    ]}),
    items:[],
  })]);
  assert.equal(focus.kind,'grammar');
  assert.equal(focus.text_zh,'把「I goes home」改说成「I go home」。');
  assert.deepEqual(focus.source,{attemptId:'a1',quote:'I goes home'});
  assert.equal(focus.id,focusId('grammar',focus.text_zh,'a1'));
});

test('grammar without a fix still asks for a complete retry',()=>{
  const focus=focusFromFeedback(12,[fb({
    scorecard:card({grammar:[{quote:'people is',severity:'major'}]}),items:[],
  })]);
  assert.equal(focus.kind,'grammar');
  assert.equal(focus.text_zh,'把「people is」再完整说一遍。');
});

test('only calibrated fluency evidence may drive a timing focus',()=>{
  const calibrated=focusFromFeedback(12,[fb({
    scorecard:card({fluency:{metrics_status:'calibrated',speech_ratio:0.4,long_pause_ratio:0.05}}),items:[],
  })]);
  assert.equal(calibrated.kind,'fluency');
  assert.match(calibrated.text_zh,/≥1 秒停顿/);
  const uncalibrated=focusFromFeedback(12,[fb({
    scorecard:card({fluency:{speech_ratio:0.2,long_pause_ratio:0.4}}),items:[],
  })]);
  assert.equal(uncalibrated.kind,'topic');
  const withinRange=focusFromFeedback(12,[fb({
    scorecard:card({fluency:{metrics_status:'calibrated',speech_ratio:0.7,long_pause_ratio:0.05}}),items:[],
  })]);
  assert.equal(withinRange.kind,'topic');
});

test('drill wording outranks lexical, lexical outranks the topic fallback',()=>{
  const drill=focusFromFeedback(12,[fb({
    scorecard:card({
      lexical:[{quote:'very good',suggestion:'rewarding'}],
      drills:[{improved:'If I had more time I would travel.',focus_zh:'虚拟语气'}],
    }),items:[],
  })]);
  assert.equal(drill.kind,'drill');
  assert.equal(drill.text_zh,'用「If I had more time I would travel.」的句式回答下一题。');
  const lexical=focusFromFeedback(12,[fb({
    scorecard:card({lexical:[{quote:'very good',suggestion:'rewarding'}]}),items:[],
  })]);
  assert.equal(lexical.kind,'lexical');
  assert.equal(lexical.text_zh,'把「very good」换成「rewarding」。');
  const topic=focusFromFeedback(12,[fb({scorecard:card({}),items:[]})]);
  assert.equal(topic.kind,'topic');
  assert.equal(topic.text_zh,'说满 30 秒，并补一个具体例子。');
});

test('score claims never reach focus copy',()=>{
  assert.equal(focusFromFeedback(12,[fb({
    scorecard:card({grammar:[{quote:'准确率低',fix:'说清楚',severity:'major'}]}),items:[],
  })]),null);
  assert.equal(focusFromFeedback(12,[fb({
    scorecard:card({lexical:[{quote:'good',suggestion:'发音错误少了'}]}),items:[],
  })]),null);
});

test('the latest reviewed scorecard wins and other days are ignored',()=>{
  const older=fb({scorecard:card({lexical:[{quote:'old',suggestion:'older'}]}),items:[]},
    {attempt:'old',createdAt:'2026-11-18T00:00:00.000Z',id:'f-old'});
  const newer=fb({scorecard:card({grammar:[{quote:'new',fix:'fixed',severity:'major'}]}),items:[]},
    {attempt:'new',createdAt:'2026-11-21T00:00:00.000Z',id:'f-new'});
  assert.equal(focusFromFeedback(12,[older,newer]).source.attemptId,'new');
  assert.equal(focusFromFeedback(13,[older,newer]),null);
});

test('focus ids are deterministic per kind, copy and attempt',()=>{
  assert.equal(focusId('grammar','x','a1'),focusId('grammar','x','a1'));
  assert.notEqual(focusId('grammar','x','a1'),focusId('grammar','x','a2'));
  assert.notEqual(focusId('grammar','x','a1'),focusId('lexical','x','a1'));
  assert.equal(focusId('topic','x'),focusId('topic','x',''));
});

test('parsing tolerates malformed input and a bare focus object',()=>{
  assert.deepEqual(parseFocus(undefined),{version:1,history:[]});
  assert.deepEqual(parseFocus('{'),{version:1,history:[]});
  assert.deepEqual(parseFocus('[]'),{version:1,history:[]});
  const bare={id:'grammar-a1-0000',kind:'grammar',text_zh:'fix it',createdAt:'2026-11-20T00:00:00.000Z',status:'done'};
  assert.deepEqual(parseFocus(JSON.stringify(bare)),{version:1,current:bare,history:[]});
  assert.equal(parseFocus(JSON.stringify({...bare,kind:'bogus'})).current,undefined);
  assert.equal(parseFocus(JSON.stringify({...bare,status:'bogus'})).current.status,'active');
  const many=Array.from({length:8},(_,i)=>({...bare,id:'f'+i}));
  assert.equal(parseFocus(JSON.stringify({version:1,history:many})).history.length,FOCUS_HISTORY_LIMIT);
  const state=parseFocus(JSON.stringify({version:1,current:bare,history:many}));
  assert.deepEqual(parseFocus(serializeFocus(state)),state);
  assert.equal(activeFocus(serializeFocus(state)).id,bare.id);
  assert.equal(activeFocus('{'),undefined);
});

test('merge is idempotent, never rewrites a decided focus and keeps five in history',()=>{
  const first=focusFromFeedback(12,[fb({scorecard:card({}),items:[]})]);
  const initial=mergeFocus(undefined,first);
  assert.equal(initial.changed,true);
  assert.equal(activeFocus(initial.value).id,first.id);
  const repeat=mergeFocus(initial.value,first);
  assert.equal(repeat.changed,false);
  assert.equal(repeat.value,initial.value);
  const sameAttempt=mergeFocus(initial.value,{...first,id:'different',text_zh:'other'});
  assert.equal(sameAttempt.changed,false);
  const older=mergeFocus(initial.value,{...first,id:'older',text_zh:'older',source:{attemptId:'a0'},
    createdAt:'2026-11-19T00:00:00.000Z'});
  assert.equal(older.changed,false);
  const later=(i)=>({...first,id:'focus-'+i,text_zh:'copy '+i,source:{attemptId:'x'+i},
    createdAt:new Date(Date.UTC(2026,10,21,0,0,i)).toISOString(),status:'active'});
  let raw=initial.value;
  for(let i=0;i<7;i++){
    const result=mergeFocus(raw,later(i));
    assert.equal(result.changed,true);
    raw=result.value;
  }
  const state=parseFocus(raw);
  assert.equal(state.current.id,'focus-6');
  assert.equal(state.history.length,FOCUS_HISTORY_LIMIT);
  assert.equal(mergeFocus(raw,null).changed,false);
  const decided=mergeFocus(setFocusStatus(raw,'focus-6','dismissed'),later(8));
  assert.equal(decided.changed,false);
  assert.equal(activeFocus(decided.value).status,'dismissed');
});

test('status changes update current and history without touching other fields',()=>{
  const state=parseFocus(JSON.stringify({
    version:1,
    current:{id:'c',kind:'grammar',text_zh:'c',createdAt:'2026-11-21T00:00:00.000Z',status:'active'},
    history:[{id:'h',kind:'lexical',text_zh:'h',createdAt:'2026-11-20T00:00:00.000Z',status:'active'}],
  }));
  const done=parseFocus(setFocusStatus(serializeFocus(state),'c','done'));
  assert.equal(done.current.status,'done');
  assert.equal(done.history[0].status,'active');
  const dismissed=parseFocus(setFocusStatus(setFocusStatus(serializeFocus(state),'h','dismissed'),'h','dismissed'));
  assert.equal(dismissed.history[0].status,'dismissed');
  assert.equal(dismissed.current.status,'active');
  assert.deepEqual(parseFocus(setFocusStatus(serializeFocus(state),'missing','done')),state);
});

test('suggestions list every available cue once, newest review only',()=>{
  assert.deepEqual(focusSuggestions(12,[]),[]);
  assert.deepEqual(focusSuggestions(13,[fb({scorecard:card({}),items:[]},{day:12})]),[]);
  const suggestions=focusSuggestions(12,[fb({
    scorecard:card({
      grammar:[{quote:'I goes',fix:'I go',severity:'major'},{quote:'minor',severity:'minor'}],
      fluency:{metrics_status:'calibrated',speech_ratio:0.7,long_pause_ratio:0.02},
      drills:[{improved:'If I were you, I would…',focus_zh:'虚拟语气'}],
    }),
    items:[],
  })]);
  assert.deepEqual(suggestions.map(item=>item.kind),['grammar','fluency','drill','topic']);
  assert.equal(new Set(suggestions.map(item=>item.text_zh)).size,suggestions.length);
  assert.ok(suggestions.every(item=>item.status==='active'&&item.source.attemptId==='a1'));
});

test('focus evidence only lists scorecard-backed rows, with honest statuses',()=>{
  const focus={id:'grammar-a1-x',kind:'grammar',text_zh:'fix',createdAt:'2026-11-20T00:00:00.000Z',status:'active',
    source:{attemptId:'a1',quote:'I goes'}};
  const rows=focusEvidence(focus,[fb({
    scorecard:card({
      grammar:[{quote:'I goes',fix:'I go',severity:'major'}],
      lexical:[{quote:'good',suggestion:'rewarding'}],
      fluency:{metrics_status:'calibrated',speech_ratio:0.62,long_pause_ratio:0.18},
    }),
    items:[word('think',{verdict:'confirmed'}),word('three',{verdict:'confirmed',isCatchTrial:true})],
  })]);
  const byLabel=Object.fromEntries(rows.map(row=>[row.label_zh,row]));
  assert.equal(byLabel['自听确认词数'].value,'1 个');
  assert.equal(byLabel['自听确认词数'].status,'suggestive');
  assert.equal(byLabel['语音占比'].value,'62%');
  assert.equal(byLabel['语音占比'].status,'calibrated');
  assert.equal(byLabel['长停顿占比'].value,'18%');
  assert.equal(byLabel['语法问题条数（参考）'].value,'1');
  assert.equal(byLabel['词汇问题条数（参考）'].status,'reference');
  // No matching attempt (or no scorecard) yields no evidence instead of a guess.
  assert.deepEqual(focusEvidence({...focus,source:{attemptId:'missing'}},[fb({scorecard:card({}),items:[]})]),[]);
  assert.deepEqual(focusEvidence(focus,[]),[]);
});
