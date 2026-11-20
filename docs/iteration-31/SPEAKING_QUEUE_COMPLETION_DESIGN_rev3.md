# Speaking 队列完成契约设计 **rev3**（评审闭环收敛稿，取代 rev2）

- 日期：2026-11-20（UTC）
- 取代：rev2（`SPEAKING_QUEUE_COMPLETION_DESIGN_rev2.md`）；rev1/rev2 逐字保留存档。
- 评审闭环：`REVIEW_CLOSURE.md`（两路独立对抗评审，接受 BL3/MJ10/mn5，降级 1，驳回 0；主导亲核）。
- owner 裁决（不变）：**Z-1=A**（grounded-prosody 完成类）、**Z-2=A1**（decoded checkpoint）、**Z-3=契约门≠质量门**。
- 状态：**实施就绪；待 owner 放行实施。未改代码/配置，未部署，未 git 写。**
- 红线：T2 退役；不伪造音素/质量 PASS；不降隔离；**绝不信任 claim body task.userId 授权**；许可②/合规门不解除；QA 音素契约逐字节不动。

---

## 0. 范围重大澄清（U-BL-2，评审证实）

**当前认证模型下队列完成仅 owner 租户可行**：`app/mcp/route.ts:34` 按 `auth.user.userId` 分派；coach-runner 恒映射 `BANDROOM_OWNER_USER_ID`（auth-adapter.ts:176-178）；complete/transfer/recording/checkpoint/calibration 工具全按调用方作用域，**无 userId 参数**。非 owner 任务 → `task_not_found`。

- 本设计**显式限 owner 租户**（= 当前 prod 现实：非 owner anonymous）。
- **真跨租户完成 = 独立后续工作流**（per-tenant service identity，token→tenant 映射，rev2 §7 S3/F15 / iteration-30 §7），本设计不实现、不声称。
- **A1 理由重构**：decoded checkpoint 对 owner 租户仍必要——分析绑定经验证解码输入 + 不可变 receipt，且复用既有 `requireDecodedInput`。非"跨租户"理由。
- 安全不变量：**绝不**把 claim 返回的 task.userId 用于授权（防 leaked runner token IDOR）。
- parity 前提（U-mn-6）：**prod 实跑 grounded**（`runner-config-prod-backup-…toml:32 coach_audio_mode="grounded"`；memory §102-103 ④-A 部署 + 实跑 processed=2；P2b 验证 audioMode=grounded）。Gate-1 hold 的是 legacy omni 教练（below baseline）；grounded prosody 是 owner 授权的安全 T1-only 路径。队列持久化同一份诚实输出，非洗白。

---

## 1. 契约规格（实施就绪）

### 1.1 两形态分离（U-BL-3 / U-MJ-2）

**Wire 契约（runner→server，untrusted，拒 candidateId）**：
```jsonc
{
  "schema": "bandroom-grounded-analysis-v1",
  "analysisVersion": "grounded-prosody-v1",
  "detectorVersion": "<≤80>",              // 与 feedbackSpec cap 80 对齐（U-mn-2）
  "inventoryVersion": "<≤80>",
  "speechSeconds": 3.0,                     // [0,10800]
  "candidates": [                           // raw，无 candidateId；可空
    {"word":"...","expected":"DH","actual":"D","atMs":2000,
     "detectorConfidence":0.7,"tier":"T3","catchTrial":false}
  ],
  "reliability": { /* T1 逐用户可靠性披露对象，UI toReliability 消费 */ },
  "calibrated_prosody": {                   // UI root.calibrated_prosody.pause_count 消费
    "pause_count":2,"pause_seconds":1.8,"speech_ratio":0.79,
    "total_duration_seconds":12.0,"speech_duration_seconds":9.5
  }
}
```
- 字段名对齐 UI（`reliability` 对象 / `calibrated_prosody`，pronunciation-review.ts:388-400），**非** prosodyEvidence/reliabilityDisclosure。
- `reliability` 由 runner pause_calibration 披露派生/有界，非自由文本（U-MJ-8）。
- `calibrated_prosody` 仅含 prosody 模块标 calibrated 指标（pause/timing）；pitch/WPM/fillers 不入。

**Server-stored 形态（签发后，UI 读 analysis_json.items）**：
```jsonc
{ "schema":"bandroom-grounded-analysis-v1", "analysisVersion":"...",
  "detectorVersion":"...","inventoryVersion":"...","speechSeconds":3.0,
  "items":[{"candidateId":"<UUIDv5>","word":"...","expected":"DH","actual":"D",
            "atMs":2000,"detectorConfidence":0.7,"tier":"T3","requestedTier":"T3",
            "isCatchTrial":false}],
  "reliability":{...},"calibrated_prosody":{...} }
```
- **tier 恒 T3**（T2 退役）；requestedTier 保留审计；isCatchTrial 服务端由 expected===actual 派生（calibration.ts:118，绝不信任客户端 flag）。
- **无** pronunciation band / 音素错误事件 / schemaVersion:1 / decoded / coverage。

