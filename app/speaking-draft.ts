export type QuestionPhase = 'part2' | 'followup';
export type Answer = { at:string; text:string; spoken:boolean; audio?:string; local?:string };
export type RecordingDraft = { id:string; at:string; blob?:Blob; audio?:string };

// Some embedded browsers expose getRandomValues but not randomUUID.
export function newRecordingId():string {
  if(typeof crypto.randomUUID==='function')return crypto.randomUUID();
  const bytes=crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;
  bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

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
    const open=indexedDB.open('ielts-speaking-audio',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('clips');
    open.onerror=()=>reject(open.error);
    open.onsuccess=()=>{
      const db=open.result,tx=db.transaction('clips',change?'readwrite':'readonly'),store=tx.objectStore('clips');
      const read=store.get(key);
      let value:RecordingDraft|undefined;
      read.onsuccess=()=>{
        value=read.result as RecordingDraft|undefined;
        if(!change)return;
        const next=change(value);
        if(next!==value){if(next===undefined)store.delete(key);else store.put(next,key);}
        value=next;
      };
      tx.oncomplete=()=>{db.close();resolve(value)};
      tx.onabort=tx.onerror=()=>{db.close();reject(tx.error)};
    };
  });
}
export function discardIfMatch(id:string){return (current:RecordingDraft|undefined)=>current?.id===id?undefined:current;}

export async function uploadDraft(draft:RecordingDraft,account:string,day:number,phase:QuestionPhase):Promise<string> {
  if(draft.audio)return draft.audio;
  if(!draft.blob)throw Error('找不到可提交的录音，请重新打开本题草稿。');
  const res=await fetch('/api/audio',{method:'POST',redirect:'manual',headers:{
    'Content-Type':draft.blob.type||'audio/webm','X-Bandroom-Account':account,
    'X-Bandroom-Day':String(day),'X-Bandroom-Phase':phase,'X-Bandroom-Attempt':draft.id
  },body:draft.blob});
  if(!res.ok){
    if(res.status===401||res.status===403||res.status===428||res.type==='opaqueredirect')
      throw Error('请重新登录本账号，再提交本题录音。');
    if(res.status===413||res.status===415)throw Error('服务器未能接收这段音频。请下载保留原件。');
    throw Error('上传失败，录音仍可试听。恢复连接后请再次提交。');
  }
  const result=await res.json() as {id?:string};
  if(typeof result.id!=='string'||!result.id)throw Error('上传结果尚未确认。请再次提交同一份录音。');
  return result.id;
}
