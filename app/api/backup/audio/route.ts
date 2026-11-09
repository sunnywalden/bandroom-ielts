import { BackupError,restoreAudio } from '@/lib/backup';
import { clipLimit,type RemoteClip } from '@/lib/backup-format';
import { limitedBody } from '../../shared';
import { withBackup } from '../handler';
export const dynamic='force-dynamic';
export function POST(request:Request){
  return withBackup(request,async(_db,bucket,uid,key)=>{
    let clip:RemoteClip;try{clip=JSON.parse(request.headers.get('X-Bandroom-Clip')||'null')}catch{throw new BackupError(422,'录音凭据格式无效。')}
    const bytes=await limitedBody(request,clipLimit);if(bytes instanceof Response)throw new BackupError(bytes.status,'录音超过 12 MiB 或读取失败。');
    await restoreAudio(bucket,uid,key,clip,bytes);return {saved:true};
  });
}
