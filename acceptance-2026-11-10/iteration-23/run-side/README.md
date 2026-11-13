# G3 v26 RUN-side 交付（本地）

2026-11-13（UTC）。本目录只含**运行侧准备物**：A/B/C 官方 Work run 提示词、output manifest 契约与校验器、G5 证据导出 schema/骨架、Chrome §5.2 测试计划。**未部署、未调用云/Work/Sites/Chrome、未修改 QA 服务端 checkout、未接触生产/学习者数据。** 设计依据：`../V26_SOLUTION_DESIGN.md`（rev2）与 `../REVIEW_CLOSURE.md`。

## 1. 文件

| 文件 | 作用 |
| --- | --- |
| `FIXED_CONTRACT.json` | 固定 jobId/taskId/recipeSha256/录音/prefix/锚点/交付清单/租约等唯一真源 |
| `RUN_A_PROMPT.txt` | A：首领取 + 编排层注入 `recording_read_failed` + retry_wait；不存前缀 |
| `RUN_B_PROMPT.txt` | B：接管 fence+1 + reuse-or-deliver/安装 + MCP 读原声 + 6 片前缀链 + `compute_budget` 中断（851 窗剩余，nextIndex=7） |
| `RUN_C_PROMPT.txt` | C：fence+2 + 读 index0..6 重组 + 851 窗续跑 + 独立冷跑 859 窗 + cold==resumed + manifest@index7 + 绑定回写 + 回执丢失重放 + 旧 fence 拒绝 + 单份反馈 |
| `RUN_D_COLD_PROMPT.txt` | D：第 4 个只读官方冷参考 run（G5 `coldRunId`），无租约/无写回；生成 `offline-checkpoint.bin`、验签器全局窗 `acoustic-NN.bin`、冷 logits 与 v26 冷输出 |
| `output-manifest.template.json` | `bandroom.qa.acoustic-output.v1` 精确字段模板（占位符必须替换为实测值） |
| `validate-acoustic-manifest.mjs` | 复刻 `completeAcousticFeedback` 校验 + v26 本地严格策略；`--selftest` 23/23；`--file` 校验真实 manifest 并打印回写参数 |
| `official-run-record.template.json` | M8 官方运行引用/服务器 runId/fence 的记录模板 |
| `g5-evidence-export.schema.json` | 32 个常规文件 + `acoustic-NN.bin`、manifest/角色/交叉绑定/验签结构、集成风险 |
| `export_g5_evidence.py` | G5 导出骨架（`--build` 映射；`--check` 校验已组装 bundle） |
| `CHROME_52_TEST_PLAN.md` | §5.2 Chrome 回听：窗口/容差/事件序列/交互矩阵/双编码/两份人工证据/§4.3 探针 |
| `RECONCILIATION.md` | R1–R6 逐条闭环：证据、导出实现、需 Agent 1/验签器配合的变更清单 |
| `test_r2_acoustic_plan.py` | R2 本地证明：plan 与真实 `acoustic_stage.windows` 相等；真实 `verify_acoustic` 正例通过、负例拒绝；exporter build/check 产物再过验签 |
| `check_recipe_sha.py` | 重算并断言 recipeSha256 |
| `SHA256SUMS` | 本目录文件摘要 |

## 2. 冻结的 recipeSha256（B4）

规范描述串（canonical JSON：排序键、`,`/`:` 分隔、无空白、无尾随换行、UTF-8）见 `FIXED_CONTRACT.json.recipeDescriptorCanonical`，401 字节：

```
{"batch":8,"frameMs":20,"interOpThreads":1,"intraOpThreads":2,"keepsAllWindowFrames":true,"mode":"diagnostic","model":{"encoder":"913f30b9...","probe":"813c83..."},"prefixWindows":8,"runtime":{"ort":"1.24.4","target":"cp312-manylinux-x86_64"},"sampleRateHz":16000,"strideMs":80,"windowMs":120}
```

**recipeSha256 = `9022a23414fc0201753c3a06e81209d058c9ae0fbe5c6dff5893042e909e95c2`**（新值，≠ 旧 CUPE `602a745b…`）。`python3 -I check_recipe_sha.py` 复核通过。

- 串中模型 SHA 为完整 64 位：encoder `913f30b9…657ed07c`，probe `813c83…22430370`（页面显示省略）。
- 若改用“字面插入顺序”序列化会得到不同值 `4254bad5…`；**不采用**，因为仓库既有 canonical 助手与 `verify_acoustic` 的 `stage_sha` 都用排序键。
- HJK 旧租约（旧 recipe/fence2）按 B4 由 owner 授权 QA-only 重置；A 预期 fence=1，B=fence_A+1，C=fence_A+2，全部记录实测、断言单调增长，不硬编码。
- 与 `../verify_official_run_v26.py` 对齐：`modelSha256` 必须是 encoder-int8 图 SHA `913f30b9…`（不是 encoder+head 合并摘要）；prefix 字段名为 `prefixSha256`（设计简写 `prefixSha` 为同值别名）。该独立验签器重算出的 recipeSha256 与本目录一致。

## 3. 使用方式

