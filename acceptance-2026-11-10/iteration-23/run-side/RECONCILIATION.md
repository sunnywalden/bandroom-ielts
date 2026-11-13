# G3 v26 RUN-side · 集成风险闭环（R1–R6）

2026-11-13（UTC）。只读/本地：未修改服务端源码、未部署、未调用云/Work/Sites、未接触生产/学习者数据。依据：`.sites-checkout/analysis/scripts/verify_cloud_release.py`（verify_work / verify_runtime / verify_acoustic / verify_offline_output / verify_browser）、`analysis/src/bandroom_acoustic/{acoustic_stage,checkpoint}.py`、Agent 1 新增的 `qa-admin.js`（`record_qa_run_event` / `read_qa_site_events`）。

## 结论摘要

| 风险 | 状态 | 闭环物 |
| --- | --- | --- |
| R1 coldRunId 必须是独立官方 run | 已闭环 | `RUN_D_COLD_PROMPT.txt`、`official-run-record.template.json`、设计 §4 Run D、exporter `coldRunId` 绑定 |
| R2 acoustic-NN 必须按验签器 plan | 已闭环（选项 2，验签器不变） | B/C plan 分块持久化/恢复、`export_g5_evidence.py`、`test_r2_acoustic_plan.py` 9/9、设计 §4 rev4 |
| R3 offline-output 需词级裁决错音 | 归为 G5 对 G1/G2 的依赖，不阻塞 G3 | schema `R3`、README §5 |
| R4 11 条 cloud site events | 已闭环 | A/B/C 逐步调用 `record_qa_run_event`；exporter 过滤/构建 |
| R5 provenance（m9） | 文档化 | schema/README |
| R6 §4.3 预算（D1） | 文档化，待 owner | schema/README |

## R1 — coldRunId 必须是独立官方 run

验签事实（`verify_cloud_release.py`）：
- L85–87：`cold_id = recovery["coldRunId"]`；要求 `set(run_ids+[cold_id]) <= records.keys()` 且 `cold_id not in run_ids`。
- L146–156：cold executor 行必须绑定独立的 official record（`cold_record`），`readOnly=true`、`cacheEmpty=true`、`restoredChunks=[]`，且 `newChunks == cold`。

闭环：新增 **Run D**（第 4 个官方 scheduled run）：
- 只读：不 claim/续租/存 checkpoint/retry/写反馈；无 server fence（证据写 null 并注明 no-lease）。
- `officialRunId` 独立于 A/B/C，写入 `official-run-history.runs` 与 `acoustic-recovery.coldRunId`；**禁止复用 C 的 runId**。
- 产出 `offline-checkpoint.bin`（bandroom-decode-v1）、验签器 plan 的 `acoustic-00.bin…`、两 pass cold logits、以及 v26 859 窗 `cold-output.f32le`（与 C 的 cold/resumed 逐字节比较）。
- C 内的 cold 仍是契约 §4C 的 in-run 硬门；D 是 G5 的独立冷证据。两者不一致时如实报告，不写完成。

落点：`RUN_D_COLD_PROMPT.txt`、`official-run-record.template.json`（run D + coldRun 块）、`V26_SOLUTION_DESIGN.md` §4 Run D、`export_g5_evidence.py`（`compose_offline` 要求 D 独立、`compose_executor` 绑定 D）。

## R2 — acoustic-NN 必须按验签器 plan

验签事实：
- `verify_acoustic`：`plan = list(windows(decoded.sample_count))`；`windows()` 用 `FRAME_SAMPLES=320`、`RECEPTIVE_SAMPLES=400`、`FRAMES_PER_WINDOW=800`、`CONTEXT_FRAMES=100`、`PASS_OFFSETS=(0,400)`。
- HJK 1,099,196 样本 → total frames 3434 → **10 个 transfer chunk**（offset 0 五个、offset 400 五个），每块 raw 长度 `(end-start)*768*4`。
- chunk 格式：4 字节大端 header 长度 + 规范 JSON `{format:"bandroom-acoustic-chunk-v1",chunkIndex,previousSha256,decodeSha256,bundleSha256,configSha256,featuresSha256}` + raw `<f4`；`previous` 从 `decodeSha256` 起链。
- L250–260：`prefix == resumed[:cut]`、`resumed == cold`、`len(set(resumed))==len(resumed)`；B `savedChunks==prefix`、C `restoredChunks==prefix`、C `newChunks==resumed[cut:]`、cold `newChunks==cold`；`stageIndexSha256` 必须复现 `AcousticStore.manifest(...)`。
- L279–281：`offline-output.json` 与 `offline-cold-output.json` 的 manifest 哈希相等且等于 C/cold executor 的 `outputSha256`。

