# QA 声学轨评估（G3 复验专用，不实现）

2026-11-14。范围：为 rev2 §4.4.2 / D-12 的 QA harness 移植做运行时、存储、工具与证据映射评估。
本文件**不实现** QA 轨；生产教练轨代码在 `runner/` 其余模块。评估依据仓库 `ca46efa`：

- `examples/work-qa/server/index.js`、`qa-admin.js`、`acoustic-checkpoints.js`、`analysis-bundle.js`、`runtime-probe.js`、`pronunciation.js`、`recordings.js`、`work-events.js`、`wrangler.json`
- `analysis/scripts/cloud_stage.py`、`analysis/requirements-cloud-x86_64.txt`
- 评审闭环 BL-5/6/11、MJ-1/2；设计 §4.4.2/§4.7

结论：QA 轨与生产教练轨**运行时身份不同**，不能由本机 Python 3.13 代跑；G3 证据必须由独立部署的 QA harness + Linux x86_64 CPython 3.12 声学 runner 产生。

## 1. 运行时需求

### 1.1 QA harness 服务（Cloudflare Worker）

- 来源：`examples/work-qa/server`，`wrangler.json`：`name=bandroom-work-review-qa`，`main=index.js`，`compatibility_date=2026-07-28`，绑定 `BUCKET`（R2），cron `* * * * *`（每分钟）。
- 运行平台：workerd（Cloudflare Workers），非 Node 常驻进程；本地测试用 Miniflare（`node --import ./scripts/sites-env.mjs` 或示例测试）。
- 仓库 `package.json` engines：Node `>=22.13.0`（仅构建/本地测试需要）。
- 必须独立于生产：独立 Worker、D1、R2、域名、CF Access 应用（独立 AUD）、service token、`QA_BUNDLE_KEY`。不得复用生产 D1/R2。
- 关键 secrets/变量（从代码读取）：
  - `QA_BUNDLE_KEY`：analysis bundle grant HMAC（`analysis-bundle.js:10/70`）。
  - `QA_ANALYSIS_MANIFEST_SHA256`：固定 manifest 的 SHA，pin 到 R2 `analysis/sha256/<sha>/manifest.json`。
  - `QA_TRANSPORT_FIXTURE_JOB_ID`：仅 fixture transport 测试时设置。
  - D1/R2 bindings（示例为 `DB`/`BUCKET`）。
- 声学工具本身**不跑 ONNX**；harness 只发租约、校验/存储 checkpoint 分片、签发 bundle grant。ONNX 计算在 Linux runner。

### 1.2 声学 runner（Linux x86_64 冻结运行时）

`analysis/scripts/cloud_stage.py` 的硬约束：

- `TARGET = {"system":"Linux","machine":"x86_64","python":"3.12"}`；`execute()` 用 `platform.system()/machine()` 与 `sys.version_info` 比较，不匹配直接失败（`cloud_stage.py:19/169-172`）。
- 依赖来自随包 wheels，`pip --isolated --no-index --no-deps --require-hashes` 安装；无网络下载：
  - `onnxruntime-1.24.4-cp312-cp312-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl`
  - `numpy-2.4.4-cp312...manylinux...whl`、`flatbuffers 25.12.19`、`mpmath 1.3.0`、`packaging 26.3`、`protobuf 7.36.2`、`sympy 1.14.0`
- 图：`encoder-int8.onnx` SHA `913f30b9…`、`probe-head.onnx` SHA `813c832b…`（`cloud_stage.py:20-23`）。
- 外部命令：`ffmpeg` 必须在 PATH（decode 阶段 `shutil.which` 检查，`cloud_stage.py:138-141`）。
- 运行时包：v26 runtime zip，`deliveryBytes=75,446,950`，SHA 绑定 `ANALYSIS_RUNTIME_BUNDLE_SHA256`；`build` 输出 `bundleSha256/bytes/protocol=bandroom-cloud-stage-v1/target/files`。
- 执行方式：`cloud_stage.py decode|acoustic --bundle ... --bundle-sha256 ...`；acoustic 默认 `--threads 4`。
- 建议宿主规格（**估算，待 P2 实测**）：Linux x86_64、4 vCPU、≥4 GB RAM、≥10 GB 磁盘（解包 runtime + numpy/ORT + 临时 decode/checkpoint）。无 GPU。
- 产物格式：`bandroom-decode-v1`（`checkpoint.py:18`）；声学分片 `bandroom-acoustic-chunk-v1`。