**runner `coerce_grounded_analysis` 同步扩 allowlist**（content_rules.py:247）：`_ANALYSIS_FIELDS += {schema, analysisVersion, reliability, calibrated_prosody}`；candidates 保持；与服务端 zod 锁步；Feedback.__post_init__ 通行。新增 runner 测试断言精确 wire 字节。

### 1.2 MCP complete 分支（lib/review-tools.ts，grounded 类）

```
if (task.kind === "speaking") {
  if (!input.analysis || !input.recordingSha256) throw ReviewTaskError("analysis_required");
  if (input.analysis.schema === "bandroom-grounded-analysis-v1") {
    // —— grounded-prosody 完成类 ——
    const av = input.analysisVersion ?? task.analysisVersion;
    if (!groundedReleasedVersions.includes(av)) throw ReviewTaskError("analysis_not_released");
    // 录音绑定：recordingSha256 === R2.customMetadata.digest（现有 :283-287）
    //   + checkpoint input（transfer 已校）；snapshot.recording 仅 present 时（U-MJ-7）
    const g = validateGroundedAnalysis(input.analysis);   // §1.1 wire zod，拒 candidateId/未知字段
    await requireDecodedInput(db, userId, taskId, fence,
        {sha256: input.recordingSha256, bytes: R2.size}, av);   // A1，复用零改动
    // 幂等候选签发（§1.3）：先查 receipt（completeReviewTask 内 matchingReceipt 已做），
    //   确定性 ID + ON CONFLICT；items:[] 跳过签发（U-MJ-1）
    let stored = g;
    if (g.candidates.length) {
      const issued = await issueCalibrationCandidatesIdempotent(db, userId, toIssueInput(g, task));
      stored = enrichCandidateIds(g, issued);            // 共享 helper，1:1 保序，tier→T3
    } else { stored = toStoredProsodyOnly(g); }          // items:[]
    // 内容规则（现有 :256-261）：feedback/evidence 禁 numeric band
    // 置于 task.state !== "completed" 守卫内（U-mn-3）；不走 validateSpeakingAnalysis
    //   不触 QA decoded.sampleCount 检查（U-mn-4）
    output.analysis = stored; feedback.analysis = stored;
  } else {
    // —— QA 声学轨原路径（逐字节不变）——
  }
}
```
- **共享 helper**（lib/grounded-analysis.ts）：`validateGroundedAnalysis` / `toIssueInput(g, task)`（attemptId/recordingId 取自 task）/ `enrichCandidateIds` / `toStoredProsodyOnly`；**coach.ts:331-356 改用同 helper**（消除 owner/queue 漂移，U-BL-3）。
- **错误映射**（U-MJ-3）：calibration 失败包 ReviewTaskError 稳定码（`calibration_version_mismatch` / `invalid_analysis`），入 toolError（:154-162）；runner 可分类。

### 1.3 幂等候选签发（U-BL-1，核心修复）

`issueCalibrationCandidatesIdempotent`（calibration.ts 新增，owner 路径亦可改用）：
1. **确定性 candidateId** = `UUIDv5(NS, userId|attemptId|expected|actual|atMs)`（replay 同 ID）。
2. `INSERT INTO calibration_candidates ... ON CONFLICT(candidate_id) DO NOTHING`。
3. `n_shown` UPSERT **仅当候选行 changes()=1**（同 saveReviewCheckpoint 模式）→ replay 不增 n_shown。
4. completeReviewTask 的 `matchingReceipt` 在签发前已短路 duplicate（receipt 存在 → 返回 duplicate，不进入签发）；output.analysis 用确定性 ID → replay outputSha256V2 一致 → duplicate 非 receipt_conflict。
5. detector_version_mismatch 仍 fail-closed（包 ReviewTaskError）。
- **CG**：duplicate complete → duplicate:true + 候选行数/n_shown 不变 + candidateIds 逐字节一致。

### 1.4 runner decoded checkpoint 客户端（新增 runner/review_transfer.py，A1）

