# Speaking 队列完成契约设计 **rev2**（收敛稿，取代 rev1）

- 日期：2026-11-20（UTC）
- 取代：`SPEAKING_QUEUE_COMPLETION_DESIGN.md`（rev1 逐字保留作存档；选项分析见 rev1 §2）。
- owner 裁决（2026-11-20）：**Z-1=A**（新增 grounded-prosody 完成类）、**Z-2=A1**（decoded checkpoint 完整性）、**Z-3=接受契约门≠质量门**。
- 状态：**设计收敛，实施就绪；待 owner 放行实施 + 独立评审。未改代码/配置，未部署，未 git 写。**
- 红线：T2 退役（音素断言 OFF）；不伪造音素分析/质量 PASS；不降阈值/隔离；许可②/合规门不解除。

---

## 0. 裁决落定 + 剩余决策推荐

| 决策 | 落定 |
|---|---|
| Z-1 完成类 | **A**：MCP complete 分支新增 grounded-prosody 类，不动 QA 音素契约 |
| Z-2 完整性 | **A1**：decoded PCM checkpoint（save_decode→read_decode 回读），跨租户完整性 |
| Z-3 release | **契约/完整性门 ≠ 质量门**；release grounded-prosody-v1 依据契约门证据 + owner sign-off |
| Z-4 cutover | **推荐**：契约门通过 + owner 设 env 后启用队列 speaking；`multi_tenant` 总开关仍受许可②/合规门（rev2 §5），本设计不解除 |
| Z-5 候选签发 | **必修**：抽共享 helper，队列与 owner 路径同源签发 candidateIds（否则校准闭环失效） |
| Z-6 analysis=None | **推荐**：prosody-only 完成（`items:[]` + prosodyEvidence，不伪造候选） |

---

## 1. 契约规格（实施就绪）

### 1.1 grounded-prosody analysis schema（服务端校验，新增 `lib/grounded-analysis.ts`）

队列 speaking 完成携带 `input.analysis`：
```jsonc
{
  "schema": "bandroom-grounded-analysis-v1",   // 识别键；与 owner 路径 coach.ts:332 同源
  "analysisVersion": "grounded-prosody-v1",
  "detectorVersion": "<≤80 字符>",
  "inventoryVersion": "<≤80 字符>",
  "speechSeconds": 3.0,                        // [0,10800]
  "items": [                                   // 服务端签发 candidateId 后填充；可空
    {"candidateId":"<uuid>","word":"...","expected":"DH","actual":"D",
     "atMs":2000,"detectorConfidence":0.7,"tier":"T3","requestedTier":"T3","isCatchTrial":false}
  ],
  "prosodyEvidence": {                         // T1 已校准指标摘要（结构化，供 UI/审计）
    "totalDurationSeconds":12.0,"speechDurationSeconds":9.5,"speechRatio":0.79,
    "pauseCount":2,"pauseSeconds":1.8
  },
  "reliabilityDisclosure": "<逐用户 T1 可靠性披露文本>"
}
```
- 服务端 zod 镜像 `runner/content_rules.coerce_grounded_analysis` 约束 + items 上限（`MAX_ANALYSIS_CANDIDATES`）；**拒绝未知字段**（fail-closed）。
- **恒 T3**：T2 退役，`tier` 服务端强制 `T3`（requestedTier 保留供审计）；catchTrial 的 actual=expected（与 calibration.ts:163 同源）。
- **无** pronunciation band / 音素错误事件 / schemaVersion:1 / decoded / coverage（那些是 QA 音素 schema，本类不走 `validateSpeakingAnalysis`）。
- `prosodyEvidence` 仅含 prosody 模块标 `calibrated` 的指标（pause/timing）；pitch/WPM/fillers 不入（未校准）。

### 1.2 MCP complete 分支（`lib/review-tools.ts:246-296` 改）

```
if (task.kind === "speaking") {
  if (!input.analysis || !input.recordingSha256) throw analysis_required;
  if (input.analysis.schema === "bandroom-grounded-analysis-v1") {
    // —— grounded-prosody 完成类（新增）——
    const av = input.analysisVersion ?? task.analysisVersion;
    if (!releasedVersions.includes(av)) throw analysis_not_released;   // grounded-prosody-v1
    // 录音三方绑定（复用现有 R2 digest 校验 review-tools.ts:283-287）
    require recordingSha256 === R2.customMetadata.digest === snapshot.recording.sha256
    const g = validateGroundedAnalysis(input.analysis);                 // §1.1 zod
    await requireDecodedInput(db, userId, taskId, fence,
        {sha256: recordingSha256, bytes: R2.size}, av);                  // A1：复用现有机械
    const issued = await issueCalibrationCandidates(db, userId, toIssueInput(g));
    const stored = enrichCandidateIds(g, issued);                       // 共享 helper（Z-5）
    // 内容规则（已有 review-tools.ts:256-261）：禁发音 band/音素断言
    output.analysis = stored; feedback.analysis = stored;               // UI 读 analysis_json
  } else {
    // —— QA 声学轨原路径（逐字节不变）——
    validateSpeakingAnalysis(...) + requireDecodedInput(...) + sampleCount 校验
  }
}
```
- **共享 helper**（Z-5）：`lib/grounded-analysis.ts` 导出 `validateGroundedAnalysis` / `toIssueInput` / `enrichCandidateIds`；`coach.ts:331-356` 改用同 helper（消除 owner/queue 漂移）。
- `requireDecodedInput` 已存在（review-transfer.ts:368），**零改动复用**；其 `checkpoint_not_read` 由 runner 的 read_decode GET 满足（route 记 `read_review_checkpoint` transport=binary-v1，app/api/review-transfer/route.ts:65-69）。

