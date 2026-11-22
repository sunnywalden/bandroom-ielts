# 口语模块体验与完整度优化设计（2026-11-22，修订 2）

本文在 2026-11-19 口语重构（评分卡 / 逐词回听 / 跟读示范 / 自听确认）之上，
给出下一阶段的产品方案。目标不是再增加几个反馈卡片，而是把口语从
**“单次作业提交”** 变成 **“可重复、可验证、可延续的训练闭环”**。

> 修订 2（2026-11-22）为代码复核后的闭环版：修正了轮询“死路”、
> `completed` 需手动重读、`processing_budget_exhausted` 含义、`nextAt` 字段名、
> 报告 `conditions` 误判等表述；补齐了 `currentPhase` 阻塞多题 Part 3、
> mock 误写 `speakingComplete`、attempt id 白名单、进度接口读取全文转写、
> 状态 JSON 上限等设计缺口。逐条评审记录见 §13。

> 前提：继续遵守 `bandroom-speaking-scorecard-v1` 的诚实契约。
> 发音 band 恒为 `null`；T2 音素断言不开；不伪造 PASS；不把“变化”说成“进步”。

---

## 0. 一页结论

### 0.1 诊断

当前口语模块已经解决了“**一次录音能不能得到诚实、可行动的结构化反馈**”。
但它仍是一个 **单发、单题、单端** 的功能：

| 断点 | 现状 | 用户实际感受 |
|---|---|---|
| 内容 | 只有 Part 2 + 1 个追问；仓库内仅 Day 11–16 有口语题（生产可由 `publish_lesson` 补充，需核实 D1） | “每天都是同一套题” |
| 到达 | 批改依赖本地 runner；断开时任务停在队列/重试；页面已有自动刷新，但 30 分钟后静默停更，状态文案仍用 “Work” | “交完作业不敢离开页面” |
| 练习 | 有示范音频，但跟读句不能单独录；重答从空白开始 | “看懂了，但没有真正练会” |
| 延续 | 自评是固定三选一，不来自本次证据，也不进入下一次 | “每次都在重新开始” |
| 进步 | 报告只统计“第几次、有无录音” | “看不到自己是否在变好” |
| 完整度 | 无 Part 1、无完整 Part 3、无模考、无题库轮换；Part 3 的多题还会被 `currentPhase` 提前判为“已进入复盘” | “这不是一个完整的雅思口语产品” |

一句话：**反馈已经及格，训练还没闭环。**

### 0.2 设计命题

把一次口语练习拆成四条闭环，每条闭环都必须有明确的“完成信号”：

1. **录音闭环（0–2 分钟）**：能开始、能暂停/取消、能恢复、不会丢。
2. **批改闭环（当天）**：提交后有据可查；结果自动到达；没有死路。
3. **练习闭环（同一次会话）**：能针对被指出的句子重录；能对比“原句 / 示范 / 新录”。
4. **跨天闭环（周/月）**：上次的焦点进入下次开口；趋势可见；只呈现有状态标签的证据。

### 0.3 P0 清单

| # | 包 | 解决的问题 | 规模 | 依赖 |
|---|---|---|---|---|
| P0-1 | 批改到达与状态可信 | 反馈不到、状态看不懂、30 分钟后静默停更 | S | 无 |
| P0-2 | 个性化焦点延续 | 固定三选一、下次不衔接 | S | P0-1 |
| P0-3 | 跟读重录与重答对比 | 练习停在“听”，没有“再录一次” | M | P0-2 |
| P0-4 | 三部分会话与题库 V1 | 内容不完整、题目不轮换 | L | 内容供给 |
| P0-5 | 纵向进步面板 | 跨天不可见 | M | P0-1 |
| P0-6 | 录音稳健性与无障碍 | 移动端/权限/丢录音/误操作 | M | 无 |

建议顺序：P0-1 → P0-2 → P0-6（前半）→ P0-4 → P0-3 → P0-5。
P0-1/P0-2 是低成本、高感知的“先止血”；P0-4 决定产品完整度上限；
P0-3/P0-5 把“练习”和“进步”变成可见事实。

---

## 1. 现状审计（代码证据）

### 1.1 已经做对、必须保留的部分

- **诚实三层契约**：`calibrated / reference / suggestive / asr` 状态标签贯穿评分卡；
  发音卡 `band === null`（`runner/scorecard.py:245-254`）。
- **逐词可回听**：Whisper 词级时间戳 + `/api/audio` Range/206，点击任一词播放精确片段
  （`app/speaking-scorecard.tsx:70-141`）。
- **精确引文纠错**：grammar/lexical issue 必须逐字出现在转写中，否则丢弃
  （`runner/scorecard.py:257-298`），UI 不展示无法溯源的“纠错”。
- **自听确认**：红/绿只来自学习者本人裁决，琥珀只是检测器“建议回听”
  （`app/speaking-scorecard.tsx:77-85`）。
- **失败关闭**：TTS 示范不可用时显示诚实回退；对比音有来源链
  （`docs/pronunciation.md`）。
- **录音恢复**：IndexedDB 草稿、上传失败保留、重挂载恢复、登录过期锁定
  （`tests/speaking-workflow.mjs` 已锁定这些行为）。

### 1.2 体验断点

| 阶段 | 代码事实 | 用户代价 |
|---|---|---|
| 开始练习 | 无设备检查、无倒计时；`Recorder` 手动开始（`app/speaking.tsx:115-302`） | 权限弹窗、选错麦克风、刚开口就错过 |
| Part 2 准备 | `PrepTimer` 手动重置 60 秒（`app/speaking.tsx:77-105`）；题卡无 4 个提示点 | 不像真实考试；容易无话可说 |
| 作答上限 | Part 2 固定 120 秒、追问 60 秒（`app/speaking.tsx:400`）；无暂停、无 15 秒提醒 | 被硬切；长答案没有准备 |
| 批改等待 | 依赖 runner；断开后提示“Work 领取了任务但连接已断开”（`app/attempt-feedback.tsx:51`） | 状态不可信；不知道还要不要等 |
| 等待放弃 | 排队/运行/完成未取回都会轮询；30 分钟后 interval 被静默清除，但 focus/visibility 仍会刷新一次（`app/studio.tsx:140-176`） | 页面不提示“自动刷新已停更”，误以为结果还会自动出现 |
| 完成未取回 | 已有自动轮询与“重新读取反馈”，不是手动死路（`app/studio.tsx:144-176`、`app/attempt-feedback.tsx:50`）；绑定持续失败时没有升级出口 | 少数绑定失败会一直显示“正在读取” |
| 多题 Part 3 | `currentPhase` 在第一个 `speakingFollowup` 后即返回 `review`（`app/speaking-draft.ts:17-20`） | 第二题无法进入；题目一多就被判“已复盘” |
| 模考完成 | `finish()` 不分场景写 `speakingComplete:"yes"`（`app/speaking.tsx:449-455`） | 模考可能被误记为当天口语已完成 |
| 自评 | 固定三句 `priorities`（`app/speaking.tsx:24`），与本次证据无关 | 感觉是模板，不是教练 |
| 跟读 | `Drills` 只播放示范和原句（`app/speaking-scorecard.tsx:177-198`） | “听懂了”但没有“说出来” |
| 重答 | 重答从空白开始；无两次作答对比 | 无法确认是否改掉问题 |
| 报告 | 只统计“Part 2/追问 · 第 n 次 · 有录音”（`app/reports.tsx:74-78`） | 看不到流利度/问题数的趋势 |
| 完整度 | 仓库内仅 Day 11–16 有口语题（`app/curriculum.ts:17-136`）；`hasLesson` 控制能否开始下一天（`app/studio.tsx:235`），但无法判断生产 D1 是否已发布 Day 17–62 | 未发布时进不去下一天；已发布但 `speaking` 为空时仍需题库兜底 |
| 发音体验 | 画像与趋势面板存在，但藏在报告深处 | 高频、可行动的进步信号被埋没 |
| 术语 | 学习者界面出现 “Work”“接管”“复制请求” | 不知道 Work 是什么，也不知道要做什么 |

### 1.3 完整度矩阵

图例：✅ 已有且可用 · ◐ 部分 · ○ 缺失

