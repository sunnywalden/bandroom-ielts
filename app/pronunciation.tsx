"use client";
import {useEffect,useId,useRef,useState} from "react";
import {createPronunciationPlayer,type PronunciationState} from "./pronunciation-player";
import {pronunciations} from "./pronunciations";

export default function Pronunciation({word}:{word:string}) {
  const key=word.trim().toLowerCase();
  const recording=Object.hasOwn(pronunciations,key)?pronunciations[key]:undefined;
  const audio=useRef<HTMLAudioElement>(null), player=useRef<ReturnType<typeof createPronunciationPlayer>|null>(null);
  const [state,setState]=useState<PronunciationState>({status:"idle"});
  const messageId=useId();
  useEffect(()=>{
    setState({status:"idle"});
    if(!audio.current||!recording) return;
    // Reapply after effect cleanup (including React Strict Mode's setup check).
    audio.current.src=recording.audio;
    const instance=createPronunciationPlayer(audio.current,setState);
    player.current=instance;
    return ()=>{ instance.destroy(); player.current=null; };
  },[recording]);
  const dictionary=recording?.source??"https://www.merriam-webster.com/dictionary/"+encodeURIComponent(key);
  if(!recording) return <span className="ex-pronunciation">
    <a className="ex-pron-link" href={dictionary} target="_blank" rel="noopener noreferrer">查词典美音 ↗</a>
    <span className="ex-pron-note">此词尚未收录录音，可到韦氏词典查找。</span>
  </span>;
  const loading=state.status==="loading", playing=state.status==="playing", failed=state.status==="error";
  return <span className="ex-pronunciation">
    <span className="ex-pron-actions">
      <a className="ex-pron-ipa" href={recording.ipaSource} target="_blank" rel="noopener noreferrer"
        title="美式音标来源：剑桥词典（新窗口）" aria-label={`${word} 的美式音标 ${recording.ipa}，来源：剑桥词典（新窗口）`}>
        <span className="ex-pron-ipa-label">美式 IPA</span><span lang="en-US">{recording.ipa}</span>
      </a>
      <button type="button" className="ex-pron-button" aria-label={`${failed?"重试":"播放"} ${word} 的真人美式发音`}
        aria-describedby={failed?messageId:undefined} onClick={()=>player.current?.play()}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>
        {failed?"重试美音":loading?"加载中…":playing?"再听一次":"美式 · 真人"}
      </button>
      {(loading||playing)&&<button type="button" className="ex-pron-stop" aria-label={`停止 ${word} 的发音`} onClick={()=>player.current?.stop()}>停止</button>}
      <a className="ex-pron-source" href={dictionary} target="_blank" rel="noopener noreferrer" aria-label={`${word} 发音来源：韦氏词典（新窗口）`}>韦氏词典 ↗</a>
    </span>
    <audio ref={audio} preload="none" src={recording.audio} aria-label={`${word} 真人美式录音`} />
    {failed&&<span className="ex-pron-error" id={messageId} role="alert">{state.message}</span>}
  </span>;
}
