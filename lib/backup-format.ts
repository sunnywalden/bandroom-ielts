export const metadataLimit = 8 * 1024 * 1024;
export const clipLimit = 12 * 1024 * 1024;
export const archiveLimit = 512 * 1024 * 1024;
export const uuid = /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
export type Clip = {id:string;size:number;type:string;hash:string};
export type RemoteClip = Clip & {ticket:string};
export type Review = {id:string;day:number;stage:string;attempt:string;evidence:string;feedback:string;createdAt:string;pronunciation?:unknown};
export type Course = {day:number;lesson:unknown};
export type Data = {state:Record<string,unknown>|null;revision:number;feedback:Review[];lessons:Course[]};
export type Manifest = Data & {format:1;owner:string;created:string;audio:RemoteClip[];local:string[]};
export type Signed = {manifest:Manifest;signature:string};
export type Header = {signed:Signed;device:Clip[];deviceSeal?:string};
const encoder=new TextEncoder();
const magic=encoder.encode('BANDROOM1\n');
export const toHex=(data:ArrayBuffer)=>Array.from(new Uint8Array(data),n=>n.toString(16).padStart(2,'0')).join('');
export const hash=async(data:ArrayBuffer|Uint8Array<ArrayBuffer>)=>toHex(await crypto.subtle.digest('SHA-256',data));
export async function checkBlob(blob:Blob, clip:Clip) {
  if(blob.size!==clip.size||await hash(await blob.arrayBuffer())!==clip.hash) throw Error('录音校验失败，请重新选择完整的备份。');
}
export function headerBytes(header:Header) {
  const data=encoder.encode(JSON.stringify(header));
  if(data.byteLength>metadataLimit) throw Error('课程记录超出单份备份的 8 MiB 上限。');
  const length=new Uint8Array(4);new DataView(length.buffer).setUint32(0,data.length);
  return [magic,length,data];
}
export function pack(header:Header, recordings:Blob[]) {
  const file=new Blob([...headerBytes(header),...recordings],{type:'application/octet-stream'});
  if(file.size>archiveLimit)throw Error('备份超出 512 MiB 上限。');
  return file;
}
export async function unpack(file:Blob) {
  if(file.size>archiveLimit)throw Error('该文件超过 512 MiB 上限。');
  const start=magic.length+4, prefix=new Uint8Array(await file.slice(0,start).arrayBuffer());
  if(prefix.length!==start||!magic.every((x,i)=>x===prefix[i])) throw Error('文件不是 Bandroom 备份。');
  const length=new DataView(prefix.buffer).getUint32(magic.length);
  if(!length||length>metadataLimit||start+length>file.size) throw Error('备份头部损坏。');
  const header=JSON.parse(await file.slice(start,start+length).text()) as Header;
  const m=header.signed?.manifest, media=m?.audio;
  if(m?.format!==1||!Array.isArray(media)||!Array.isArray(m.local)||!Array.isArray(header.device)||
    header.device.length!==m.local.length||header.device.some((c,i)=>c.id!==m.local[i]))throw Error('备份录音索引损坏。');
  let offset=start+length;
  const result:Blob[]=[];
  for(const c of [...media,...header.device]){
    if(!uuid.test(c.id)||!Number.isSafeInteger(c.size)||c.size<=0||c.size>clipLimit||!/^audio\/[\w.+-]+$/.test(c.type)||!/^\w{64}$/.test(c.hash))throw Error('备份录音信息无效。');
    const blob=file.slice(offset,offset+c.size,c.type);offset+=c.size;
    await checkBlob(blob,c);result.push(blob);
  }
  if(offset!==file.size)throw Error('备份文件不完整或含有多余内容。');
  return {header,blobs:result};
}
