# 口语模块重构设计（2026-11-19）

参考 ELSA Speak / Speak 的产品形态：分数先行、逐词可交互、纠错可落地、练习成闭环。
约束：零成本诚实模式（owner 选定）——不引入商用发音评估引擎；测不准的不装测准。

## 产品调研依据（2026-11-19）

ELSA 官方 API（elsaspeak.com/en/elsa-api/）的评估维度为 **Overall / Pronunciation /
Intonation / Fluency / Grammar / Vocabulary**，含 sentence/word/phoneme 三级分数、
spoken transcript、Grammar/Vocabulary Highlights、Top Errors、Average Pace、
pausing metrics，以及专门的 **IELTS assessment** 模式。其反馈闭环：
录音 → 分数+转写 → Areas for Improvement → Suggestions → Tips → 词/句/自发口语重练。
配色惯例（第三方评测）：绿=准确、黄橙=需改进、红=读错。

Speak（speak.com）定位会话优先 + 结构化课程 + 口语反馈；评测普遍将其与 ELSA 对比：
ELSA 强在发音/口音纠正（自研音素模型），Speak 强在对话与纠正循环。

**对 Bandroom 的映射（诚实适配）：**
- ELSA 六维 →  IELTS 四科评分卡：FC（已校准韵律 + 参考 band）、LR/GRA（转写结构化
  分析 + 参考 band）、P（建议性，无 band）。ELSA 把 Grammar/Vocabulary 与 Pronunciation
  分开打分——这正是无音素引擎时仍可诚实提供的部分。
- 配色语义诚实反转：ELSA 的红来自验证过的模型；我们的红只来自**学习者自听确认**
  （确实读错），琥珀=检测器建议回听（非断言），绿=自听确认没错。
- Top Errors → 语法问题卡（精确引文→修正→原因）；Average Pace/pausing → FC 证据条
  （语速标"参考"，停顿标"已校准"）。
- 闭环 → drills：原句→改写→TTS 示范→回听→重答（Speak 式 say-it-better）。
- Intonation 维度 v1 不做（F0 仅 consistency_checked，无可呈现校准）；留作后续。

