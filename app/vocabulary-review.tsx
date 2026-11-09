import { getExercises } from "./curriculum";
import { notes } from "./ledger";
import Pronunciation from "./pronunciation";

type ReviewWord = { term:string; meaning:string; example:string; day:number; relevant:boolean };

export function learnedWords(day:number, completedDays:number[], answer:string):ReviewWord[] {
  const completed=new Set(completedDays.filter(d=>d<day));
  const target=answer.trim().toLowerCase();
  const words=new Map<string,ReviewWord>();
  for(const note of notes) {
    if(completed.has(note.day)) words.set(note.word,{term:note.word,meaning:note.meaning,example:note.after,day:note.day,
      relevant:target===note.word||target===note.key});
  }
  for(const previousDay of [...completed].sort((a,b)=>a-b)) {
    for(const [term,meaning,example] of getExercises(previousDay)?.words??[]) {
      const key=term.trim().toLowerCase();
      words.set(key,{term,meaning,example,day:previousDay,relevant:key===target});
    }
  }
  return [...words.values()].sort((a,b)=>Number(b.relevant)-Number(a.relevant)||b.day-a.day||a.term.localeCompare(b.term));
}

export default function VocabularyReview({words}:{words:ReviewWord[]}) {
  return <>
    <p className="ex-review-intro">先看单词、中文含义和例句，慢慢找回印象。不用一次记住，练习时也可以随时回来看看。</p>
    <p className="ex-review-count">学习记录中已收录的旧词 · {words.length} 个</p>
    {words.length?<div className="ex-review-grid">{words.map(word=><article className={"ex-review-word"+(word.relevant?" ex-review-relevant":"")} key={word.term}>
      <div className="ex-review-source"><span>Day {word.day}</span>{word.relevant&&<span>本次会用到</span>}</div>
      <div className="ex-word-heading"><h3 lang="en">{word.term}</h3><Pronunciation word={word.term}/></div>
      <p className="ex-review-meaning">{word.meaning}</p>
      <p className="ex-review-example" lang="en">{word.example}</p>
    </article>)}</div>:<p>暂时没有可展示的旧词记录。你可以开始练习，核对后查看释义。</p>}
  </>;
}
