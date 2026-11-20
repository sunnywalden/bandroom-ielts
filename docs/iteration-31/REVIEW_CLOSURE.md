# Speaking 队列完成契约 — 独立评审闭环

- 日期：2026-11-20（UTC）
- 评审对象：`SPEAKING_QUEUE_COMPLETION_DESIGN_rev2.md`
- 两路独立对抗评审（不锚定设计结论，逐行对 `.p2b-wiring-checkout` 干净合并 main 核验）：
  - **R1**：安全 / 跨租户隔离 / 诚实性 / 契约正确性（4 BL / 7 MJ / 5 mn）
  - **R2**：实施可行性 / 二进制传输机械 / 测试覆盖 / 工日（2 BL / 7 MJ / 5 mn）
- 主导逐条亲核（BL-1/BL-2/BL-3 读码证实；BL-4 部分驳回）。统一编号 U-*。
- 结论：**rev2 不可原样实施**；闭环全部 BL/MJ 后收敛 rev3（`SPEAKING_QUEUE_COMPLETION_DESIGN_rev3.md`）。

---

## 0. 裁决摘要

| 统一 ID | 来源 | 严重度 | 裁决 | 核心 |
|---|---|---|---|---|
| U-BL-1 | R1.BL-1 + R2.BL-1 | BL | **接受** | 候选签发非幂等 → replay 重铸 UUID → receipt_conflict + 重复行 + n_shown 污染 |
| U-BL-2 | R1.BL-3 + R2.BL-2 | BL | **接受** | 跨租户完成在当前认证下不可行（coach-runner 恒映射 owner userId）→ 设计须显式限 owner 租户 |
| U-BL-3 | R1.BL-2 + R2.MJ-2/MJ-3 | BL | **接受** | runner coerce_grounded_analysis 拒新字段；input/stored 形态混淆；UI 字段名不符 |
| U-MJ-1 | R1.MJ-1 + R2.MJ-1 | MJ | **接受** | items:[] → issueInput.min(1) ZodError → 须 guard |
| U-MJ-2 | R1.MJ-3 | MJ | **接受** | ANALYSIS_BUNDLE_VERSION 全局命名空间挪用 QA 门 → 独立 env |
| U-MJ-3 | R1.MJ-6 + R2.MJ-1 | MJ | **接受** | CalibrationError/ZodError 逃逸 toolError 映射 → 包 ReviewTaskError |
| U-MJ-4 | R1.MJ-4 + R2.mn-2 | MJ | **接受** | decode_to_wav 出 WAV 头；manifest probe 字段；strictObject null 须present；container 非空 |
| U-MJ-5 | R2.MJ-5 + R2.mn-4 | MJ | **接受** | >393s 无分类路径；transfer 错误码未入 QUEUE_PERMANENT_CODES |
| U-MJ-6 | R2.MJ-6 | MJ | **接受** | analysisVersion 引导循环（stock task null，runner 不知 Worker env）→ runner config 钉死 |
| U-MJ-7 | R2.MJ-4 | MJ | **接受** | 三方绑定 snapshot 腿有条件（assertBoundRecording 缺 recording 静默 return）→ 述真实保证 |
| U-MJ-8 | R1.MJ-7 | MJ | **接受** | coachingContentViolation 仅扫文本非 analysis；"无音素断言"是渲染属性非数据属性 |
| U-MJ-9 | R1.MJ-5 + R2.mn-1 | MJ | **接受** | read_decode 非 checkpoint_not_read 必需（save PUT 已满足）→ 精确化 |
| U-MJ-10 | R2.MJ-7 | MJ | **接受** | 测试计划缺失败模式 → 补齐 |
| U-mn-1 | R1.mn-1 | mn | 接受 | 行号引用纠正（calibration.ts:154/171；complete 分支至 321） |
| U-mn-2 | R1.mn-2 | mn | 接受 | detectorVersion cap 80(feedbackSpec) vs 120(issueInput) 对齐 |
| U-mn-3 | R1.mn-4 | mn | 接受 | grounded 分支置于 task.state!=="completed" 守卫内（必要非充分） |
| U-mn-4 | R2.mn-3 | mn | 接受 | QA decoded.sampleCount 检查不入 grounded 分支（undefined.sampleCount 抛） |
| U-mn-5 | R2.mn-5 | mn | 接受 | produce temp dir 先删 → transfer 从内存 raw 二次解码 |
| U-mn-6 | R1.BL-4 | mn | **降级**（原 BL） | parity 前提：评审用 repo example(off)，但 **prod 实为 grounded**（亲核）→ 仅须引 prod 证据 |

