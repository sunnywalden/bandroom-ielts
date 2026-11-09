"use client";

import { useState } from "react";

// Names are copied from the <audio src> in each official C1 lesson.
const recordings: Record<string, string> = {
  "job-interview": "LE_listening_C1_A_job_interview.mp3",
  "introverts-redressing-balance": "LE_listening_C1_Introverts_reddressing_the_balance.mp3",
  "helix": "LE_listening_C1_The_helix.mp3",
  "renting-house": "LE_listening_C1_Renting_a_house.mp3",
  "catching-after-trip": "LE_listening_C1_Talking_about_a_trip.mp3",
};

export default function ListeningPlayer({slug,source}:{slug:string;source:string}) {
  const [failed, setFailed] = useState("");
  const file = Object.hasOwn(recordings, slug) ? recordings[slug] : undefined;
  return <div className="ex-source">
    {file && failed !== slug ? <>
      <p>先听完整段录音，再作答并记录播放条件。</p>
      <audio key={slug} controls controlsList="nodownload" preload="none" aria-label="British Council C1 原版听力"
        style={{width:"100%"}} src={"https://learnenglish.britishcouncil.org/sites/podcasts/files/"+file}
        onError={()=>setFailed(slug)}/>
    </> : <p role="status">{failed===slug?"此设备暂时无法载入音频，请使用官方播放器。":"请在官方播放器中听完录音，再回到此页作答。"}</p>}
    <a href={source} target="_blank" rel="noopener noreferrer">British Council 原版播放器与原文 ↗</a>
  </div>;
}