| 能力 | 现状 | 目标 |
|---|---|---|
| Part 1 热身 | ○ | ✅ 每日 2 题，可不批改 |
| Part 2 题卡 | ◐ 有题面，无 4 个提示点/笔记/自动准备 | ✅ 完整题卡 + 笔记 + 60 秒准备 |
| Part 3 讨论 | ◐ 仅 1 题 | ✅ 每日 2 题；完整练习 3 题 |
| 全真模考（11–14 分钟） | ○ 只能在报告里手工登记成绩 | ✅ 严格计时、整场批改、练习模考声明 |
| 题库与轮换 | ○ 题目写死在 6 个 lesson 内 | ✅ 原创题库 + 按主题/弱项轮换 |
| Day 17–62 内容 | ○ 仓库内无；依赖教练发布 | ✅ 每个可开始的日子都有口语题 |
| 录音与恢复 | ✅ | ✅ 增加设备检查/倒计时/暂停/上传队列 |
| 逐词回听 | ✅ | ✅ 增加句子模式/慢速/键盘 |
| 语法/词汇纠错 | ✅ | ✅ 保持 |
| 诚实发音层 | ✅ 设计如此 | ✅ 保持，不升级为分数 |
| 跟读示范 | ✅ | ✅ 增加逐句重录 |
| 重答 | ✅ | ✅ 增加同题对比 |
| 焦点延续 | ○ | ✅ 证据生成 + 下次显示 |
| 批改到达 | ◐ runner 依赖 | ✅ 收件箱/退避/恢复/明确下一步 |
| 跨天指标 | ○ | ✅ 状态标签 + 样本量 + 置信区间 |
| 移动端/离线 | ◐ IndexedDB 恢复 | ✅ 上传队列/唤醒锁/前后台处理 |
| 无障碍 | ◐ 已有焦点样式/reduced motion | ✅ 倒计时播报/键盘操作/焦点管理 |
| 通知 | ○ | ◐ 应用内未读（P0）/ Web Push（P2） |

---

## 2. 设计原则

1. **诚实优先于完整**：任何新指标必须携带状态；发音永不出现 band。
2. **呈现变化，不宣布进步**：可以说“语音占比 61%→70%”，不能说“流利度进步 1 分”。
   只有校准指标可做差值；参考/建议性指标只列原始值与样本量。
3. **一次只改一件事**：每次批改只生成 1 个主焦点 + 2 个备选；下次开口先看焦点。
4. **先给下一步，再给解释**：每个失败状态都必须有一个可点击的下一步。
5. **可恢复性 > 流畅性**：宁可多一次确认，不可丢一段录音。
6. **内容原创、可审计**：题库不得复制雅思真题/剑桥材料；每条题目有稳定 ID 与来源。
7. **低成本路径优先**：热身不批改、焦点确定性生成、趋势本地聚合，避免无谓的 LLM 调用。

---

## 3. 目标体验

### 3.1 每日 15 分钟（默认）

```
[上次焦点] → [Part 1 热身 ×2（不批改）] → [Part 2：题卡+笔记+60s 准备+120s]
           → [Part 3 ×2（首题批改，次题可选）] → [自评：确认/调整焦点]
           → [提交批改] → [批改返回：评分卡 → 转写 → 跟读 → 重录]
```

- 只有 **2 段录音进入批改**（Part 2 + Part 3 首题），控制成本与等待。
- Part 1 与 Part 3 次题是“开口热身”：可回听、可自评，不产生 runner 任务。
- 会话阶段由 `entry.speakingSession`（服务端状态）驱动；`localStorage`/IndexedDB
  草稿只用于恢复尚未提交的输入，**不单独决定当前步骤**。两者冲突时保留草稿并
  提供“继续未提交录音 / 以服务端进度为准”的选择（§4 P0-4）。
- 提交后可以继续别的模块；页面顶部有“批改收件箱”，返回时自动刷新。

### 3.2 每周完整练习（20–25 分钟）

- Part 1 ×3（热身）→ Part 2 → Part 3 ×3（全部批改）。
- 结束时生成 **本次会话报告**：各 Part 证据卡 + 焦点完成情况 + 与上次同题对比。
- 明确标注“练习场，不是官方成绩”。

### 3.3 考前模考（11–14 分钟）

- 严格计时：Part 1 4–5 分钟、Part 2 3–4 分钟、Part 3 4–5 分钟。
- 不可暂停、不可回看前题；结束前不显示逐题反馈。
- 开始前显示批改段数与预算估算；预算不足时明确降级（只批改 Part 2+3 首题），
  不静默丢任务。
- 模考数据写入独立的 `speakingMock` / `speakingMockSession`，**不写
  `speakingComplete`、`speakingReview`，也不自动生成 `fullTests` 记录**；
  它只是练习模考，完成 Day 仍需单独打卡。
- 结束后输出 **整场报告**，并标注“练习模考，非官方成绩”。
- 无障碍例外：允许一次“非计时暂停”，恢复后整场标记为 `timed:false`，
  只显示“计时不完整”，绝不把它当作严格模考成绩呈现。

### 3.4 回访（批改到达）

- 离开页面 → 返回：顶部“2 份批改已返回”；无需手动复制。
- 若批改服务未连接：显示“等待批改服务连接”，提供“检查连接 / 手动交给教练”；
  不出现“Work 状态：xxx”。

---

## 4. P0 方案

### P0-1 批改到达与状态可信（S，约 1 周）

**问题**

- 学习者界面大量出现内部术语 `Work`（`app/attempt-feedback.tsx:36,51-59,127-140`；
  `app/studio.tsx:273`）。`copyManualRequest` 会先 `POST /api/review-tasks/takeover`
  再复制请求（`app/attempt-feedback.tsx:124-137`），接管后自动批改不会继续，但 UI
  没有把这一后果说清楚。
- 轮询并非“30 分钟后死路”：页面已对 `focus`/`visibilitychange` 刷新，也会自动
  拉取 `completed` 但尚无反馈的任务（`app/studio.tsx:144-176`）。真正的缺口是
  30 分钟后 `clearInterval` 静默停更，页面仍显示旧状态，用户不知道自动刷新已暂停。
- `blocked` 与 `needs_attention` 是两种不同结果：前者来自不可重试的
  `fail_review_task`/同意撤回/DSR（`lib/review-tools.ts:132`、`lib/consent.ts:120`），
  后者来自自动重试次数或任务年龄耗尽（`lib/review-tasks.ts:162,239`）。
  当前 UI 没有为两者分别给出下一步。
- `processing_budget_exhausted` 的真实含义是“自动重试次数已用完”
  （`app/attempt-feedback.tsx:40-43`），不是“今日额度用完”。
- 自动化预计时间字段是 `automation.nextExpectedAt`（`lib/coach.ts:198-211`）；
  任务自身的 `nextAt` 是重试时间（`app/feedback-model.ts:49-53`），不能混用。

**方案**

1. **术语统一**：学习者侧统一为“教练批改 / 批改服务”。
   - `Work 正在分析…` → `教练正在分析录音…`
   - `已保存，等待 Work 领取。` → `已排队，等待批改服务。`
   - `待在 Work 中发起` → `等待提交批改`
   - `粘贴到 Work 会话` → `交给教练批改`
   - 接管时明确写：“本次批改将交给你的教练会话完成，自动批改不会再领取。”
   - 内部实现名保留在代码/运维文档，不出现在 UI。
2. **批改收件箱**：复用 `/api/coach` 已返回的 `reviewTasks` 与 `feedback`。
   - 顶部 badge：`completed 且未绑定反馈` + `needs_attention` + 可处理的
     `blocked`（同意撤回/DSR 等不可恢复的 `blocked` 只显示原因，不计入待办）。
   - 点击跳转到对应 Day/attempt；`localStorage` 记录已读，服务端状态为准。
   - 跨设备未读状态是“尽力而为”，不得因本地已读而隐藏真正未返回的批改。
3. **轮询生命周期**：
   - 保留现有 `focus`/`visibilitychange` 立即刷新与 `completedUnfetched` 自动拉取。
   - 活跃等待时退避：3s → 5s → 10s → 30s → 60s → 300s（不再固定 3s 空转）。
   - 30 分钟后**不静默停止**：降为 5 分钟一次，并在收件箱显示
     “自动刷新已降频，点击可立即刷新”；页面隐藏时暂停，恢复可见时立即刷新一次。
   - `automation.connected === false` 时最低 60s 一次，不按 3s 轮询。
   - `completed` 但反馈未绑定：继续自动读取；连续 2 次失败才显示
     “重新读取反馈”，并同时给出“交给教练”出口——**不需要用户一开始就手动复制**。
4. **诚实 ETA**：只在 `automation.connected && automation.nextExpectedAt` 存在时
   显示“预计下次检查”；否则显示“等待批改服务连接”，不编造时间。
   任务 `retry_wait` 显示自己的 `nextAt`，并注明“重试时间，不是完成时间”。
