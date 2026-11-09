import type { ReviewAttempt } from "@/app/feedback-model";
import type { Lesson } from "@/app/curriculum";
import { part3 } from "@/app/ledger";

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
    return {...(reading?{passage:lesson.passage}:{source:'https://learnenglish.britishcouncil.org/free-resources/listening/c1/'+lesson.slug}),
      ...(reading?lesson.reading:lesson.listening)[index]};
  }
  if(field.startsWith('write'))return {prompt:lesson.writing,revisionGuidance:lesson.edit,fullEssay:!!lesson.fullEssay,sourcePassage:lesson.passage};
  return {prompt:'Review the learner’s reflection and suggest one specific next practice step.'};
}
