# 自听确认 UI（音频教练 rev2）

实现范围：`app/pronunciation-review.ts`（纯模型）、`app/pronunciation-coach-client.ts`（MCP 客户端）、
`app/pronunciation-coach.tsx` + `.css`（组件），接入 `app/attempt-feedback.tsx` 与 `app/studio.tsx`。
设计依据：`AUDIO_COACH_REFACTOR_DESIGN_rev2.md` §0.2、§4.4、§4.5、§4.7、§7、§13；
评审闭环 FIX-5、FIX-8、FIX-13、FIX-21、FIX-25、FIX-26、FIX-28。

## 1. 交互模型

反馈行（`complete_review_task` 的 `output.analysis` → 页面 `feedback[].analysis`）出现新的
`analysis.pronunciation` 结构时，`AttemptFeedback` 在教练散文之后追加 `<PronunciationCoach>`。
旧式 `analysis.errors` 不会被当作新契约，因此原有隐藏提示的测试行为不变。

- **T1 可靠性**：若 `analysis.pronunciation.reliability`（或 `analysis.reliability`）存在，先显示
  该用户的停顿检测可靠性；`analysis.prosody.pauseCount` 可作为结构化停顿数的回退。
- **冷启动**：`profile.exists === false`（或 `profileExists:false` / `coldStart:true`）时显示。
- **T2/T3 节**：`sections` / `tiers` 中的字符串逐字渲染在各自 `<section>`，不重写、不并入 T1 散文。
  runner 也会把确定性 T3/画像/T2/可靠性块直接追加在 `feedback` 文本里；UI 只按固定标题
  `六、建议自听对比（非错误断言）`、`七、你的发音画像（建议性质）`、`【T2 历史确认】`、
  `【T1 可靠性披露】` 切分，逐字放入独立 `<section>`，不改写模型写的 T1 散文。
- **自听确认**：只对 T3 和带 `isReprobe`/`override` 标志的 T2 渲染卡片。每张卡片包含：
  - 单词与**秒**级时间戳（`20.31 秒`）；
  - `RecordingClipPlayer` 点击回听原录音；
  - 标准发音对比播放器，含 **0.75× 慢速**按钮；
  - 三态按钮：**确实读错 / 其实没错 / 不确定**。
- **一次回答**：提交成功后按钮禁用，并显示“已记录：…”。服务端字段 `priorVerdict` /
  `answeredVerdict` / `verdict` 会在重新打开页面时恢复已答状态。
- **不确定**：提交 `verdict:"unsure"`，显示“已记录：不确定（不计入画像）”。UI 的同类进度只读
  `nConfirmed`，不把 `nUnsure` 加到分子；服务端后验同样排除 `unsure`。
- **幂等**：提交参数只有 `{candidateId, verdict}`。组件有同 tick 的 in-flight ref 防双击，
  服务端再以 `(userId, attemptId, candidateId)` 唯一约束兜底；重复/刷新不会改计数。

## 2. 为什么 catch trial 必须在视觉上不可区分

catch trial 的作用是测量“用户是否会不加分辨地确认任何被标记的项”。如果 UI 暴露哪一条是
catch/control，用户会针对性回答，控制项就不再提供信息，BL-H 的“无信息确认者”检测会失效。
因此：

- `toCandidate()` **不复制** `isCatchTrial`/`catch`/`isControl` 字段，公开候选类型里没有该字段；
- 卡片**不显示** `expected`/`actual` 音素对：服务端 catch trial 的 `expected === actual`，
  显示音素对会成为可识别标志。卡片只显示单词、时间、回听与标准音对比；
- 组件从不读取或渲染 `isCatchTrial` 标志；catch 与真实项的 DOM 完全同构（测试用 `expected === actual`
  的 catch 项与 `expected !== actual` 的真实项逐字比较 `outerHTML`）；
- 提交 payload **不含** `isCatchTrial`；服务端从自己的候选行写入事件（“由服务端标记”）。
- 测试同时断言页面文本/HTML 不含 `isCatchTrial`、`catch trial`、`对照项`、`控制项`。
- **服务端约束**：同一会话的所有确认项必须一致地提供或省略 `canonicalAudioUrl`。如果只给 catch 项提供
  标准音、而真实项没有，UI 的“可用/不可用”差异会泄露控制项；这不是 UI 能补救的。