5. **失败即下一步**：

   | 状态 / `lastError` | 学习者看到的文案 | 下一步 |
   |---|---|---|
   | `queued` / `retry_wait` | 已排队 / 等待重试 | 自动等待；连接断开时提供“检查连接 / 交给教练” |
   | `running` | 教练正在分析录音… | 可离开页面；回来自动刷新 |
   | `completed` 未绑定反馈 | 结果已生成，正在读取 | 自动重试；2 次失败后“重新读取” |
   | `blocked` + `temporary_read_failure` | 读取原录音暂时失败 | 重新读取原录音 / 重录 |
   | `blocked` + `recording_missing` / `recording_digest_mismatch` | 原录音不可用 / 校验未通过 | 重新上传或重录；不静默重试 |
   | `needs_attention` + `processing_budget_exhausted` | 自动重试次数已用完 | “交给教练批改 / 明天再试” |
   | `blocked` + `analysis_required` | 尚未取得声学证据 | 等待重试 / 交给教练 |
   | `blocked` + `qualified_analyzer_unavailable` | 声学分析器暂不可用 | 稍后自动重试 / 交给教练 |

6. **提交回执**：提交后固定显示一张“批改单”（题目、提交时间、状态、录音可回听），
   刷新/换设备后仍可从服务端状态找回。

**UI 插入点**：`app/attempt-feedback.tsx`（文案、状态机、回执）、
`app/studio.tsx`（轮询、顶部 badge）、`app/feedback-model.ts`（状态类型可选扩展）。

**验收**

- 排队中离开页面 40 分钟再回来：若 runner 已连接，结果自动出现；若超过 30 分钟，
  页面明确显示“自动刷新已降频”，而不是静默停更。
- 任意任务状态都有可执行的下一步；学习者 UI 中不再出现 “Work”。
- 未读 badge 数与 `completed && !feedback` + `needs_attention` + 可处理 `blocked`
  的数量一致。
- 断网/恢复后不丢状态，不产生重复上传。
- 接管后文案说明“自动批改不会再领取”，不继续把任务显示为“等待中”。

**测试**：扩展 `tests/feedback-ui.mjs`、`tests/speaking-workflow.mjs`；
fake timers 模拟 35/40 分钟与 `visibilitychange`；断言 30 分钟后仍保留低频 timer；
逐项断言 6 种 `lastError` 的文案与动作；断言无 “Work” 文案。

**风险**：托管 runner 未启用时，退避轮询会长期空转 → 必须同时显示“服务未连接”，
页面隐藏时完全暂停，断连时最低 60s 一次。

---

### P0-2 个性化焦点延续（S，约 3–5 天）

**问题**

- `priorities` 是固定三句（`app/speaking.tsx:24`），与本次评分卡无关。
- 焦点只存进 `speakingReview` 文本；`finish()` 要求它非空
  （`app/speaking.tsx:449-455`），且下一次开口时既不显示也不使用。
- `Speaking` 的 props 里没有 `feedback`
  （`app/studio.tsx:273`），组件拿不到评分卡；需要先补数据通路，否则焦点生成无输入。

**方案**

1. **数据通路**：`studio.tsx` 把 `feedback`（或最小投影
   `{attemptId, scorecard, transcriptWords}`）传给 `Speaking` / `AnswerTask`；
   不在 `Speaking` 内重新请求。若担心耦合，改为在 `FeedbackProvider` 下渲染一个
   只读 `FocusHint`，但 props 仍是最小改动。
2. 新增纯函数 `app/speaking-focus.ts`，从最近一次评分卡确定性生成焦点：
   - 优先级 1：学习者**自听确认**的词（`verdict === 'confirmed'`）；文案只说
     “把这 2 个词放慢读一遍，再自听确认”，不声称音素错误。
   - 优先级 2：`major` 语法问题 → “把「quote」改说成「fix」”，quote/fix 均来自
     已校验的评分卡。
   - 优先级 3：校准流利度 → 语音占比 < 0.55 或长停顿占比 > 15% 时，
     “先列两个要点，把 ≥1 秒停顿压到 2 次以内”。
   - 优先级 4：drill 的 `focus_zh` → “用「improved」的句式回答下一题”。
   - 优先级 5：词汇建议 → “把「quote」换成「suggestion」”。
   - 无反馈时：使用题库主题生成“说满 30 秒 + 一个具体例子”。
3. 数据结构：`entry.speakingFocus`（JSON 字符串）：

```ts
type SpeakingFocus = {
  id: string;                 // 稳定 hash，用于跨天去重
  kind: 'pronunciation'|'grammar'|'fluency'|'lexical'|'drill'|'topic';
  text_zh: string;
  source?: { attemptId?: string; quote?: string };
  createdAt: string;
  status: 'active'|'done'|'dismissed';
};
```

4. **生成与覆盖规则（防止覆盖用户决定）**：
   - 同一 `source.attemptId` 只生成一次；已存在 `status:'done'|'dismissed'`
     的焦点不被自动覆盖。
   - 仅当出现**更新的 attempt** 且旧焦点仍为 `active` 时才替换，并保留
     “上次焦点”历史（最多 5 条）。
   - `speakingReview` 在 `finish()` 成功后冻结：之后的反馈生成不得回写它；
     焦点只写 `speakingFocus`。这样批改绑定与历史复盘文本都不会被改写。
5. **交互**：
   - 下次口语开始页显示“上次的练习点”卡片（可展开证据、可换一个、可关闭）。
   - 自评页默认选中该焦点，允许编辑或自定义；不再强制三选一。
   - **焦点可选**：`finish()` 改为只在焦点存在时保存，不再以 `!focus` 阻止完成；
     焦点为空或用户关闭时直接完成，不写空字符串。
   - 旧数据兼容：旧的固定三句文本仍按普通 `speakingReview` 展示，不试图解析成
     `SpeakingFocus`；只有 `speakingFocus` 存在时才渲染新卡片。
6. 反馈返回后的 `FocusReview`：
   - 展示与本焦点相关的证据：校准指标数值、问题条数（reference）、自听词数。
   - 由学习者勾选“这次用到了 / 还没做到”，**不自动宣布已改正**。

**验收**

- 焦点在刷新、换天、换设备后仍存在。
- 新会话开始页 100% 显示当前焦点（若有）。
- 旧数据（`speakingReview` 为固定三句之一）仍可读取，不破坏批改绑定。
- 已 dismiss / done 的焦点不会被新反馈自动复活或覆盖。
- 焦点为空时也能完成自评；`speakingReview` 完成后不再被改写。
- 焦点文案不含“发音错误”“准确率”“进步”等断言。

**测试**：`tests/speaking-focus.test.mjs`（新）：各优先级 golden case、
同 attempt 幂等、done/dismissed 不被覆盖、legacy 兼容、确定性（同输入同输出）。

---

### P0-3 跟读重录与重答对比（M，约 1.5–2 周）

**问题**

- `Drills` 只有播放（`app/speaking-scorecard.tsx:177-198`）；`SpeakingScorecard`
  的 props 只有 `analysis/recordingId/verdicts`（`:200`），没有 attempt 身份，
  取回录音后无法把重录归属到具体批改。
- 重答按钮只回到空白题面（`app/speaking.tsx:481-484`），没有“上次 vs 这次”。
- `/api/audio` 的上下文上传只接受 `phase=part2|followup` 和 uuid attempt
  （`app/api/audio/route.ts:46-57`）；drill take 与 Part 1/模考录音需要走通用上传
  或扩展 phase 白名单，否则会被 400 拒绝。

**方案**

1. **逐句重录**：每张 drill 卡增加“录这一句”（上限 15 秒）。
   - `SpeakingScorecard` 新增 `attemptId` prop（由 `ReviewRow` 传入
     `row.attempt`），并透传给 `Drills`；没有 attemptId 时禁用重录按钮。
   - 存 `entry.speakingDrillTakes`：
     `{drillKey, attemptId, at, audio, selfRating, durationMs}`。
   - `drillKey = attemptId + ':' + hash(normalized(quote)) + ':' + hash(improved)`。
     **attemptId 必须入 key**：同一句在不同次批改中重复出现时，不能把两次的新录音
     混成同一条。
   - 上限：每 drill 3 条、每会话 12 条、每条 ≤ 15 秒；超限时替换同 key 最旧一条
     并提示，不无限增长状态 JSON。
   - 上传：优先复用通用 `POST /api/audio`（返回 uuid）并在队列里先持久化 id 再清
     pending；若使用上下文路径，需把 phase 白名单扩为 `part1|part2|part3|followup|mock`
     （服务端校验同步更新）。不进入 runner 批改，因此零 LLM 成本。
   - 播放组：`示范（TTS） / 你的原句 / 你的新录音`，可 0.75× 慢放；
     新录音只做自听，不给分。
