import {dayStamp,oldResults,type Ledger} from './ledger'
const epoch=Date.UTC(2026,9,29), unit=86400000
const fmt=(n:number)=>new Date(n).toISOString().slice(0,10)
export function periods(today=dayStamp()){
 const n=Math.min(104, Math.floor((Date.parse(today+'T00:00:00Z')-epoch)/unit/7))
 return Array.from({length:Math.max(0,n)},(_,i)=>{const end=epoch+(i+1)*7*unit;return {id:'W'+(i+1),label:'第 '+(i+1)+' 周'+((i+1)%4===0?' · 四周合评':''),from:fmt(end-7*unit),to:fmt(end-unit),cycleFrom:(i+1)%4===0?fmt(end-28*unit):undefined}}).reverse()
}
export type Period=ReturnType<typeof periods>[number]
export function recordsIn(s:Ledger,from:string,to:string){
 const rows:string[]=[]
 const inside=(date?:string)=>!!date&&date>=from&&date<=to
 for(const [day,date] of [[8,'2026-10-29'],[9,'2026-10-30'],[10,'2026-11-02'],[11,'2026-11-02']] as const)
  if(inside(date))rows.push('Day '+day+' · '+date+' ｜ '+oldResults[day].map(x=>x.join(' ')).join('，'))
 Object.entries(s.entries).forEach(([d,e])=>{Object.entries(e).filter(([k,v])=>k.startsWith('_date_')&&inside(v)).forEach(([k,v])=>rows.push('Day '+d+' · '+v+' ｜ '+k.slice(6)+' 已提交'))})
 return rows
}

