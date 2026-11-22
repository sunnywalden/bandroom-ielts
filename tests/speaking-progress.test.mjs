import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PROGRESS_ROW_LIMIT, PROGRESS_WINDOW_DAYS, aggregateProgress, pointFromRow, progressCutoff,
} from '../lib/speaking-progress.ts';

const criterion=(key,label,extra={})=>({key,label_zh:label,band:null,status:'reference',disclosure_zh:'',...extra});
const scorecard=(metrics,issues)=>({
  schema:'bandroom-speaking-scorecard-v1',
  overall:{band:null,status:'reference',disclosure_zh:'',basis_zh:''},
  criteria:[
    criterion('fluency','流利度',{evidence:metrics}),
    criterion('grammar','语法',{evidence:{issues:Array.from({length:issues},(_,i)=>({quote:'q'+i}))}}),
  ],
});
const row=(id,analysis,created='2026-11-20T00:00:00.000Z',day=12)=>({
  id:'fb-'+id,day,attempt_id:'attempt-'+id,created_at:created,
  analysis_json:analysis===undefined?null:JSON.stringify(analysis),
});

test('v2 scorecard projects calibrated fluency, reference grammar and suggestive self-listen counts',()=>{
  const point=pointFromRow(row('a',{
    scorecard:scorecard({metrics_status:'calibrated',speech_ratio:0.62,long_pause_ratio:0.08},2),
    items:[
      {word:'think',verdict:'confirmed'},
      {word:'three',answeredVerdict:'confirmed'},
      {word:'catch',verdict:'confirmed',isCatchTrial:true},
      {word:'pending',verdict:'pending'},
    ],
  }));
  assert.deepEqual(point,{
    attemptId:'attempt-a',day:12,createdAt:'2026-11-20T00:00:00.000Z',
    speechRatio:0.62,longPauseRatio:0.08,grammarIssues:2,selfListenWords:2,
    statuses:{speechRatio:'calibrated',longPauseRatio:'calibrated',grammarIssues:'reference',selfListenWords:'suggestive'},
  });
});

test('uncalibrated metrics stay unavailable instead of being guessed',()=>{
  const point=pointFromRow(row('b',{scorecard:scorecard({speech_ratio:0.62,long_pause_ratio:0.08},1)}));
  assert.equal(point.speechRatio,null);
  assert.equal(point.longPauseRatio,null);
  assert.equal(point.statuses.speechRatio,'unavailable');
  assert.equal(point.grammarIssues,1);
  assert.equal(point.statuses.grammarIssues,'reference');
});

test('legacy feedback, bad JSON and scorecard-less analyses are skipped',()=>{
  assert.equal(pointFromRow(row('legacy',undefined)),null);
  assert.equal(pointFromRow({...row('bad',undefined),analysis_json:'{'}),null);
  assert.equal(pointFromRow(row('plain',{errors:[]})),null);
  assert.equal(pointFromRow(row('nocard',{scorecard:{schema:'x'}})),null);
});

test('aggregation counts legacy rows, per-metric samples and truncation',()=>{
  const rows=[
    row('a',{scorecard:scorecard({metrics_status:'calibrated',speech_ratio:0.6,long_pause_ratio:0.1},1)}),
    row('b',{scorecard:scorecard({metrics_status:'calibrated',speech_ratio:0.7,long_pause_ratio:0.05},0)},
      '2026-11-21T00:00:00.000Z'),
    row('legacy',undefined,'2026-11-19T00:00:00.000Z'),
  ];
  const result=aggregateProgress(rows,{truncated:true,windowDays:90,now:new Date('2026-11-22T10:00:00.000Z')});
  assert.equal(result.points.length,2);
  assert.equal(result.legacyCount,1);
  assert.equal(result.truncated,true);
  assert.equal(result.windowDays,90);
  assert.equal(result.generatedAt,'2026-11-22T10:00:00.000Z');
  assert.deepEqual(result.metricCounts,{speechRatio:2,longPauseRatio:2,grammarIssues:2,selfListenWords:0});
  const defaults=aggregateProgress([]);
  assert.equal(defaults.windowDays,PROGRESS_WINDOW_DAYS);
  assert.equal(defaults.truncated,false);
  assert.deepEqual(defaults.metricCounts,{speechRatio:0,longPauseRatio:0,grammarIssues:0,selfListenWords:0});
});

test('window and row limits are the documented constants',()=>{
  assert.equal(PROGRESS_WINDOW_DAYS,180);
  assert.equal(PROGRESS_ROW_LIMIT,200);
  const now=Date.parse('2026-11-22T00:00:00.000Z');
  const cutoff=progressCutoff(now);
  assert.equal(new Date(cutoff).toISOString(),cutoff);
  assert.equal(Date.parse(cutoff),now-PROGRESS_WINDOW_DAYS*86_400_000);
});