### 1.3 runner decoded checkpoint 客户端（新增 `runner/review_transfer.py`，A1）

**二进制 body 格式**（parseCheckpointBody，review-transfer.ts:278-305）：
```
body = uint32_be(manifestBytes) || manifestJson_UTF8[manifestBytes] || PCM_s16le_mono_16k
artifact.sha256 = SHA256(整个 body);  artifact.bytes = len(body)
manifestBytes ≤ 4096 (binaryManifestLimit);  PCM ≤ 12 MiB → sampleCount ≤ 6,291,456 (~393s)
```
**manifest（`bandroom-decode-v1`，manifestSchema review-transfer.ts:57-73）**：
```jsonc
{"format":"bandroom-decode-v1","analysisVersion":"grounded-prosody-v1",
 "inputSha256":"<原始录音 sha>","inputBytes":<原始字节>,
 "container":"<mp3/webm/...>","codec":"<...>","sourceRateHz":<...>,"sourceChannels":<...>,
 "containerDurationMs":<...>,"primingMs":<...>,
 "pcm":{"encoding":"s16le","rateHz":16000,"channels":1,"sampleCount":<N>,"sha256":"<PCM sha>"},
 "mediaTime":{"originMs":0,"samplesPerSecond":16000}}
```
- decode manifest **不要求 canonical 排序**（仅 acoustic chunks 要求；uploadDecodeCheckpoint 只 parse manifestSchema）。
- 约束：`pcm.length === sampleCount*2` 且 `SHA256(pcm) === pcm.sha256`；analysisVersion/inputSha256/inputBytes 须与 grant 一致。
- **时长上限**：decoded PCM ≤12MiB → ~393s。IELTS speaking Part2(~2min)/followup(~1min) 适配；超长录音（>393s）需分块或另议（**披露限制**，不在 MVP 伪造）。

**流程**（`_process_queue_task` speaking，在 produce 后、complete 前）：
1. ffmpeg 解码原始录音 → 16kHz s16le mono PCM（`audio` 模块已有解码；复用 grounded 的 decode_to_wav）。
2. `get_review_transfer({taskId,fence,action:"save_decode",artifactSha256,bytes})` → grant{url,method:PUT,authorization}。要求 task.stage ∈{read_input,decode}，expectedPointer=task.checkpointSha256。
3. `client.put_bytes(grant.url, body, headers={Authorization: grant.authorization})`（mcp_client 已有 put_bytes）。
4. `get_review_transfer({...,action:"read_decode"})` → grant{method:GET} → `client.get_bytes` 回读 → 校验 SHA==artifact.sha256（满足 requireDecodedInput 的 binary-v1 回读事件）。
5. complete_review_task（analysis=grounded storedAnalysis, recordingSha256, analysisVersion=task.analysisVersion or grounded-prosody-v1）。
- 租约：transfer 期间由 `run_one` 的 LeaseRenewer 续租（P2b 已交付）；grant.expiresAt=min(leaseUntil, now+120s)。

### 1.4 runner grounded 产出（`runner/grounded_audio.py` 改）
- `build_grounded_analysis` 无候选时返回 **prosody-only 结构**（非 None）：`{schema, analysisVersion, detectorVersion, inventoryVersion, speechSeconds, items:[], prosodyEvidence, reliabilityDisclosure}`（Z-6）。
- 有候选时 items 由**服务端**签发 candidateId（runner 只供 raw candidates，与 owner 路径 FIX-6 一致——runner 永不供 candidateId）。
- `_produce_grounded` 的 Produced.complete_args 携带 grounded schema + recordingSha256 + analysisVersion。

### 1.5 配置（prod，需 owner 显式授权，阶段3）
- `ANALYSIS_BUNDLE_VERSION=grounded-prosody-v1`（新 speaking 任务携带，app/api/state/route.ts:116）。
- `ANALYSIS_RELEASED_VERSIONS=grounded-prosody-v1`（契约门通过 + sign-off 后）。
- `ANALYSIS_RUNTIME_BUNDLE_SHA256` **不需要**（prosody-only 无 acoustic chunks）。
- 存量 task.analysisVersion=null：complete 显式传 `input.analysisVersion=grounded-prosody-v1`（MCP 允许 override，review-tools.ts:275）。
- **无 D1 迁移**（review_tasks/checkpoints/transfer 表已存在）。

