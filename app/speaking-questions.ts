// P0-4: authored speaking question bank, V1. All prompts are original; no
// Cambridge/IELTS material is copied. Future edits must bump `version`.
export type SpeakingPart = 1|2|3;
export type SpeakingQuestion = {
  id:string;
  part:SpeakingPart;
  topic:string;
  prompt:string;
  bullets?:string[];
  linked?:string[];
  source:'authored';
  version:1;
};
export type SpeakingMode = 'daily'|'full'|'mock';
export type SpeakingPlan = {
  mode:SpeakingMode;
  day:number;
  topic:string;
  part1:SpeakingQuestion[];
  part2:SpeakingQuestion;
  part3:SpeakingQuestion[];
};

type TopicSpec = {
  slug:string;
  zh:string;
  p1:string[];
  p2:{prompt:string;bullets:string[]};
  p3:string[];
};

export const TOPIC_LABELS:Record<string,string>={
  work:'工作与学习',study:'学习方式',hometown:'家乡与地点',technology:'科技',
  travel:'旅行',food:'食物',exercise:'运动',shopping:'购物',music:'音乐',
  environment:'环境',community:'社区',memory:'记忆',
};

const SPECS:TopicSpec[]=[
  {slug:'work',zh:'工作',p1:[
    'Do you work or are you a student?',
    'What do you like most about your work or studies?',
    'Would you like to change your job or subject in the future?',
  ],p2:{prompt:'Describe a job you would like to try for a short time.',bullets:[
    'what the job is','what skills it needs','why you would like to try it','how you would feel doing it']},p3:[
    'Why do some people change careers in mid-life?',
    'What jobs are most valued in your country?',
    'Should schools help students choose careers?',
    'How might remote work change career choices?',
  ]},
  {slug:'study',zh:'学习',p1:[
    'What subject are you studying or most interested in?',
    'What part of it is hardest for you?',
    'Do you prefer studying alone or with others?',
  ],p2:{prompt:'Describe a skill you learned slowly.',bullets:[
    'what the skill was','how you learned it','why it took a long time','how you felt when it improved']},p3:[
    'Why do some skills take longer to learn than others?',
    'Should adults keep learning new skills?',
    'Is practice more important than talent?',
    'How can teachers help people who learn slowly?',
  ]},
  {slug:'hometown',zh:'家乡',p1:[
    'Where is your hometown?',
    'What is your hometown known for?',
    'Would you like to live there in the future?',
  ],p2:{prompt:'Describe a place in your hometown that has changed.',bullets:[
    'where it is','what it was like before','what changed','how local people feel about it']},p3:[
    'Why do city centres change over time?',
    'Should old buildings be protected?',
    'How does tourism change a place?',
    'What makes a neighbourhood feel friendly?',
  ]},
  {slug:'technology',zh:'科技',p1:[
    'Which piece of technology do you use most?',
    'What do you mainly use it for?',
    'Is there any technology you avoid?',
  ],p2:{prompt:'Describe a time when technology failed you.',bullets:[
    'what you were doing','what went wrong','how you solved the problem','what you learned from it']},p3:[
    'Why do people depend on technology so much?',
    'Should schools limit students\' screen time?',
    'How can older people be helped to use new tools?',
    'Will artificial intelligence replace many jobs?',
  ]},
  {slug:'travel',zh:'旅行',p1:[
    'Do you enjoy travelling?',
    'What kind of transport do you prefer?',
    'Where would you like to go next?',
  ],p2:{prompt:'Describe a journey that did not go as planned.',bullets:[
    'where you were going','what happened','how you responded','how the journey ended']},p3:[
    'Why do people like to visit unfamiliar places?',
    'Should travel be part of education?',
    'How does tourism affect local culture?',
    'What will travel be like in the future?',
  ]},
  {slug:'food',zh:'食物',p1:[
    'What food do you often eat?',
    'Do you enjoy cooking?',
    'Is there a food you dislike?',
  ],p2:{prompt:'Describe a meal you remember well.',bullets:[
    'what the meal was','who was with you','where and when it happened','why you remember it']},p3:[
    'Why do eating habits differ between countries?',
    'Should schools teach children to cook?',
    'Is fast food a problem for society?',
    'How might food production change in the future?',
  ]},
  {slug:'exercise',zh:'运动',p1:[
    'How often do you exercise?',
    'What kind of exercise do you enjoy?',
    'Did you play sports as a child?',
  ],p2:{prompt:'Describe a time you tried a new sport or activity.',bullets:[
    'what it was','how you prepared','what was difficult','whether you continued']},p3:[
    'Why do some people avoid exercise?',
    'Should employers encourage exercise?',
    'Is sport more about health or competition?',
    'How can cities make exercise easier?',
  ]},
  {slug:'shopping',zh:'购物',p1:[
    'Do you prefer shopping online or in shops?',
    'What do you usually buy?',
    'Do you enjoy window shopping?',
  ],p2:{prompt:'Describe something you bought recently that you are happy with.',bullets:[
    'what it was','why you bought it','where you bought it','why you are pleased with it']},p3:[
    'Why do people buy things they do not need?',
    'How does advertising affect shopping?',
    'Should governments limit online shopping?',
    'What makes a shop worth visiting?',
  ]},
  {slug:'music',zh:'音乐',p1:[
    'What kind of music do you like?',
    'When do you listen to music?',
    'Can you play an instrument?',
  ],p2:{prompt:'Describe a song or piece of music that means something to you.',bullets:[
    'what it is','when you first heard it','why it matters to you','how it makes you feel']},p3:[
    'Why is music important in many cultures?',
    'Should children learn music at school?',
    'How has streaming changed the way people listen?',
    'Can music help people learn?',
  ]},
  {slug:'environment',zh:'环境',p1:[
    'Is the environment a concern where you live?',
    'What do you do to reduce waste?',
    'Do you spend time in nature?',
  ],p2:{prompt:'Describe a local environmental problem.',bullets:[
    'what the problem is','what causes it','who is affected','what could be done about it']},p3:[
    'Why do some people ignore environmental problems?',
    'Should individuals or governments do more?',
    'How can cities reduce pollution?',
    'Will technology solve environmental problems?',
  ]},
  {slug:'community',zh:'社区',p1:[
    'Do you know your neighbours?',
    'What makes a good community?',
    'Do you take part in local events?',
  ],p2:{prompt:'Describe a person in your community you admire.',bullets:[
    'who the person is','how you know them','what they do','why you admire them']},p3:[
    'Why do some communities become stronger over time?',
    'Should people volunteer locally?',
    'How can new residents feel welcome?',
    'What role do public spaces play in community life?',
  ]},
  {slug:'memory',zh:'记忆',p1:[
    'Do you have a good memory?',
    'What kinds of things do you forget?',
    'How do you remember important dates?',
  ],p2:{prompt:'Describe a childhood memory you still remember clearly.',bullets:[
    'what happened','how old you were','who was there','why it stayed with you']},p3:[
    'Why do some memories stay while others fade?',
    'Should schools teach memory techniques?',
    'How do photos change the way we remember?',
    'Is it better to remember everything?',
  ]},
];