来源：[ELSA API](https://elsaspeak.com/en/elsa-api/)、
[ELSA Pronunciation Coach 评测](https://elsaspeak.com/en/news-events/elsa-speak-review)、
[ELSA 功能综述](https://englishtalky.com/official-elsa-speak-pronunciation-feedback-features-2026/)、
[AI 口语 App 对比评测](https://borderset.com/blogs/posts/top-10-ai-language-learning-apps-2026)、
[Univerbal 2025 指南](https://blog.univerbal.app/ai-language-learning)。

## 0. 前置修复（已交付 b15bde4）

Silero VAD 调用约定错误（512 vs 官方 64-context+512=576）导致全部录音
`speech_duration=0`，流利度证据恒空，批改退化为"请重新录制"。G2 旧
"retest=1.0" 为退化验证（0==0）。已修复调用约定、加非退化门禁、生产回退
`waveform_only`（有人工标注校准）。证据：`G2_RETEST_NONVACUOUS_2026-11-19.json`。

## 1. 产品形态（重构后）

提交录音 → 批改返回后，学习者看到：

1. **评分卡（score-first）**：总体参考 band + 四科卡片
   - 流利度与连贯性 FC：语音占比、停顿剖面（已校准）+ 语速（参考，ASR 词数/语音时长，未校准构念）
   - 词汇 LR：转写词数、多样性、用词问题（LLM 结构化分析，精确引文）
   - 语法 GRA：逐条语法问题（精确引文 → 修正 → 原因），LLM 结构化分析
   - 发音 P：**不给 band**。建议性回听候选（T3）+ 自听确认进度 + 发音画像入口。
     音素断言门禁（Wilson 95% LB ≥ 0.70）未通过前，任何发音分数都是造假。
2. **逐词交互转写**：Whisper 词级时间戳转写，每个词可点击回听自己的片段；
   检测器候选词标琥珀色"建议回听"（非错误断言）；自听确认"确实读错"标红、
   "其实没错"标绿。语法问题卡挂在转写下方。
3. **跟读闭环（drills）**：1–3 个句子级练习：你的原句 → 更自然改写 →
   标准 TTS 示范音频（qwen-audio-3.0-tts-plus，fail-closed）→ 你的片段回听 →
   "重答"入口。Speak 式 say-it-better 循环。
4. **录音质量门**：录音时实时电平表；停止时若全程近静音，提示重录而非提交。
5. 教练散文批改（一至五部分）保留为"教练详评"，规则不变（禁止断言音素错误、
   禁止在散文中给分）。分数只存在于结构化评分卡契约中，带强制状态标签。

## 2. 诚实性契约（bandroom-speaking-scorecard-v1）

每个 criterion 携带 `status`：
- `calibrated`：仅 FC 的停顿/时长指标（人工标注校准的 waveform 检测器）
- `reference`：启发式 rubric 估计（FC/LR/GRA band），UI 必须显示"参考估计，非官方雅思评分"
- `suggestive`：发音层（T3 候选、自听），UI 必须显示"建议性，非错误断言"
- `asr`：转写本身（Whisper，词概率随附）

band 启发式（披露于 UI 与文档）：FC 由 speech_ratio + 停顿密度 + 语速映射到
band 描述符区间；LR/GRA 由 LLM 对转写的问题计数与严重度映射。映射表确定性、
可审计（runner/scorecard.py）。发音 band 恒为 null，直到 T2 门禁通过。

引文校验：LLM 返回的每条 grammar/lexical issue 的 quote 必须是转写子串
（归一化后），否则丢弃该条（fail-closed，不展示无法溯源的"纠错"）。

## 3. 数据流变更

- Stage B 检测器 JSON 已含 Whisper `words`（word/start/end/probability），
  此前仅 predictions 被上报。**新增：transcript 随证据上报**（groundedAnalysis v2）。
- runner 新增 `scorecard.py`：确定性 FC 启发式 + 组装；新增 prompt
  `grounded_scorecard.txt` 请求严格 JSON（grammar issues / lexical notes / drills）。
  与散文批改同一次模型调用不可行（散文规则禁 JSON）→ 独立一次 text 调用，
  成本计入 grounded 预算（~0.05 CNY/次）。
- `lib/coach.ts` feedbackSpec.groundedAnalysis 扩展：transcript + scorecard，
  analysisJson schema 升级 `bandroom-grounded-analysis-v2`（向后兼容 v1 读取）。
- TTS：runner 在 review 时为 drill 句子生成示范音频（contrast_audio 模块，
  fail-closed → status=unavailable，UI 显示"示范音频暂不可用"）。

## 4. UI 插入点

- `app/attempt-feedback.tsx`：af-review 文章改为 Scorecard → Transcript →
  Drills → 教练详评（原 TieredFeedbackProse）→ 自听确认（原 PronunciationCoach）。
- 新组件：`app/speaking-scorecard.tsx`、`app/speaking-transcript.tsx`、
  `app/speaking-drills.tsx`；录音电平表加入 `app/speaking.tsx` Recorder。
- 发音画像面板（report tab）不变，继续吃 speechSeconds（修复后不再恒 0）。

## 交付状态（2026-11-19）

- b15bde4 修复：VAD 调用约定 + 非退化门禁 + 生产 waveform_only + G2 诚实 FAIL 记录。
- 3af9950 Slice 1：scorecard.py + 转写上报 + 传输契约（runner 266 过，tsc 干净）。
- c3f508d Slice 2：评分卡 UI + 逐词交互转写 + 真实电平表（feedback-ui 21/21）。
- 8dbe624 Slice 3：drills TTS 示范音频 + T3 对比音频启用（runner 267 过）。
- 端到端验证：原始故障录音（58.74s）经完整管线 → speech 33.385s、33 词转写、
  四科评分卡（P 不评分）、伪造引文被丢弃、drill 对比音频 ok、传输层完整。
- 生产 runner 镜像已同步（~/.bandroom-runner-prod），下次真实提交即生效。
- **Worker/UI 部署待 owner 明确授权**（红线：不擅自 deploy）。未部署前新反馈
  携带 scorecard 数据，旧 UI 向后兼容忽略；runner 修复（语音不再恒 0）已生效。

## 5. 不做的事

- 不启用 T2 音素断言（门禁未过）。
- 不给发音 band / 音素级分数（无可靠引擎）。
- 不在散文中给分（prompt 规则 9 保留）。
- 不伪造 PASS：G2 稳健性声明已收窄并记录 FAIL。