---

## 2. 契约门预注册协议（Z-3，单次运行，不伪造）

**冻结 criteria（评估前写定，不可协商）**——见 rev1 §3 清单 1-8，固化为 `iteration-31/CONTRACT_GATE_PREREGISTRATION.md`（实施阶段产出）：
- CG-1 grounded schema 对抗（未知字段/越界/缺字段/tier≠T3 拒绝）。
- CG-2 录音三方绑定（recordingSha256↔R2 digest↔snapshot）；篡改任一拒绝。
- CG-3 decoded checkpoint 提交→回读→sampleCount/SHA 一致；旧 fence/过期租约拒绝；binary-v1 回读事件存在。
- CG-4 候选签发 parity：队列 vs owner 同输入 → 相同 candidateIds 语义（T3/catchTrial/detector_version_mismatch fail-closed）。
- CG-5 analysis=None → 完成 items:[]，无伪造候选。
- CG-6 跨租户写侧矩阵：完成 tenant A 不写 tenant B 行/审计（复用 tests/tenant-isolation）。
- CG-7 内容规则：speaking 禁发音 band/音素断言（coachingContentViolation）。
- CG-8 诚实声明审计：恒 T1 可靠性披露 + T3 建议标签；无 pronunciation band。

**协议**：预注册先冻结（SHA256SUMS）→ 单次运行（Miniflare 真实服务端 + runner）→ 证据包封存 → **owner sign-off** → 设 prod env。**任何 CG FAIL = 不 release，不重试洗判定**（与观察窗重评协议同源：重试只解决"测不到"，不解决"测得不合格"）。

**诚实声明**：契约门通过 **≠** G1/G2 质量门通过。G1 全协议 FAIL（iteration-28）、G2 历史 INVALID、T2 退役记录**不动**。队列持久化的是 owner 路径今天已在服务的同一份诚实 T1/T3 输出。

---

## 3. 测试计划

- **服务端**（tests/grounded-analysis、review-tools 扩展）：CG-1/2/4/5/7/8 + release 门（未设拒绝/设后通过）+ 共享 helper parity（coach vs queue）。
- **runner**（tests/test_review_transfer、test_grounded_audio 扩展）：manifest 字节格式（uint32 前缀+PCM）、save→read 往返 SHA、prosody-only 无候选产出、complete_args grounded schema、>393s 限制披露、release 未设仍 fail-closed（QUEUE_PERMANENT_CODES 回归）。
- **集成**（Miniflare）：queue claim→grounded produce→transfer→complete→receipt→UI 读 candidateIds；与 owner 路径同录音语义一致；CG-3/6。
- **不回归**：runner 242、review-tools118、calibration106、tenant-isolation11、state-api2484、coach-audio。

## 4. rollout / rollback

1. **阶段1（代码）**：服务端 grounded 完成类 + 共享 helper + runner transfer/produce。multi_tenant 仍 false → 线上零变化。git/PR/merge（需授权）。
2. **阶段2（契约门）**：预注册冻结 → 单次运行 → 证据包封存 → owner sign-off。
3. **阶段3（prod env + 部署）**：owner 授权设 ANALYSIS_BUNDLE_VERSION/RELEASED_VERSIONS → 部署 Worker → 开观察窗（canonical+mirror）。
4. **阶段4（启用）**：owner 授权 multi_tenant=true（**仍受许可②/合规门**，rev2 §5）。
- **rollback**：移除 RELEASED_VERSIONS 的 grounded-prosody-v1 → 队列 speaking 回 fail-closed；或 redeploy 前 Worker。env 可逆，无 D1 迁移。

## 5. 工日估算

- 服务端 grounded-analysis.ts + MCP 分支 + 共享 helper + coach.ts 改用：~1.5 工日。
- runner review_transfer.py + grounded prosody-only 产出 + complete_args：~1.5 工日。
- 测试（服务端+runner+Miniflare 集成）：~1.5 工日。
- 契约门预注册 + 单次运行 + 证据包：~0.5 工日。
- 合计 **~5 工日**（不含独立评审/owner 日历/许可合规门）。

## 6. 不做 / 红线

- 不启用 T2；不产出音素错误事件/发音 band；不伪造质量 PASS release。
- 不降跨租户隔离（A1 decoded checkpoint 保留）；不放宽服务身份 blast radius。
- 不解除许可②/合规门；multi_tenant 启用仍需 owner + 那些门。
- 不动 QA 音素契约（validateSpeakingAnalysis / save_acoustic / runtime bundle 原路径逐字节不变）。
- 未放行实施前不改代码/配置/部署/git。