function build():SpeakingQuestion[] {
  const result:SpeakingQuestion[]=[];
  for(const spec of SPECS){
    const p2Id=`p2-${spec.slug}-01`;
    const p3Ids=spec.p3.map((_,index)=>`p3-${spec.slug}-0${index+1}`);
    spec.p1.forEach((prompt,index)=>result.push({
      id:`p1-${spec.slug}-0${index+1}`,part:1,topic:spec.slug,prompt,source:'authored',version:1,
    }));
    result.push({id:p2Id,part:2,topic:spec.slug,prompt:spec.p2.prompt,
      bullets:[...spec.p2.bullets],linked:p3Ids,source:'authored',version:1});
    spec.p3.forEach((prompt,index)=>result.push({
      id:p3Ids[index],part:3,topic:spec.slug,prompt,linked:[p2Id],source:'authored',version:1,
    }));
  }
  return result;
}

export const SPEAKING_QUESTIONS:SpeakingQuestion[]=build();
export const QUESTION_BY_ID=new Map(SPEAKING_QUESTIONS.map(question=>[question.id,question]));
const SPEC_BY_SLUG=new Map(SPECS.map(spec=>[spec.slug,spec]));
export const TOPICS=SPECS.map(spec=>spec.slug);

export function topicForDay(day:number){
  const index=Math.max(0,Math.floor(day)-11)%TOPICS.length;
  return TOPICS[index];
}
export function topicLabel(topic:string){return TOPIC_LABELS[topic]||topic}
export function questionsFor(part:SpeakingPart,topic?:string){
  return SPEAKING_QUESTIONS.filter(question=>question.part===part&&(!topic||question.topic===topic));
}
export function questionById(id:string|undefined){return id?QUESTION_BY_ID.get(id):undefined}
function rotate<T>(list:T[],offset:number){return list.length?list.slice(offset%list.length).concat(list.slice(0,offset%list.length)):[]}