## 3. 冷启动文案（逐字）

> **还没有你的个人发音画像**
>
> 目前的发音提示来自尚未用你的确认校准过的检测器，只能作为回听建议，不是评分结论。
>
> 建立画像需要同一类别至少 3 次确认。每次会话最多展示 3 条候选，所以通常需要多次会话；
> 不同类别出现频率差别很大，无法保证在固定时间内出现。
>
> 对照标准发音做 A/B 听辨是常见的听辨练习。但系统不会逐条告诉你判断是否正确；
> 长期只靠自判可能固化错误，因此这里不声称它一定能训练听音。

明确没有“3–5 条确认即出现断言”的承诺；进度按**同一类别**显示（如 `DH→D 1/3 次同类确认`），
同时显示“只按同一类别累计，不是所有类别的总数；「不确定」会记录，但不计入”。

## 4. 可靠性披露文案

有个人精确率估计时：

> 本次检测到 36 次停顿。按你个人的停顿检测可靠性估计（精确率约 65%），其中可能多计约 13 次；
> 请把这个数量当作估计，而不是精确计数。
>
> 停顿计数用于节奏练习，不是评分依据。

只有群体估计时：

> 系统整体的停顿精确率约为 81.2%，但不同说话人的精确率在 33.3%–100% 之间；
> 目前还没有你的个人估计，因此这个数量应视为估计，而不是精确计数。

措辞避免“假的/错误结论”，用“可能多计”“当作估计”；同时不把停顿计数说成评分依据。
若服务端已把同样的披露写入 `row.feedback`（标记 `【T1 可靠性披露】`），组件不重复渲染独立块。

## 5. 进步指标定义

**指标 = 每分钟语音中该类候选的出现次数（per-class candidate rate per minute），带 95% CI（若服务端提供）。**

- 明确**不**使用 posterior 上升、确认率或否认比例：这些会被自报与“产品展示该类的频率”混淆（FIX-26）。
- 纯函数 `buildProgressSeries()` 只接受 `candidates` + `speechMinutes`/`speechSeconds`
  （以及可选的 `ciLow`/`ciHigh`，单位与每分钟率一致）；传 `nConfirmed`/`nRejected` 不会产生点。
- 没有 CI 时：点估计照常画，但显示“部分时间点缺少置信区间数据；曲线只显示点估计，不画置信区间，也不推测区间。”
  绝不伪造上下界。
- **没有服务端时间序列时的回退**：从历史反馈的
  `calibrated_prosody.speech_duration_seconds`（或 `total_duration_seconds`）与
  `tier_assignment` 的候选计数，推导最近 12 次会话的每分钟率；仍然不计算/伪造 CI，
  面板会注明“由最近 12 次含声学分析的反馈按语音分钟数推导”。
- 超过 3 个类别时，其余合并为“其他”（灰色），避免超出经验证的三色分类调色板。
- 图表为单 y 轴、2px 线、点标记带 `<title>`/键盘聚焦、图例 + 末点直接标注 + 可展开数据表。
- 三个类别使用经校验的蓝/橙/青分类色（`#2a78d6`/`#eb6834`/`#1baf7a`）；青色在浅色背景上对比度
  低于 3:1，因此始终同时提供直接标注与数据表，不以颜色作为唯一识别手段。超过三类合并为灰色“其他”。
- 文案明确：“只有与独立度量对照验证后，才能把它解释为进步。”

数据来源假设：`read_pronunciation_profile` 返回 `progress` / `progressSeries`（数组，或含 `classes` 的对象），
每项 `{expected, actual, points:[{label, candidates, speechMinutes|speechSeconds, ciLow?, ciHigh?}]}`
或聚合 `{expected, actual, candidates, speechMinutes, ciLow?, ciHigh?}`。

## 6. 重置与留存语义

入口在“阶段评估”页的个人发音画像面板。确认对话框逐字包含：

> **重置发音画像？**
>
> 这会清除你的发音画像和确认记录。
>
> **不会删除你的录音或备份。**
>
> 重置后需要重新积累同一类别的确认，个人历史条件化建议才会再次出现。
>
> [前往「学习档案」管理录音] [取消] [确认重置]