2. **重答带焦点**：重答页顶部固定显示“本次只练：…”，提交后继续走现有批改队列。
3. **同题对比** `AttemptCompare`：
   - 新条目：以 `questionId` 精确匹配；仅当两次作答都有反馈时显示。
   - 旧条目没有 `questionId`：使用 `lesson:<day>:<hash(prompt)>` 作为等价键；
     `hash` 使用同一规范化（小写、折叠空白、去标点）。
   - **旧新不混比**：旧条目之间可按键比较；旧条目与新条目只在键完全一致时比较，
     且 UI 标注“旧版题目/流程，对比仅供参考”。无法确定同题时不显示对比。
   - 校准 FC：语音占比、语音时长、总时长、停顿数、长停顿秒数；并列原值 + 差值。
   - 参考层：WPM、语法问题数、词汇问题数；标注“转写差异会影响计数”。
   - 建议层：建议回听词数；**不计算“发音进步”**。
   - 固定提示：“录音时长不同会影响占比与停顿计数，请结合原值阅读。”
   - 不出现“总分提高”标题；只呈现事实。
4. **练习完成信号**：学习者可标记“这句我练顺了 / 还需要练”，写入 drill take；
   不声称客观达标；同一 drill 以最后一次标记为当前状态。

**验收**

- 逐句录音刷新后仍可回放；三个播放器均可独立工作。
- 同一句在不同 attempt 下的重录互不覆盖。
- 对比只在同题同 Part 出现；发音永远不出现 band。
- 对比页无“进步/退步”断言，只有数值与状态标签。
- 旧 attempt 不因新增字段改变 id（golden test）。
- 离线重录恢复后不产生孤儿/重复对象；超限时有明确提示。

**测试**：`tests/speaking-compare.test.mjs`（新）；扩展 `feedback-ui.mjs`；
合成音频与 fake timers；断言 attemptId 参与 drillKey、旧新不混比、上传队列去重。

---

### P0-4 三部分会话与题库 V1（L，约 2–3 周）

**问题**

- 只有 Part 2 + 1 个追问（`app/feedback-model.ts:66-75` 只枚举两个字段）。
- `currentPhase` 在出现第一个 `speakingFollowup` 后就返回 `review`
  （`app/speaking-draft.ts:17-20`）；不替换它，多题 Part 3 与模考根本无法进入。
- `answers()` 只保留 `spoken === true` 的条目（`app/speaking-draft.ts:6-15`）；
  Part 1 若按普通对象写入会被静默丢弃。
- `finish()` 不分场景写 `speakingComplete:"yes"`（`app/speaking.tsx:449-455`），
  模考会误占当天口语完成状态。
- 仓库内仅 Day 11–16 有口语题（`app/curriculum.ts:17-136`）；
  `hasLesson = Boolean(getExercises(day))`（`:130-141`）控制能否开始下一天。
- 无 Part 1、无完整 Part 3、无模考、无题库轮换。
- 状态 JSON 单次保存上限 1 MiB（`app/studio.tsx:184-185`）；
  新增数组若无上限会在长期使用后触顶。

**方案**

1. **原创题库** `app/speaking-questions.ts`：

```ts
type SpeakingQuestion = {
  id: string;                 // 'p1-work-01' / 'p2-place-03' / 'p3-design-02'
  part: 1|2|3;
  topic: string;              // work / place / design / expectations / public-space / warning ...
  prompt: string;
  bullets?: string[];         // Part 2 四个提示点
  linked?: string[];          // Part 2 ↔ Part 3 主题关联
  source: 'authored';
  version: 1;
};
```

- V1：12 个主题 ×（Part 1 3 题 + Part 2 1 张题卡 + Part 3 4 题）≈ 96 题。
- 全部原创；不复制剑桥/雅思真题。测试校验 ID 唯一、无空字段、Part 2 必有 4 个 bullet。
- Day 绑定：优先 lesson 的 `speaking`/`followup`；**仅当该 Day 已有 exercises
  但口语字段缺失时**按主题从题库选。题库不能把 `hasLesson === false` 的 Day 变成可开始；
  Day 17–62 的可达性仍取决于 lesson 供给（见下方“内容供给”）。

2. **会话状态机** `app/speaking-session.ts`（纯 reducer，可测）：

```
intro → part1(q0…qn) → prep → part2 → part3(q0…qn) → review → done
```

- **替换 `currentPhase`**：新增 `phaseFor(entry)`，优先读取
  `entry.speakingSession.phase + qIndex`；只有 `speakingSession` 缺失或 JSON 无效时，
  才回退到旧 `currentPhase`（保证历史进行中的会话可继续）。
- `Speaking` 不再用 `retake` 局部状态决定阶段；retake 作为 reducer 的
  `{mode:'drill'|'reanswer', questionId}` 动作并入会话。
- 状态持久化到 `entry.speakingSession`；刷新/换设备按 `phase + qIndex` 恢复。
- 计时以持久化的 `startedAt/deadlineAt` 为准（`Date.now()` 差值），不累计
  `setInterval` tick；后台节流或息屏不会白送时间。超时在恢复时立即停止并进入下一步。
- 每日模式：Part 1 ×2（`reviewed:false`）→ Part 2 → Part 3 ×2（首题 reviewed）。
- 完整模式：Part 1 ×3（不批改）→ Part 2 → Part 3 ×3（全部 reviewed）。
- 模考模式：严格计时、不可暂停、结束前不显示逐题反馈、结束后批量排队
  （无障碍例外见 §3.3：一次非计时暂停 → `timed:false`）。

3. **作答数据**（仅新增可选字段，旧数据不变）：

```ts
type SpeakingAnswer = {
  at: string; text: string; audio?: string; spoken: true; local?: boolean;
  sessionId?: string; part?: 1|2|3; questionId?: string; seq?: number;
  mode?: 'daily'|'full'|'mock'; notes?: string; reviewed?: boolean;
};
```

- `speakingPart1` / `speakingPart2` / `speakingFollowup` 继续作为三个数组；
  Part 3 全部用 `speakingFollowup`，用 `seq` 区分。`answers()` 可直接复用，
  但**必须写 `spoken:true`**（`app/speaking-draft.ts:14` 会过滤掉非 `true`）。
- 模考独立存储：`speakingMock`（答案数组）、`speakingMockSession`
  （`{id, mode:'mock', phase, qIndex, startedAt, deadlineAt, timed}`）、
  `speakingMockComplete`（只有整场结束才写）。**不写**
  `speakingComplete` / `speakingReview` / `fullTests`。
- **`reviewed` 语义**：
  - Part 1 与热身题永不进入 `reviewAttempts`（字段白名单根本不含 Part 1）。
  - `speakingPart2` 恒批改。
  - `speakingFollowup` 只在 `reviewed !== false` 时生成任务；旧条目没有该字段，
    视为 `true`，行为不变。
  - `speakingMock` 只在 `speakingMockComplete && mode==='mock'` 时生成任务，
    `field:'speakingMock'`；任务标题按 `part + seq` 生成，不能沿用“重答 N”。
- **任务标题**：`speakingFollowup` 新条目用 `口语 Part 3 · 第 ${seq+1} 题`
  （有 `questionId` 时可带主题）；旧条目保持 `首次回答 / 重答 N`。
  `speakingMock` 用 `练习模考 · Part ${part} · 第 ${seq+1} 题`。
- **attempt id 稳定性**：见 §7.2 的显式白名单；`notes/reviewed/seq/part/mode/sessionId`
  一律不进入 hash。
- **状态预算**：
  - Part 1 ≤ 40 条、Part 3 ≤ 40 条、mock ≤ 30 条、focus 历史 ≤ 5 条、
    drill take ≤ 12 条；notes ≤ 2 KB；超限时按最旧条目淘汰并提示“已移除最旧记录”。
  - 保存前估算字节数；接近 1 MiB 时先淘汰草稿/最旧热身，再保存；仍超限则
    明确提示“保存失败，请导出后清理”，**不静默丢数据**。

4. **题卡与计时**：
   - Part 2 显示 4 个 bullet、笔记框（≤ 2 KB，仅本地/状态，不当作转写文本）、
     60 秒准备（10 秒提醒）、“提前开始”。
   - 作答上限：Part 1 40 秒、Part 2 120 秒、Part 3 60 秒；最后 15 秒提醒并自动停止。
   - 练习模式可暂停（覆盖层显示“已暂停 00:12，不计入录音”）；模考模式禁用暂停，
     仅保留无障碍例外。
   - 录音上传：Part 1 与 mock 需要扩展 `/api/audio` 的 phase 白名单
     （`part1|mock`；Part 3 继续用 `followup`），或统一走通用上传；
     两条路径都要有 owner/租户校验与配额。

