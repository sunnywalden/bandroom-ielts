import assert from 'node:assert/strict';
import test from 'node:test';
import {answers,changeDraft,currentPhase,discardIfMatch,draftKey,submitted,uploadDraft,newRecordingId} from '../app/speaking-draft.ts';

// Small transactional storage boundary. Browser acceptance separately exercises native IndexedDB.
function memoryIDB() {
  const map=new Map(),later=queueMicrotask;
  return {open(){const open={result:{close(){},transaction(){const tx={objectStore(){return {
    get(k){const r={result:structuredClone(map.get(k))};later(()=>{r.onsuccess();later(()=>tx.oncomplete())});return r},
    put(v,k){map.set(k,structuredClone(v))},delete(k){map.delete(k)}
  }}};return tx}}};later(()=>open.onsuccess());return open}};
}
test('recorded follow-up survives remount, upload retries and a failed checkpoint; successful commit then enters review',async t=>{
  const id=crypto.randomUUID(),at=new Date().toISOString(),scope=draftKey('student',12,'followup');
  t.mock.method(globalThis,'fetch');
  Object.defineProperty(globalThis,'indexedDB',{configurable:true,value:memoryIDB()});
  t.after(()=>delete globalThis.indexedDB);
  const first={at:new Date(0).toISOString(),text:'',audio:crypto.randomUUID(),spoken:true};
  const entry={speakingPart2:JSON.stringify([first]),speakingPhase:'followup'};
  const bytes=new Uint8Array([14,17,12,190]),draft={id,at,blob:new Blob([bytes],{type:'audio/webm'})};
  assert.equal(currentPhase(12,entry),'followup');
  await changeDraft(scope,()=>draft);
  assert.equal(await changeDraft(draftKey('other',12,'followup')),undefined);
  assert.equal(await changeDraft(draftKey('student',12,'part2')),undefined);
  let loaded=await changeDraft(scope);
  assert.deepEqual(new Uint8Array(await loaded.blob.arrayBuffer()),bytes);
  globalThis.fetch.mock.mockImplementation(async(_url,request)=>{
    assert.equal(request.headers['X-Bandroom-Attempt'],id);
    assert.equal(request.headers['X-Bandroom-Phase'],'followup');
    return new Response('',{status:503});
  });
  await assert.rejects(uploadDraft(loaded,'student',12,'followup'));
  loaded=await changeDraft(scope);
  globalThis.fetch.mock.mockImplementation(async(_url,request)=>{
    assert.equal(request.headers['X-Bandroom-Attempt'],id);return Response.json({id});
  });
  const audio=await uploadDraft(loaded,'student',12,'followup');
  await changeDraft(scope,d=>({...d,audio}));
  // No checkpoint acknowledgement yet.
  assert.equal(currentPhase(12,entry),'followup');
  loaded=await changeDraft(scope);
  assert.equal(await uploadDraft(loaded,'student',12,'followup'),audio);
  assert.equal(globalThis.fetch.mock.callCount(),2);
  entry.speakingFollowup=JSON.stringify([{at:loaded.at,audio,text:'',spoken:true}]);
  // A stale phase flag cannot hide the already accepted follow-up.
  assert.equal(currentPhase(12,entry),'review');
  assert.ok(submitted(loaded,answers(entry.speakingFollowup)));
  await changeDraft(scope,discardIfMatch(loaded.id));
  assert.equal(await changeDraft(scope),undefined);
  const retry={...draft,id:crypto.randomUUID(),at:new Date(Date.now()+2000).toISOString()};
  await changeDraft(scope,()=>retry);
  assert.equal((await changeDraft(scope,discardIfMatch(id))).id,retry.id);
  assert.equal(submitted(retry,answers(entry.speakingFollowup)),false);
  assert.equal(currentPhase(12,{}),'part2');assert.equal(currentPhase(11,{}),'followup');
});

test('recording stop works when only getRandomValues is available',()=>{
  Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});
  try {
    const id=newRecordingId();
    assert.match(id,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
    assert.notEqual(id,newRecordingId());
  }finally{delete crypto.randomUUID}
});
