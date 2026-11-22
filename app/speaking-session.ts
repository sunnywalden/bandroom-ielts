// P0-4: persisted speaking-session reducer. Pure and clock-injected so tests
// cover resume, deadline recovery and the mock no-pause rule without timers.
import type {SpeakingMode, SpeakingPlan, SpeakingQuestion} from './speaking-questions';
import {partDuration} from './speaking-questions';

export type SessionPhase = 'intro'|'part1'|'prep'|'part2'|'part3'|'review'|'done';
export type LegacyPhase = 'part1'|'part2'|'followup'|'review';
export type SpeakingSession = {
  id:string;
  mode:SpeakingMode;
  phase:SessionPhase;
  qIndex:number;
  startedAt:number;
  deadlineAt:number|null;
  timed:boolean;
  pausedAt?:number;
  pausedMs?:number;
};
export type PhaseState = {phase:SessionPhase;qIndex:number;mode:SpeakingMode|null;legacy:boolean;session?:SpeakingSession};
const PHASES:SessionPhase[]=['intro','part1','prep','part2','part3','review','done'];
const MODES:SpeakingMode[]=['daily','full','mock'];

function record(value:unknown):Record<string,unknown>|null {
  return value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
}
export function sessionStorageKey(mode:SpeakingMode){return mode==='mock'?'speakingMockSession':'speakingSession'}
export function parseSession(raw?:string):SpeakingSession|null {
  if(!raw?.trim())return null;
  try {
    const value=record(JSON.parse(raw));
    if(!value)return null;
    const phase=PHASES.find(item=>item===value.phase);
    const mode=MODES.find(item=>item===value.mode);
    if(!phase||!mode||typeof value.id!=='string'||!value.id)return null;
    if(!Number.isSafeInteger(value.qIndex)||(value.qIndex as number)<0)return null;
    if(!Number.isFinite(value.startedAt))return null;
    if(value.deadlineAt!==null&&!Number.isFinite(value.deadlineAt))return null;
    return {
      id:value.id,mode,phase,qIndex:value.qIndex as number,
      startedAt:value.startedAt as number,
      deadlineAt:value.deadlineAt===null?null:value.deadlineAt as number,
      timed:value.timed===true,
      ...(Number.isFinite(value.pausedAt)?{pausedAt:value.pausedAt as number}:{}),
      ...(Number.isFinite(value.pausedMs)?{pausedMs:value.pausedMs as number}:{}),
    };
  } catch {return null}
}
export function serializeSession(session:SpeakingSession){return JSON.stringify(session)}
function mapLegacy(phase:LegacyPhase):{phase:SessionPhase;qIndex:number} {
  if(phase==='followup')return {phase:'part3',qIndex:0};
  if(phase==='part1')return {phase:'part1',qIndex:0};
  return {phase,qIndex:0};
}
export function phaseFor(raw:string|undefined,legacyPhase:LegacyPhase='part2'):PhaseState {
  const session=parseSession(raw);
  if(session)return {phase:session.phase,qIndex:session.qIndex,mode:session.mode,legacy:false,session};
  const mapped=mapLegacy(legacyPhase);
  return {...mapped,mode:null,legacy:true};
}
function fallbackId(){
  if(typeof crypto!=='undefined'&&typeof crypto.randomUUID==='function')return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
export function createSession(mode:SpeakingMode,now=Date.now(),id=fallbackId()):SpeakingSession {
  return {id,mode,phase:'intro',qIndex:0,startedAt:now,deadlineAt:null,timed:mode==='mock'};
}
export function begin(session:SpeakingSession,plan:SpeakingPlan,now=Date.now()):SpeakingSession {
  if(session.phase!=='intro')return session;
  if(!plan.part1.length)return {...session,phase:'prep',deadlineAt:now+60_000};
  return {...session,phase:'part1',qIndex:0,deadlineAt:now+partDuration(1)*1000};
}
export function questionFor(session:SpeakingSession,plan:SpeakingPlan):SpeakingQuestion|null {
  if(session.phase==='part1')return plan.part1[session.qIndex]||null;
  if(session.phase==='part2')return plan.part2;
  if(session.phase==='part3')return plan.part3[session.qIndex]||null;
  return null;
}
export function phasePart(phase:SessionPhase){return phase==='part1'?1:phase==='part2'?2:phase==='part3'?3:null}
export function answer(session:SpeakingSession,plan:SpeakingPlan,now=Date.now()):SpeakingSession {
  if(session.phase==='intro')return begin(session,plan,now);
  if(session.phase==='part1'){
    if(session.qIndex+1<plan.part1.length)
      return {...session,phase:'part1',qIndex:session.qIndex+1,deadlineAt:now+partDuration(1)*1000};
    return {...session,phase:'prep',qIndex:0,deadlineAt:now+60_000};
  }
  if(session.phase==='prep')return startPart2(session,now);
  if(session.phase==='part2'){
    if(!plan.part3.length)return {...session,phase:'review',qIndex:0,deadlineAt:null};
    return {...session,phase:'part3',qIndex:0,deadlineAt:now+partDuration(3)*1000};
  }
  if(session.phase==='part3'){
    if(session.qIndex+1<plan.part3.length)
      return {...session,phase:'part3',qIndex:session.qIndex+1,deadlineAt:now+partDuration(3)*1000};
    return {...session,phase:'review',qIndex:0,deadlineAt:null};
  }
  if(session.phase==='review')return {...session,phase:'done',qIndex:0,deadlineAt:null};
  return session;
}
export function startPart2(session:SpeakingSession,now=Date.now()):SpeakingSession {
  if(session.phase!=='prep')return session;
  return {...session,phase:'part2',qIndex:0,deadlineAt:now+partDuration(2)*1000};
}
export function remainingSeconds(session:SpeakingSession,now=Date.now()):number|null {
  if(session.deadlineAt===null)return null;
  const reference=session.pausedAt??now;
  return Math.max(0,Math.ceil((session.deadlineAt-reference)/1000));
}
export function expired(session:SpeakingSession,now=Date.now()){
  const remaining=remainingSeconds(session,now);
  return remaining!==null&&remaining<=0;
}
// Mock pause is an accessibility exception only: the first permitted pause
// marks the rest of the attempt as `timed:false` in the report.
export function pause(session:SpeakingSession,now=Date.now(),options:{accessible?:boolean}={}):SpeakingSession {
  if(session.pausedAt!==undefined||session.deadlineAt===null)return session;
  if(session.phase==='intro'||session.phase==='review'||session.phase==='done')return session;
  if(session.mode==='mock'&&!options.accessible)return session;
  return {...session,pausedAt:now,...(session.mode==='mock'?{timed:false}:{})};
}
export function resume(session:SpeakingSession,now=Date.now()):SpeakingSession {
  if(session.pausedAt===undefined)return session;
  const paused=Math.max(0,now-session.pausedAt);
  return {...session,
    ...(session.deadlineAt===null?{}:{deadlineAt:session.deadlineAt+paused}),
    pausedMs:(session.pausedMs||0)+paused,
    pausedAt:undefined,
  };
}
export function restart(session:SpeakingSession,plan:SpeakingPlan,now=Date.now()):SpeakingSession {
  return begin({...session,phase:'intro',qIndex:0,deadlineAt:null,pausedAt:undefined,pausedMs:0},plan,now);
}
export function sessionComplete(session:SpeakingSession){return session.phase==='done'}
export function sessionReviewReady(session:SpeakingSession){return session.phase==='review'||session.phase==='done'}
export function answerField(session:SpeakingSession){
  if(session.phase==='part1')return 'speakingPart1' as const;
  if(session.phase==='part2')return 'speakingPart2' as const;
  if(session.phase==='part3')return 'speakingFollowup' as const;
  return null;
}
export function answerPart(session:SpeakingSession){return phasePart(session.phase)}
