import {downloadBackup} from '@/lib/backup';
import {withBackup} from '../handler';
export const dynamic='force-dynamic';
export function GET(request:Request){
  const receipt=new URL(request.url).searchParams.get('receipt')||'';
  return withBackup(request,(db,bucket,uid,key)=>downloadBackup(db,bucket,uid,key,receipt),'signed-download');
}
