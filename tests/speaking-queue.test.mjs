// Durable upload queue: dedupe, backoff, crash recovery and account scoping.
// Uses fake-indexeddb so each test starts from empty browser storage.
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {IDBFactory} from 'fake-indexeddb';

const {queueKey,backoffMs,queueRecording,retryPending,pendingCount,queuedAudio,discardQueued,clearUploadQueue,isQueueStorageError}=
  await import('../app/speaking-queue.ts');

const bytes=(seed=1)=>new Blob([new Uint8Array([seed,seed+1,seed+2,seed+3])],{type:'audio/webm'});
const draft=(seed=1,id='draft-a')=>({id,at:new Date('2026-11-22T09:00:00.000Z').toISOString(),blob:bytes(seed)});

async function rawTasks() {
  const db=await new Promise((resolve,reject)=>{
    const open=indexedDB.open('ielts-speaking-uploads',1);
    open.onsuccess=()=>resolve(open.result);open.onerror=()=>reject(open.error);
  });
  const rows=await new Promise((resolve,reject)=>{
    const request=db.transaction('tasks').objectStore('tasks').getAll();
    request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);
  });
  db.close();
  return rows;
}

beforeEach(()=>{Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:new IDBFactory()});});

test('the same bytes upload once and later calls return the stored id',async()=>{
  let uploads=0;
  const upload=async call=>{uploads++;return `server-${call.id}`};
  const first=await queueRecording(draft(),'student',12,'part1',upload);
  assert.equal(first,'server-draft-a');
  assert.equal(uploads,1);
  assert.equal(await pendingCount('student'),0);
  assert.equal(await queuedAudio('student',12,'part1',bytes()),'server-draft-a');
  // Same content, different local id: reuse the confirmed server id.
  const again=await queueRecording(draft(1,'draft-b'),'student',12,'part1',upload);
  assert.equal(again,'server-draft-a');
  assert.equal(uploads,1);
  // Concurrent callers join the same in-flight upload.
  uploads=0;
  const [left,right]=await Promise.all([
    queueRecording(draft(9,'draft-c'),'student',12,'part2',upload),
    queueRecording(draft(9,'draft-c'),'student',12,'part2',upload),
  ]);
  assert.equal(left,'server-draft-c');assert.equal(right,left);assert.equal(uploads,1);
});

test('a failed upload stays staged with exponential backoff and retries later',async()=>{
  let offline=true,uploads=0;
  const upload=async call=>{uploads++;if(offline)throw Error('offline');return `server-${call.id}`};
  await assert.rejects(queueRecording(draft(2,'draft-a'),'student',12,'part1',upload),/offline/);
  assert.equal(await pendingCount('student'),1);
  const [task]=await rawTasks();
  assert.equal(task.status,'failed');assert.equal(task.attempts,1);
  assert.ok(task.nextAt>Date.now()+1500&&task.nextAt<=Date.now()+2500,'first backoff is ~2s');
  offline=false;
  assert.equal(await retryPending('student',upload),0,'not due before backoff elapses');
  assert.equal(uploads,1);
  assert.equal(await retryPending('student',upload,{force:true}),1);
  assert.equal(await pendingCount('student'),0);
  assert.equal(await queuedAudio('student',12,'part1',bytes(2)),'server-draft-a');
});

test('a task left "uploading" by a crashed page is retried',async()=>{
  const blob=bytes(3),key=queueKey('student',12,'followup','manual-hash');
  const db=await new Promise(resolve=>{
    const open=indexedDB.open('ielts-speaking-uploads',1);
    open.onupgradeneeded=()=>{open.result.createObjectStore('tasks');open.result.createObjectStore('done')};
    open.onsuccess=()=>resolve(open.result);
  });
  await new Promise((resolve,reject)=>{
    const tx=db.transaction('tasks','readwrite');
    tx.objectStore('tasks').put({key,account:'student',day:12,phase:'followup',attemptId:'draft-crash',hash:'manual-hash',
      at:new Date().toISOString(),status:'uploading',attempts:0,nextAt:0,blob},key);
    tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
  });
  db.close();
  const seen=[];
  assert.equal(await retryPending('student',async call=>{seen.push(call.id);return `server-${call.id}`}),1);
  assert.deepEqual(seen,['draft-crash']);
  assert.equal(await pendingCount('student'),0);
});

test('tasks are account-scoped and clearUploadQueue wipes both stores',async()=>{
  const blobA=bytes(4),blobB=bytes(5);
  await queueRecording({...draft(4,'draft-a'),blob:blobA},'alice',12,'part1',async call=>`server-${call.id}`);
  await assert.rejects(queueRecording({...draft(5,'draft-b'),blob:blobB},'bob',12,'part1',async()=>{throw Error('offline')}),/offline/);
  assert.equal(await pendingCount(),1);
  assert.equal(await pendingCount('alice'),0);
  assert.equal(await pendingCount('bob'),1);
  const seen=[];
  assert.equal(await retryPending('alice',async call=>{seen.push(call.id);return `server-${call.id}`},{force:true}),0);
  assert.deepEqual(seen,[]);
  assert.equal(await clearUploadQueue(),true);
  assert.equal(await pendingCount(),0);
  assert.equal(await queuedAudio('alice',12,'part1',blobA),undefined);
});

test('discarded staged takes are dropped before they upload',async()=>{
  const blob=bytes(6);
  await assert.rejects(queueRecording({...draft(6,'draft-a'),blob},'student',12,'part1',async()=>{throw Error('offline')}),/offline/);
  assert.equal(await pendingCount('student'),1);
  assert.equal(await discardQueued('student',12,'part1',blob),true);
  assert.equal(await pendingCount('student'),0);
  assert.equal(await queuedAudio('student',12,'part1',blob),undefined);
});

test('unavailable storage is reported as a storage failure, not an upload failure',async()=>{
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:undefined});
  await assert.rejects(queueRecording(draft(7,'draft-a'),'student',12,'part1',async()=>'never'),
    error=>isQueueStorageError(error));
});

test('backoff doubles from two seconds and caps at five minutes',()=>{
  assert.equal(backoffMs(1),2000);assert.equal(backoffMs(2),4000);assert.equal(backoffMs(3),8000);
  assert.equal(backoffMs(10),300000);assert.equal(backoffMs(0),2000);
});