**统计**：接受 BL 3 / MJ 10 / mn 5；降级 1（R1.BL-4→mn）；驳回 0。两路 0 驳回主导复核后全闭环。

---

## 1. Blocker 逐条闭环

### U-BL-1 候选签发幂等（接受）
**亲核证实**：`completeReviewTask` 对 enriched `output.analysis` 算 `outputSha256V2`（review-tasks.ts:357-360），replay 比对存证哈希不符即 `receipt_conflict`（:369-374）；`issueCalibrationCandidates` 每次 `crypto.randomUUID()` + 无条件 `n_shown=n_shown+1`（calibration.ts:170-193）；`calibration_candidates` 仅 candidate_id PK + 非唯一 (user_id,attempt_id) 索引（drizzle/0007）；`complete_review_task ∈ RETRYABLE_TOOLS`（mcp_client.py:35-49）→ 一次瞬时 5xx 重 POST 即触发。
**修复（rev3 §1.3）**：
1. **先查存证/任务态再签发**：complete 分支开头 `readReviewReceipt`；已 completed 且 receipt 存在 → 直接返回 duplicate，**不签发**。
2. **确定性 candidateId**：`UUIDv5(namespace, userId|attemptId|expected|actual|atMs)`（非随机）→ replay 同 ID。
3. **INSERT ... ON CONFLICT(candidate_id) DO NOTHING**；`n_shown` UPSERT 仅在候选行 `changes()=1` 时执行（同 saveReviewCheckpoint 模式）。
4. **receipt 哈希稳定**：output.analysis 用确定性 ID → replay 哈希一致 → duplicate 非 conflict。
5. grounded 分支置于 `task.state !== "completed"` 守卫内（U-mn-3）。
**CG**：duplicate complete → `duplicate:true` + candidate 行数/n_shown 不变 + candidateIds 逐字节一致。

### U-BL-2 跨租户完成不可行 → 限 owner 租户（接受）
**亲核证实**：`app/mcp/route.ts:34` `callCoach(auth.user.userId,…)`；coach-runner 经 `auth-adapter.ts:176-178` 恒 `serviceUser(BANDROOM_OWNER_USER_ID)`。下游 `getReviewTask/snapshotFor/read_review_recording/requireDecodedInput/issueCalibrationCandidates` 全按调用方=owner 作用域；completeSpec/transferSpec/recordingSpec 均 strictObject **无 userId 参数**。非 owner 任务 → `task_not_found`。claim_next 描述"pass that userId to every subsequent call"**无法实现**。
**修复（rev3 §0/§1）**：
- 设计**显式限 owner 租户**（当前 prod 现实：BANDROOM_ALLOWED_EMAIL_DOMAINS 未设，非 owner anonymous）。删除"跨租户完成"声明与 CG-6 跨租户完成用例。
- **真跨租户完成 = 独立后续工作流**：per-tenant service identity（token→tenant 映射，rev2 §7 S3/F15，iteration-30 蓝图 §7）。本设计不实现。
- **绝不**把 claim 返回的 task.userId 用于授权（防 leaked runner token IDOR）。
- **A1 理由重构**：decoded checkpoint 完整性对 owner 租户仍有价值（分析绑定经验证解码输入 + 不可变 receipt），且是复用 requireDecodedInput 的既有要求；非"跨租户"理由。Z-2=A1 决定不变。
- CG-6 改为**owner 租户隔离回归**（完成 owner 任务不写他租户行/审计；服务身份写侧矩阵复用 tests/tenant-isolation）。

