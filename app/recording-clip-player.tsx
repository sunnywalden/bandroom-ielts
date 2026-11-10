'use client';
import {useEffect,useRef,useState} from 'react';

type Props = {recordingId:string; startMs:number; endMs?:number; anchorMs?:number; label:string};

// Plays only the evidence window, not the whole answer. The browser seeks on
// the original recording timeline produced by the analysis bundle.
export default function RecordingClipPlayer({recordingId,startMs,endMs,anchorMs,label}:Props) {
  const audio=useRef<HTMLAudioElement>(null);
  const playback=useRef<symbol|null>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'playing'|'error'>('idle');
  const from=Math.max(0,anchorMs!=null?anchorMs-750:startMs-500);
  const to=Math.max(from+300,anchorMs!=null?anchorMs+750:(endMs??startMs+500)+500);
  useEffect(()=>{
    const element=audio.current;
    return ()=>{
      playback.current=null;
      element?.pause();
    };
  },[]);
  function stop(){
    playback.current=null;
    audio.current?.pause();
    setStatus('idle');
  }
  function fail(){
    playback.current=null;
    setStatus('error');
  }
  async function togglePlayback(){
    const element=audio.current;
    if(!element)return;
    if(playback.current){
      stop();
      return;
    }
    const request=Symbol();
    playback.current=request;
    setStatus('loading');
    try{
      if(element.error)element.load();
      element.currentTime=from/1000;
      await element.play();
      if(playback.current===request)setStatus('playing');
    }catch{
      if(playback.current===request)fail();
    }
  }
  function tick(){
    const element=audio.current;
    if(!element)return;
    if(playback.current&&element.currentTime*1000>=to){
      stop();
      element.currentTime=to/1000;
    }
  }
  const active=status==='loading'||status==='playing';
  return <div className="clip-player">
    <audio ref={audio} src={'/api/audio?id='+encodeURIComponent(recordingId)} preload="none"
      onTimeUpdate={tick} onEnded={stop} onError={fail}/>
    <button type="button" className="secondary" onClick={togglePlayback}>
      {active?'停止回听':status==='error'?'重试回听 '+label:'回听 '+label}
    </button>
    <span role="status" className="af-hint">
      {status==='error'?'原录音暂时无法播放，可以重试。':status==='loading'?'正在加载原录音…':status==='playing'?`正在播放 ${(from/1000).toFixed(1)}–${(to/1000).toFixed(1)} 秒`:`第 ${(from/1000).toFixed(1)}–${(to/1000).toFixed(1)} 秒`}
    </span>
  </div>;
}
