// P0-5: read-only aggregation for the vertical speaking progress panel.
// Only scorecard evidence is projected. Transcripts, quotes and drafts never
// leave the server, and there is no composite score or invented confidence
// interval: each metric carries its real status.
import type {CoachAnalysis, SpeakingScorecardData} from '../app/feedback-model';

export type ProgressStatus='calibrated'|'reference'|'suggestive'|'unavailable';
export type ProgressPoint={
  attemptId:string;
  day:number;
  createdAt:string;
  speechRatio:number|null;
  longPauseRatio:number|null;
  grammarIssues:number|null;
  selfListenWords:number|null;
  statuses:{speechRatio:ProgressStatus;longPauseRatio:ProgressStatus;grammarIssues:ProgressStatus;selfListenWords:ProgressStatus};
};
export type ProgressDbRow={
  id:string;day:number;created_at:string;attempt_id:string;analysis_json:string|null;
};
export type SpeakingProgress={
  points:ProgressPoint[];
  legacyCount:number;
  truncated:boolean;
  windowDays:number;
  generatedAt:string;
  metricCounts:{speechRatio:number;longPauseRatio:number;grammarIssues:number;selfListenWords:number};
};
export const PROGRESS_WINDOW_DAYS=180;
export const PROGRESS_ROW_LIMIT=200;

type RecordValue=Record<string,unknown>;
function record(value:unknown):RecordValue|null {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as RecordValue:null;
}
function ratio(value:unknown){
  return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1?value:null;
}
function finiteInt(value:unknown){
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function criterion(scorecard:SpeakingScorecardData,keys:string[],labels:string[]){
  return scorecard.criteria.find(item=>keys.includes(item.key)||labels.some(label=>item.label_zh?.includes(label)));
}
function confirmedWords(analysis:CoachAnalysis|undefined){
  if(!Array.isArray(analysis?.items))return null;
  return analysis.items.filter(item=>item&&item.isCatchTrial!==true
    &&(item.answeredVerdict==='confirmed'||item.verdict==='confirmed')).length;
}
export function pointFromRow(row:ProgressDbRow):ProgressPoint|null {
  if(!row.analysis_json)return null;
  let analysis:CoachAnalysis;
  try {analysis=JSON.parse(row.analysis_json) as CoachAnalysis}
  catch {return null}
  const scorecard=analysis?.scorecard;
  if(!scorecard||!Array.isArray(scorecard.criteria))return null;
  const fluency=criterion(scorecard,['fluency'],['流利']);
  const calibrated=fluency?.evidence?.metrics_status==='calibrated'||fluency?.status==='calibrated';
  const speechRatio=calibrated?ratio(fluency?.evidence?.speech_ratio??fluency?.evidence?.speechRatio):null;
  const longPauseRatio=calibrated?ratio(fluency?.evidence?.long_pause_ratio??fluency?.evidence?.longPauseRatio):null;
  const grammar=criterion(scorecard,['grammar'],['语法']);
  const grammarList=grammar?.evidence?.issues;
  const grammarIssues=Array.isArray(grammarList)?grammarList.length:null;
  const selfListenWords=confirmedWords(analysis);
  return {
    attemptId:row.attempt_id,
    day:row.day,
    createdAt:row.created_at,
    speechRatio,
    longPauseRatio,
    grammarIssues,
    selfListenWords,
    statuses:{
      speechRatio:speechRatio===null?'unavailable':'calibrated',
      longPauseRatio:longPauseRatio===null?'unavailable':'calibrated',
      grammarIssues:grammarIssues===null?'unavailable':'reference',
      selfListenWords:selfListenWords===null?'unavailable':'suggestive',
    },
  };
}
export function aggregateProgress(rows:ProgressDbRow[],options:{truncated?:boolean;windowDays?:number;now?:Date}={}):SpeakingProgress {
  const points:ProgressPoint[]=[];
  let legacyCount=0;
  for(const row of rows){
    const point=pointFromRow(row);
    if(point)points.push(point);
    else legacyCount++;
  }
  const metricCounts={speechRatio:0,longPauseRatio:0,grammarIssues:0,selfListenWords:0};
  for(const point of points){
    if(point.speechRatio!==null)metricCounts.speechRatio++;
    if(point.longPauseRatio!==null)metricCounts.longPauseRatio++;
    if(point.grammarIssues!==null)metricCounts.grammarIssues++;
    if(point.selfListenWords!==null)metricCounts.selfListenWords++;
  }
  return {
    points,
    legacyCount,
    truncated:Boolean(options.truncated),
    windowDays:options.windowDays??PROGRESS_WINDOW_DAYS,
    generatedAt:(options.now??new Date()).toISOString(),
    metricCounts,
  };
}
export function progressCutoff(now=Date.now(),windowDays=PROGRESS_WINDOW_DAYS){
  return new Date(now-windowDays*24*60*60*1000).toISOString();
}
