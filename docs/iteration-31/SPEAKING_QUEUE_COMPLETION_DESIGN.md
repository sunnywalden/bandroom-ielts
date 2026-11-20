# Speaking 队列完成契约设计 **rev1**

- 日期：2026-11-20（UTC）
- 上游：`iteration-30/P2B_ORCHESTRATOR_WIRING_PLAN.md` + `P2B_DELIVERY.md`（P2b 接线已交付，Worker 7cf214c1，multi_tenant 默认 false）。
- 触发：P2b 交付披露的 **speaking 队列完成启用前 blocker**（owner 决策 A：fail-closed）。本文件设计如何让 grounded prosody 评审**诚实、安全地**经 `complete_review_task` 完成 speaking 任务。
- 状态：**设计稿 rev1，待 owner 裁决 + 独立评审；未改代码/配置，未部署，未 git 写。**
- 红线：T2 已正式退役（音素断言 OFF）；不伪造音素分析/质量 PASS；不降阈值；跨租户 blast radius 优先。

---

## 0. 问题的精确形态（五层缺口，逐行核验）

队列路径 speaking 完成走 **MCP 工具层** `callReviewTool("complete_review_task")`（`lib/review-tools.ts:246-296`），其在核心事务 `completeReviewTask`（`lib/review-tasks.ts`）之上叠加了一组**为 QA 声学轨（iteration-24 D2/G3 云端音素分析器）设计的门**。grounded prosody 教练的产出形态与之不匹配：

| # | 缺口 | 服务端要求（file:line） | grounded 现状 |
|---|---|---|---|
| 1 | **schema 不匹配** | `validateSpeakingAnalysis`（`lib/speaking-analysis.ts:53`）要求 `schemaVersion:1` + `decoded{16000,sampleCount}` + `coverage.analyzedSamples` 全覆盖 + `errors[]`（音素 substitution/deletion/addition 事件）+ `state:"completed"` | grounded 产出 `bandroom-grounded-analysis-v1`（`detectorVersion/inventoryVersion/speechSeconds/candidates→items T3`，`lib/coach.ts:331-356`），**无** schemaVersion/decoded/coverage/errors |
| 2 | **release 门** | `analysisVersion ∈ ANALYSIS_RELEASED_VERSIONS`（`review-tools.ts:278-280`）；task.analysisVersion 来自 `env.ANALYSIS_BUNDLE_VERSION`（`app/api/state/route.ts:116`） | CF API 实查 prod：**两个 env 均未设** → task.analysisVersion=null → `analysis_version_required` |
| 3 | **decoded checkpoint** | `requireDecodedInput`（`lib/review-transfer.ts:368`）要求经二进制 transfer 提交并**在当前租约下回读** 16kHz s16le mono PCM（`save_decode` PUT + `read_decode` GET，manifest `bandroom-decode-v1`） | runner **无 transfer 客户端**；grounded 仅 ffmpeg→WAV 跑 prosody，不提交 checkpoint |
| 4 | **候选签发缺失** | MCP complete 分支**不调用** `issueCalibrationCandidates`（`lib/calibration.ts:138`），仅原样存 `input.analysis` | owner 路径经 `coach.ts:331` FIX-6 **服务端签发 candidateIds**；队列若原样存 groundedAnalysis → UI 读不到 candidateId → **个人校准闭环失效** |
| 5 | **analysis=None** | speaking 强制 `input.analysis && input.recordingSha256`（`review-tools.ts:263`）否则 `analysis_required` | `build_grounded_analysis` 无候选时返回 **None**（`runner/grounded_audio.py`）；prosody 证据在**散文 evidence**，不在结构化 analysis |

**关键架构事实**：重门在 **MCP 工具层**，核心事务 `completeReviewTask` 本身**无**此门——owner 路径 `add_coach_feedback` 直接调核心事务（`coach.ts:375`），存 groundedAnalysis、analysisVersion=null、无 decoded checkpoint，**今天就在生产工作**。因此本设计可在 MCP 层新增一个 **grounded-prosody 完成类**，不动核心事务，也不动 QA 声学轨的音素契约。

**当前 fail-closed 行为（P2b 已交付）**：`QUEUE_PERMANENT_CODES`（orchestrator.py）把缺口 1/2/3 的拒绝码分类为非 retryable → 立即 blocked。这是**正确的临时态**，不是终态。

---

## 1. grounded 诚实产出清单（设计输入）

grounded prosody 教练（`runner/grounded_audio.py`，T2 退役后）实际产出：

