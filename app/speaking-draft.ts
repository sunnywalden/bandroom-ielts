import {requestJSON} from './request-json';
export type QuestionPhase = 'part2' | 'followup';
export type Answer = { at:string; text:string; spoken:boolean; audio?:string; local?:string };
export type RecordingDraft = { id:string; at:string; blob?:Blob; audio?:string };

export {newClientId,newClientId as newRecordingId} from './client-id';

export function answers(raw?:string):Answer[] {
  try {
    const v:unknown=JSON.parse(raw||'[]');
    return Array.isArray(v)?v.filter(a=>a&&typeof a.at==='string'&&typeof a.text==='string'&&a.spoken===true):[];
  } catch {return []}
}

export function currentPhase(day:number,entry:Record<string,string>):QuestionPhase|'review' {
  if(answers(entry.speakingFollowup).length)return 'review';
  return day===11||answers(entry.speakingPart2).length?'followup':'part2';
}

export function draftKey(account:string,day:number,phase:QuestionPhase){
  return JSON.stringify(['speaking-draft-v1',account,day,phase]);
}

export function submitted(draft:RecordingDraft,items:Answer[]){
  return items.some(a=>a.audio===draft.id||Boolean(draft.audio&&a.audio===draft.audio)||a.at===draft.at);
}

// Legacy recordings are stored under bare UUIDs. Pending recordings use a separate key namespace.
export function changeDraft(key:string,change?:(current:RecordingDraft|undefined)=>RecordingDraft|undefined):Promise<RecordingDraft|undefined> {
  return new Promise((resolve,reject)=>{
    let settled=false,db:IDBDatabase|undefined,tx:IDBTransaction|undefined;
    const finish=(error?:unknown,value?:RecordingDraft)=>{
      if(settled)return;settled=true;clearTimeout(timer);
      if(error){try{tx?.abort()}catch{/* already finished */}}
      db?.close();if(error)reject(error);else resolve(value);
    };
    const timer=setTimeout(()=>finish(Error('本机草稿存储超时')),2500);
    try {
    const open=indexedDB.open('ielts-speaking-audio',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('clips');
    open.onerror=()=>finish(open.error||Error('本机草稿存储不可用'));
    open.onblocked=()=>finish(Error('本机草稿存储被阻塞'));
    open.onsuccess=()=>{
      db=open.result;if(settled){db.close();return;}
      try {
      tx=db.transaction('clips',change?'readwrite':'readonly');const store=tx.objectStore('clips');
      const read=store.get(key);
      let value:RecordingDraft|undefined;
      read.onsuccess=()=>{
        value=read.result as RecordingDraft|undefined;
        if(!change)return;
        const next=change(value);
        if(next!==value){if(next===undefined)store.delete(key);else store.put(next,key);}
        value=next;
      };
      tx.oncomplete=()=>finish(undefined,value);
      tx.onabort=tx.onerror=()=>finish(tx?.error||Error('本机草稿存储失败'));
      }catch(error){finish(error)}
    };
    }catch(error){finish(error)}
  });
}
export function discardIfMatch(id:string){return (current:RecordingDraft|undefined)=>current?.id===id?undefined:current;}

// MT-5 (G11): clear ALL locally cached recording clips. Called on sign-out /
// account switch so a shared browser never leaves one account's voice clips
// readable by the next account. Legacy clips were stored under bare UUIDs with
// no account scope; wiping the store on account change is the safe remediation.
// New draft keys are already account-scoped via draftKey().
export function clearLocalClips():Promise<void> {
  return new Promise((resolve)=>{
    let settled=false,db:IDBDatabase|undefined;
    const finish=()=>{if(settled)return;settled=true;clearTimeout(timer);db?.close();resolve();};
    const timer=setTimeout(finish,2500);
    try {
      const open=indexedDB.open('ielts-speaking-audio',1);
      open.onupgradeneeded=()=>open.result.createObjectStore('clips');
      open.onerror=finish;open.onblocked=finish;
      open.onsuccess=()=>{
        db=open.result;if(settled){db.close();return;}
        try {
          const tx=db.transaction('clips','readwrite');
          tx.objectStore('clips').clear();
          tx.oncomplete=finish;tx.onabort=tx.onerror=finish;
        }catch{finish();}
      };
    }catch{finish();}
  });
}

export async function uploadDraft(draft:RecordingDraft,account:string,day:number,phase:QuestionPhase):Promise<string> {
  if(draft.audio)return draft.audio;
  if(!draft.blob)throw Error('找不到可提交的录音，请重新打开本题草稿。');
  const {response:res,data:result}=await requestJSON<{id?:string}>('/api/audio',{method:'POST',redirect:'manual',headers:{
    'Content-Type':draft.blob.type||'audio/webm','X-Bandroom-Account':account,
    'X-Bandroom-Day':String(day),'X-Bandroom-Phase':phase,'X-Bandroom-Attempt':draft.id
  },body:draft.blob},45_000);
  if(!res.ok){
    if(res.status===401||res.status===403||res.status===428||res.type==='opaqueredirect')
      throw Error('请重新登录本账号，再提交本题录音。');
    if(res.status===413||res.status===415)throw Error('服务器未能接收这段音频。请下载保留原件。');
    if(res.status===409)throw Error('录音标识与已上传内容冲突。请下载保留录音，再读取最新进度。');
    throw Error(`音频上传失败（${res.status}），录音仍可试听。恢复连接后请再次提交。`);
  }
  if(!result||result.id!==draft.id)throw Error('上传结果尚未确认。请再次提交同一份录音。');
  return result.id;
}