**二进制 body**（parseCheckpointBody，review-transfer.ts:278-305）：
```
body = uint32_be(manifestBytes) || manifestJson_UTF8[manifestBytes] || PCM_s16le_mono_16k
artifact.sha256 = SHA256(整个 body);  artifact.bytes = len(body);  manifestBytes ≤ 4096
```
**manifest（bandroom-decode-v1，strictObject，nullable 字段须 present 为 null，U-MJ-4）**：
```jsonc
{"format":"bandroom-decode-v1","analysisVersion":"<av>",
 "inputSha256":"<原始 sha>","inputBytes":<原始字节>,
 "container":"<mimeType，非空>","codec":"<ffprobe>","sourceRateHz":<ffprobe|null>,
 "sourceChannels":<ffprobe|null>,"containerDurationMs":<ffprobe|null>,"primingMs":<null>,
 "pcm":{"encoding":"s16le","rateHz":16000,"channels":1,"sampleCount":<N>,"sha256":"<PCM sha>"},
 "mediaTime":{"originMs":0,"samplesPerSecond":16000}}
```
- **raw PCM**：`wave.open` 读 decode_to_wav 产物 → 剥 44 字节 RIFF 头 → readframes → s16le bytes + sampleCount（U-MJ-4）。decode manifest 不需 canonical。
- **container** 取自 read_review_recording.mimeType；codec/sourceRateHz/sourceChannels/containerDurationMs 由 ffprobe；primingMs=null。
- **analysisVersion 引导**（U-MJ-6）：取 task.analysisVersion（present）否则 runner config `grounded_analysis_version`（钉死=Worker GROUNDED_ANALYSIS_VERSION）；皆无 → fail closed。
- **>393s 早失败**（U-MJ-5）：解码后 sampleCount>6,291,456 → 永久码 `decoded_too_long`（入 QUEUE_PERMANENT_CODES），不提交。
- **流程**：produce 后（temp dir 已删，从内存 raw 二次解码，U-mn-5）→ get_review_transfer(save_decode) → put_bytes(body, Authorization) → get_review_transfer(read_decode) → get_bytes 回读校 SHA（完整性校验；checkpoint_not_read 实由 save PUT 事件满足，U-MJ-9）→ complete。
- **错误分类**（U-MJ-5/U-mn-4）：transfer 永久码（artifact_conflict/invalid_decode_checkpoint/transfer_expired/checkpoint_advanced/decoded_too_long）入 QUEUE_PERMANENT_CODES；put/get_bytes McpError 须带码（扩 mcp_client _check_response 保留 4xx body code，或 orchestrator 映射）。
- 租约：LeaseRenewer 包整个 process（含 transfer）；grant.expiresAt=min(leaseUntil, now+120s) 每次重算。

### 1.5 runner grounded 产出（grounded_audio.py / orchestrator.py）
- `build_grounded_analysis` 无候选 → prosody-only wire 结构（非 None）：`{schema, analysisVersion, detectorVersion, inventoryVersion, speechSeconds, candidates:[], reliability, calibrated_prosody}`（U-MJ-1/Z-6）。
- 有候选 → raw candidates（runner 永不供 candidateId）；reliability/calibrated_prosody 从 analyze_calibrated 的 calibrated 指标 + pause_calibration 披露填充。
- `_produce_grounded` Produced.complete_args 携带 wire analysis + recordingSha256 + analysisVersion。
- `coerce_grounded_analysis` 扩 allowlist（§1.1）锁步。

### 1.6 配置（独立命名空间，U-MJ-2；prod 需 owner 授权，阶段3）
- Worker：`GROUNDED_ANALYSIS_VERSION=grounded-prosody-v1`、`GROUNDED_RELEASED_VERSIONS=grounded-prosody-v1`（契约门+sign-off 后）。**不**设全局 ANALYSIS_BUNDLE_VERSION/RELEASED_VERSIONS（避免挪用 QA 门，speaking-analysis.ts:61）。
- 新 speaking 任务 analysisVersion：submitReview 按 kind 取 grounded 版本（或 complete 时 input.analysisVersion override，review-tools.ts:275）。
- runner config：`grounded_analysis_version="grounded-prosody-v1"`（钉死=Worker，U-MJ-6）。
- `ANALYSIS_RUNTIME_BUNDLE_SHA256` 不需要（prosody-only 无 acoustic chunks）。
- **无 D1 迁移**（calibration_candidates/review_tasks/analysis_events/transfer 表已存在；候选幂等用 ON CONFLICT，无新索引必需——可选加唯一索引加固）。

---

## 2. 契约门预注册协议（Z-3，单次运行，不伪造）

