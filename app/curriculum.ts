export type Item = {
  prompt: string;
  choices: [string, string, string];
  answer: number;
  why: string;
};
type Word = [term: string, meaning: string, example: string];
export type Lesson = {
  theme: string; speaking: string; followup: string;
  words: Word[]; phrases: [string,string][]; collocations: [string,string][];
  recall: [string,string]; use: string;
  audioTitle: string; slug: string; listening: [Item,Item];
  readingTitle: string; passage: string; reading: [Item,Item]; writing: string; edit: string;
  fullEssay?: boolean;
};
const q = (prompt: string, choices: Item["choices"], answer: number, why: string): Item => ({prompt,choices,answer,why});
const catalogue: Record<number,Lesson> = {
  12: {
    theme: "The next role", speaking: "Describe a skill you learned at work that opened up a new opportunity. Explain how you learned it and what changed afterwards.",
    followup:"When should an employer give staff time to specialise rather than rotate them between roles?",
    words:[
      ["transferable","adj. 可迁移的","Debugging is a transferable skill."],
      ["retain","v. 保留，留住","Flexible schedules can help a company retain experienced staff."],
      ["scope","n. 发挥或改进的空间","The new role offers scope for independent work."]
    ],
    phrases:[["in the long run","从长远来看"],["in my experience","根据我的经验"]],
    collocations:[["develop expertise in","在某领域积累专长"],["meet a requirement","满足要求"]],
    recall:["A practical proposal that is likely to succeed is _____. Use the adjective from Day 9.","viable"],
    use:"Explain one reason to change roles. Use develop expertise in or meet a requirement.",
    audioTitle:"A job interview",slug:"job-interview",
    listening:[
      q("What does Maria hope this new employer can offer?",["The chance to focus on staff development","Her first opportunity to work in HR","A move from corporate clients to private customers"],0,"Maria 已在小团队承担多项 HR 工作。她看重大公司的规模，因为这能让她专攻学习与发展。"),
      q("How does Maria turn a potential weakness into a strength?",["She says her current team already has 2,000 employees.","She thinks a fresh perspective could help her adapt.","She says every employee can receive exactly the same individual support."],1,"谈到大公司经验不足时，她说自己较少带着固有做法进入新岗位，也承认个人化支持需要调整。")
    ],
    readingTitle:"The mentoring pilot",
    passage:"Northline offered an eight-week mentoring scheme to eighteen volunteers in its support team. Thirteen volunteers then passed a skills assessment. No assessment had been given before the scheme, and colleagues outside the scheme did not take the test. Managers approved a second pilot. A decision about permanent funding will follow a comparison with a team that receives the usual training.",
    reading:[
      q("Which decision has already been made?",["Permanent funding for mentoring","A further pilot","Replacement of all usual training"],1,"文中批准的是第二轮试点。长期经费要等对照结果。"),
      q("Which missing comparison most limits the claim that mentoring raised scores?",["The age of each mentor","The cost of the assessment","How similar staff performed under usual training"],2,"没有常规培训组结果，也没有前测。13 人通过只是观察到的结果，无法独立说明因果。")
    ],
    writing:"In 90–130 words, advise Northline whether to fund mentoring permanently. Use one detail from the pilot and name one comparison that would improve the decision.",
    edit:"检查每个因果动词。能否把一处因果断言改成有证据支持的观察，再说明缺少哪项对照？"
  },
  13: {
    theme:"Room to think",speaking:"Describe a place where you do your best thinking. Give one example of something you worked out there.",
    followup:"How could a manager support both people who like to work alone and people who like to discuss ideas?",
    words:[["autonomy","n. 自主权","Staff have autonomy over when to do focused work."],["facilitate","v. 促进，使更容易","A written agenda can facilitate discussion."],["distraction","n. 使人分心的事物","Frequent alerts are a distraction during writing."]],
    phrases:[["to some extent","在一定程度上"],["from my perspective","在我看来"]],
    collocations:[["sustain concentration","保持专注"],["reach a consensus","达成共识"]],
    recall:["A decision that could still change is _____. Use the Day 11 adjective.","tentative"],
    use:"Explain a benefit or drawback of group work. Use sustain concentration or reach a consensus.",
    audioTitle:"Introverts – redressing the balance",slug:"introverts-redressing-balance",
    listening:[
      q("Why might an introvert take on a leadership role, according to the speaker?",["Public attention helps them recharge.","They usually prefer giving instructions.","A situation makes them feel responsible for change."],2,"开场用历史人物挑战领袖形象的刻板印象。演讲者认为行动的动力可以来自具体处境。"),
      q("Which office policy best matches the speaker’s proposal?",["Provide both quiet work areas and opportunities to share ideas.","Reserve leadership positions for quiet employees.","Make every team-building day a solitary activity."],0,"结尾建议给独自思考和共同交流都留出空间，也保留团队活动。")
    ],
    readingTitle:"A quieter floor",
    passage:"A design firm marked one floor as a quiet zone on Tuesday mornings for six weeks. Of the 42 staff who used it at least once, 31 said they found it easier to concentrate. Staff who never used the floor did not receive the questionnaire. Project deadlines and output were not tracked. The firm plans to test the policy on another floor before changing its lease.",
    reading:[
      q("Who provided the survey evidence?",["Everyone working at the company","Employees who had tried the quiet zone","Only employees who completed projects early"],1,"问卷发给使用过安静区域的员工。未使用的员工不在调查样本中。"),
      q("What remains unmeasured?",["The number of users who reported better focus","The length of the pilot","Whether the firm delivered more work or met deadlines more often"],2,"员工自述专注度改善。项目产量和期限达成情况都未追踪。")
    ],
    writing:"Some people think employees should have the freedom to choose where they work, while others believe employers should decide. Discuss both views and give your own opinion. Write at least 250 words.",
    edit:"圈出分别解释两种立场的句子，再核对最后的判断是否与开头一致。重点检查 employees who work 和 each employee works。",fullEssay:true
  },
  14: {
    theme:"Small spaces, better design",speaking:"Describe an object whose design makes it easier to use. Explain the problem it solves, and describe one limitation.",
    followup:"When cities lack space, what should designers prioritise?",
    words:[["compact","adj. 紧凑的","A compact desk fits beside the window."],["capacity","n. 容量","The room has a seating capacity of forty."],["accommodate","v. 容纳，满足需要","The revised plan accommodates wheelchair users."]],
    phrases:[["by comparison","相比之下"],["within reach","在够得着的范围内"]],
    collocations:[["make efficient use of space","高效利用空间"],["impose a limit on","对……设限"]],
    recall:["A new position may offer _____ for growth. Use the Day 12 noun that means opportunity or room to do something.","scope"],
    use:"Explain one choice a designer might make. Use make efficient use of space or impose a limit on.",
    audioTitle:"The helix",slug:"helix",
    listening:[
      q("Why does the lecturer connect a staircase with DNA?",["Each always twists clockwise.","Both can fit a long structure into limited space.","Both have exactly two strands."],1,"两者共享的特点是紧凑。双股属于 DNA 描述，不是所有楼梯都具有的属性。"),
      q("What does the mirror demonstration illustrate?",["The coil can look as though it twists the other way.","A double helix turns into a single helix.","A mirror physically straightens the wire."],0,"镜像改变观察到的旋向。讲者没有说实物变形。")
    ],
    readingTitle:"Two floor plans",
    passage:"A neighbourhood centre is comparing two proposals. Plan A provides 48 seats and 12 square metres of storage. Plan B provides 36 seats and 20 square metres of storage. Both plans allow wheelchair access. The figures are design estimates. The centre has not yet counted how many people attend its busiest evening classes.",
    reading:[
      q("Which comparison is numerically accurate?",["Plan B has twelve more seats.","Plan B offers eight extra square metres of storage.","Plan A provides twice as much storage."],1,"储藏面积从 12 到 20 平方米，相差 8 平方米。"),
      q("What would staff need to know before concluding that 36 seats are enough?",["Whether the two plans have different names","Whether Plan B allows wheelchair access","The number of participants at peak times"],2,"两种方案均允许轮椅通行。高峰出勤尚未统计。")
    ],
    writing:"In 90–130 words, compare the plans for the centre. Report two numerical differences using the correct units. Recommend one further measurement before a decision.",
    edit:"逐个核对比较对象、数字和单位。检查 more seats than 与 more space than 的搭配。"
  },
  15: {
    theme:"What a listing leaves out",speaking:"Describe a place you visited that looked different from what you expected. What shaped your expectations?",
    followup:"What information should people check before choosing a place to live?",
    words:[["disclose","v. 披露","A listing should disclose recurring charges."],["prospective","adj. 未来可能的","Prospective tenants can ask to view the flat twice."],["overlook","v. 忽略","It is easy to overlook noise during a short visit."]],
    phrases:[["on closer inspection","仔细查看之后"],["at first glance","乍看之下"]],
    collocations:[["make an informed decision","作出知情决定"],["raise concerns about","对……提出疑虑"]],
    recall:["The ability to decide how to organise your own work is called _____. Use the Day 13 noun.","autonomy"],
    use:"Describe one thing a visitor should check before renting. Use make an informed decision or raise concerns about.",
    audioTitle:"Renting a house",slug:"renting-house",
    listening:[
      q("What explains the difference between Speaker A’s first impression and later experience?",["An office was removed after the viewing.","New owners replaced the windows.","The viewing took place in a cooler season."],2,"A 在较冷时看房，次年天气变热才感到窗户带来的高温。"),
      q("Why did Speaker D eventually leave?",["The garden was too small.","The landlord’s visits became intrusive.","The tenants were obliged to manage all the bills."],1,"D 起初欢迎帮助，随后房东来得越来越频繁，租户开始躲避。")
    ],
    readingTitle:"A noise survey",
    passage:"Residents near a station sent 60 responses to an online survey. Forty respondents said late trains disturbed their sleep. The local council knows that 500 households received a survey invitation, but the form did not identify households. Several people in one home could each submit a response. Noise readings are due next month.",
    reading:[
      q("Which statement can be reported as written?",["Forty respondents mentioned sleep disturbance.","Forty of the 500 households definitely lost sleep.","Independent sound readings confirm a legal breach."],0,"数据以受访者为单位。一个住户内可能有多人作答。"),
      q("Why can the council not treat the responses as a household count?",["No invitations were sent.","All residents completed the form.","Responses from the same home cannot be identified."],2,"调查没有记录家庭标识，因而无法去重。")
    ],
    writing:"In 90–130 words, summarise what the council can learn from the responses, explain one limitation and recommend one follow-up action.",
    edit:"逐个核对 respondents 和 households 的指代。检查 evidence 作不可数名词时的动词形式。"
  },
  16: {
    theme:"A city beneath the streets",speaking:"Describe an unusual public space you have visited. Explain what you did there and who benefits from it.",
    followup:"Should public spaces be designed mainly for local residents or for visitors?",
    words:[["accessible","adj. 方便到达或使用的","Clear signs make the station accessible to newcomers."],["infrastructure","n. 基础设施","The town needs better cycling infrastructure."],["integrate","v. 整合，使融入","The design integrates the station with nearby shops."]],
    phrases:[["in practical terms","从实际角度看"],["over the course of","在……期间"]],
    collocations:[["improve access to","改善对……的可及性"],["allocate funds to","向……拨款"]],
    recall:["A design that fits into a small area is _____. Use the adjective from Day 14.","compact"],
    use:"Recommend one change to a public space. Use improve access to or allocate funds to.",
    audioTitle:"Catching up after a trip",slug:"catching-after-trip",
    listening:[
      q("Why was Dave anxious before he entered his accommodation?",["He had read accounts of rentals going badly.","The host had cancelled his reservation.","He had seen photographs of damaged windows."],0,"找到公寓之前，他担心的是读到的租房经历。进入后他对实景十分满意。"),
      q("What surprised Dave about walking through the PATH?",["All the shops were closed in winter.","The temperature was below zero inside.","The daylight made it easy to forget he was underground."],2,"Dave 强调里面有自然光，同时指出地下通道能避寒。")
    ],
    readingTitle:"A winter walkway",
    passage:"A city opened a covered walkway linking its station and market. In December the market recorded 15,000 visitors, up from 12,000 the previous December. A new festival also ran for a week that month. Visitor counters recorded entries but did not identify the route people took. The transport office has requested a visitor survey before recommending an extension.",
    reading:[
      q("Which change can the market confirm?",["All 3,000 extra visitors used the walkway.","Entry counts rose by a quarter.","Unique visitors rose by a fifth."],1,"3,000 除以原来的 12,000 是 25%。计数器记录进场次数，不能识别个人或路线。"),
      q("Why is the festival relevant?",["It confirms the survey has taken place.","It made the walkway inaccessible.","It could also have attracted people to the market."],2,"节庆是同时发生的其他变化。数据不能单独归因于步道。")
    ],
    writing:"Cities should spend more on improving existing public spaces than on building new attractions. To what extent do you agree or disagree? Develop your position and support it with examples. Write at least 250 words.",
    edit:"在每个主体段找出主张、理由和例子。检查是否把一次客流变化写成了确定的因果关系。",fullEssay:true
  }
};
let additionalLessons: Record<string,Lesson> = {};
export function registerExtraLessons(extras: Record<string,Lesson>) { additionalLessons = {...extras}; }
export const hasLesson = (day: number): boolean => Boolean(getExercises(day));
const day11 = { theme:"A warning worth noticing", speaking:"Describe a time when you noticed a potential problem and took action before it became serious.", followup:"Why do some drivers ignore warning lights on their dashboards, even when they know it could be dangerous?" };
export function getLesson(day: number) {
  return day === 11 ? day11 : getExercises(day) ?? {theme:"待编排",speaking:"",followup:""};
}
export function getExercises(day: number): Lesson | undefined {return catalogue[day] ?? additionalLessons[day];}
export function sourceUrl(lesson: Lesson) { return "https://learnenglish.britishcouncil.org/free-resources/listening/c1/" + lesson.slug; }
