'use client';
import { useState, useRef, useEffect } from 'react';
import { checkBlob, clipLimit, hash, pack, unpack,type Signed,type Clip,type Header } from '@/lib/backup-format';

type Plan={missing:string[];stateToAdd:boolean;lessons:number;feedback:number;reviewJobs:number};
type Ready={file:Awaited<ReturnType<typeof unpack>>;plan:Plan};
async function checked(response:Response){
  if(!response.ok){const error=await response.json().catch(()=>null) as {error?:string}|null;throw Error(error?.error||'请求失败，请确认登录与网络。');}
  return response;
}
async function plan(account:string,header:Header,action:'check'|'restore'){
  const r=await checked(await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json','X-Bandroom-Account':account},body:JSON.stringify({action,...header})}));
  return await r.json() as Plan;
}
async function deviceClip(id:string,blob?:Blob):Promise<Blob|undefined>{
  return new Promise((resolve,reject)=>{
    const open=indexedDB.open('ielts-speaking-audio',1);
    open.onupgradeneeded=()=>open.result.createObjectStore('clips');open.onerror=()=>reject(Error('本机录音存储不可用。'));
    open.onsuccess=()=>{const db=open.result,tx=db.transaction('clips',blob?'readwrite':'readonly'),store=tx.objectStore('clips');
      const request=blob?store.add(blob,id):store.get(id);
      tx.oncomplete=()=>{db.close();resolve(blob||request.result as Blob|undefined)};
      tx.onabort=tx.onerror=()=>{db.close();reject(Error('本机录音写入失败，请检查设备空间后重试。'))};
    };
  });
}
type BackupProps={account:string;onRestored:()=>void|Promise<void>};
export default function BackupPanel(props:BackupProps){return <AccountBackup key={props.account} {...props}/>;}
function AccountBackup({account,onRestored}:BackupProps){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[archive,setArchive]=useState<File|null>(null),
    [ready,setReady]=useState<Ready|null>(null),[consent,setConsent]=useState(false);
  const [downloadLink,setDownloadLink]=useState<{url:string;name:string}|null>(null);
  const lock=useRef(false),mounted=useRef(false),objectUrl=useRef('');
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);objectUrl.current=''}},[]);
  async function run(op:()=>Promise<void>){if(lock.current)return;lock.current=true;setBusy(true);setMessage('');
    try{await op()}catch(e){setMessage(e instanceof Error?e.message:'备份操作失败，请重试。')}finally{lock.current=false;setBusy(false)}}
  async function download(){
    setMessage('正在核对课程记录与录音…');
    const signed=await (await checked(await fetch('/api/backup',{cache:'no-store',headers:{'X-Bandroom-Account':account}}) )).json() as Signed & {downloadReceipt?:string};
    const name='Bandroom-'+signed.manifest.created.slice(0,10)+'.bandroom';
    if(!signed.manifest.local.length&&signed.downloadReceipt){
      if(!mounted.current)return;
      if(objectUrl.current){URL.revokeObjectURL(objectUrl.current);objectUrl.current='';}
      setDownloadLink({url:'/api/backup/download?receipt='+encodeURIComponent(signed.downloadReceipt),name});
      setMessage('已准备好 '+signed.manifest.audio.length+' 段录音及课程记录。请在 15 分钟内点击「下载备份文件」保存。');return;
    }
    const recordings:Blob[]=[],device:Clip[]=[];
    for(const c of signed.manifest.audio){
      const blob=await (await checked(await fetch('/api/audio?id='+encodeURIComponent(c.id),{cache:'no-store',headers:{'X-Bandroom-Account':account}}))).blob();
      await checkBlob(blob,c);recordings.push(blob);
    }
    for(const id of signed.manifest.local){
      const blob=await deviceClip(id);if(!blob)throw Error('有录音仅保存在其他设备。请使用原来的浏览器导出完整备份。');
      if(blob.size>clipLimit)throw Error('本机录音超出每段 12 MiB 上限。');
      device.push({id,type:blob.type.split(';')[0],size:blob.size,hash:await hash(await blob.arrayBuffer())});recordings.push(blob);
    }
    const header:Header={signed,device};
    if(device.length){const r=await checked(await fetch('/api/backup',{method:'POST',headers:{'Content-Type':'application/json','X-Bandroom-Account':account},body:JSON.stringify({action:'seal-device',...header})}));header.deviceSeal=(await r.json() as {deviceSeal:string}).deviceSeal;}
    if(!mounted.current)return;
    const url=URL.createObjectURL(pack(header,recordings));
    if(objectUrl.current)URL.revokeObjectURL(objectUrl.current);
    objectUrl.current=url;setDownloadLink({url,name});
    setMessage('已准备好 '+recordings.length+' 段录音及课程记录。点击「下载备份文件」保存。');
  }
  async function verify(){
    if(!archive)return;setMessage('正在逐段校验并比对云端记录…');const file=await unpack(archive);
    const info=await plan(account,file.header,'check');
    for(const c of file.header.device){const local=await deviceClip(c.id);if(local)await checkBlob(local,c);}
    setReady({file,plan:info});setConsent(false);setMessage('文件和账号校验通过。');
  }
  async function restore(){
    if(!ready||!consent)return;const {file}=ready,{signed,device}=file.header;
    const info=await plan(account,file.header,'check');for(const [i,c] of signed.manifest.audio.entries()){
      if(info.missing.includes(c.id))await checked(await fetch('/api/backup/audio',{method:'POST',headers:{'Content-Type':c.type,'X-Bandroom-Account':account,'X-Bandroom-Clip':JSON.stringify(c)},body:file.blobs[i]}));
    }
    // Device-only clips stay local. Never replace a different clip with the same ID.
    for(const [i,c] of device.entries()){
      const present=await deviceClip(c.id);if(present)await checkBlob(present,c);else await deviceClip(c.id,file.blobs[signed.manifest.audio.length+i]);
    }
    await plan(account,file.header,'restore');await onRestored();setReady(null);setConsent(false);setMessage('恢复完成。云端记录与录音已核对。');
  }
  return <details className="card pad"><summary>备份与恢复</summary>
    <p>下载本账号的学习进度、评估、课包、教练反馈和已提交录音。文件含有私人作答和原声，请保存在可信位置。</p>
    <button className="secondary" disabled={!account||busy} onClick={()=>void run(download)}>准备完整备份</button>
    {downloadLink&&<a className="primary" href={downloadLink.url} download={downloadLink.name}>下载备份文件</a>}
    <label className="packet-label">选择 .bandroom 备份文件<input type="file" accept=".bandroom,application/octet-stream" disabled={busy} onChange={e=>{setArchive(e.target.files?.[0]||null);setReady(null);setConsent(false);setMessage('')}}/></label>
    <button className="secondary" disabled={!account||!archive||busy} onClick={()=>void run(verify)}>校验并预览恢复</button>
    {ready&&<div className="notice"><p>可补回 {ready.plan.stateToAdd?1:0} 份学习进度、{ready.plan.feedback} 条评语、{ready.plan.lessons} 个课包、{ready.plan.reviewJobs??0} 份独立作答及 {ready.plan.missing.length} 段云端录音。本机录音 {ready.file.header.device.length} 段。</p>
      <p>只补入同账号缺失的数据。当前记录与备份存在差异时，恢复会停止。</p>
      <label><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/> 确认补回上述内容</label>
      <button className="primary" disabled={!consent||busy} onClick={()=>void run(restore)}>恢复已核验备份</button></div>}
    <p role="status" aria-live="polite">{message}</p>
    <small className="muted">单份上限 512 MiB，含最多 8 MiB 的课程记录，每段录音最多 12 MiB。单设备录音需在保存它们的浏览器导出。</small>
  </details>;
}