5. **模考报告**：所有批改返回后，按 Part 聚合：
   - 每 Part 的评分卡摘要 + 逐词转写入口；
   - 全场时间线（准备/作答/停顿），`timed:false` 时只显示“计时不完整”；
   - “练习模考，非官方成绩”固定声明；
   - 部分返回时显示“3/6 已返回”，不阻塞其他结果；
   - 结束时只标记 `speakingMockComplete`，不标记当天口语完成；完成 Day 仍需
     单独的打卡/自评流程。

**内容供给（硬依赖）**

- 仓库内只有 6 天课程；生产可能通过 `publish_lesson` 补充。
  实施前必须核对 D1 `teacher_lessons` 对 Day 17–62 的覆盖率。
- `hasLesson` 是开始下一天的硬门（`app/studio.tsx:235`）；题库兜底只解决
  “有课程但口语字段为空”，**不能**让未发布的 Day 17+ 变得可进入。
  若覆盖不足，建议并行推进 **Day 17–62 lesson pack**（复用现有 Coach 发布管线），
  或至少保证每个可开始的日子都有口语题。

**验收**

- 可完整走完 Part 1/2/3；任意步骤刷新后从原位置恢复。
- 历史进行中会话（无 `speakingSession`）仍能按 `currentPhase` 继续并完成。
- 热身不产生 review task；批改段数与 `reviewed` 语义一致。
- Part 3 第 2 题不被提前判为 review；模考不会写 `speakingComplete`。
- Part 2 题卡 4 个 bullet、笔记、60 秒准备、120 秒作答均可用。
- 模考结束前不出现逐题反馈；结束后整场报告可见；`timed:false` 不被当作严格成绩。
- 连续添加 40 条 Part 1 / 40 条 Part 3 后保存仍成功；接近 1 MiB 有可见处置。
- 题库测试通过，且所有题目 `source: 'authored'`。

**测试**：`tests/speaking-session.test.mjs`（新，reducer + 计时 + 旧数据回退）、
扩展 `tests/speaking-workflow.mjs`（三部分、刷新恢复、无重复上传、1 MiB 边界）、
`tests/speaking-questions.test.mjs`（新，题库完整性）、
`tests/speaking-identity.test.mjs`（新，golden attempt id）。

---

### P0-5 纵向进步面板（M，约 1–2 周）

**问题**

- 报告只统计次数（`app/reports.tsx:74-78`）。
- 发音画像趋势存在，但只在报告深处；没有流利度/问题数趋势。
- `lib/coach.ts:152-211` 的 `reviews()` **无 limit、取全部列**，包含整段
  `analysisJson`（转写全文）。进度接口若直接复用，会把多份完整转写读进内存并
  可能超出响应/时长限制。
- `teacherFeedback` 只有 `(userId, day)` 与唯一 `reviewTaskId` 索引
  （`db/schema.ts:15-36`），没有按时间范围扫描的索引。
- `ProgressChart` 只消费服务端给的 `ciLow/ciHigh`
  （`app/pronunciation-review.ts:559-610`），并不在客户端计算 Wilson；
  runner 的 `progress_metrics.py:47-118` 以“每秒语音”为暴露量计算。
  新接口不能自造另一套置信区间。

**方案**

1. 新增 `lib/speaking-progress.ts`（纯聚合）+ `GET /api/speaking/progress`：
   - `requireUserScope()`；强制 `userId`，不返回他人数据。
   - 查询：`WHERE user_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT 200`
     （默认 180 天窗口；返回 `truncated` 标志）。不复用 `reviews()`。
   - 列投影：只取 `id, day, created_at, attempt_id, analysis_json`，并在 SQL 层用
     `json_extract(analysis_json, '$.scorecard')` 缩小读取；**不返回
     transcript、不返回学习者草稿、不返回引文**。响应只含聚合点：
     FC 校准指标、WPM（reference）、语法/词汇问题数（reference）、词数/TTR、
     建议回听词数（suggestive）、自听裁决计数。
   - 缺少 `scorecard` 的 v1 反馈计入 `legacyCount`，不参与趋势。
   - 坏 JSON / 缺字段跳过该点，不让整页失败；返回空数组而非 500。
2. 索引：先用 `EXPLAIN QUERY PLAN` 验证现有 `(userId, day)` 是否够用；
   若时间范围扫描走全表，再新增 `(user_id, created_at)` 迁移。**不为假设性需求
   提前加索引**。
3. UI：`SpeakingProgressPanel` 放在报告页发音画像旁；首页/报告顶部加
   `WeeklySpeakingCard`：
   - 本周练习次数、已批改段数；
   - 语音占比、长停顿秒数的最新值与变化；
   - 建议回听词数；
   - 当前焦点。
4. 图表：4 个小型折线/柱状（语音占比、长停顿、语法问题数、回听词数），
   **不做单一综合分**；每个图带状态 chip、样本量 `n`、最近值。
5. **置信区间来源**：
   - 候选率/分钟的 Wilson CI 必须与 runner 同一暴露量定义（每秒语音为 trial）。
     服务端按 `progress_metrics.py` 的公式计算并返回 `ciLow/ciHigh`；
     用 `tests/fixtures/wilson-golden.json`（由 Python 生成）锁定 TS 实现。
   - 若本期不做候选率图，则只显示点估计 + `n`，**不得**在客户端临时算一个
     口径不同的 CI 充数。
   - 其他指标（语法问题数等）不附带 CI，避免暗示不存在的精度。
6. 导出：**移到 P1**（见 P1-9），P0 只做只读面板；DSR 已有导出，不重复实现。

**验收**

- 所有指标带状态标签与样本量；无“准确率/进步率”文案。
- 解析失败的旧反馈不会让页面崩溃；显示“x 条历史反馈无指标”。
- 查询最多返回 200 条、180 天内；`truncated` 时 UI 明示。
- 响应与日志不出现转写原文/引文；只返回本人数据。
- 候选率图（若做）的 CI 与 Python golden fixture 一致。

**测试**：`tests/speaking-progress.test.mjs`（新）：v1/v2 fixtures、
空数据、坏 JSON、200 条上限、跨用户隔离（API 层）、Wilson golden 对比。

---

### P0-6 录音稳健性与无障碍（M，约 1 周）

**问题**

- 无设备检查/倒计时/暂停；权限超时 30 秒；移动端息屏/切换应用；
- 上传失败只能手动重试（虽保留录音）；无键盘操作说明。
- `MediaRecorder.pause()` 并非所有浏览器/容器都支持；`enumerateDevices()`
  在授权前拿不到设备标签；`navigator.wakeLock` 需要用户手势且可能被系统回收。

**方案**

1. `MicCheck`：首次使用弹窗——权限说明、设备选择、3 秒电平测试、耳机/安静环境提示。
   - **先请求权限再 `enumerateDevices()`**；授权前只显示“默认麦克风”。
   - 设备 id 记入 `localStorage`；设备不存在时回退默认并提示，不阻断开始。
   - 用 `MediaRecorder.isTypeSupported` 选择容器（webm/ogg/mp4）；都不支持时
     明确提示换浏览器，不静默录出坏文件。
2. 开始流程：3-2-1 可取消倒计时；进入录音页后（用户手势内）请求
   `navigator.wakeLock`；`visibilitychange` 回到前台时重新申请；
   API 不存在或被拒时显示“请保持屏幕常亮”，不当作错误。
3. 录制中：最后 15 秒提示（视觉 + `aria-live`）；到限自动停止；
   练习模式可暂停/继续（暂停时间不入音频，界面明示）；取消需二次确认。
   - **能力检测**：`typeof recorder.pause === 'function'` 才提供暂停；
     不支持时练习模式显示“此浏览器不支持暂停，可停止后重录”，模考的
     无障碍例外改为分段录制并在报告中标记 `timed:false`。
4. 停止后 `TakeSummary`：时长、设备电平判断（“检测到语音 / 大部分静音”，
   标注“设备估算，非校准指标”）、试听、重录、提交。
5. 上传队列：IndexedDB 持久化 `pending|uploading|failed`，指数退避；
   `online`/`visibilitychange` 触发重试；UI 显示“待上传（自动重试）”。
   - **去重**：以 `(attempt/Kind, day, phase, contentHash)` 为键；服务端返回的
     audio id 先持久化、再清除 pending；同一 hash 已有 id 时直接复用。
   - 队列任务带 owner/account scope；切换账号时按现有 `clearLocalClips()`
     规则清理，不跨账号重放。
6. 设备中断：track `ended`/`mute` 时停止并提示；已录部分 > 3 秒则允许提交
   （标注“录音可能不完整”）。
