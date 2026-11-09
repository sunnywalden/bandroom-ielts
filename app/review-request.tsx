"use client"
import { useRef, useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { type Entry, oldResults, writings } from './ledger'
export default function ReviewRequest({day,entry}:{day:number;entry:Entry}){
 const [message,setMessage]=useState(''),[include,setInclude]=useState(false)
 const box=useRef<HTMLTextAreaElement>(null)
 const intro='请使用 Bandroom 读取我在 Day '+day+' 已经提交的练习。分别点评内容、语法和搭配，给出两项优先改进，并将评语追加到这次作答。口语发音和流利度仅在实际听到录音时评价。'
 const packet=include?intro+'\n\n'+JSON.stringify({阶段成绩:oldResults[day],写作:writings[day],提交记录:Object.fromEntries(Object.entries(entry).filter(([k])=>!k.startsWith('_')&&!k.endsWith('Draft')))},null,2):intro
 async function copy(){try{await navigator.clipboard.writeText(packet);setMessage('已复制，可粘贴到教练对话。')}catch{box.current?.focus();box.current?.select();setMessage('已选中，请使用系统复制快捷键。')}}
 return <div className="review-handoff"><label className="packet-label">给教练的请求<textarea ref={box} value={packet} readOnly onFocus={e=>e.target.select()}/></label><label className="review-option"><input type="checkbox" checked={include} onChange={e=>setInclude(e.target.checked)}/> 同时附上文字作答（适合未连接学习工具时）</label><div className="actions"><button className="secondary" onClick={()=>void copy()}><Copy size={15}/>复制请求</button><a className="secondary" href="https://chatgpt.com/c/6adc0a0c-e9a4-83ec-96a3-ddef0fe89edd" target="_blank" rel="noreferrer">打开原教练对话<ExternalLink size={14}/></a></div><p role="status">{message}</p></div>
}