### 1.3 本机 Python 3.13 与 QA 轨 3.12 的差异

- 本机（darwin/arm64，Python 3.13.13）**不能**运行 `cloud_stage.py`：平台三元组不符，且 ORT 1.24.4 轮子仅 cp312 manylinux x86_64。
- `runner/` 生产教练轨仅用标准库（`tomllib`、`urllib`、`fcntl`），在 Python 3.13 可运行、可测试；这**不**代表 QA 声学轨可移植。
- QA 验收必须使用 Linux x86_64 + CPython 3.12 容器/VPS；本机只做单元测试与 mock。若用 Mac 宿主，需新运行时身份、重新冻结并记录偏离（BL-5/rev2 D-4）。

## 2. 存储需求

### 2.1 D1（QA 专用）

代码中出现的表（`CREATE TABLE IF NOT EXISTS`）：

| 类别 | 表 |
| --- | --- |
| 复核/答案 | `qa_audio_processing`、`qa_feedback`、`qa_recordings`、`qa_recording_objects`、`qa_review_reads`、`qa_review_recovery`、`qa_speech_evidence` |
| 投递/订阅 | `qa_outbox`、`qa_subscriptions`、`qa_drained_jobs` |
| 声学 | `qa_acoustic_leases`、`qa_acoustic_parts`、`qa_acoustic_completions` |
| 运行证据 | `qa_site_events`（append-only，wake + run event）、`qa_runtime_probe_scratch` |
| 其他 | `probe`、`qa_pronunciation` |

容量估算（**估算**）：元数据为主，验收规模下 <100 MB；`qa_site_events` 按 24h/minute wake + run events 计，远小于此。保留期按 owner 决议。

### 2.2 R2

- 录音对象：`qa_recording_objects` 引用；原始录音上限按站点 12 MiB（生产约定；QA fixture 更小）。
- 声学 checkpoint 分片：单分片 ≤24,576 B，index 0..8191（`maxParts=8192`），`sha256` 去重存储；每条录音最多约 192 MiB（理论上限，实际远低）。
- `bandroom-decode-v1` 单次 PUT ≤12,587,012 B（`decodeCheckpointLimit = 4 + 4096 + 12MiB`）。
- `bandroom-acoustic-chunk-v1` 单片 ≤2,461,700 B（`4 + 4096 + 800*768*4`），chunkIndex 0..50。
- analysis bundle：manifest ≤64 KiB，最多 100 片、单片 ≤6 MiB、总 ≤512 MiB（`analysis-bundle.js`）；v26 runtime zip 75,446,950 B 单独交付，不属于 bundle。
- v24 CUPE 诊断 ZIP（120,583,778 B）仅归档，不入 runtime/bundle。

### 2.3 租约/时序（与生产 review_tasks 是两套机制）

- QA 声学 lease：`leaseMs = 10 * 60_000`（600,000 ms）；`retryMs = 30_000`；默认 `threads=4`。
- claim 语义：`claim_qa_acoustic` 用同一 `runId` 在租约内 reclaim = 续租且 **fence 不变**；新 Work execution 用新 UUID；`recipeSha256` 跨 run 复用。
- 生产教练轨不 claim 租约（服务端 `add_coach_feedback` 内部 claim→complete），两者不得互证（mn-6）。
- MCP body 128 KiB 风险（mn-7）仅影响 QA 大 payload；生产 `analysis:null` 无此问题。