### U-BL-3 wire schema 被 runner 拒绝 + 形态混淆 + UI 字段名（接受）
**亲核证实**：`coerce_grounded_analysis` `_ANALYSIS_FIELDS={detectorVersion,inventoryVersion,speechSeconds,candidates}`，未知字段 raise（content_rules.py:247-271）；Feedback.__post_init__ 调它（models/base.py:32-33）。UI 消费 `root.items`/`root.candidates`、`reliability`/`t1_reliability`（对象）、`calibrated_prosody.pause_count`（pronunciation-review.ts:366-400），**非** prosodyEvidence/reliabilityDisclosure。
**修复（rev3 §1.1/§1.2）**：
- **单一 wire 契约**（runner→server，untrusted）：`{schema:"bandroom-grounded-analysis-v1", analysisVersion, detectorVersion, inventoryVersion, speechSeconds, candidates:[{word,expected,actual,atMs,detectorConfidence,tier,catchTrial?}], reliability:{...}, calibrated_prosody:{pause_count,pause_seconds,speech_ratio,...}}`。**禁 candidateId**（server 签发）。
- **coerce_grounded_analysis 同步扩 allowlist**（+schema/analysisVersion/reliability/calibrated_prosody；candidates 保持），与服务端 zod 锁步。
- **两形态分离**：wire input（拒 candidateId）vs server-stored（`items:[{candidateId,...,tier:"T3",requestedTier,isCatchTrial}]`，UI 读 items）。
- `toIssueInput(g, task)` 从 task 取 attemptId/recordingId（issueInput 必需，calibration.ts:107-114）；enrichCandidateIds 1:1 保序。
- 字段名对齐 UI（reliability 对象 / calibrated_prosody），CG-8 断言披露实际渲染。

## 2. Major 逐条闭环（摘要，详见 rev3）

- **U-MJ-1**：`if (candidates.length)` 才签发；items:[] 存 prosody-only；真 parse 失败抛 ReviewTaskError("invalid_analysis")。CG-5 断言无候选行。
- **U-MJ-2**：独立 env `GROUNDED_ANALYSIS_VERSION` / `GROUNDED_RELEASED_VERSIONS`（或按 task kind 作用域），**不**设全局 ANALYSIS_BUNDLE_VERSION（避免给 QA 声学轨 speaking 任务打 grounded 版本，speaking-analysis.ts:61 会拒）。文档明写 grounded release=契约门。
- **U-MJ-3**：calibration 失败（detector_version_mismatch / ZodError）包成 ReviewTaskError 稳定码（如 `calibration_version_mismatch`/`invalid_analysis`），入 toolError 映射，runner 可分类。
- **U-MJ-4**：runner 用 `wave` 取 raw s16le frames（剥 44 字节 WAV 头）+ sampleCount；ffprobe 取 container/codec/sourceRateHz/sourceChannels/containerDurationMs/primingMs；manifest strictObject **nullable 字段须 present 为 null**；container 非空（取自 read_review_recording.mimeType）。
- **U-MJ-5**：解码后预计 sampleCount，>6,291,456（~393s）→ 早失败专用永久码 `decoded_too_long` 入 QUEUE_PERMANENT_CODES；transfer 永久码（artifact_conflict/invalid_decode_checkpoint/transfer_expired/checkpoint_advanced）入 QUEUE_PERMANENT_CODES；put/get_bytes 的 McpError 须带码分类（扩 mcp_client 或 orchestrator 映射）。
- **U-MJ-6**：manifest.analysisVersion 取 task.analysisVersion（present 时）否则 runner config `grounded_analysis_version`（钉死=Worker GROUNDED_ANALYSIS_VERSION）；两者皆无 → fail closed。文档明写耦合。
- **U-MJ-7**：真实保证 = recordingSha256 ↔ R2 digest ↔ checkpoint input ↔ complete digest；snapshot.recording 腿**仅 present 时**（assertBoundRecording:136 缺则 return）。CG-2 显式测 absent-snapshot 分支；queue speaking 任务要求 snapshot.recording present（新提交必有）。
- **U-MJ-8**：精确声明——coachingContentViolation 仅扫 feedback/evidence 文本禁 numeric band（content-rules.ts:20-40），**不**检 analysis；"无音素断言"= **非断言渲染**（tier 恒 T3 + UI 不渲染 expected→actual 为断言）+ 数据层 catchTrial 盲化。CG-7 改"渲染非断言 + tier T3 强制"；reliability 由 runner 校准披露派生/有界，非自由文本。
- **U-MJ-9**：checkpoint_not_read 由 save_decode PUT 的 save_review_checkpoint(transport=binary-v1) 事件即满足（route:40-61；requireDecodedInput:380-385 event IN save/read）。read_decode GET 保留作完整性校验，**不**声称其为 checkpoint_not_read 机制。
- **U-MJ-10**：测试补全失败模式（见 rev3 §3）：duplicate-complete 候选稳定/无新行、artifact_conflict、checkpoint_advanced、transfer_expired、新 fence 重 claim 须重发 save/read 事件（fence-scoped）、stock task analysisVersion override、absent snapshot、>393s、owner 隔离回归。

