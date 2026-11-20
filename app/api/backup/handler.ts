import { env } from 'cloudflare:workers';
import { requireUserScope } from '@/lib/route-guard';
import { BackupError } from '@/lib/backup';
import { crossOrigin,json } from '../shared';
export async function withBackup(request:Request, operation:(db:D1Database,bucket:R2Bucket,uid:string,key:string)=>Promise<unknown>,accountBinding:'header'|'signed-download'='header'){
  const auth=await requireUserScope({write:request.method!=='GET'});
  if(auth instanceof Response)return auth;
  const user=auth.user;
  if(accountBinding==='header'&&request.headers.get('X-Bandroom-Account')!==user.userId)return json({error:'登录账号已变更，请刷新页面后重试。'},428);
  if(crossOrigin(request))return json({error:'请求来源无效。'},403);
  const key=(env as typeof env & {BANDROOM_BACKUP_KEY?:string}).BANDROOM_BACKUP_KEY;
  if(!env.DB||!env.BUCKET||!key||!/^[a-f0-9]{64}$/i.test(key))return json({error:'备份服务暂未配置。'},503);
  try{const value=await operation(env.DB,env.BUCKET,user.userId,key);return value instanceof Response?value:json(value);}
  catch(e){if(e instanceof BackupError)return json({error:e.message},e.status);return json({error:'备份服务暂不可用，请稍后重试。'},503);}
}