## 3. QA 工具清单（代码实测）

### 3.1 声学（`acoustic-checkpoints.js`）

| 工具 | 作用 |
| --- | --- |
| `claim_qa_acoustic` | 领取/续租声学 checkpoint lease；返回已提交前缀长度、原始录音 SHA。 |
| `save_qa_acoustic_checkpoint` | 追加一个 SHA-256 校验的分片（≤24,576 B，index 连续）；歧义写可用同 bytes/index 重试。 |
| `read_qa_acoustic_checkpoint` | 在活跃租约下读取并校验一个已提交分片。 |
| `retry_qa_acoustic` | 释放租约，按 server backoff 让同一 job 下轮可领；已提交分片保留。 |

### 3.2 证据/管理（`qa-admin.js`）

| 工具 | 作用 |
| --- | --- |
| `read_qa_site_events` | 只读导出 append-only `qa_site_events`（wake/run events；since/afterId/type/officialRunId 过滤）。 |
| `record_qa_run_event` | 追加一条 G5/site-event 运行事件；owner/officialRunId/type/fence 幂等。 |
| `drain_qa_queue` | 24h 空队列前清空待处理文字题与 probe scratch，标记具名已完成 job；返回前后快照。 |

### 3.3 复核/投递/音频（`index.js`）

| 工具 | 作用 |
| --- | --- |
| `read_qa_status` | 读取待复核/待声学/订阅状态；每次调用追加 wake 行。 |
| `recover_qa_reviews` | 恢复一条到期 QA review（含已投递未写回）。 |
| `read_qa_recording_bytes` | 读取原始录音有界字节（≤24,576/次），重组前验 SHA。 |
| `retry_qa_work_delivery` | 重试一条到期 synthetic QA review 投递。 |
| `read_qa_text_answer` | 读取某 jobId 的私有 QA 答案与可用声学证据。 |
| `write_qa_text_feedback` | 写回 owner-scoped QA 结果；完整口语题需 recipeSha256/runId/fence/outputSha256/outputIndex 与最终声学输出一致。 |
| `read_qa_speaking_recording` | 以 MCP native audio 读取固定 synthetic QA 录音。 |
| `write_qa_speaking_feedback` | 固定 synthetic QA 口语题写回（听后）。 |

### 3.4 探针/bundle

| 工具/路由 | 作用 |
| --- | --- |
| `read_qa_probe_blob` / `manage_qa_probe_scratch` | 运行时探针（probe owner only）。 |
| `get_analysis_bundle` | 签发短时 owner 认证的固定 SHA bundle 下载 grant；需活跃 job recipe/run/fence。 |
| `/qa/analysis-bundle/upload` | CF API/owner 上传分片（非 runner 凭据）。 |

## 4. G3 证据映射（QA harness 轨）