## 3. Minor 闭环
U-mn-1 行号纠正；U-mn-2 detectorVersion cap 对齐（wire ≤80 与 feedbackSpec 一致，issueInput ≤120 兼容）；U-mn-3 grounded 分支入 state 守卫；U-mn-4 QA decoded.sampleCount 检查隔离（grounded 无 .decoded）；U-mn-5 transfer 从内存 raw 二次解码（produce temp dir 已删）。

## 4. 降级项（R1.BL-4 → U-mn-6）
**主导驳回原 BL 定性**：评审引 `runner/config.example.toml:33 coach_audio_mode="off"`，但 **prod 备份 `runner-config-prod-backup-20261120T054416Z.toml:32 = "grounded"`**（亲核）；memory §102-103 ④-A 已部署 grounded + launchd audioMode=grounded + 实跑 processed=2 grounded feedback；P2b 验证亦 audioMode=grounded。**parity 前提为真**。Gate-1 held 的是**legacy omni 音频教练**（below baseline）；grounded prosody（④-A）是 owner 授权的**安全 T1-only 路径**（无音素断言），非被 hold 的教练洗白。修复仅须：rev3 引 prod 配置证据 + 澄清 Gate-1 hold 对象。无质量门绕过。

## 5. 两路核验为正确（保留）
uint32_be（DataView.getUint32 大端）；artifact.sha256 覆盖整个 body；decode manifest 不需 canonical（仅 acoustic 需）；binaryManifestLimit=4096；PCM≤12MiB→6,291,456 samples≈393.2s；grantLifetime=120s 每次调用重算（240-900s 模型调用不耗它，LeaseRenewer 包整个 process）；save_decode 要求 stage∈{read_input,decode}=claimed stage；expectedPointer=task.checkpointSha256 fresh=null（sha.nullable 允许）；**无 D1 迁移**；选项 A 正确绕过 validateSpeakingAnalysis（无 errors:[]/coverage/伪造 band）；T3 强制避免 T2 断言。

## 6. 工日修订
R2 判 ~5 工日乐观 1.5-2×。主导接受：**~7-10 工日**（字节精确大端帧 PCM + 签名 grant + 真实 Miniflare/R2 集成 + owner 路径共享 helper 无漂移重构 + 候选幂等修复），不含契约门运行/owner 日历/许可合规门。

## 7. 红线不变
T2 退役；不伪造音素/质量 PASS；不降隔离；**绝不信任 claim body task.userId 授权**；许可②/合规门不解除；QA 音素契约逐字节不动；未放行实施前不改代码/部署/git。