- **T1 已校准韵律**（可断言，附逐用户可靠性披露）：`total_duration_seconds / speech_span / speech_duration_seconds / speech_ratio / pause_count / pause_seconds / pauses[]`（仅 prosody 模块标 `calibrated` 的指标；pitch 仅 consistency_checked，WPM/fillers 未校准不呈现）。这些进入**散文 evidence + feedback**（精确时间戳停顿 + 编号原因 + 一个微 drill）。
- **T3 建议性自听候选**（非错误断言）：`candidates[]`（word/expected/actual/atMs/detectorConfidence/tier），服务端签发 candidateId 后渲染为 T3；**可能为空**（旧录音大概率 0 候选）。
- **结构化 analysis**：`bandroom-grounded-analysis-v1`（speechSeconds + items T3 + candidateIds）。**无音素断言、无发音 band**。
- **录音绑定**：recordingId + recordingSha256（reassemble 校验）。

**诚实边界**：grounded **不**产出音素错误事件、**不**给发音 band、**不**声称全 clip 音素分析。任何让它"看起来像"音素分析器的设计都是造假。

---

## 2. 设计选项（三选一，含推荐）

### 选项 A（推荐）：新增 grounded-prosody 完成类

在 `complete_review_task` MCP 分支识别 grounded schema（`analysis.schema === "bandroom-grounded-analysis-v1"`，或升级 v2），走**独立校验路径**：

1. **grounded schema 服务端校验**：把 `runner/content_rules.coerce_grounded_analysis` 的约束镜像为服务端 zod（detectorVersion/inventoryVersion ≤80 字符、speechSeconds ∈[0,10800]、candidates 上限、tier ∈{T2,T3}、catchTrial bool）。拒绝未知字段（fail-closed）。
2. **录音完整性绑定**：`recordingSha256` 必须等于 R2 对象 digest（已有逻辑 `review-tools.ts:283-287`）+ snapshot.recording 身份一致。
3. **decoded checkpoint（完整性，见 Z-2）**：要求提交并回读 16kHz PCM checkpoint（复用现有 `bandroom-decode-v1` transfer 机械），证明分析绑定到**经验证的解码输入**。prosody-only **不需要** acoustic feature chunks（`save_acoustic`/`ANALYSIS_RUNTIME_BUNDLE_SHA256` 仅音素轨需要）。
4. **服务端签发候选**：调用 `issueCalibrationCandidates`（与 owner 路径 FIX-6 同源），把 candidateIds 注入 items（tier 恒 T3，T2 退役）。**抽共享 helper** 供 coach.ts 与 review-tools.ts 复用，避免漂移。
5. **release 治理**：grounded 完成版本（如 `grounded-prosody-v1`）经**契约/完整性门**验证后加入 `ANALYSIS_RELEASED_VERSIONS`（见 §3，非质量门）。
6. **analysis=None 处理**：无候选时仍完成——存 `{schema, speechSeconds, items:[], prosodyEvidence}`（prosody 证据结构化摘要），满足 speaking 需 analysis 非空，**不伪造候选**。

**优点**：不动 QA 音素契约（未来声学轨仍可走原门）；诚实（不伪装音素分析）；跨租户完整性保留；校准闭环与 owner 路径同源。
**代价**：runner 需新增 decode+transfer 客户端（若 Z-2 选 A1）；服务端新增 grounded 校验分支 + 共享候选签发；需 release 治理决策。

### 选项 B：复用 SpeakingAnalysis schema（errors:[] + grounded  extras）

runner 产出完整 `SpeakingAnalysis`：`schemaVersion:1, decoded{16000,sampleCount}, coverage:[[0,sampleCount]], errors:[], state:"completed"` + grounded extras（prosody/candidates）。服务端门**不改**，release `grounded-prosody-v1`。

**优点**：服务端门零改动。
**缺点**：①语义挪用——errors/coverage 源自音素时代，`errors:[]` 虽诚实但 schema 出处误导；②`coverage:[[0,sampleCount]]` 声称"全 clip 声学分析"，对 prosody DSP 诚实但对 schema 语义是借壳；③仍需 decoded checkpoint + 候选签发（门原样存 analysis，不会签发 candidateId）→ 缺口 4/5 仍在；④runner 工作量和 A1 相当。**不推荐**（诚实性弱于 A，工作量不减）。

### 选项 C：放宽 MCP speaking 门镜像 owner 路径

让 MCP complete 分支接受 grounded schema，仅 recordingSha256 绑定，**无 decoded checkpoint**（等同 owner 路径完整性）。

**优点**：最轻；runner 无需 transfer 客户端。
**缺点**：**削弱跨租户完整性**——queue 是 coach-runner 服务身份（可 claim 任意租户，P2a 已披露接受），去掉 decoded-input 验证使"分析绑定到经验证解码输入"的保证降级。owner 路径是单 owner 自证，blast radius 小；queue 跨租户不宜同级放宽。**不推荐**（安全降级）。

