export type PronunciationState = { status: "idle"|"loading"|"playing"|"error"; message?:string };

// One vocabulary recording at a time, including across separate word lists.
let stopActive:(()=>void)|undefined;

export function createPronunciationPlayer(audio:HTMLAudioElement, update:(state:PronunciationState)=>void, timeoutMs=12000) {
  let generation=0, disposed=false, timer:ReturnType<typeof setTimeout>|undefined;
  const clear=()=>{ if(timer) clearTimeout(timer); timer=undefined; };
  const current=()=>!disposed&&stopActive===stop;
  function stop() {
    ++generation; clear(); audio.pause();
    if(stopActive===stop) stopActive=undefined;
    if(!disposed) update({status:"idle"});
  }
  function fail(message:string) {
    if(!current()) return;
    stop(); update({status:"error",message});
  }
  function wait() {
    if(!current()) return;
    clear(); update({status:"loading"});
    timer=setTimeout(()=>fail("录音加载超时，请检查网络后重试，或打开词典原页收听。"),timeoutMs);
  }
  function playing() {
    if(!current()) { audio.pause(); return; }
    clear(); update({status:"playing"});
  }
  function ended() { if(current()) stop(); }
  function error() { fail("词典录音暂时无法播放，请重试，或打开词典原页收听美式发音。"); }
  audio.addEventListener("playing",playing);
  audio.addEventListener("waiting",wait);
  audio.addEventListener("ended",ended);
  audio.addEventListener("error",error);
  return {
    play() {
      if(disposed) return;
      stopActive?.(); stopActive=stop;
      const request=++generation;
      wait();
      try {
        if(audio.error||audio.readyState===0) audio.load();
        audio.currentTime=0;
        // Called directly from the click gesture, including on mobile browsers.
        Promise.resolve(audio.play()).catch((reason:unknown)=>{
          if(request!==generation||!current()) return;
          fail(reason instanceof Error&&reason.name==="NotAllowedError"
            ?"浏览器阻止了播放，请再次点击播放按钮，或打开词典原页收听。"
            :"词典录音暂时无法播放，请重试，或打开词典原页收听美式发音。");
        });
      } catch { if(request===generation) error(); }
    },
    stop,
    destroy() {
      disposed=true; stop();
      audio.removeEventListener("playing",playing);
      audio.removeEventListener("waiting",wait);
      audio.removeEventListener("ended",ended);
      audio.removeEventListener("error",error);
      audio.removeAttribute("src"); audio.load();
    },
  };
}