7. 无障碍：Space/Enter 开始/停止（停止需确认）、Esc 取消、焦点回到录音按钮；
   倒计时在 30/10/3 秒播报（不要每秒播报）；`aria-pressed`/`aria-live` 状态
   与视觉同步；保留 `prefers-reduced-motion`。

**验收**

- 拒绝权限、拔麦、息屏、切后台、断网各有明确提示与恢复路径。
- 授权前设备列表不展示空标签；不支持的浏览器在开始前就被拦下。
- 上传队列刷新后仍在；同一录音不会重复上传；切换账号不重放旧队列。
- 不支持 `pause()` 时不会假装已暂停；模考例外明确标记 `timed:false`。
- 键盘可完成“开始 → 停止 → 试听 → 提交”。
- 近静音仍阻止提交（现有行为保留）。

**测试**：扩展 `tests/speaking-workflow.mjs`（合成 MediaRecorder、
fake timers、离线/恢复、无 pause 能力）；新增无障碍断言（aria-live、焦点）。

---

## 5. P1（增强项）

| 项 | 内容 | 价值 |
|---|---|---|
| P1-1 转写句子模式 | 按标点/停顿分组；整句播放/循环/0.75×；键盘上一个/下一个词 | 从“查词”升级为“练句” |
| P1-2 跟读影子模式 | 示范 → 跟读 → 波形并排（纯视觉，不评分） | 增加开口量，不造假 |
| P1-3 题库轮换 | 同主题间隔重现、弱项优先、避免近期重复 | 解决“每天同题” |
| P1-4 反馈可读性 | 状态说明浮层、手机端评分卡布局、导出/打印 | 降低理解成本 |
| P1-5 托管批改 | 在授权/合规门通过后启用 `multi_tenant`，按 entitlement/预算运行 | 摆脱本地 runner 依赖 |
| P1-6 通知 | Web Push 或邮件“批改已返回” | 回访率 |
| P1-7 内容扩充 | Day 17–62 lesson pack；`publish_lesson` 可选增加 part1/part3 题组 | 产品完整度 |
| P1-8 会话级批量批改 | 一次任务处理整场，减少排队与模型调用 | 成本/延迟 |
| P1-9 口语数据导出 | 本人 JSON/CSV（与 DSR 一致），不含他人数据 | 可携带/信任 |

---

## 6. P2（条件性）

- **AI 对话伙伴**：实时 ASR + LLM + TTS；需要成本上限与并发控制；
  不评发音、不给音素断言。
- **语调可视化**：仅在 F0 校准门通过后；当前不做。
- **发音 band / T2 断言**：门禁未过，继续关闭。
- **社交/班级功能**：与当前单人产品定位无关，暂不做。

---

## 7. 数据、契约与成本

### 7.1 状态 JSON（向后兼容）

新增键（全部可选）：

- `speakingPart1`：Part 1 热身数组；条目必须 `spoken:true`，`reviewed:false`；
  最多 40 条。
- `speakingSession`：当前会话 `{id, mode, phase, qIndex, startedAt, deadlineAt}`。
- `speakingMock` / `speakingMockSession` / `speakingMockComplete`：
  模考答案、模考进度、整场完成标记；与当天完成状态完全分离。
- `speakingFocus`：当前焦点 JSON；最多保留 5 条历史；已 `done/dismissed`
  的条目不被自动覆盖。
- `speakingDrillTakes`：逐句重录数组；每条带 `attemptId`；最多 12 条。
- `speakingFollowup`：继续承载 Part 3；新条目带 `seq/questionId/part/reviewed`。
- `notes`：Part 2 笔记，≤ 2 KB，仅作为学习者私记，不进入 attempt identity、
  不进入提示词、不作为转写文本。

保留与冻结：

- 旧键 `speakingPart2` / `speakingFollowup` / `speakingReview` 语义不变；
  旧条目无需迁移。
- `speakingReview` 在 `finish()` 成功后冻结；焦点与批改结果不得回写它。
  焦点为空时允许完成，此时不写空字符串。
- 所有新增数组都有上限；保存前估算字节，接近 1 MiB（`app/studio.tsx:184-185`）
  时按“草稿 → 最旧热身 → 最旧 drill take”顺序淘汰并提示；仍超限则明确报错，
  不静默丢数据。

### 7.2 attempt id 稳定性（必须锁死）

`app/feedback-model.ts:84-90` 用 `JSON.stringify(identity)` 做 SHA-256。
**对象键顺序即序列化顺序**，所以“按需 spread”会随字段增删改变 hash。

规则（显式白名单，不用 spread）：

- 旧路径（`speakingPart2` / `speakingFollowup` 中无 `part/questionId` 的条目）
  identity 保持今天完全相同的键与顺序：
  `day, field, index, stage, response, conditions, evidence, [recordingId], at, localOnly`。
  逐字节复现，golden fixture 锁定。
- 新路径（带 `idScheme:'v2'` 的新条目）在**固定位置**加入 `questionId` 与
  `part`；其余键同上。`seq` 不入 hash（由数组 index 与 questionId 决定），
  `mode/sessionId/notes/reviewed` **永不入 hash**——它们可变，且 `notes/reviewed`
  会随学习行为改变。
- 模考条目使用独立 `field:'speakingMock'`，identity 同样走 v2 白名单；
  不与日常条目共享 id 空间。
- `recordingId` 只在存在时加入（与今天一致）；录音重新上传但内容相同必须得到
  同一个 id（服务端按 digest 去重，见 `/api/audio`）。
- golden test：用 `tests/speaking-workflow.mjs` 的现有 `part2` fixture 断言新实现
  产出与旧实现逐字节一致的 id；另加 v2 fixture 断言不同 `questionId` 必得不同 id。
- 若未来必须改 identity，采用显式版本前缀（`v3:`）并保留旧反馈读取，不得让
  历史反馈静默失配。

### 7.3 API

- `GET /api/coach`：继续返回 `reviewTasks`/`feedback`/`automation`；
  收件箱复用，不新增接口。
- `GET /api/speaking/progress`（新）：`requireUserScope`；180 天 / 最多 200 条；
  只返回聚合点与状态标签，不返回转写/引文/草稿；坏数据跳过，失败返回空。
- `reviewTasks`：`speakingMock` 任务只在 `speakingMockComplete` 后出现；
  `speakingFollowup` 只对 `reviewed !== false` 生成；Part 1 永不生成。
- `/api/audio`：复用 owner/租户校验与配额；drill take 走通用上传；
  Part 1/模考若用上下文上传，需同步扩展 `phase` 白名单并与服务端测试一起改。
- MCP：P0 不改工具面；`/mcp` 路由不变。

### 7.4 成本与队列

- 每日：2 段批改（Part 2 + Part 3 首题）；热身 0 成本。
- 完整：4 段；模考：6–9 段（按题量，最多 9）。
- 开始完整/模考前显示“本次将批改 N 段”与**当前剩余批改预算**；
  预算不足时明确降级（模考只批改 Part 2 + Part 3 首两题），不静默跳过。
  文案不写“今日额度”，因为 `processing_budget_exhausted` 指自动重试次数耗尽
  （`app/attempt-feedback.tsx:40-43`）；预算是独立概念，需服务端返回真实字段，
  没有字段时不显示数字。
- 会话内任务独立排队；部分返回可先看，不阻塞整场。
- TTS 继续 fail-closed；URL 过期有回退（已有）。
- 批量批改（一会儿话一个任务）留给 P1-8；P0 不做模型调用合并。

### 7.5 隐私

- 进度接口只返回本人数据；`teacher_feedback` 查询强制 `userId`。
- 日志不写转写原文/引文；错误详情继续走 `redact_error_detail`。
- drill take 与录音同属本人，随 DSR 删除。

---

## 8. 交付顺序与工作量

| 阶段 | 内容 | 估算 | 可演示结果 |
|---|---|---|---|
| Sprint A | P0-1 + P0-2 + P0-6（MicCheck/倒计时） | 1.5–2 周 | 批改自动到达；下次开口有焦点；录音前有检查 |
| Sprint B | P0-4 核心（`phaseFor` 替换 `currentPhase`、会话状态机、Part 1、题卡、Part 3 ×2、题库 V1） | 2–3 周 | 可完成三部分日常练习；刷新可恢复 |
| Sprint C | P0-3（逐句重录、同题对比） | 1.5–2 周 | 从“看懂”走到“重录并对比” |
| Sprint D | P0-5 + 模考模式 + 打磨 | 1.5–2 周 | 跨天趋势；整场模考报告 |
| Sprint E | P1 选做（通知/句子模式/托管批改） | 按优先级 | 留存与可达性提升 |

> 内容供给（Day 17–62）与 Sprint B 并行；若生产覆盖不足，
> 它是最可能阻塞“完整体验”的外部依赖。