// Lesson prompts win over the bank; the bank only fills a missing field. It
// never makes an unpublished day reachable (see curriculum.hasLesson).
export function buildPlan(options:{mode:SpeakingMode;day:number;speaking?:string;followup?:string;questionId?:string}):SpeakingPlan {
  const {mode,day}=options;
  const topic=topicForDay(day);
  const count=mode==='daily'?2:3;
  const offset=Math.max(0,day-11)%3;
  const part1=rotate(questionsFor(1,topic),offset).slice(0,count);
  const bank2=questionsFor(2,topic)[0];
  const question=questionById(options.questionId);
  const part2:SpeakingQuestion|undefined=question?.part===2
    ?question
    :mode!=='mock'&&options.speaking?.trim()
      ?{id:`lesson-${day}-p2`,part:2,topic,prompt:options.speaking.trim(),source:'authored' as const,version:1 as const}
      :bank2;
  const bank3=rotate(questionsFor(3,topic),offset);
  const part3:SpeakingQuestion[]=[];
  if(mode!=='mock'&&options.followup?.trim()){
    part3.push({id:`lesson-${day}-p3-01`,part:3,topic,prompt:options.followup.trim(),source:'authored',version:1});
  }
  for(const candidate of bank3){
    if(part3.length>=count)break;
    if(part3.some(item=>item.prompt===candidate.prompt))continue;
    part3.push(candidate);
  }
  if(!part2)throw Error('speaking_bank_missing_part2');
  return {mode,day,topic,part1,part2,part3:part3.slice(0,count)};
}

export function reviewedFor(mode:SpeakingMode,index:number){
  if(mode==='daily')return index===0;
  return true;
}
export function partAnswerField(part:SpeakingPart){
  return part===1?'speakingPart1':part===2?'speakingPart2':'speakingFollowup';
}
export function partDuration(part:SpeakingPart){return part===1?40:part===2?120:60}
export function partLabel(part:SpeakingPart){return `Part ${part}`}

// Integrity checks used by tests and by authored-content review.
export function validateQuestionBank(questions:SpeakingQuestion[]=SPEAKING_QUESTIONS){
  const errors:string[]=[];
  const ids=new Set<string>();
  for(const question of questions){
    if(ids.has(question.id))errors.push(`duplicate id: ${question.id}`);
    ids.add(question.id);
    if(!question.id.trim())errors.push('empty id');
    if(!question.prompt.trim())errors.push(`empty prompt: ${question.id}`);
    if(!question.topic.trim())errors.push(`empty topic: ${question.id}`);
    if(question.source!=='authored')errors.push(`not authored: ${question.id}`);
    if(question.version!==1)errors.push(`bad version: ${question.id}`);
    if(question.part===2&&question.bullets?.length!==4)errors.push(`part 2 needs 4 bullets: ${question.id}`);
  }
  for(const linked of questions.flatMap(question=>question.linked||[]))
    if(!ids.has(linked)&&!linked.startsWith('lesson-'))
      errors.push(`unresolved link: ${linked}`);
  for(const slug of TOPICS){
    const expected={1:3,2:1,3:4};
    for(const part of [1,2,3] as const){
      const actual=questions.filter(question=>question.topic===slug&&question.part===part).length;
      if(actual!==expected[part])errors.push(`topic ${slug} part ${part}: ${actual}`);
    }
  }
  return errors;
}
export function topicCount(){return SPEC_BY_SLUG.size}
