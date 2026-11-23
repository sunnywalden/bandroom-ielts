import type { ReviewAttempt } from "@/app/feedback-model";
import type { Item, Lesson } from "@/app/curriculum";
import { part3 } from "@/app/ledger";

const optionAt=(item:Item,index:number)=>({index,letter:'ABC'[index],text:item.choices[index]});

export function reviewContext(attempt:ReviewAttempt,lesson:Lesson|undefined) {
  if(attempt.day===11&&attempt.field==='speakingFollowup')return {prompt:part3};
  if(!lesson)return {scope:'Use only the available submitted evidence; full task context unavailable.'};
  const field=attempt.field;
  if(field==='speakingPart2')return {prompt:lesson.speaking};
  if(field==='speakingFollowup')return {prompt:attempt.day===11?part3:lesson.followup};
  if(field==='vocabRecall')return {prompt:lesson.recall[0],answer:lesson.recall[1]};
  if(field==='vocabUse')return {prompt:lesson.use,phrases:lesson.phrases,collocations:lesson.collocations};
  if(field.startsWith('readQ')||field.startsWith('listenQ')) {
    const reading=field.startsWith('readQ'),index=Number(field.slice(-1));
    const item=(reading?lesson.reading:lesson.listening)[index];
    const base=reading?{passage:lesson.passage}:{source:'https://learnenglish.britishcouncil.org/free-resources/listening/c1/'+lesson.slug};
    if(!item)return base;
    // The saved response is only the chosen option's index. Say so, and decode
    // it, so the coach grades the choice and the evidence sentence instead of
    // critiquing a bare "1" as a too-short answer.
    const response=attempt.response.trim();
    const picked=/^[0-2]$/.test(response)?Number(response):null;
    return {...base,...item,
      responseKind:'multiple_choice_option_index' as const,
      learnerChoice:picked===null?null:optionAt(item,picked),
      correctChoice:optionAt(item,item.answer),
      isCorrect:picked===null?null:picked===item.answer};
  }
  if(field.startsWith('write'))return {prompt:lesson.writing,revisionGuidance:lesson.edit,fullEssay:!!lesson.fullEssay,sourcePassage:lesson.passage};
  return {prompt:'Review the learner’s reflection and suggest one specific next practice step.'};
}