| G3 机制 | QA 工具/输出 | 证据要点 |
| --- | --- | --- |
| C 冷算 == 续算 | `claim_qa_acoustic`（新 runId 领取已提交前缀）→ `read_qa_acoustic_checkpoint` → 继续 `save_qa_acoustic_checkpoint`；`record_qa_run_event` 记 `checkpoint_restored`/`suffix_completed` | 两条路径 `outputSha256`/`outputIndex`/最终 receipt 一致；前缀 bytes=已提交 parts。 |
| D 独立冷算 | 新 `runId` + 同 `recipeSha256`；`decodeSha256`/`bundleSha256` 绑定；`record_qa_run_event` `claimed`/`recording_verified`/`feedback_committed` | 两次独立输出逐字节/逐 SHA 相等；bundle SHA = `ANALYSIS_RUNTIME_BUNDLE_SHA256`。 |
| 前缀恢复 | `claim_qa_acoustic` 返回 `nextIndex`/committed prefix；`save_qa_acoustic_checkpoint` 同 bytes/index 幂等重放；`retry_qa_acoustic` 释放后重领 | 丢失 receipt 重放不产生重复分片；旧 fence 写被拒。 |
| 绑定回写 + 丢失重放 + 旧 fence 拒绝 | `write_qa_text_feedback`（recipeSha256/runId/fence/outputSha256/outputIndex/evidenceReceipt） | 同参数重放返回原 receipt；改 feedback 拒绝；旧 fence 拒绝；`record_qa_run_event` 记 `feedback_committed`/`receipt_readback`。 |
| 队列 drain | `drain_qa_queue`（excludeJobIds）→ `read_qa_site_events`（kind=`drain_qa_queue`/wake） | 前后 pending 数一致为 0；`emptyQueueAccepted=true`；HJK original 不静默删除。 |
| 24h 实测 | `read_qa_status`（追加 wake）+ `read_qa_site_events`（afterId 增量） | 24h 连续 wake、订阅 active、无漏跑；`official-run-history` 导出。 |
| site events（9 类云事件/11 条 site-event） | `record_qa_run_event`；`runEventTypes`：claimed/retry_wait/recording_verified/checkpoint_saved/interrupted/checkpoint_restored/suffix_completed/feedback_committed/receipt_readback/offline_run | 逐条映射 RUN prompts；officialRunId 用 QA 轨语义，**不等于**生产 D-13 服务端 receipt。 |
| M4 矩阵（Linux） | `cloud_stage.py decode|acoustic` + `save_decode`/`save_acoustic` 传输契约 | 宿主三元组、ORT 1.24.4、bundle 75,446,950 B SHA 核对。 |
| G5 正式 | **不在此轨** | G5 verifier/schema/四角色独立版本化，未解锁（MJ-16）。 |

## 5. 移植方案与工日估计

1. **部署隔离 QA harness**（独立 Worker/D1/R2/域名/Access 应用+独立 AUD/service token）：包装 `examples/work-qa/server`，固定 `compatibility_date`，配置 1 分钟 cron；迁移/建表。约 1–1.5 工日。
2. **QA 数据路径与 secrets**：`QA_BUNDLE_KEY`、`QA_ANALYSIS_MANIFEST_SHA256`、D1/R2 bindings；上传 bundle manifest/分片（CF API，runner 无 R2 凭据）。约 0.5 工日。
3. **Linux 声学 runner**：3.12 + ORT 1.24.4 + ffmpeg；`cloud_stage.py build/unpack/decode/acoustic`；实现 claim、独立续租线程（200–240 s，覆盖子进程全程）、transfer GET/PUT、save_decode/save_acoustic、失败分类。约 1.5–2 工日。
4. **证据导出/契约**：G3 证据包脚本、`official-run-history`/`site-events`/receipts、逐 SHA 清单、验签器 v27 对接（G3 QA 与 G5 分离）。约 1 工日。
5. **验收执行**：M4 矩阵、C/D/前缀/绑定/drain、24h 实测与报告。约 0.5–1 工日。

合计 **约 4.5–6 工日**（与 rev2 P2 的 6–9 工日总盘一致，不含 P0 owner 决策与真实凭证审批）。

## 6. 风险与未决

- QA harness 是 Worker 代码但声学 runner 是 Python/Linux；两条执行路径需在同一证据链中绑定 `officialRunId`+receipt，避免混用生产锚点语义。
- `analysis bundle` 上传需要 CF API/owner 凭据，runner 不应持有 R2 凭据（MJ-4）。
- MCP 128 KiB body 限制需以实测最大 analysis payload 验证（mn-7）；超限按契约版本化调整。
- 当前仓库冻结的 qa_v26 脚本是诊断探针，不能宣称“一字不改复用”（BL-5）；服务器兼容路径在 `bandroom_acoustic`/`cloud_stage.py`。
- 真实 QA 验收需要真实 D1/R2/CF Access/DashScope（仅生产教练轨）凭证；本任务全部 mock，未调用任何生产站点或真实模型。