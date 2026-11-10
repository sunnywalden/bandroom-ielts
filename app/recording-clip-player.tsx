'use client';
import {useEffect,useRef,useState} from 'react';

type Props = {recordingId:string; startMs:number; endMs?:number; anchorMs?:number; label:string};

// Plays only the evidence window, not the whole answer. The browser seeks on
// the original recording timeline produced by the analysis bundle.
export default function RecordingClipPlayer({recordingId,startMs,endMs,anchorMs,label}:Props) {
  const audio=useRef<HTMLAudioElement>(null);
  const [status,setStatus]=useState<'idle'|'playing'|'error'>('idle');
  const from=Math.max(0,anchorMs!=null?anchorMs-750:startMs-500);
  const to=Math.max(from+300,anchorMs!=null?anchorMs+750:(endMs??startMs+500)+500);
  useEffect(()=>()=>{audio.current?.pause()},[]);
  async function play(){
    const element=audio.current;
    if(!element)return;
    try{
      element.currentTime=from/1000;
      await element.play();
      setStatus('playing');
    }catch{setStatus('error')}
  }
  function tick(){
    const element=audio.current;
    if(!element)return;
    if(element.currentTime*1000>=to){element.pause();element.currentTime=to/1000;setStatus('idle')}
  }
  return <div className="clip-player">
    <audio ref={audio} src={'/api/audio?id='+encodeURIComponent(recordingId)} preload="metadata"
      onTimeUpdate={tick} onEnded={()=>setStatus('idle')} onError={()=>setStatus('error')}/>
    <button type="button" className="secondary" onClick={play} disabled={status==='error'}>
      {status==='playing'?'停止回听':'回听 '+label}
    </button>
    <span role="status" className="af-hint">
      {status==='error'?'原录音暂时无法播放。':status==='playing'?`正在播放 ${(from/1000).toFixed(1)}–${(to/1000).toFixed(1)} 秒`:`第 ${(from/1000).toFixed(1)}–${(to/1000).toFixed(1)} 秒`}
    </span>
  </div>;
}
