"use client";
import {useEffect,useMemo,useSyncExternalStore} from "react";

type Draft={base:string;value:string};
function draftStore(key:string) {
  let draft:Draft|undefined;
  try {
    const saved=JSON.parse(localStorage.getItem(key)||"null");
    if(typeof saved?.base==="string"&&typeof saved?.value==="string")draft=saved;
  }catch{/* Keep an in-memory draft when browser storage is unavailable. */}
  const listeners=new Set<()=>void>();
  const persist=()=>{try{localStorage.setItem(key,JSON.stringify(draft));}catch{}};
  return {
    subscribe(listener:()=>void){listeners.add(listener);return ()=>{listeners.delete(listener)};},
    value(base:string){return draft&&draft.value!==draft.base?draft.value:base;},
    change(value:string,base:string){draft={base,value};persist();listeners.forEach(fn=>fn());},
    acknowledge(base:string){
      // An acknowledgement can retire the submitted draft, never edits typed after it.
      if(draft&&(draft.value===base||draft.value===draft.base)){
        draft={base,value:base};persist();
      }
    },
  };
}

export function useDraft(account:string,key:string,initial:string) {
  const storageKey="bandroom.draft."+account+"."+key;
  const store=useMemo(()=>draftStore(storageKey),[storageKey]);
  const value=useSyncExternalStore(store.subscribe,()=>store.value(initial),()=>initial);
  useEffect(()=>store.acknowledge(initial),[store,initial]);
  return [value,(next:string)=>store.change(next,initial)] as const;
}