---

## 3. release 治理的诚实重构（核心，Z-3）

**必须区分两类门，不可混淆**：

- **质量门**（G1/G2/D2 precision）：grounded prosody 的**发音/韵律质量**证据——G1-R 全协议 **FAIL**（iteration-28，L3 阻断 + 仲裁未决）、G2-prosody VAD 修复后非退化 retest（b15bde4）、T2 退役。这些**不因本设计改变**，也**不**被本设计声称为 PASS。
- **契约/完整性门**（本设计新增）：grounded-prosody 完成版本能否**诚实、安全地经队列持久化**——录音绑定正确、decoded 输入经验证、输出恒 T1/T3（无音素断言）、候选签发与 owner 路径同源、analysis=None 不伪造、跨租户隔离不回归。

**release `grounded-prosody-v1` 的依据 = 契约门通过，不是质量门通过。** 队列完成持久化的是 **owner 路径今天已在服务的同一份诚实输出**；release 只是确认"这份输出经队列路径持久化时完整性/诚实性/隔离不降级"。

**契约门验证清单（预注册，单次运行，不伪造）**：
1. grounded schema 服务端校验对抗测试（未知字段/越界/缺字段拒绝）。
2. recordingSha256 ↔ R2 digest ↔ snapshot 三方一致；篡改任一 → 拒绝。
3. decoded checkpoint 提交→回读→sampleCount 一致；旧 fence/过期租约拒绝（若 Z-2=A1）。
4. 候选签发 parity：队列与 owner 路径对同一输入产出相同 candidateIds 语义（tier 恒 T3、catchTrial 处理、detector_version_mismatch fail-closed）。
5. analysis=None → 完成且 items:[]，无伪造候选。
6. 跨租户写侧矩阵：服务身份完成 tenant A 任务不写 tenant B 行/审计（复用 tests/tenant-isolation 模式）。
7. 内容规则：speaking feedback 禁发音 band/音素断言（`coachingContentViolation`，review-tools.ts:256-261 已有）。
8. **诚实声明审计**：产出恒含 T1 可靠性披露 + T3 建议性标签；无 pronunciation band。

**owner  sign-off**：契约门证据包封存后，owner 批准把 `grounded-prosody-v1` 加入 `ANALYSIS_RELEASED_VERSIONS`（+ 设 `ANALYSIS_BUNDLE_VERSION=grounded-prosody-v1` 使新 speaking 任务携带该版本）。**这是 prod 配置变更，需显式授权**；不设则队列 speaking 仍 fail-closed。

---

## 4. 推荐契约规格（选项 A，待 Z-1/Z-2 裁决）

### 4.1 服务端（`lib/review-tools.ts` complete 分支）
```
if (task.kind === "speaking") {
  if (input.analysis?.schema === "bandroom-grounded-analysis-v1") {
    // grounded-prosody 完成类
    require released(input.analysisVersion ?? task.analysisVersion)  // grounded-prosody-v1
    require recordingSha256 === R2 digest === snapshot.recording.sha256
    validateGroundedAnalysis(input.analysis)        // 镜像 coerce_grounded_analysis
    if (Z-2 == A1) requireDecodedInput(...)         // 复用现有 transfer 机械
    const issued = await issueCalibrationCandidates(db, userId, groundedInput)
    storedAnalysis = enrichWithCandidateIds(input.analysis, issued)  // 共享 helper
    // 不走 validateSpeakingAnalysis（音素 schema）
  } else {
    // 原 QA 声学轨路径（不变）
    validateSpeakingAnalysis(...) + requireDecodedInput(...)
  }
}
```
- 新增 `lib/grounded-analysis.ts`（服务端 zod 校验 + 共享候选签发/enrich helper，coach.ts 改用同 helper）。
- `analysis=None` → runner 侧保证产出 `{schema, speechSeconds, items:[], prosodyEvidence}`（非 null），服务端接受 items:[]。

### 4.2 runner（`runner/`）
- `grounded_audio`：无候选时 `build_grounded_analysis` 返回 prosody-only 结构（非 None），含 prosodyEvidence 摘要（pause_count/pause_seconds/speech_ratio 等已校准指标）。
- 新增 `runner/review_transfer.py`（若 Z-2=A1）：`get_review_transfer(save_decode)` → PUT canonical manifest+PCM → `get_review_transfer(read_decode)` → GET 回读校验。decode 用现有 ffmpeg→16kHz s16le mono（`audio` 模块已有解码）；manifest 按 `bandroom-decode-v1`（format/analysisVersion/inputSha256/inputBytes/container/codec/sourceRateHz/sourceChannels/containerDurationMs/primingMs/pcm{...}/mediaTime）。
- `_process_queue_task` speaking：produce grounded → （A1）提交+回读 decoded checkpoint → complete_review_task（analysis=grounded storedAnalysis, recordingSha256, analysisVersion=task.analysisVersion）。
- `QUEUE_PERMANENT_CODES` 保留（release 未设时仍 fail-closed）；release 设后 speaking 走通。