### 决策与闭环：选项 2（B/C 额外持久化 plan 分块），正式验签器不变

选择理由：`verify_cloud_release.py` 是发布门，改动敏感；选项 2 只增加 run 侧证据，不动 release 验签代码。

实现（run 侧）：
- 固定 `cut=6`、总块数 10（HJK）。`analysis-config.json.acousticConfig` 由编排方放到 `/mnt/data/bandroom-g5/`，B/C/D 逐字使用，不求自造 configSha。
- **B**：在 v26 6 片 prefix 之外，按验签器 plan 计算第 0..5 块，写 `/mnt/data/bandroom-g5/acoustic-plan/acoustic-00..05.bin` 与 `plan-b.json`；`checkpoint_saved` 用 plan 语义（`nextChunk=6`、`checkpointSha256=transfer[5]`、`planChunkSha256`）；v26 prefix 照旧保存/中断。
- **C**：必须从该目录读取并逐块校验前 6 块（缺失即阻塞，不用重算冒充），续算第 6..9 块；`checkpoint_restored`（`nextChunk=6`、`checkpointSha256=transfer[5]`）与 `suffix_completed.chunks=transfer[6:]` 使用 plan 列表；同时保留 v26 prefix 读回与 851 窗续跑。
- **D**：cold 全 10 块，`plan.json` 带 `chunks`（raw payload SHA/bytes）、`cold`（transfer SHA）、`coldStageIndexSha256`、`coldLogits`、`cut=6`。
- **exporter**：`emit_acoustic` 重算 plan，校验块长度/摘要/前驱/identity；`AcousticStore.manifest` 用 **raw payload** 摘要，`resumed/manifest.files/executor` 用 **transfer blob** 摘要（这是首次测试暴露的关键区别）；`compose_executor` 强制 B/C/D 的 lists 与 stage hashes；`--check` 重走 transfer 链。

验签事实（已逐条满足）：
- `prefix == resumed[:cut]`、`resumed == cold`、digest 互异；B `savedChunks==prefix`、C `restoredChunks==prefix`、C `newChunks==resumed[cut:]`、cold `newChunks==cold`。
- `checkpoint_saved/restored.nextChunk==cut` 且 `checkpointSha256==prefix[-1]`。
- `stageIndexSha256`：B = `sha256(AcousticStore.manifest(rows[:cut]))`，C/D/`coldStageIndexSha256` = 全量；rows 用 raw 摘要。
- `logits` C==D==`coldLogits`，offsets `[0,400]`，frames 等于各 pass 的 `sum(end-start)`。
- `offline-output.json`/`offline-cold-output.json` 哈希相等且等于 C/D `outputSha256`（内容仍来自 G1/G2，见 R3）。

测试证据（`test_r2_acoustic_plan.py`，9/9 PASS）：
- `plan_windows()` 与真实 `bandroom_acoustic.acoustic_stage.windows()` 对 1,099,196 与 100,000 样本完全相等；HJK=10 块。
- 手工构造 evidence 调真实 `verify_acoustic`：正例通过；篡改 chunk、错误 suffix、错误 prefix stage index 均被拒。
- 用 `export_g5_evidence.build()` 生成完整 bundle、`--check` 通过，再把导出的 docs 喂真实 `verify_acoustic`：正例通过。
- 合成夹具均为 TEST-ONLY，运行后删除；未写入正式证据。

## R3 — offline-output 的词级裁决错音

验签事实：`verify_offline_output` 要求 `analysis.errors` 的 `{wordIndex,phoneIndex,kind,target,actual}` 与 `adjudicated.json`/`reference-words.json` 的人工错误逐项匹配，`coverage.analyzedSamples` 覆盖 `[[0,sampleCount]]`，且 `playback.startMs` 命中某错音起点。

