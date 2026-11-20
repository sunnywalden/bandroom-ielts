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
`waveform_only`（有人工标注校准）。证据（内部保留，NC 语料不进 git）：
`~/.bandroom-acoustic/G2_RETEST_NONVACUOUS_2026-11-19.json`。

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
   标准 TTS 示范音频（qwen3-tts-flash，fail-closed）→ 你的片段回听 →
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
（忽略大小写/标点、按词边界匹配），否则丢弃该条（fail-closed，不展示无法
溯源的"纠错"）。已知残余风险（评审记录）：学习者文字草稿会进入提示词，注入
只能影响其本人的 fix/improved 自由文本（quote 已 fail-closed 校验，improved
仅回灌给本人的 TTS 示范），无跨用户边界。Stage B 关闭时评分卡退化为仅流利度
+ 发音建议层（无转写），这是有意的降级。

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
- **已部署**（owner 授权 2026-11-19）：版本 `9a5f71c7-28fa-4e05-b0fa-afd089bc2652`，
  100% 流量，https://bandroom.sunnywalden0209.workers.dev（拓扑不变：workers_dev，
  无自定义域）。D1 11 个迁移全部在位（含 0010）。配置备份：
  `~/.config/bandroom/wrangler.prod-20261119-speaking-redesign.json`（600）。
  验证：MCP read_study_session 对新版本正常；部署 bundle 含评分卡 UI。
  历史 attempt 的旧反馈（v1 analysis）向后兼容显示散文；**新提交**产出评分卡。
  UI 视觉确认需 owner 的 Access 登录会话。

## 线上验证与修复轮（2026-11-20）

- 重新部署评审修复：版本 `8fc1859b-018a-42b5-a5eb-8ea2d9016de0`（100% 流量），
  配置备份 `wrangler.prod-20261119-speaking-review-fixes.json`。
- 首次真实提交（v2:f5603a46，followup，474 KB）走通新管线：评分卡模型调用成功，
  但写回 toolerror 使 attempt 被 block；真实模型重放后成功保存（receipt
  `rt:f496ff0b-c90f-46d2-9b21-177ac5de8dbc`），落库 v2（41 词转写、3 候选、四科卡、
  P 不评分、2 drills）。原错误无详情 → 已补 `detail` 到 attempt_failed 日志。
- drill TTS 全失败：`qwen-audio-3.0-tts-plus` 对该账户 `InvalidParameter: url error`；
  实测 `qwen3-tts-flash` 同端点同音色正常，已切换并验证真实调用返回音频 URL。
- 评审修复（独立评审 6 项 + 自审 8 项）全部闭环：见提交 1b913d1、632b74a、46e0c06、
  77afa09、dd800aa。

## 残余风险收敛（2026-11-20 第二轮）

| 残余风险 | 处置 |
|---|---|
| learner_draft 提示词注入 → fix/improved 自由文本 | 控制字符清洗 + 长度上限（300）；quote 词边界 fail-closed；improved 仅回灌本人 TTS；无跨用户边界 |
| Stage B 关闭时评分卡退化 | 转写读取与 self_listen 解耦（缓存命中即可用），LLM 调用仍受 scorecard_enabled/预算控制 |
| 瞬时写冲突（真实一次 toolerror） | 已知瞬态消息（re-read session / writer contention）分类为可重试，不 block；下一次运行自愈 |
| 错误详情泄密 | `redact_error_detail`：Bearer/API key/token/secret 等模式脱敏后再入日志与 state；长度 300 |
| 超大分析写入 | 整体 payload 256 KiB 后挡（单项已有 64 KiB/2000 词上限） |
| 评分卡成本未记账 | scorecard_model_usage 事件补 costCny |
| TTS URL 过期 → 坏播放器 | 示范音频 onError 降级为"链接可能已过期"回退；T3 对比播放器原有 error 状态 |
| 非流式重试重复扣费 | 仅在实际发起调用的路径预扣（已修）；重试即真实重调，扣费与调用对齐 |

以上均有测试锁定；无新增 Worker 契约变更（运行器侧 + UI 回退）。
最终部署：版本 `fce97a96-4863-460e-bba7-4a504b80e818`（100% 流量，PR #41 合并后从 main 构建），
配置备份 `~/.config/bandroom/wrangler.prod-20261120-main-fce97a96.json`。

## 5. 不做的事

- 不启用 T2 音素断言（门禁未过）。
- 不给发音 band / 音素级分数（无可靠引擎）。
- 不在散文中给分（prompt 规则 9 保留）。
- 不伪造 PASS：G2 稳健性声明已收窄并记录 FAIL。