### 4.3 配置（prod，需 owner 授权）
- `ANALYSIS_BUNDLE_VERSION=grounded-prosody-v1`（新 speaking 任务携带）。
- `ANALYSIS_RELEASED_VERSIONS=grounded-prosody-v1`（契约门通过 + owner sign-off 后）。
- `ANALYSIS_RUNTIME_BUNDLE_SHA256` **不需要**（prosody-only 无 acoustic chunks）。
- 既有 task.analysisVersion=null 的存量 speaking 任务：complete 时 `input.analysisVersion` 显式传 grounded-prosody-v1（MCP 允许 override task.analysisVersion，review-tools.ts:275）。

### 4.4 迁移
- **无 D1 schema 变更**（review_tasks/checkpoints/transfer 表自 P2a/QA 轨已存在）。仅 env 配置 + 代码。

---

## 5. 测试计划

- 服务端：grounded schema 对抗（未知字段/越界/缺字段）、录音三方绑定篡改、候选签发 parity（队列 vs owner 同输入）、analysis=None 完成、跨租户写侧矩阵、内容规则禁 band、release 门（未设拒绝/设后通过）、旧 fence/过期租约拒绝（A1）。
- runner：decode manifest canonical 字节、save_decode→read_decode 往返 SHA 一致、prosody-only 无候选产出、complete_args 携带 grounded schema+recordingSha256+analysisVersion、release 未设仍 fail-closed（QUEUE_PERMANENT_CODES 回归）。
- 集成（Miniflare 真实服务端）：queue claim→grounded produce→(A1)transfer→complete→receipt→UI 读 candidateIds；与 owner 路径同录音产出语义一致。
- 既有套件不回归：runner 242、review-tools118、calibration106、tenant-isolation11、state-api2484。

## 6. rollout / rollback

- 阶段1：服务端 grounded 完成类 + 共享候选 helper + runner transfer/produce（代码，multi_tenant 仍 false，线上零变化）。
- 阶段2：契约门预注册单次运行 → 证据包封存 → owner sign-off。
- 阶段3：owner 授权设 prod env（ANALYSIS_BUNDLE_VERSION/RELEASED_VERSIONS）→ 部署 Worker → 开观察窗。
- 阶段4：owner 授权启用 multi_tenant（**仍受许可②/合规门约束**，rev2 §5；本设计不解除那些门）。
- rollback：移除 RELEASED_VERSIONS 中的 grounded-prosody-v1 → 队列 speaking 回到 fail-closed；或 redeploy 前 Worker。env 变更可逆，无 D1 迁移。

## 7. owner 决策（Z-D，待裁决）

- **Z-1 完成类方案**：A（新增 grounded-prosody 类，推荐）/ B（复用音素 schema errors:[]）/ C（放宽门镜像 owner）。
- **Z-2 完整性级别**（若 A）：A1（decoded checkpoint，跨租户完整性，推荐）/ A2（仅 recordingSha256 绑定，轻但完整性降级）。
- **Z-3 release 治理**：接受"契约/完整性门 ≠ 质量门"重构（推荐）；契约门清单 §3 是否需增删；grounded-prosody-v1 命名。
- **Z-4 cutover 策略**：契约门通过后即启用队列 speaking（multi_tenant 仍待许可/合规）/ 还是 speaking 暂留 owner 路径待 QA 声学轨。
- **Z-5 候选签发 parity**：必修（非可选）——共享 helper，队列与 owner 同源。确认。
- **Z-6 analysis=None**：prosody-only 完成（items:[]，不伪造候选，推荐）/ 还是无候选 speaking 任务走文本式完成。

## 8. 不做 / 红线

- 不启用 T2 音素断言（退役）；不产出音素错误事件/发音 band。
- 不伪造质量 PASS 来 release；G1 全协议 FAIL / G2 历史 INVALID 记录不动。
- 不降跨租户隔离；服务身份 blast radius 不放宽（Z-2 推荐 A1）。
- 不解除许可②/合规门（rev2 §5）；multi_tenant 启用仍需 owner + 那些门。
- 未裁决前不改代码/配置/部署/git。