结论：G3 的 `bandroom.qa.acoustic-output.v1` 是传输/推理诊断，不含词级错误；`offline-output.json/offline-cold-output.json` 必须来自 G1/G2 的裁决账本与合格模型输出。**这是 G5 对 G1/G2 的依赖，不是 G3 失败**。exporter 只做拷贝与哈希相等/执行器 outputSha 绑定，不合成词级内容。

## R4 — 11 条 cloud site events

Agent 1 新增（`qa-admin.js`）：
- `record_qa_run_event`：owner-only、append-only、幂等 per `(owner,officialRunId,type,fence)`；类型 9 类 + `offline_run`；`recording_verified` 强制 `bytes` + 64-hex `sha256`；`offline_run` 强制 `automationId` 且 `isolated===true`；`source` 默认 `cloud`；`detail` 扁平化进行。
- `read_qa_site_events`：按 `type/officialRunId/since/afterId/limit` 过滤，返回 `kind/type/at/utc/officialRunId/fence/jobId/automationId/isolated/bytes/sha256/stage/detail/source/pendingCount/pendingAcoustics/subscriptionActive/subscriptionVerified/subscriptionExpiresAt/emptyQueueAccepted`。

闭环：
- A/B/C 提示词在对应步骤调用 `record_qa_run_event`：A→claimed/retry_wait；B→claimed/recording_verified/checkpoint_saved/interrupted；C→claimed/checkpoint_restored/suffix_completed/feedback_committed/receipt_readback；每 run 另发 `offline_run` 审计行；结束前 `read_qa_site_events({officialRunId})` 导出。
- `export_g5_evidence.py`：只保留 9 类云事件共 11 条（`CLOUD_EVENT_TYPES`），强制 `source=="cloud"`，`at=utc`；`offline_run/wake/drain_qa_queue` 一律过滤；`emptyQueueWakes` 从 `kind=="wake"` 且 `emptyQueueAccepted/subscriptionActive` 的行构建，`drain_qa_queue` 不参与。
- `--check` 额外拒绝 non-G5 类型混入 site export。

## R5 — provenance（m9）

F2/F3–F5/F6 主云 JSON 未本地字节核验；以本地 SHA 核验的 Work readback 为准。导出脚本只接受 run 目录中的实测 readback，不接受转述值。

## R6 — §4.3 预算（D1）

`runtime-profile` 要求 `download+prepare≤300 s`、`coldBytes≤300 MB`；实测 4.044 MiB/min 使 48.1 MiB int8 模型单独超 300 s。需 owner 批准证据化修订；exporter 只校验实测字段，不会写达标值。

## 需 Agent 1/验签器配合的变更清单（按优先级）

1. `verify_acoustic` **不需要改**（选项 2 已用真实函数验证）。仅需在 release 证据中保证 `analysis-config.json.acousticConfig` 与 run 侧使用同一冻结对象，且 B/C 的 plan 分块可见性符合 `/mnt/data` 持久性实测。
2. `verify_work` 已支持第 4 个 official run；确认 Run D 的 `officialRunId` 进 `history.runs` 与 `recovery.coldRunId` 的映射。
3. `verify_offline_output` 保持 G1/G2 裁决账本输入；G3 不提供词级 `analysis.errors`。
4. `site-event-export.json` 只收 11 条云事件；`offline_run` 行仅用于 `offline.json` 审计交叉校验，wake 行仅用于 `emptyQueueWakes`。
5. （可选）在 `verify_official_run_v26.py` 增加 Run D 的 `offline-checkpoint.bin`/plan/冷 logits 校验。

## 本地验证证据

- `export_g5_evidence.py --build/--check` 在临时合成 run 上通过：32 常规文件 + 2 个验签器 plan chunk + 全部绑定；site export 恰 11 条（9 类），`offline.isolated=true`、`coldRunId` 独立、3 条 wake、`recording_verified` bytes/sha 匹配。合成夹具已删除。
- `test_r2_acoustic_plan.py`：9/9 PASS；包含 plan 等价、真实 `verify_acoustic` 正/负例、exporter build→check→`verify_acoustic` 全链路。运行：`python3 -I test_r2_acoustic_plan.py`。
- `validate-acoustic-manifest.mjs --selftest` 28/28；`check_recipe_sha.py` PASS（`9022a234…`）。
- 未运行真实云/Work；未改服务端源码。