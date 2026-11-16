import { archiveLimit,clipLimit,hash,headerBytes,metadataLimit,toHex,uuid, type CalibrationCandidateRow, type CalibrationEventRow, type CalibrationProfileRow, type Clip, type Data, type Manifest, type RemoteClip, type Signed, type Review,type Header,type SavedReviewJob } from './backup-format';

export class BackupError extends Error {
  status:number;
  constructor(status:number,message:string){super(message);this.status=status;}
}
const reject=(status:number,message:string):never=>{throw new BackupError(status,message)};
const utf8=new TextEncoder();
function canonical(v:unknown):string {
  if(!v||typeof v!=='object')return JSON.stringify(v);
  if(Array.isArray(v))return '['+v.map(canonical).join(',')+']';
  const obj=v as Record<string,unknown>;
  return '{'+Object.keys(obj).sort().map(k=>JSON.stringify(k)+':'+canonical(obj[k])).join(',')+'}';
}
async function sign(key:string,input:string){
  if(!/^[\da-f]{64}$/i.test(key))return reject(503,'备份服务密钥暂不可用。');
  const secret=await crypto.subtle.importKey('raw',Uint8Array.from(key.match(/../g)!,a=>parseInt(a,16)),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return toHex(await crypto.subtle.sign('HMAC',secret,utf8.encode(input)));
}
function equalSig(a:unknown,b:string) {
  if(typeof a!=='string'||a.length!==b.length)return false;
  let d=0;for(let i=0;i<b.length;i++)d|=a.charCodeAt(i)^b.charCodeAt(i);return d===0;
}
const ownerTag=(uid:string)=>hash(utf8.encode(uid));
const path=(uid:string,id:string)=>'speaking/'+encodeURIComponent(uid)+'/'+id;
type StoredClip=Clip&{meta?:Record<string,string>};
const ticket=(key:string,uid:string,c:StoredClip)=>sign(key,JSON.stringify(c.meta
  ?['clip',uid,c.id,c.size,c.type,c.hash,c.meta]
  :['clip',uid,c.id,c.size,c.type,c.hash]));
const recordSignature=(key:string,m:Manifest)=>sign(key,'manifest\n'+canonical(m));
function refs(state:Data['state'],reviewJobs:SavedReviewJob[]=[]){
  const cloud=new Set<string>(),device=new Set<string>();
  const add=(bag:Set<string>,id:unknown)=>{if(id===undefined)return;if(typeof id!=='string'||!uuid.test(id))reject(422,'学习记录含有无法识别的录音标识。');else bag.add(id)};
  for(const e of Object.values(state?.entries??{}) as Record<string,string>[]){
    for(const k of ['speakingPart2','speakingFollowup']){
      if(!e[k])continue;let candidates;
      try{candidates=JSON.parse(e[k])}catch{return reject(422,'口语作答索引损坏。')}
      if(!Array.isArray(candidates))return reject(422,'口语作答索引损坏。');
      for(const a of candidates){add(cloud,a.audio);add(device,a.local)}
    }
  }
  for(const t of (state?.fullTests||[]) as {audio?:string}[])add(cloud,t.audio);
  for(const job of reviewJobs)add(cloud,job.snapshot.attempt.recordingId);
  return {cloud:[...cloud].sort(),device:[...device].sort()};
}
async function snapshot(db:D1Database,uid:string):Promise<Data>{
  const [states,feedback,lessons,jobs,profile,candidates,events]=await db.batch([
    db.prepare('SELECT revision,state FROM learner_states WHERE user_id=?').bind(uid),
    db.prepare('SELECT id,day,stage,attempt,evidence,feedback,created_at AS createdAt,pronunciation,analysis_json AS analysisJson FROM teacher_feedback WHERE user_id=? ORDER BY id').bind(uid),
    db.prepare('SELECT day,lesson FROM teacher_lessons WHERE user_id=? ORDER BY day').bind(uid),
    db.prepare(`SELECT id,day,submission_key AS submissionKey,request_hash AS requestHash,revision,snapshot,created_at AS createdAt
      FROM review_jobs WHERE user_id=? ORDER BY id`).bind(uid),
    // Format 4 (FIX-16): calibration rows are part of the owner's backup.
    db.prepare(`SELECT expected,actual,n_confirmed AS nConfirmed,n_rejected AS nRejected,n_unsure AS nUnsure,
      n_shown AS nShown,state,rule_version AS ruleVersion,detector_version AS detectorVersion,
      inventory_version AS inventoryVersion,updated_at AS updatedAt
      FROM personal_calibration WHERE user_id=? ORDER BY expected,actual`).bind(uid),
    db.prepare(`SELECT candidate_id AS candidateId,attempt_id AS attemptId,recording_id AS recordingId,word,
      expected,actual,at_ms AS atMs,detector_confidence AS detectorConfidence,shown_at AS shownAt,answered_at AS answeredAt
      FROM calibration_candidates WHERE user_id=? ORDER BY shown_at,candidate_id`).bind(uid),
    db.prepare(`SELECT attempt_id AS attemptId,candidate_id AS candidateId,expected,actual,verdict,
      is_catch_trial AS isCatchTrial,created_at AS createdAt
      FROM calibration_events WHERE user_id=? ORDER BY created_at,candidate_id`).bind(uid)
  ]);
  const state=states.results[0] as {revision:number;state:string}|undefined;
  const reviewJobs=(jobs.results as (Omit<SavedReviewJob,'snapshot'>&{snapshot:string})[])
    .map(({snapshot,...job})=>({...job,snapshot:JSON.parse(snapshot) as SavedReviewJob['snapshot']}));
  const feedbackRows=feedback.results as (Omit<Review,'analysis'> & {pronunciation:string|null;analysisJson:string|null})[];
  const savedFeedback=feedbackRows.map(({pronunciation,analysisJson,...row})=>{
    const base:Review=pronunciation?{...row,pronunciation:JSON.parse(pronunciation)}:row;
    if(!analysisJson)return base;
    try{return {...base,analysis:JSON.parse(analysisJson) as unknown};}
    catch{return base;}
  });
  return {...(reviewJobs.length?{reviewJobs}:{}),state:state?JSON.parse(String(state.state)):null,revision:Number(state?.revision||0),
    feedback:savedFeedback,lessons:(lessons.results as {day:number;lesson:string}[]).map(r=>({day:Number(r.day),lesson:JSON.parse(String(r.lesson))})),
    personalCalibration:(profile.results as CalibrationProfileRow[]).map(row=>({...row,
      nConfirmed:Number(row.nConfirmed),nRejected:Number(row.nRejected),nUnsure:Number(row.nUnsure),
      nShown:Number(row.nShown),updatedAt:Number(row.updatedAt)})),
    calibrationCandidates:(candidates.results as CalibrationCandidateRow[]).map(row=>({...row,
      atMs:Number(row.atMs),detectorConfidence:Number(row.detectorConfidence),shownAt:Number(row.shownAt),
      answeredAt:row.answeredAt==null?null:Number(row.answeredAt)})),
    calibrationEvents:(events.results as CalibrationEventRow[]).map(row=>({...row,
      isCatchTrial:Boolean(row.isCatchTrial),createdAt:Number(row.createdAt)}))};
}
async function inspect(bucket:R2Bucket,uid:string,id:string):Promise<StoredClip|null>{
  const obj=await bucket.get(path(uid,id));if(!obj)return null;
  if(obj.size<=0||obj.size>clipLimit){await obj.body.cancel();return reject(422,'录音超出支持的大小。');}
  const type=obj.httpMetadata?.contentType?.split(';')[0].toLowerCase()||'';
  if(!/^audio\/[\w.+-]+$/.test(type)){await obj.body.cancel();return reject(422,'录音缺少可识别的音频类型。');}
  const meta:Record<string,string>={};
  for(const name of ['purpose','day','phase','digest']){
    const value=obj.customMetadata?.[name];
    if(typeof value==='string'&&value)meta[name]=value;
  }
  return {id,type,size:obj.size,hash:await hash(await obj.arrayBuffer()),...(Object.keys(meta).length?{meta}:{})};
}
export async function exportBackup(db:D1Database,bucket:R2Bucket,uid:string,key:string,created=new Date().toISOString()):Promise<Signed>{
  const data=await snapshot(db,uid),ids=refs(data.state,data.reviewJobs),audio:RemoteClip[]=[];
  let bytes=0;
  for(const id of ids.cloud){
    const c=await inspect(bucket,uid,id);if(!c)return reject(409,'发现缺失的云端录音，无法导出完整备份。');
    bytes+=c.size;if(bytes>archiveLimit)return reject(413,'云端录音超过单份备份的 512 MiB 上限。');
    audio.push({...c,ticket:await ticket(key,uid,c)});
  }
  const hasEvidence=data.feedback.some(row=>row.analysis!==undefined)||audio.some(clip=>clip.meta!==undefined);
  const reviewJobs=data.reviewJobs??[];
  const {personalCalibration:profile=[],calibrationCandidates:candidates=[],calibrationEvents:events=[],reviewJobs:_reviewJobs,...base}=data;
  void _reviewJobs; // removed from `base`; re-added only when format > 1
  // Format 4 is emitted whenever any calibration row exists, so an older reader
  // fails closed on the unknown format instead of silently dropping the profile.
  // Empty calibration data keeps the highest legacy format for compatibility.
  const hasCalibration=profile.length>0||candidates.length>0||events.length>0;
  const format=hasCalibration?4:(hasEvidence?3:(reviewJobs.length?2:1));
  const analysisBytes=data.feedback.reduce((total,row)=>total+
    (row.analysis===undefined?0:utf8.encode(JSON.stringify(row.analysis)).length),0);
  if(analysisBytes>4*1024*1024)return reject(413,'纠音证据超过单份备份的 4 MiB 上限，无法安全导出。');
  const manifest:Manifest={format,owner:await ownerTag(uid),created,...base,...(format>1?{reviewJobs}:{}),
    ...(format>=4?{personalCalibration:profile,calibrationCandidates:candidates,calibrationEvents:events}:{}),
    audio,local:ids.device};
  if(utf8.encode(JSON.stringify(manifest)).length>metadataLimit-1024)return reject(413,'课程记录超出单份备份的 8 MiB 上限。');
  return {manifest,signature:await recordSignature(key,manifest)};
}
const receiptLifetime=15*60*1000;
const downloadMac=(key:string,uid:string,stamp:string,digest:string)=>sign(key,JSON.stringify(['download',uid,stamp,digest]));
export async function prepareBackup(db:D1Database,bucket:R2Bucket,uid:string,key:string){
  const signed=await exportBackup(db,bucket,uid,key);
  if(signed.manifest.local.length)return signed;
  const stamp=String(Date.parse(signed.manifest.created));
  return {...signed,downloadReceipt:[stamp,signed.signature,await downloadMac(key,uid,stamp,signed.signature)].join('.')};
}
export async function downloadBackup(db:D1Database,bucket:R2Bucket,uid:string,key:string,receipt:string,now=Date.now()){
  const match=/^(\d{13})\.([a-f0-9]{64})\.([a-f0-9]{64})$/.exec(receipt);
  if(!match||!equalSig(match[3],await downloadMac(key,uid,match[1],match[2])))return reject(403,'下载凭据无效或账号已变更。');
  const stamp=Number(match[1]);
  if(stamp>now||now-stamp>receiptLifetime)return reject(410,'下载链接已到期，请重新准备备份。');
  const signed=await exportBackup(db,bucket,uid,key,new Date(stamp).toISOString());
  if(signed.manifest.local.length||!equalSig(signed.signature,match[2]))return reject(409,'记录已变化，请重新准备备份。');
  const prefix=headerBytes({signed,device:[]});
  const total=prefix.reduce((n,b)=>n+b.length,0)+signed.manifest.audio.reduce((n,c)=>n+c.size,0);
  if(total>archiveLimit)return reject(413,'备份超出 512 MiB 上限。');
  let cursor=-1;
  const body=new ReadableStream<Uint8Array>({async pull(controller){
    if(cursor===-1){cursor=0;for(const bytes of prefix)controller.enqueue(bytes);return;}
    if(cursor===signed.manifest.audio.length){controller.close();return;}
    const c=signed.manifest.audio[cursor++],file=await bucket.get(path(uid,c.id));
    if(!file||file.size!==c.size){if(file)await file.body.cancel();throw Error('Recording changed during download');}
    const bytes=new Uint8Array(await file.arrayBuffer());
    if(await hash(bytes)!==c.hash)throw Error('Recording changed during download');
    controller.enqueue(bytes);
  }});
  return new Response(body,{headers:{'Content-Type':'application/octet-stream','X-Content-Type-Options':'nosniff',
    'Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','Content-Length':String(total),
    'Content-Disposition':'attachment; filename="Bandroom-'+signed.manifest.created.slice(0,10)+'.bandroom"'}});
}
async function authentic(uid:string,key:string,signed:Signed){
  const m=signed?.manifest;
  if(!m||![1,2,3,4].includes(m.format)||(m.format>=2&&!Array.isArray(m.reviewJobs))||
    (m.format>=4&&(!Array.isArray(m.personalCalibration)||!Array.isArray(m.calibrationCandidates)||!Array.isArray(m.calibrationEvents)))||
    !Array.isArray(m.audio)||!Array.isArray(m.feedback)||!Array.isArray(m.lessons)||!Array.isArray(m.local))return reject(422,'备份格式无效。');
  if(m.owner!==await ownerTag(uid))return reject(403,'此备份属于其他账号或站点。');
  if(!equalSig(signed.signature,await recordSignature(key,m)))return reject(422,'备份签名无效或内容已被修改。');
  return m;
}
export async function sealDevice(uid:string,key:string,signed:Signed,device:Clip[]){
  const m=await authentic(uid,key,signed);
  if(!Array.isArray(device)||device.length!==m.local.length||device.some((c,i)=>!c||c.id!==m.local[i]||
    !Number.isSafeInteger(c.size)||c.size<1||c.size>clipLimit||!/^audio\/[\w.+-]+$/.test(c.type)||!/^([a-f0-9]{64})$/.test(c.hash)))
    return reject(422,'本机录音清单与备份不匹配。');
  return sign(key,canonical(['device',uid,signed.signature,device]));
}
export async function verifyDevice(uid:string,key:string,header:Header){
  if(!header?.signed?.manifest?.local?.length&&!header?.device?.length)return;
  if(!equalSig(header.deviceSeal,await sealDevice(uid,key,header.signed,header.device)))reject(422,'本机录音签名无效，已停止恢复。');
}
function compareRows<T,K>(present:T[],archived:T[],id:(v:T)=>K){
  const saved=new Map(archived.map(v=>[id(v),v]));
  for(const row of present){
    if(canonical(saved.get(id(row)))!==canonical(row))return reject(409,'当前存在备份中没有的记录或不同版本，已停止恢复。');
    saved.delete(id(row));
  }
  return [...saved.values()];
}
export async function restoreAudio(bucket:R2Bucket,uid:string,key:string,c:RemoteClip,bytes:Uint8Array<ArrayBuffer>){
  if(!c||!uuid.test(c.id)||!Number.isSafeInteger(c.size)||c.size<1||c.size>clipLimit||bytes.length!==c.size||
    !equalSig(c.ticket,await ticket(key,uid,c))||await hash(bytes)!==c.hash)return reject(422,'录音凭据或校验值无效。');
  if(c.meta?.digest&&c.meta.digest!==c.hash)return reject(422,'录音摘要与备份元数据不一致。');
  const current=await inspect(bucket,uid,c.id);
  if(current){
    if(current.type!==c.type||current.hash!==c.hash||current.size!==c.size)
      return reject(409,'相同录音标识下存在其他内容，已停止恢复。');
    if(canonical(current.meta??{})!==canonical(c.meta??{})){
      const updated=await bucket.put(path(uid,c.id),bytes,{httpMetadata:{contentType:c.type},
        sha256:c.hash,...(c.meta?{customMetadata:c.meta}:{})});
      if(!updated)return reject(503,'录音元数据暂时无法写回。');
    }
    return;
  }
  const existing=await bucket.put(path(uid,c.id),bytes,{onlyIf:{etagDoesNotMatch:'*'},httpMetadata:{contentType:c.type},
    sha256:c.hash,...(c.meta?{customMetadata:c.meta}:{})});
  if(!existing){const raced=await inspect(bucket,uid,c.id);
    if(raced?.type!==c.type||raced.hash!==c.hash||canonical(raced?.meta??{})!==canonical(c.meta??{}))
      return reject(409,'相同录音标识下存在其他内容，已停止恢复。');}
}
export async function restoreBackup(db:D1Database,bucket:R2Bucket,uid:string,key:string,signed:Signed,apply:boolean){
  const m=await authentic(uid,key,signed),data=await snapshot(db,uid);
  if(data.state&&(!m.state||canonical(data.state)!==canonical(m.state)))return reject(409,'当前学习进度与备份不同，已停止恢复。');
  // Format 1/2 backups predate acoustic evidence; ignore analysis fields when
  // comparing them against current rows so old backups remain restorable.
  const withoutAnalysis=(rows:Review[])=>rows.map(row=>{const copy:Review={...row};delete copy.analysis;return copy;});
  const feedback=compareRows(m.format<3?withoutAnalysis(data.feedback):data.feedback,
    m.format<3?withoutAnalysis(m.feedback):m.feedback,x=>x.id);
  const lessons=compareRows(data.lessons,m.lessons,x=>x.day);
  const reviewJobs=compareRows(data.reviewJobs??[],m.reviewJobs??[],x=>x.id);
  // Format <4 has no calibration section. If the current database already has
  // calibration rows, such a backup cannot restore cleanly: the extra rows are
  // not in the archive, and silently deleting them would lose confirmations.
  const profile=compareRows(data.personalCalibration??[],m.personalCalibration??[],
    x=>`${x.expected}\u0000${x.actual}`);
  const candidates=compareRows(data.calibrationCandidates??[],m.calibrationCandidates??[],x=>x.candidateId);
  const events=compareRows(data.calibrationEvents??[],m.calibrationEvents??[],
    x=>`${x.attemptId}\u0000${x.candidateId}`);
  const missing:string[]=[];
  for(const c of m.audio){
    const found=await inspect(bucket,uid,c.id);
    if(!found)missing.push(c.id);
    else if(c.hash!==found.hash||c.type!==found.type||c.size!==found.size)
      return reject(409,'云端已有同标识的不同录音，已停止恢复。');
    else if(canonical(found.meta??{})!==canonical(c.meta??{}))
      // Same bytes but the private metadata differs: re-put the clip so the
      // restored recording keeps its purpose/day/phase/digest binding.
      missing.push(c.id);
  }
  const stateToAdd=!data.state&&!!m.state;
  const result={missing,stateToAdd,lessons:lessons.length,feedback:feedback.length,reviewJobs:reviewJobs.length,
    personalCalibration:profile.length,calibrationCandidates:candidates.length,calibrationEvents:events.length};
  if(!apply)return result;
  if(missing.length)return reject(409,'录音尚未全部通过校验，课程记录尚未恢复。');
  // The read snapshot includes append-only coach tables. Recheck counts/revision in the same transaction as every insert.
  const commands=[db.prepare(`SELECT json(CASE WHEN
    COALESCE((SELECT revision FROM learner_states WHERE user_id=?),0)=? AND
    (SELECT COUNT(*) FROM teacher_lessons WHERE user_id=?)=? AND
    (SELECT COUNT(*) FROM teacher_feedback WHERE user_id=?)=? AND
    (SELECT COUNT(*) FROM review_jobs WHERE user_id=?)=? AND
    (SELECT COUNT(*) FROM personal_calibration WHERE user_id=?)=? AND
    (SELECT COUNT(*) FROM calibration_candidates WHERE user_id=?)=? AND
    (SELECT COUNT(*) FROM calibration_events WHERE user_id=?)=? THEN 'true' ELSE 'conflict' END)`)
    .bind(uid,data.revision,uid,data.lessons.length,uid,data.feedback.length,uid,data.reviewJobs?.length??0,
      uid,data.personalCalibration?.length??0,uid,data.calibrationCandidates?.length??0,uid,data.calibrationEvents?.length??0)];
  if(stateToAdd)commands.push(db.prepare('INSERT INTO learner_states(user_id,revision,state) VALUES(?,?,?)').bind(uid,m.revision+1,JSON.stringify(m.state)));
  function batches<T>(rows:T[],query:string){
    for(let i=0;i<rows.length;i+=35)commands.push(db.prepare(query).bind(uid,JSON.stringify(rows.slice(i,i+35))));
  }
  batches(lessons,"INSERT INTO teacher_lessons(user_id,day,lesson) SELECT ?,value->>'$.day',value->'$.lesson' FROM json_each(?)");
  batches(feedback,`INSERT INTO teacher_feedback(user_id,id,day,stage,attempt,evidence,feedback,created_at,pronunciation,analysis_json)
    SELECT ?,value->>'$.id',value->>'$.day',value->>'$.stage',value->>'$.attempt',value->>'$.evidence',value->>'$.feedback',value->>'$.createdAt',value->'$.pronunciation',value->'$.analysis' FROM json_each(?)`);
  batches(reviewJobs,`INSERT INTO review_jobs(user_id,id,day,submission_key,request_hash,revision,snapshot,created_at)
    SELECT ?,value->>'$.id',value->>'$.day',value->>'$.submissionKey',value->>'$.requestHash',
      value->>'$.revision',value->'$.snapshot',value->>'$.createdAt' FROM json_each(?)`);
  batches(profile,`INSERT INTO personal_calibration(user_id,expected,actual,n_confirmed,n_rejected,n_unsure,n_shown,
      state,rule_version,detector_version,inventory_version,updated_at)
    SELECT ?,value->>'$.expected',value->>'$.actual',value->>'$.nConfirmed',value->>'$.nRejected',
      value->>'$.nUnsure',value->>'$.nShown',value->>'$.state',value->>'$.ruleVersion',
      value->>'$.detectorVersion',value->>'$.inventoryVersion',value->>'$.updatedAt' FROM json_each(?)`);
  batches(candidates,`INSERT INTO calibration_candidates(candidate_id,user_id,attempt_id,recording_id,word,
      expected,actual,at_ms,detector_confidence,shown_at,answered_at)
    SELECT value->>'$.candidateId',?,value->>'$.attemptId',value->>'$.recordingId',value->>'$.word',
      value->>'$.expected',value->>'$.actual',value->>'$.atMs',value->>'$.detectorConfidence',
      value->>'$.shownAt',value->>'$.answeredAt' FROM json_each(?)`);
  batches(events,`INSERT INTO calibration_events(user_id,attempt_id,candidate_id,expected,actual,verdict,
      is_catch_trial,created_at)
    SELECT ?,value->>'$.attemptId',value->>'$.candidateId',value->>'$.expected',value->>'$.actual',
      value->>'$.verdict',CASE WHEN value->>'$.isCatchTrial' IN ('1','true') THEN 1 ELSE 0 END,
      value->>'$.createdAt' FROM json_each(?)`);
  try {await db.batch(commands);}catch(e){
    if(/malformed JSON|UNIQUE constraint/i.test(String(e)+' '+String((e as Error).cause)))return reject(409,'记录在恢复过程中发生变化。请重新核对备份。');
    throw e;
  }
  return result;
}