- 确认后调用 `reset_pronunciation_profile`，成功显示“已重置个人发音画像。你的录音和备份未受影响。”
- “前往「学习档案」管理录音”由 `Studio` 传入回调并切换到学习档案页签；组件本身不删除音频。
- 服务端 reset 不删除 R2 音频或备份；UI 不声称会删除，也不提供删除动作。

## 7. 服务端契约假设（与并行工作流对齐）

浏览器通过同源 `POST /mcp`（JSON-RPC `tools/call`，路由为 `app/mcp/route.ts`）调用：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
  "name":"record_pronunciation_verdict",
  "arguments":{"candidateId":"…","verdict":"confirmed|rejected|unsure"}
}}
```

- 三个工具：`record_pronunciation_verdict` / `read_pronunciation_profile` / `reset_pronunciation_profile`；
- **任何工具参数都不含 `userId`**，userId 由会话取（测试断言请求体中不存在 `"userId"`）；
- `read`/`reset` 的参数为 `{}`；
- 工具成功返回 `result.content[0].text` 为 JSON；错误走 JSON-RPC `error` 或 `result.isError`。

反馈证据的假设形状（容错读取）。并行工作流当前实际存储的是
`schema:"bandroom-grounded-analysis-v1"`：

```ts
analysis = {
  schema: "bandroom-grounded-analysis-v1",
  detectorVersion, inventoryVersion, speechSeconds,
  items: [{candidateId, word, expected, actual, atMs, detectorConfidence,
           tier:"T3", requestedTier:"T2"|"T3", isCatchTrial}],
}
```

同时兼容更完整的嵌套形状：

```ts
analysis.pronunciation = {
  items: [{candidateId, word, expected, actual, atMs, tier:"T1"|"T2"|"T3",
           isCatchTrial, detectorConfidence, isReprobe?, priorVerdict?,
           canonicalAudioUrl?, clipStartMs?, clipEndMs?}],
  sections: {T2:"…逐字模板…", T3:"…逐字模板…"},
  reliability: {pauseCount?, pausePrecision?, pauseRecall?, macroPrecision?,
                perSpeakerMin?, perSpeakerMax?, basis?},
  profile: {exists?, classes:[{expected, actual, nConfirmed, nRejected, nUnsure,
            nShown, state, ruleVersion?, detectorVersion?}]},
  progress: [...] // 见 §5
}
```

容错别名（已与并行工作流实际字段对齐）：

- 画像：`classes` / `rows` / `perClass`；画像行可带 `ruleVersion` / `detectorVersion` / `inventoryVersion`。
- 可靠性：`reliability` / `reliabilitySummary` / `t1_reliability`；字段可为
  `pausePrecision|userPrecision`、`macroPrecision|populationMacroPrecision`、
  `perSpeakerMin/Max|populationSpeakerPrecisionRange[]`、`pauseCount|pauseCountInThisRecording`；
  顶层 `calibrated_prosody.pause_count` 也会补进停顿数。
- 条目：`items` / `candidates` / `pronunciationCandidates` / `self_listen_suggestions` /
  `tier_assignment.t2_items` + `.t3_items`；字段别名
  `atMs|timestamp_ms|timestampMs|seconds`、`expected|expected_phone`、`actual|actual_phone`、
  `detectorConfidence|detector_confidence`、`canonicalAudioUrl|canonicalAudio|contrast_audio.url`。
- 节：`sections` / `tiers` / `tier_sections`。
- 进步：`progress` / `progressSeries` / `progress_metrics` / `progressMetrics` / `candidate_rates`；
  既支持 `{expected, actual, points:[…]}`，也支持 runner 的
  `{classKey:"DH->D", candidates, speechSeconds, ratePerMinuteWilson95:[low,high]}`。

## 8. 未验证项（需要真实服务端/浏览器）

1. **工具已由并行工作流登记，但未做真实账号联调**：只读检查 `lib/mcp-scope.ts` 确认
   `record_pronunciation_verdict` / `reset_pronunciation_profile` 为 owner-only，
   `read_pronunciation_profile` 允许 owner/coach/coach-runner。本次未修改这些文件，也未向真实会话发起
   `/mcp` 调用；“浏览器会话 → tools/call → D1”链路仍需端到端验证。
   **2026-11-19 更正与闭环**：rev2 客户端曾误写 `/api/mcp`（该路径从未挂载，生产表现为画像读取
   404/500），已改为 `/mcp`；`tests/pronunciation-client-route.mjs` 将真实客户端经按路径分发的
   路由 mock 接到真实 `app/mcp/route.ts`（未知路径 404），读/裁决/重置全链路端到端验证通过。
2. **实际存储分析已由并行工作流补齐 `candidateId`，但未做真实账号端到端**：只读检查
   `lib/coach.ts` 的 `groundedAnalysis` 路径，服务端用 `issueCalibrationCandidates` 签发 id 并写入
   `analysisJson.items`；runner 不提供 id。T2/T3 文本仍由 runner 追加在 `feedback` 中，UI 按固定标题切分。
   `runner → add_coach_feedback → complete_review_task → analysisJson → 页面` 的完整链路未在真实账号执行。
3. **`read_pronunciation_profile` 当前不返回时间序列或可靠性摘要**：真实返回是
   `{rows, classes, totals, notes}`。缺少 `progress` 时，面板从历史反馈的
   `speechSeconds`/`calibrated_prosody` 与 items 推导最近 12 次会话的每分钟率（不伪造 CI）；
   缺少 `reliability` 时省略可靠性块（反馈行仍从散文/`t1_reliability` 显示）。
   `runner/progress_metrics.py` 已实现 Wilson 区间；若服务端以后返回
   `ratePerMinuteWilson95`，UI 会直接绘制。
4. **canonical 音频 URL 的来源与格式**未联调。runner 的 `contrast_audio` 可能是
   `{url, expiresAt, audioId}`；UI 读取 `.url`，缺失时明确显示“标准发音对比暂不可用”，不伪造音频。
5. **0.75× 慢速**依赖浏览器 `HTMLMediaElement.playbackRate`；测试用 jsdom 断言属性为 0.75，
   真实 Safari/iOS 的听感与音频时长变化未人工试听。
6. **catch trial 的真实候选构造**由服务端决定；UI 只保证不泄露标志。catch 失败率/异常确认者的
   拒绝晋升逻辑不在 UI 层。
7. **progress CI 的统计口径**（Wilson/自助法等）由服务端提供；UI 只画传入的区间，无法验证其正确性。
8. **同一用户多设备并发回答**由服务端唯一约束保证；UI 只做本页 in-flight 防抖，未做跨标签页协调。
9. **真实账号的暂停检测可靠性值**未接入；服务端 `t1_reliability` 若提供 `userPrecision` 才显示个人估计。
10. **图表的真实浏览器排版未截图检查**：jsdom 测试验证了数值、CI、图例、直接标注与数据表，
    但没有在桌面/移动端真实浏览器里检查标签碰撞与横向溢出。
11. 未做生产部署、未运行 wrangler、未接触 `~/.bandroom-runner-prod/` 或 launchd。

## 9. 复现命令

在仓库根目录运行：

```bash
# 纯模型测试（20 项）
node --experimental-strip-types --test tests/pronunciation-review.test.mjs