---

## 9. 测试与验收

新增/扩展：

- `tests/speaking-focus.test.mjs`：焦点生成、同 attempt 幂等、done/dismissed 不被覆盖、
  legacy、确定性。
- `tests/speaking-session.test.mjs`：reducer、计时（`deadlineAt` 差值）、刷新恢复、
  旧数据回退到 `currentPhase`、模考不可暂停、无障碍例外置 `timed:false`。
- `tests/speaking-questions.test.mjs`：题库完整性、原创来源字段、Part 2 四个 bullet。
- `tests/speaking-identity.test.mjs`：旧 attempt id golden（逐字节）、v2 白名单、
  `notes/reviewed` 不入 hash、不同 `questionId` 不同 id。
- `tests/speaking-compare.test.mjs`：同题对比、旧新不混比、状态标签、无发音 band。
- `tests/speaking-progress.test.mjs`：v1/v2 解析、坏 JSON、200 条上限、
  `truncated`、跨用户隔离（API 层）、Wilson golden。
- 扩展 `tests/speaking-workflow.mjs`：MicCheck 能力检测、倒计时、上传队列去重、
  三部分、1 MiB 边界与淘汰顺序。
- 扩展 `tests/feedback-ui.mjs`：收件箱、退避轮询、30 分钟后降频、无 “Work” 文案、
  六种 `lastError` 的动作、接管副作用说明。
- `tests/fixtures/wilson-golden.json`：由 `runner/progress_metrics.py` 生成，
  TS 实现必须一致。
- 浏览器 fixture：新增 `/__fixture/speaking-session` 手动走查三部分与模考。

**接线（必须显式）**：`test:review` 是一个显式文件列表（`package.json:15`），
不会自动发现新文件。实施时二选一：

1. 把上述 `.mjs` 直接加入该列表；或
2. 新增 `test:speaking` 脚本，并在 `test:review` 末尾 `&& npm run test:speaking`。

无论哪种，CI 与提交前都必须真的执行；只写文件不加脚本视为未交付。

提交前跑：`pnpm run test:review`、`pnpm run test:multitenant`（触及队列/API/音频时）、
TypeScript 检查、必要的 browser fixture。不把全量 eslint 历史债务当作本次门禁。

---

## 10. 成功指标（诚实定义）

| 指标 | 定义 | 目标 |
|---|---|---|
| 批改到达率 | 提交后 24h 内取到反馈的比例 | ≥ 80% |
| 会话完成率 | 开始三部分会话并完成自评的比例 | ≥ 70% |
| 练习闭环率 | 7 天内完成 drill take 或重答的比例 | ≥ 30% |
| 焦点延续率 | 下次会话显示并使用焦点的比例 | ≥ 90% |
| 次周口语留存 | 第 2 周仍有口语练习的学习者比例 | 基线 + 10pp |
| 批改延迟 | 提交 → 反馈可见的 p50/p95 | 只记录，不设无依据目标 |
| 失败率 | `needs_attention` / 总任务 | 下降，按错误类型拆分 |

**口径澄清**

- “候选词数”是检测器**建议回听**的数量（suggestive），**不是错误数**；
  它下降可能只是录音更短、ASR 更稳或题目更容易。
- “语法/词汇问题数”来自 LLM 且已通过逐字引文校验（reference），仍受转写质量、
  录音时长、题目难度影响；不是“错误率”。
- “失败率”按 `needs_attention` / 总任务计算，并排除同意撤回/DSR 主动关闭的任务；
  报告时按 `lastError` 拆分，避免把“自动重试耗尽”和“录音缺失”混为一谈。

**禁止**把“候选词数下降”“语法问题数下降”直接当作“口语变好”；
指标只用于产品运营，不进入学习者评分。任何对外展示都必须同时给出状态标签与 `n`。

---

## 11. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| attempt id 漂移 | 历史反馈失配、重复批改 | 显式白名单 + 冻结键序 + 逐字节 golden test；变更走 `v3:` |
| 新元数据（notes/reviewed）入 hash | 学习者一改笔记 id 就变 | 白名单明确排除；测试断言改 notes/reviewed 后 id 不变 |
| 状态 JSON 膨胀 | 触 1 MiB 上限后保存失败 | 每类数组上限、notes ≤ 2 KB、保存前估算与淘汰顺序、边界测试 |
| 模考误写日完成 | 当天口语被误记为完成 | 独立 `speakingMock*` 键；不写 `speakingComplete/review/fullTests` |
| 旧新题目混比 | 虚假对比 | `questionId` 精确匹配 + `lesson:<day>:<hash(prompt)>` 回退；不确定就不比 |
| 焦点覆盖用户决定 | dismissed/done 被自动复活 | 同 attempt 幂等；仅 active 可替换；历史最多 5 条 |
| 轮询长期空转/静默停更 | 电量、流量、误以为还会到达 | 3→300s 退避、30 分钟后明示降频、隐藏暂停、断连最低 60s |
| 三部分/模考成本上升 | 预算与等待 | 热身不批改；开始前显示段数与真实预算字段；可降级 |
| 对比页暗示虚假精度 | 违反诚实契约 | 只呈现数值；发音无 band；加时长/转写混杂提示 |
| 题库质量/版权 | 法律与体验 | 全原创、`source:'authored'`、人工审校 |
| 题库兜底被误解为解锁 Day 17+ | 承诺了做不到的可达性 | 明确 `hasLesson` 硬门；兜底只补“有课程但无口语题” |
| 音频 phase 白名单未同步 | Part 1/模考上传 400 | 扩展白名单或走通用上传；服务端与客户端测试同改 |
| 上传队列重复/孤儿对象 | 配额与隐私残留 | 内容 hash 去重、先持久化返回 id、账号切换清理 |
| runner 不可用 | 反馈不到 | P0-1 诚实降级；P1 托管批改为根治 |
| 移动端录音失败 | 直接流失 | MicCheck + 唤醒锁 + 上传队列 + 设备中断处理 |
| 计时依赖 setInterval | 后台节流失真 | 以 `deadlineAt` 差值计时；恢复时立即结算 |
| CI 口径混用 | 暗示不存在的精度 | 与 `progress_metrics.py` 同定义 + Python golden；否则只显示点估计 |
| 无障碍回归 | 部分用户不可用 | 键盘/aria-live/焦点测试纳入门禁；暂停能力检测 |
| 内容不足（Day 17–62） | 口语不可达 | 与 Sprint B 并行的 lesson pack / 题库兜底（仅限已有课程） |

---

## 12. 明确不做（诚实红线）

- 不启用 T2 音素断言；发音 band 恒为 `null`。
- 不生成“发音准确率”“口音分数”“进步百分比”。
- 不把检测器候选词说成错误；红色只来自学习者自听确认。
- 不自动宣布“语法已改正”“这句已经练好”；只呈现问题与学习者自评。
- 不自动宣布“比上次进步”；只并列数值、样本量与状态标签。
- 不把练习模考说成官方成绩；`timed:false` 不当作严格模考成绩。
- 模考**不写** `speakingComplete` / `speakingReview` / `fullTests`，不替代当天打卡。
- 不伪造置信区间：没有与 runner 同口径的 CI 就只显示点估计 + `n`。
- 不因为题库兜底而声称未发布的 Day 可开始；`hasLesson` 仍是硬门。
- 不静默丢数据：状态超限、保存失败、上传失败都必须可见并给出下一步。
- 接管/手动批改必须披露“自动批改不会再领取”，不把副作用藏起来。
- 不复制雅思真题/剑桥材料；题库原创。
- 不在日志/分析事件中写入转写原文或引文。

---

## 13. 评审记录与闭环（2026-11-22）

本轮评审以仓库代码为准，逐条核对原方案的事实与设计缺口。下表每条都给出证据与
落点；“闭环”指设计文档已修正，**不代表应用代码已实现**。