1. 部署 v26 并完成 B4 重置 + claim smoke test（本目录不执行）。
2. 依序把 `RUN_A_PROMPT.txt` / `RUN_B_PROMPT.txt` / `RUN_C_PROMPT.txt` / `RUN_D_COLD_PROMPT.txt` 作为同一官方周期任务四次独立 scheduled run 的指令；每次只跑一个阶段。A/B/C 用 `record_qa_run_event` 发射 9 类云事件 + `offline_run` 审计行，并各自 `read_qa_site_events` 导出。
3. C 产出的 `checkpoint-7.json` 用 `node validate-acoustic-manifest.mjs --file <path> --fence <fence_C> --quote "[原声录音]"` 校验；通过后打印的 `write_qa_text_feedback` 参数应与 C 实际调用逐字一致。
4. 证据回收后按 `g5-evidence-export.schema.json` 组装：`export_g5_evidence.py --build` 会按验签器的全局窗计划验证/拷贝 `acoustic-NN.bin`，过滤 `site-event-export.json` 为 11 条云事件，从 wake 行构建 `emptyQueueWakes`；`--check <dir>` 做结构与绑定自检。正式验签仍用 `analysis/scripts/verify_cloud_release.py`。
5. Chrome 按 `CHROME_52_TEST_PLAN.md` 执行并落两份人工证据。

## 4. 本地已验证

- `check_recipe_sha.py`：PASS（401 B，canonical yes）。
- `validate-acoustic-manifest.mjs --selftest`：28/28（正例接受；缺 schema/错录音/cold≠resumed/非 hex/windows=0/duration 越界/rawOutputBytes=0/pcm/model 非 hex/runtime 数组/prefix 缺失/measured_feedback/短 feedback/错前缀/marker 来源/truth/跨度/词长/7 markers/占位符/windows≠859/rawOutputBytes/锚点/prefixBytes/合成 SHA 全部拒绝）。
- `output-manifest.template.json` 被校验器正确拒绝（占位符/占位 runId），防止把模板当证据。
- `export_g5_evidence.py --check`：在临时合成 bundle 上 PASS（32 文件 + plan chunks + 绑定）；缺文件/错绑定会失败。合成 bundle 已删除，未留假证据。
- `test_r2_acoustic_plan.py`：9/9 PASS（plan 与真实 `acoustic_stage.windows` 相等；真实 `verify_acoustic` 接受 exporter 产物；篡改 chunk/suffix/stage index 被拒）。

## 5. 集成风险闭环（逐条见 `RECONCILIATION.md`）

1. **R1 冷跑独立官方 run — 已闭环**：新增 `RUN_D_COLD_PROMPT.txt`（第 4 个只读官方 run，无租约/无写回），其 `officialRunId` 即 `acoustic-recovery.coldRunId`；C 内冷跑仍是 §4C 硬门，D 为 G5 冷证据。禁止复用 C 的 runId。
2. **R2 acoustic 分片计划 — 已闭环（选项 2，验签器不变）**：`export_g5_evidence.py` 按 `windows(sample_count)`（320/400/800/context100/offsets 0,400）重算并校验 `acoustic-NN.bin`；B 持久化 plan 前 6 块、C 恢复并续算第 6..9 块，executor/事件用 plan 列表；v26 6 片 prefix 保留给 G3 resume。`test_r2_acoustic_plan.py` 9/9：plan 与真实 `acoustic_stage` 相等，真实 `verify_acoustic` 接受 exporter 产物、拒绝篡改。
3. **R3 词级输出 — G5 依赖 G1/G2，不阻塞 G3**：`offline-output.json/offline-cold-output.json` 的词级 `analysis.errors` 来自 G1/G2 裁决账本，不由 G3 诊断 manifest 产生。
4. **R4 site event log — 已闭环（Agent 1）**：`record_qa_run_event`（幂等，`recording_verified` 强制 bytes+sha256，`offline_run` 强制 automationId+isolated）与 `read_qa_site_events` 已上线；A/B/C 提示词逐步调用，`export_g5_evidence.py` 过滤为 11 条云事件并从 `kind=wake` 行构建 `emptyQueueWakes`（排除 `drain_qa_queue`）。
5. **R5 provenance — 文档化**：F2/F3–F5/F6 主云 JSON 未本地字节核验（m9）；以本地 SHA 核验的 Work readback 为准。
6. **R6 预算 — 文档化，待 D1**：`runtime-profile` 要求 download+prepare≤300 s；实测吞吐下 48.1 MiB int8 模型已超 300 s。需 owner 批准 §4.3 证据化修订，不得写未实测的达标值。

已并入协调者 relay：

- 每个 offline run 记录必须带 `automationId`，且 `offline.isolated=true`；exporter 强制 `run.automationId == history.automationId`，并用 `offline_run` 审计行交叉校验。
- B 的 `recording_verified` 必须带 `bytes=441322` 与 `sha256=<recording sha>`；schema、exporter 与 B 提示词三处一致校验。
- site-event-export 只允许 9 类云事件共 11 条；`offline_run/wake/drain_qa_queue` 必须过滤。
- 已知 G1 风险（供参考）：ASR 词若无 cmudict 读音，aligner `phones()` 会因空表拒绝。

## 6. 诚实边界

- A 的 `recording_read_failed` 是**编排层注入**：服务端无声学读故障钩子，`retryReasons` 仅为 client 声明；提示词要求在证据中写明 `serverHook=false`。
- HJK 的 PCM/prefix/output SHA 必须云端实测；本地值（`912fcde5…`、`4b347dd6…`）只作比较。禁止使用 `487a9db6…`、`4779241b…`、`21440` 等 v24/CUPE/合成夹具值。
- 本目录不声称 G3 通过；Chrome 与 24h 唤醒另行验收。