# 组件/jsdom 测试（11 项）
node tests/pronunciation-coach-ui.mjs

# 两者合并（package.json 脚本）
pnpm run test:pronunciation-coach

# 既有相关套件（回归）
pnpm run test:pronunciation        # 14 项
node tests/feedback-ui.mjs         # 20 项（含 AttemptFeedback → 确认 UI 接线）

# 静态检查
pnpm exec eslint app components hooks tests/pronunciation-review.test.mjs tests/pronunciation-coach-ui.mjs tests/feedback-ui.mjs
pnpm exec tsc --noEmit

# 全仓 lint（基线本就有 104 个错误，均在 examples/ 等非本工作区文件）
pnpm run lint
```

本次实测（2026-11-15）：纯模型 20/20、组件 11/11、既有 pronunciation 14/14、
既有 feedback-ui 20/20、全仓 `pnpm run test:review` 63/63 exit 0；
`eslint app components hooks …` exit 0；全仓 `pnpm exec tsc --noEmit` exit 0
（期间并行工作流的 `lib/coach.ts` 曾短暂报错，已由其负责方修复；本次未修改该文件）。
全仓 `pnpm run lint` 仍为改动前相同的 **104 errors / 3205 warnings**（`examples/` 等预存问题），
本工作区目录无新增告警。