| ID | 级别 | 评审发现 | 代码证据 | 处置 |
|---|---|---|---|---|
| R-01 | 高 | 原文称“30 分钟后死路”，与自动刷新/聚焦刷新不符 | `app/studio.tsx:144-176` | §0.1、§1.2、P0-1 改为“静默停更”，并给出降频方案 |
| R-02 | 高 | 原文称 `completed` 需手动重新读取；实际已自动拉取 | `app/studio.tsx:144-176`、`app/attempt-feedback.tsx:50` | §1.2、P0-1 改为“绑定失败才升级” |
| R-03 | 高 | 自动化 ETA 字段写成 `nextAt` | `lib/coach.ts:198-211`、`app/feedback-model.ts:49-53` | P0-1、§7.4 区分 `nextExpectedAt` 与任务 `nextAt` |
| R-04 | 高 | `processing_budget_exhausted` 被解释为“今日额度” | `app/attempt-feedback.tsx:40-43` | P0-1 状态表、§7.4、§10 改为“自动重试次数耗尽” |
| R-05 | 高 | `blocked` 与 `needs_attention` 未区分下一步 | `lib/review-tools.ts:132`、`lib/consent.ts:120`、`lib/review-tasks.ts:162,239` | P0-1 分状态给动作；徽标只计可处理项 |
| R-06 | 中 | 接管会停止自动批改，但 UI 未披露 | `app/attempt-feedback.tsx:124-137` | P0-1 明确副作用文案 |
| R-07 | 中 | 曾把报告 `conditions` 的 “Part 1–3” 误判为虚假产品声明 | `app/reports.tsx:25` | 删除该推断；§1.2 只保留“报告只统计次数” |
| R-08 | 阻断 | `currentPhase` 在首个 Part 3 后即进入 review，多题/模考无法实现 | `app/speaking-draft.ts:17-20` | P0-4 用 `phaseFor` 替换；§8 Sprint B 纳入 |
| R-09 | 高 | `answers()` 只收 `spoken===true`，Part 1 若按普通对象写入会被丢弃 | `app/speaking-draft.ts:6-15` | P0-4、§7.1 明确 `spoken:true` |
| R-10 | 高 | `finish()` 强制焦点非空并写 `speakingComplete:"yes"`，模考会误记完成 | `app/speaking.tsx:449-455` | P0-2 焦点可选；P0-4/§3.3 模考独立键 |
| R-11 | 高 | `Speaking` 没有 `feedback` prop，焦点生成无数据输入 | `app/studio.tsx:273` | P0-2 增加最小数据通路 |
| R-12 | 高 | 焦点可能覆盖用户 `dismissed/done` 的决定 | 设计缺口 | P0-2、§7.1、§11 加幂等与覆盖规则 |
| R-13 | 中 | `speakingReview` 在完成后仍可能被反馈回写 | `app/speaking.tsx:449-476` | P0-2、§7.1 冻结该键 |
| R-14 | 中 | 旧固定三句自评与新焦点结构未定义兼容 | `app/speaking.tsx:24` | P0-2 仅渲染 `speakingFocus` 时走新卡片 |
| R-15 | 高 | drillKey 不含 attemptId，同句跨次批改会互相覆盖 | `app/speaking-scorecard.tsx:177` | P0-3 把 attemptId 纳入 key |
| R-16 | 高 | `SpeakingScorecard`/`Drills` 没有 attempt 身份 | `app/speaking-scorecard.tsx:177,200` | P0-3 新增 `attemptId` prop |
| R-17 | 中 | drill take 无上限，状态 JSON 会增长 | `app/studio.tsx:184-185` | P0-3、§7.1 设每 drill/会话上限 |
| R-18 | 中 | 仅按 `questionId` 对比无法覆盖旧条目，且旧新混比会产生虚假结论 | 设计缺口 | P0-3 增加 `lesson:<day>:<hash(prompt)>` 回退与“旧新不混比” |
| R-19 | 高 | 上下文上传只接受 `part2|followup`，Part 1/模考会被 400 | `app/api/audio/route.ts:46-57` | P0-3/P0-4/§7.3 扩展白名单或走通用上传 |
| R-20 | 高 | 模考沿用 `finish()` 会写当天完成状态 | `app/speaking.tsx:449-455` | §3.3、P0-4、§12 明确独立键且不写完成 |
| R-21 | 高 | 模考需要独立任务字段，否则 `reviewAttempts` 不会生成任务 | `app/feedback-model.ts:66-75` | P0-4、§7.3 定义 `field:'speakingMock'` |
| R-22 | 中 | 多题 Part 3 仍会显示“重答 N” | `app/feedback-model.ts:71` | P0-4、§7.1 按 `seq/questionId` 生成标题 |
| R-23 | 中 | `reviewed` 未定义：热身/次题是否建任务不清 | `app/feedback-model.ts:66-75` | P0-4、§7.1 明确 Part 1 永不建任务、次题按 `reviewed` |
| R-24 | 阻断 | “新字段只在存在时入 hash”受对象键序影响，旧 id 可能漂移 | `app/feedback-model.ts:84-90` | §7.2 改为显式白名单 + 冻结键序 + 逐字节 golden |
| R-25 | 高 | `notes/reviewed` 可变，若入 hash 会导致历史反馈失配 | 设计缺口 | §7.2、§11 明确排除 |
| R-26 | 高 | “题库兜底”与 `hasLesson` 硬门矛盾，不能解锁 Day 17+ | `app/curriculum.ts:130-141`、`app/studio.tsx:235` | P0-4、§11 限定兜底范围 |
| R-27 | 高 | 新数组无上限，可能触 1 MiB 保存失败 | `app/studio.tsx:184-185` | P0-4、§7.1 加上限、淘汰顺序与显式报错 |
| R-28 | 高 | 进度接口若复用 `reviews()` 会无 limit 读取完整 `analysisJson` | `lib/coach.ts:152-211` | P0-5 独立查询、200 条/180 天、最小投影 |
| R-29 | 中 | 只有 `(userId, day)` 索引，时间范围扫描可能全表 | `db/schema.ts:15-36` | P0-5 先 EXPLAIN，必要时再加 `(user_id, created_at)` |
| R-30 | 高 | Wilson CI 由服务端/runner 计算，客户端并不自算；口径不能另起 | `app/pronunciation-review.ts:559-610`、`runner/progress_metrics.py:47-118` | P0-5 同口径 + Python golden；否则只显示点估计 |
| R-31 | 低 | 导出属于范围蔓延 | 原 P0-5 | 移到 P1-9 |
| R-32 | 中 | `pause()`/Wake Lock/设备标签都有能力与时机前提 | 平台能力 | P0-6 加能力检测、授权后枚举、失败回退 |
| R-33 | 中 | 上传队列未定义去重与账号切换 | `app/speaking.tsx` 现仅手动重试 | P0-6 内容 hash 去重、先持久化 id、账号清理 |
| R-34 | 中 | 计时依赖 `setInterval` 会在后台节流失真 | 设计缺口 | P0-4 以 `deadlineAt` 差值计时；§11 记录 |
| R-35 | 高 | 新测试文件不会自动进入显式 `test:review` 列表 | `package.json:15` | §9 要求显式接线或新增 `test:speaking` |
| R-36 | 中 | 候选词数容易被误读为错误数 | `runner/scorecard.py:245-254` | §10 口径澄清、§12 红线 |
| R-37 | 高 | 自造 CI 或把参考层差值说成进步会违反诚实契约 | `runner/scorecard.py:49-56,136-197` | P0-5、§10、§12 明确禁止 |
| R-38 | 中 | 超限/失败若静默丢弃会破坏“可恢复性” | `app/studio.tsx:184-185` | §7.1、§7.4、§12 要求可见处置 |

### 13.1 诚实契约复核结论

- `runner/scorecard.py:245-254`：发音卡 `band: None`、`STATUS_SUGGESTIVE`，
  本方案未提出任何发音 band 或音素断言。
- `runner/scorecard.py:257-298`：语法/词汇引文 fail-closed 未改动；
  新焦点只消费已通过校验的 quote/fix。
- `runner/scorecard.py:136-163`：无可用语音时流利度拒绝评分，
  与“不把设备故障翻译成低分”一致。
- T2 音素断言继续关闭；P1/P2 均未安排重新开启。
- 所有新指标都带 `calibrated/reference/suggestive` 标签与样本量；
  不新增“综合分”。

### 13.2 残余风险（实施前必须验证）

1. **生产 D1 的 Day 17–62 覆盖率未知**：仓库只有 6 天课程，
   `publish_lesson` 的实际覆盖必须查生产库；否则完整体验不可达。
2. **浏览器能力矩阵未实测**：`pause()`、Wake Lock、mp4/MIME、后台计时
   需要至少在 iOS Safari / Android Chrome / 桌面 Chrome 各走一次。
3. **D1 查询计划依赖数据量**：200 条上限与索引是否足够，需用真实数据
   `EXPLAIN QUERY PLAN` 验证。
4. **单测不等于端到端**：合成 MediaRecorder/IndexedDB 无法覆盖真实上传、
   解码、runner 批改；Sprint B/C 结束前各做一次真实录音走查。
5. **状态上限是工程折中**：40 条历史仍可能被长文本触顶；超限提示与淘汰
   必须实际测试，而不是只写在文档里。
6. **本轮未修改任何应用代码**：所有处置均为设计文档修订；实现、测试接线与
   部署需在 owner 授权后另行进行。
