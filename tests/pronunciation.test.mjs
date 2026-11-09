import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPronunciationPlayer} from '../app/pronunciation-player.ts';
import {pronunciations} from '../app/pronunciations.ts';
import {getExercises} from '../app/curriculum.ts';
import {notes} from '../app/ledger.ts';

class AudioFixture extends EventTarget {
  paused=true; readyState=0; currentTime=0; error=null; loads=0; plays=0; src='fixture.mp3';
  nextPlay=()=>Promise.resolve();
  play(){this.plays++;this.paused=false;return this.nextPlay()}
  pause(){this.paused=true}
  load(){this.loads++;this.readyState=0;this.error=null}
  removeAttribute(name){if(name==='src')this.src=''}
  emit(name){this.dispatchEvent(new Event(name))}
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,timeout=1000){
  const audio=new AudioFixture(),states=[];
  const player=createPronunciationPlayer(audio,state=>states.push(state),timeout);
  t.after(()=>player.destroy());
  return {audio,player,states,last:()=>states.at(-1)};
}

test('all recorded old words and prepared lesson words have verified US dictionary recordings',()=>{
  const words=new Set([...notes.map(n=>n.word),...Array.from({length:5},(_,i)=>getExercises(i+12).words.map(w=>w[0])).flat()]);
  assert.equal(words.size,19);
  for(const word of words){
    const recording=pronunciations[word];assert.ok(recording,word);
    const audio=new URL(recording.audio),source=new URL(recording.source);
    assert.equal(audio.protocol,'https:');assert.equal(audio.hostname,'media.merriam-webster.com');
    assert.match(audio.pathname,/^\/audio\/prons\/en\/us\/mp3\/[a-z]+\/[a-z0-9_]+\.mp3$/);
    assert.equal(source.href,`https://www.merriam-webster.com/dictionary/${word}`);
  }
  // The curriculum uses the adjective, whose stress differs from the noun.
  assert.ok(pronunciations.compact.audio.endsWith('/c/compac01.mp3'));
});
test('no autoplay; playback waits for actual media events and ends cleanly',t=>{
  const f=fixture(t);assert.equal(f.audio.plays,0);assert.equal(f.audio.loads,0);
  f.player.play();assert.equal(f.last().status,'loading');assert.equal(f.audio.plays,1);
  f.audio.emit('playing');assert.equal(f.last().status,'playing');
  f.audio.emit('ended');assert.equal(f.last().status,'idle');assert.ok(f.audio.paused);
});
test('another word stops the previous recording and late events cannot restart it',t=>{
  const a=fixture(t),b=fixture(t);a.player.play();a.audio.emit('playing');
  b.player.play();assert.ok(a.audio.paused);assert.equal(a.last().status,'idle');
  a.audio.emit('playing');assert.ok(a.audio.paused);assert.equal(b.last().status,'loading');
  b.audio.emit('playing');assert.equal(b.last().status,'playing');
});
test('rapid repeat clicks restart without a stale rejection hiding the new playback',async t=>{
  const f=fixture(t);let reject;
  f.audio.nextPlay=()=>new Promise((_,r)=>{reject=r});f.player.play();
  f.audio.currentTime=0.7;f.audio.nextPlay=()=>Promise.resolve();f.player.play();
  assert.equal(f.audio.currentTime,0);f.audio.emit('playing');
  reject(new Error('old request aborted'));await tick();
  assert.equal(f.last().status,'playing');assert.equal(f.audio.plays,2);
});
test('playback rejection is actionable and a retry can succeed',async t=>{
  const f=fixture(t);f.audio.nextPlay=()=>Promise.reject(new Error('network unavailable'));
  f.player.play();await tick();assert.equal(f.last().status,'error');assert.match(f.last().message,/重试/);assert.ok(f.audio.paused);
  f.audio.nextPlay=()=>Promise.resolve();f.player.play();f.audio.emit('playing');
  assert.equal(f.last().status,'playing');
});
test('browser gesture rejection has a specific explanation',async t=>{
  const f=fixture(t),error=new Error('gesture required');error.name='NotAllowedError';
  f.audio.nextPlay=()=>Promise.reject(error);f.player.play();await tick();
  assert.match(f.last().message,/浏览器阻止/);
});
test('an indefinitely pending load times out, stops, and permits retry',async t=>{
  const f=fixture(t,20);f.audio.nextPlay=()=>new Promise(()=>{});f.player.play();
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.last().status,'error');assert.match(f.last().message,/超时/);assert.ok(f.audio.paused);
  f.audio.nextPlay=()=>Promise.resolve();f.player.play();f.audio.emit('playing');assert.equal(f.last().status,'playing');
});
test('a stalled playing stream also has a bounded wait',async t=>{
  const f=fixture(t,20);f.player.play();f.audio.emit('playing');f.audio.emit('waiting');
  assert.equal(f.last().status,'loading');await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.last().status,'error');assert.ok(f.audio.paused);
});
test('media errors reload the original source on retry',t=>{
  const f=fixture(t);f.player.play();f.audio.emit('playing');f.audio.readyState=4;
  f.audio.error={code:4};f.audio.emit('error');assert.equal(f.last().status,'error');
  const before=f.audio.loads;f.player.play();assert.equal(f.audio.loads,before+1);
  f.audio.emit('playing');assert.equal(f.last().status,'playing');
});
test('explicit stop cancels timeout and ignores a pending rejection',async t=>{
  const f=fixture(t,20);let reject;f.audio.nextPlay=()=>new Promise((_,r)=>{reject=r});
  f.player.play();f.player.stop();reject(new Error('aborted'));await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(f.last().status,'idle');assert.ok(f.audio.paused);
});
test('unmount releases media and ignores later requests or events',async t=>{
  const f=fixture(t);let reject;f.audio.nextPlay=()=>new Promise((_,r)=>{reject=r});
  f.player.play();f.player.destroy();const count=f.states.length;
  reject(new Error('unmounted'));f.audio.emit('error');f.player.play();await tick();
  assert.equal(f.states.length,count);assert.equal(f.audio.plays,1);assert.equal(f.audio.src,'');assert.ok(f.audio.paused);
});
