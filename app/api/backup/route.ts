import { prepareBackup,restoreBackup,sealDevice,verifyDevice,BackupError } from '@/lib/backup';
import { metadataLimit, type Header } from '@/lib/backup-format';
import { limitedBody } from '../shared';
import { withBackup } from './handler';
import { snapshotSchema } from '../state/transition';
export const dynamic='force-dynamic';
export function GET(request:Request){return withBackup(request,prepareBackup);}
export function POST(request:Request){
  return withBackup(request,async(db,bucket,uid,key)=>{
    if(request.headers.get('Content-Type')?.split(';')[0]!=='application/json')throw new BackupError(415,'备份清单格式无效。');
    const bytes=await limitedBody(request,metadataLimit);if(bytes instanceof Response)throw new BackupError(bytes.status,'备份清单过大或不完整。');
    let payload:Header & {action?:string};try{payload=JSON.parse(new TextDecoder().decode(bytes))}catch{throw new BackupError(400,'无法解析备份清单。')}
    if(!payload?.signed||!['check','restore','seal-device'].includes(payload.action||''))throw new BackupError(422,'备份操作无效。');
    if(payload.action==='seal-device')return {deviceSeal:await sealDevice(uid,key,payload.signed,payload.device)};
    await verifyDevice(uid,key,payload);
    if(payload.signed.manifest?.state!=null&&!snapshotSchema.safeParse(payload.signed.manifest.state).success)throw new BackupError(422,'备份中的学习进度与当前版本不兼容。');
    return restoreBackup(db,bucket,uid,key,payload.signed,payload.action==='restore');
  });
}