冻结 criteria（`iteration-31/CONTRACT_GATE_PREREGISTRATION.md`，实施阶段产出）：
- **CG-1** wire schema 对抗：未知字段/越界/缺字段/**客户端 candidateId**/tier≠T3 拒绝。
- **CG-2** 录音绑定：recordingSha256↔R2 digest↔checkpoint input↔complete digest；篡改拒绝；**absent snapshot.recording 分支显式测**（U-MJ-7）。
- **CG-3** decoded checkpoint：提交→回读→sampleCount/SHA 一致；旧 fence/过期租约拒绝；save PUT binary-v1 事件存在；**新 fence 重 claim 须重发 save/read 事件**（fence-scoped）。
- **CG-4** 候选签发 parity + **幂等**：队列 vs owner 同输入相同 candidateIds 语义；**duplicate complete → 行数/n_shown 不变 + ID 逐字节一致**；detector_version_mismatch fail-closed（ReviewTaskError 可观测）。
- **CG-5** items:[] → 完成 prosody-only，**无候选行写入**。
- **CG-6** **owner 租户隔离回归**（U-BL-2）：完成 owner 任务不写他租户行/审计（服务身份写侧矩阵，tests/tenant-isolation）。**非跨租户完成**（当前不可行）。
- **CG-7** 渲染非断言（U-MJ-8）：tier 恒 T3；feedback/evidence 禁 numeric band（coachingContentViolation）；UI 不渲染 expected→actual 为断言；catchTrial 盲化。
- **CG-8** 诚实披露实际渲染：reliability/calibrated_prosody 经 UI 消费 surfaced（pronunciation-review.ts）；无 pronunciation band。
- **CG-9**（新增）>393s `decoded_too_long` 永久分类；transfer 永久码分类；stock task analysisVersion 引导。

协议：预注册先冻结（SHA256SUMS）→ 单次运行（Miniflare 真实服务端 + runner）→ 证据包封存 → owner sign-off → 设 prod env。**任何 CG FAIL = 不 release，不重试洗判定**。
诚实声明：契约门通过 ≠ G1/G2 质量门通过（G1 全协议 FAIL/G2 历史/T2 退役不动）。

## 3. 测试计划（U-MJ-10 补全）

- **服务端**（tests/grounded-analysis、review-tools 扩展）：CG-1/2/4/5/7/8 + release 门 + 共享 helper parity（coach vs queue）+ **duplicate-complete 候选稳定/无新行** + artifact_conflict/checkpoint_advanced/transfer_expired + absent snapshot + calibration ReviewTaskError 映射。
- **runner**（tests/test_review_transfer、test_grounded_audio、test_orchestrator_multitenant 扩展）：manifest uint32 前缀+raw PCM 字节、save→read 往返 SHA、prosody-only 无候选、wire 精确字节（coerce 锁步）、>393s decoded_too_long、transfer 永久码分类、analysisVersion 引导 fail-closed、release 未设仍 fail-closed（QUEUE_PERMANENT_CODES 回归）。
- **集成**（Miniflare + R2）：queue claim→grounded produce→transfer→complete→receipt→UI 读 candidateIds/reliability；与 owner 路径同录音语义一致；CG-3/6/9；新 fence 重 claim 重发事件。
- **不回归**：runner 242、review-tools118、calibration106、tenant-isolation11、state-api2484、coach-audio、claim-any。

## 4. rollout / rollback
1. **阶段1（代码）**：服务端 grounded 类 + 共享 helper + 幂等签发 + runner transfer/produce + coerce 锁步。multi_tenant 仍 false → 线上零变化。git/PR/merge（需授权）。
2. **阶段2（契约门）**：预注册冻结 → 单次运行 → 证据包封存 → owner sign-off。
3. **阶段3（prod env + 部署）**：owner 授权设 GROUNDED_ANALYSIS_VERSION/GROUNDED_RELEASED_VERSIONS → 部署 Worker → 开观察窗（canonical+mirror）。
4. **阶段4（启用）**：owner 授权 multi_tenant=true（**仍受许可②/合规门**，rev2 §5）。
- rollback：移除 GROUNDED_RELEASED_VERSIONS → 队列 speaking 回 fail-closed；或 redeploy 前 Worker。env 可逆，无 D1 迁移。

## 5. 工日（U-工日修订）
**~7-10 工日**（R2 判 rev2 ~5 乐观 1.5-2×，主导接受）：字节精确大端帧 PCM + 签名 grant + Miniflare/R2 集成 + owner 共享 helper 无漂移重构 + 候选幂等。不含契约门运行/owner 日历/许可合规门。

## 6. 不做 / 红线
- 不启用 T2；不产出音素错误事件/发音 band；不伪造质量 PASS release。
- 不声称跨租户完成（当前 owner-only）；**绝不信任 claim body task.userId 授权**。
- 不降隔离；不放宽服务身份 blast radius；不解除许可②/合规门。
- 不动 QA 音素契约（validateSpeakingAnalysis/save_acoustic/runtime bundle/全局 ANALYSIS_BUNDLE_VERSION 原路径逐字节不变）。
- 未放行实施前不改代码/配置/部署/git。