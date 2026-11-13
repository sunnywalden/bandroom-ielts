# Bandroom G3 · v26 完整方案设计 rev2（MCP-only ONNX 跨运行恢复验收）

2026-11-13（UTC）。**rev2 已闭环独立评审全部发现**（B1–B4/M1–M14/m1–m12，见 [REVIEW_CLOSURE.md](REVIEW_CLOSURE.md)）；决议见 [DECISIONS.md](DECISIONS.md)。依据：[可行性报告](../iteration-22/official-hjk-v24/feasibility-report.json) decision=go（F1–F6）、[G3 契约](../iteration-12/IMPLEMENTATION_DESIGN.md) §4.1/4.2/4.3/§5.1/§5.2、v26-probe 服务端源码、Agent 1/3 产物。**本文件是设计，不是部署授权；本轮不改代码、不部署**（owner 指示）。

## 0. 范围与口径

- 目标：隔离 QA 站用官方 Work 周期任务，对同一 HJK 原题完成契约 §5.1 的 A/B/C 跨运行恢复 + 回执幂等 + 原题单次绑定回写 + §5.2 Chrome 回听 + 24h 空队列唤醒。
- 非目标：G3 是传输/恢复机制验收，非 G2 模型合格、非 G1 盲测。声学载荷用 DistilHuBERT int8 诊断推理；feedback 明确「不代表纠音盲测达标」。
- 口径：G3 通过 ≠ D2 通过；G1/G5 各自达标。生产 v15/学习者数据全程不动。
- 可行性已证（云端实测）：F1 单次 MCP 4MiB（8MiB 失败）；F2 75.4MB 全量+4 次同 run 续租无间断（1067.528s，4.044MiB/min，续租延迟 3.6/5.2/2.7/2.1s）；F3 ORT 离线装+两冷跑逐字节一致；F4 模型重哈希执行；F5 合成夹具 prefix+851 窗 resume 逐字节相等；F6 一次 15,360B index0 往返+旧 fence lease_lost+scratch 清理 remainingObjects=0。
- **provenance 限制（m9）**：F2/F3–F5/F6 主云 JSON 未本地字节核验（文件查看器报错）；以本地 SHA 核验的 Work readback 为准；实施时须恢复字节并复核。
- **F3–F5 SHA 仅适用合成夹具（M2）**：features 94676ef8/output 487a9db6/prefix eaf0e0f7 对应合成 PCM 2757883c；**HJK 真实 PCM 为 912fcde5**，HJK 输出 SHA 须实测，不得套用合成值。

## 1. 架构

```
官方 Work 周期任务（同一 Automation_c2ca080e…，每小时）
  └─ Work 云代码运行时（Python 3.12/NumPy/FFmpeg；无 Torch；HTTP 出口被 Envoy 挡）
       ├─ MCP 工具（/mcp 通，唯一数据通道）
       │    read_qa_status / claim_qa_acoustic / read_qa_probe_blob（交付）
       │    save/read_qa_acoustic_checkpoint / retry_qa_acoustic
       │    write_qa_text_feedback（绑定回写）/ read_qa_text_answer（回执）
       │    recover_qa_reviews（jobId）/ subscribe_to_events·update_subscription（续期）
       ├─ 离线 ONNX Runtime 1.24.4（--no-index）+ int8 encoder/probe-head
       └─ 禁回显 PTY 桥（base64 ≤3000 字符/行，@end 帧，字节不入聊天/日志）
隔离 QA Worker（D1/R2）
  ├─ qa_acoustic_leases/parts（租约/围栏/检查点 CAS，part ≤24576B）
  ├─ qa_acoustic_completions（五元组绑定回执）/ qa_feedback（单次）
  ├─ qa-runtime-probe/v26/assets（pinned 模型/wheel）
  └─ append-only site event log（新增，唤醒/订阅存活证据，M13）
```

核心：弃用 get_analysis_bundle HTTP（Envoy 挡），用 MCP read_qa_probe_blob 交付；离线 ORT 推理；复用声学检查点/回写工具。

## 2. 固定制品与 recipe（冻结）

| 制品 | Bytes | SHA-256 |
| --- | ---: | --- |
| encoder-int8.onnx | 50,410,797 | `913f30b95735bbf2e7d80dc93066e2730dc02bd0d19fb4a6b7cfefab657ed07c` |
| probe-head.onnx | 455,850 | `813c832bebffb68087be08544a1be100c1e73dda6f431d7a4731084e22430370` |
| onnxruntime-1.24.4-cp312-manylinux wheel | 17,244,912 | `0d640eb9f3782689b55cfa715094474cd5662f2f137be6a6f847a594b6e9705c` |
| flatbuffers/packaging/protobuf/sympy/mpmath wheel | 见 Agent 1 manifest | 见 manifest |
| HJK recording.m4a | 441,322 | `55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1` |

- 交付集 75,446,950 B（71.95MiB），8 文件，4MiB/次≈25 次。
- **truth.json（SHA 394fcb74…）非 probe 资产（m4）**：留主导/验签器本地；仅 3 锚点 + truthSha256 嵌入 output manifest。
- recipe：16kHz 单声道；窗 120ms(1920)/stride 80ms(1280)/帧 20ms；prefix 8 窗；batch 8；CPU intraOp2/interOp1；keepsAllWindowFrames=true。HJK 859 窗/4295 交付帧/3434 全局帧；解码 1,099,196 样本、**duration 68.699728s**（m11，用解码媒体时长）。
- 图语义：encoder samples[1,N]→features[1,frames,768]；head→frame[49]/ctc[50]/boundary；posterior=softmax(frame)*0.82+softmax(ctc)[:,:-1]*0.18。
- **recipeSha256 冻结（B4）**：规范描述串=canonical JSON{model:{encoder:913f30b9…,probe:813c83…},runtime:{ort:"1.24.4",target:"cp312-manylinux-x86_64"},sampleRateHz:16000,windowMs:120,strideMs:80,frameMs:20,prefixWindows:8,batch:8,intraOpThreads:2,interOpThreads:1,keepsAllWindowFrames:true,mode:"diagnostic"}；recipeSha256=SHA256(该串)，实施时计算并冻结（**新值，≠旧 CUPE 602a745b**）。
- **HJK 租约重置（B4）**：现有 HJK qa_acoustic_leases 绑旧 recipe 602a745b/fence2；新 recipe claim 会 unavailable。owner 授权 QA-only 重置：删 HJK 旧 qa_acoustic_leases 行 + qa_acoustic_parts 测试残留 → 新 recipe 从 fence1 起。重置前后 read_qa_status 记录；A 前 claim smoke test。
- 云端参考 SHA 仅合成夹具（M2）；HJK 硬门=in-run coldOutputSha256==resumedOutputSha256，实测记录。

## 3. 交付机制与云预算（关键决策）

机制：read_qa_probe_blob({artifact,offset,length≤4194304})，owner-only/pinned，structuredContent.base64（文本仅元数据）；PTY ≤3000 字符/行+@end；逐片严格 base64.b64decode(validate=True)+SHA，逐文件 file_digest 匹配。

**预算结论（M4，诚实）**：契约 §4.3 冷缓存"下载+安装≤300s、全任务≤900s"。F2 实测交付 1067.5s、4.044MiB/min → 300s 仅~20.2MiB < int8 模型 48.1MiB。**以此载荷/吞吐，冷缓存预算不可达**。不存在契约外的"稳态满足"类别。
- 调和路径（D1）：① 先实测官方 scheduled run 间 /mnt/data 持久性 + 4–8MiB 单次区间 + Work run 总时长上限；② 若持久，后续 run 复用（file_digest 复核~177ms），但**冷缓存首 run 仍超预算**；③ 故须 **owner 批准 §4.3 证据化修订**（下载+安装~1100s、全任务~1200s 含续租，峰值内存实测），或选 ≤~20MiB 载荷（需重新验证模型，int8 已是最小候选）。推荐前者（owner 已授权按推荐继续）。
- 每编码须 3 次冷缓存 + 30–45s/165–180s 探针（§4.3）；预算入 §15 判据。
- 续租：同 runId 延至新 600s/同 fence（F2 证 4 次无间断，延迟 3.6/5.2/2.7/2.1s，m7）；每~200–240s 或 TTL<260s 续租。
- **reuse-or-deliver+install（M12）**：每个需推理 run 显式"复用已验证文件否则交付+安装"；**先 claim 立 fence→租约下交付+续租**；测持久/非持久两路径。

## 4. A/B/C 官方运行流程（契约 §5.1 语义，B3）

固定：jobId qa_hosted_ad79ac58-4d0a-4a29-af0f-c4f37cbc5710；task Automation_c2ca080e…；recipeSha256=§2 新冻结值。每 run 新 runId（**小写 hex UUID，runPattern，先校验，m10**）；每 run 一个阶段。**fence 相对预期（M1）**：重置后 A=fence_A(=1)、B=fence_A+1、C=fence_A+2；断言单调增长，记录实测。
**官方 run 引用（M8）**：每 run 记录 Work userTurnId/assistantMessageId/turnKey（官方平台引用）入 official-run-history.json；server runId/fence 为独立内部绑定。

### Run A — 首领取 + 注入暂态 + retry_wait
1. read_qa_status 确认 HJK 在 pendingAcoustics、availableAt 到期；完成回执检测用 read_qa_text_answer/completionReceipt（m2，非 read_qa_status）。
2. claim_qa_acoustic({jobId,recipeSha256,runId=A})→记录 fence_A/nextIndex=0/leaseUntil；claim smoke test 先验。
3. **注入 recording-read 暂态（B3）**：首次读原声故意失败，client-declared `retry_qa_acoustic(reason="recording_read_failed")`→retry_wait（availableAt 退避）。**披露**：服务端无声学读故障钩子（retryReasons 仅 client 声明），暂态在编排层注入；契约"pre-injected"以此满足，证据记录注入点。
4. 记录 A runId/fence/官方引用/注入与 retry 回执；停止本次（不存前缀、不继续 B）。

### Run B — 接管 + 存一个前缀块（仍有剩余）+ 中断
1. read_qa_status：nextIndex=0、无完成回执；reuse-or-deliver+install（§3）。
2. claim_qa_acoustic(runId=B)→fence_A+1、nextIndex=0。
3. 读原声（read_qa_recording_bytes MCP，**无 download=1 回退，m5**；run 纪律不回显文本 content，m1），校验 441,322B+recording SHA；FFmpeg 解码 16k mono f32，记 HJK PCM SHA（实测，非合成值）。
4. 推理前 8 窗→prefix（125,976B）；**切 6 片（B1）**：checkpoint-0.json（metadata：recording/recipe/pcmSha/samples/windows/duration/runtime/modelSha/runnerSha/prefixSha/prefixBytes/**partCount=6/逐片 SHA**）存 index0；prefix 切 index1..6（每片≤24576B）。逐片 save+read 校验；**nextIndex=7**。
5. **中断（B3）**：retry_qa_acoustic(reason="compute_budget")，保留前缀链、仍有 851 窗剩余；记录 B runId/fence/前缀链 SHA/nextIndex=7/官方引用；停止。
   - **部分 A/崩溃状态机（M11）**：若 nextIndex∈[1,6]（前缀片不全），B 先重算/重存缺失片至 nextIndex=7 再续跑；崩溃注入测试覆盖 index0 后/前缀中/retry 后。

### Run C — 接管 + fence 增长 + 读 B 检查点 + 续跑 + cold==resumed + 完成 + 模拟回执丢失
1. read_qa_status：nextIndex=7、无完成回执；reuse-or-deliver+install。
2. claim_qa_acoustic(runId=C)→fence_A+2、nextIndex=7。
3. read_qa_acoustic_checkpoint index0..6→重组 prefix，校验 prefixSha/partCount/逐片 SHA 与 writtenByRun=B/writtenByFence=fence_A+1。
4. 续跑：reload prefix→只算剩余 851 窗→拼接；**独立冷跑全 859 窗**；断言 coldOutputSha256==resumedOutputSha256 逐字节（HJK 实测 SHA，M2）。失败不写完成。
5. 构造 output manifest（§6 精确 schema）；以 nextIndex=7 为 outputIndex 追加 save **checkpoint-7.json**（服务端 checkpoint index 7；旧稿的 checkpoint-2.json 同义）；outputSha256=sha(checkpoint-7.json 字节)。
6. write_qa_text_feedback({jobId,quote:"[原声录音]",feedback:<manifest.feedback>,recipeSha256,runId=C,fence,outputSha256,outputIndex=7})→原子单次提交反馈+回执+释放租约。
7. **模拟回执丢失（B3）**：完全相同参数重发→duplicate=true、同 savedAt/payloadSha256；read_qa_text_answer 确认反馈+receipt 绑定同一 recording/recipe/run/fence/outputSha；用 B 的旧 runId/fence（取自 B 报告/读回 writtenBy*）尝试相同写入→拒绝（-32009/lease_lost），缺失则 missing evidence 不伪造；原题反馈仅一份。记录 C 结果停止。

### Run D — 只读冷参考（G5 `coldRunId`；R1 闭环，rev3 补充）
1. 在 C 完成回写与回执核对后增加第 4 个官方 scheduled run；**只读**：不 claim、不续租、不存 checkpoint、不 retry、不写反馈。不得复用 C 的 runId。
2. read_qa_status 确认 C 已完成（`read_qa_text_answer` 有 completion）；reuse-or-deliver+install（M12）；MCP 读原声并校验 441,322 B/recording SHA。
3. 生成 `bandroom-decode-v1` 的 `offline-checkpoint.bin`；按验签器 `windows(sample_count)`（320/400/800/context100/offsets 0,400）冷算 `acoustic-00.bin…acoustic-NN.bin` 传输块（header/identity/前驱链与 `acoustic_stage.encode_chunk` 一致），并算两 pass 的 head logits。HJK 预期 10 块；**不得把 v26 的 6 片 prefix 冒充 acoustic-NN.bin**。
4. 另做 v26 859 窗完整冷跑 `cold-output.f32le`，与 C 的 cold/resumed 逐字节比较。
5. 写 `plan.json`（sampleCount/identity/plan/chunks/cold/coldStageIndexSha256/coldLogits）；`officialRunId` 入 `official-run-history.runs` 与 `acoustic-recovery.coldRunId`；以 `record_qa_run_event(type="offline_run", automationId, isolated=true)` 记审计行。
6. **R2 闭环（选项 2，rev4）**：B 额外持久化验签器 plan 的前 6 块（`acoustic-00..05.bin` 到 `/mnt/data/bandroom-g5/acoustic-plan/`，cut=6）；C 从该目录恢复并校验前 6 块、续算第 6..9 块，`executor.savedChunks/restoredChunks/newChunks` 与 `checkpoint_saved/restored/suffix_completed` 事件使用该 plan 列表。v26 的 6 片 120/80 ms prefix 仍保留给 G3 resume，两者并行。正式 `verify_cloud_release.py` 不改；`run-side/test_r2_acoustic_plan.py` 用真实 `verify_acoustic` 证明正例通过、负例拒绝。若 B 的 plan 块在 C 时不可见，C 必须报告阻塞，不得用重算冒充 restored。

## 5. 检查点格式与恢复

- part ≤24576B（B1）；不可变产物先写 R2 校验长度/SHA/格式，再 D1 CAS 当前 fence/预期上一指针更新可见索引。
- **checkpoint-chain manifest**：metadata 记 partCount/逐片 SHA/prefixSha/prefixBytes；恢复复用可见且校验通过的最长连续前缀；清理仅处理超保留期且无可见索引/活跃租约/读引用对象。
- 部分前缀状态机（M11）：keyed on nextIndex+已验证片；缺失片重算重存。
- F6 证明范围（m6）：一次 15,360B index0 往返+旧 fence 拒绝+scratch 清理；完整回归矩阵见 §13。

## 6. 绑定回写与 output manifest 精确契约（B2）

五元组绑定 recipeSha256/runId/fence/outputSha256/outputIndex（outputIndex 1–8191）；bindingMatches 全匹配；当前 fence 匹配原题身份/原声/模型/输出摘要后同一 D1 事务提交反馈+回执，置 state='complete'；重放同回执；旧 fence→lease_lost/-32009；读取豁免（v25）凭 durable receipt+owner/verified。

**output manifest 必需字段（completeAcousticFeedback 硬校验）**：
- schema=`bandroom.qa.acoustic-output.v1`；mode=`diagnostic`；recordingSha256===current.recordingSha256；recipeSha256/runId/fence 匹配；coldOutputSha256==resumedOutputSha256（均 64-hex）；windows 安全整数≥1；**duration 有限∈(0,181]**（HJK 68.699728）；rawOutputBytes/pcmSha256/modelSha256/runtime/prefixSha。
- feedback===output.feedback，长 10–800，**startsWith「声学链路验收（不代表纠音盲测达标）。」**；quote===「[原声录音]」。
- markers≤6，各 source=`human_annotation`、truthSha256=`394fcb74…`（64-hex）、word 字符串≤80、start/end 有限、0≤start<end≤duration。3 锚点：business 3.360–3.660（替换）、and 11.440–11.740（漏音）、suitcase 55.209724–55.509724（添音）。
- **契约测试**：把产出的 manifest 喂 completeAcousticFeedback 验证通过/负例拒绝。

## 7. Chrome 回听（契约 §5.2，M10）

- 回写后打开原题 ?review=qa_hosted_ad79ac58-…（owner 登录）。
- 窗口：S/I ±500ms、D ±750ms；媒体时误差≤150ms；事件序列 loadedmetadata→seeked→playing→stop。
- 交互：pause/refresh/re-entry/slow metadata/rapid marker clicks；两份独立人工证据文件；双编码各验。
- 3 真值锚点（truth.json）：business 3.360s/and 11.440s/suitcase 55.209724s；记录 currentTime/媒体事件/截图；readyState=4、无媒体错误、可定位范围用解码时长 68.699728s（m11）。
- **webm 来源（M10）**：由同一 HJK 源转码 WebM/Opus，作为第二录音对象/第二 QA job（注明来源/SHA/转码命令）；不得伪造浏览器采集。
- §4.3 探针：30–45s 与 165–180s 各编码探针 + 3 次冷缓存。
- 加窗 posterior 非无缝（边界帧 cosine~0.76）；反馈标记用人工锚点非模型结论；G3 验回听机制非纠音精度。
- 证据：browser-acceptance.json + browser-playback-events.json。

## 8. 24h 空队列唤醒与公平性

- **队列清空机制（M6）**：owner 授权 QA-only drain——2 pending text reviews 经现有写路径完成；5 pending acoustic fixtures 经 v26 流程完成或 manage_qa_probe_scratch cleanup 清理；HJK 完成后标记/移除。drain 前后 read_qa_status 记录。
- **订阅存活（M7/m3）**：每次唤醒须 subscriptionActive=true 才接受 pendingCount=0（pendingReviews 需未过期订阅，否则假空）。
- **持久唤醒历史（M13）**：append-only site event log（新增）或导出 Work run history，每唤醒记 UTC/pendingCount/pendingAcoustics/subscriptionActive；≥3 次官方唤醒、跨度≥86400s；emptyQueueWakes 入 official-run-history.json。
- 公平性：多 job 时 evidenceReady 优先+创建顺序、availableAt 排序，无饥饿/重复领取；fairness 入 offline.json。

## 9. 订阅续期（M7/m8）

- Work 订阅 TTL 4h。**续期触发**：每 run 开始读订阅 expiresAt（持久观测），剩余<阈值（如 30min）即调 subscribe_to_events/update_subscription 续订同一 owner（不新建 job/任务）；24h 阶段周期性续期。
- 声学 claim/检查点/完成仅需 verified（不查 expires_at，m8）；非声学事件投递/读需未过期订阅。
- 证据：每唤醒 subscriptionActive + expiresAt。

## 10. 证据 schema（G5 完整映射，M5/m12）

G3 产出须封存为 G5 可验签证据（32 常规文件 + acoustic 分片）：
- acoustic-recovery.json（**resumed 长度 N→acoustic-00.bin…acoustic-NN.bin，N∈[1,24]**）+ offline-checkpoint.bin/offline-output.json/offline-cold-output.json。
- official-run-history.json（A/B/C 官方引用 userTurnId/assistantMessageId/turnKey + server runId/fence + **emptyQueueWakes**）+ site-event-export.json/executor-event-export.json。
- offline.json（嵌 **fairness**）+ platform-probe.json/runtime-profile.json（云环境/ORT/冷启 profile）。
- browser-acceptance.json/browser-playback-events.json（两份人工证据）。
- runtime-bundle.zip/gates.json/release-gates.json；manifest schemaVersion=1/protocol=bandroom-d2-cloud-recovery-v1/route=A/sourceSha/sourceTreeSha 绑定。
- **四角色签名**（G3 需 work-auditor + site-auditor，m12；G5 全四角色 release-owner/holdout-custodian/work-auditor/site-auditor）。
- provenance（m9）：标主云 JSON 字节恢复状态；以本地 SHA 核验 readback 为准。
- G3 证据是 G5 必要非充分（G1/G2/G4 证据另需）；验签器 dry-run  against v26 证据。

## 11. 安全边界

- 只动隔离 QA；生产 v15/学习者数据/Mac 网络/发音提示隐藏不动。
- owner-only（pinned ownerSha256）；模型/wheel pinned SHA；**交付字节仅经 read_qa_probe_blob structuredContent（文本仅元数据）；read_qa_recording_bytes 文本 content 含 base64（服务端行为，m1）→run 纪律不回显文本 content，标记服务端 metadata-only 改进项**；凭据/grant 不入报告/Git/URL。
- scratch 独立 job+清理；HJK 排除于 scratch；不新建重复任务。
- **零逐次确认/无主机执行（M9）**：A/B/C 全程 confirmations=0；无 Mac 网络/tunnel/Chrome 参与执行；官方 run log + site/executor exports 佐证。
- 不伪造分析器/回执/预期值；无 lease 如实记录。

## 12. 风险与缓解

| 风险 | 缓解 |
| --- | --- |
| 冷缓存预算不可达（M4） | owner 批准 §4.3 证据化修订（D1）；测持久性/4–8MiB/Work 上限；不谎称缓存满足 |
| 跨 run 不持久 | 每 run reuse-or-deliver+续租；测两路径 |
| Work run 总时长上限 | 实测；缓存复用稳态分钟级；必要时分阶段 |
| 云≠本地（M2） | 硬门=云端 cold==resumed；HJK SHA 实测 |
| 加窗边界帧伪影 | G3 传输验收非 G2；人工锚点；披露 |
| 工具目录缓存旧版 | 部署后刷新/重绑连接器（F1 曾踩已解） |
| 订阅 4h 过期 | 每 run 观测+续期；完成读取豁免不依赖订阅 |
| 8MiB 传输失败 | 固定 4MiB 操作点 |
| prefix 超 part 上限（B1） | 切 6 片+chain manifest+边界测试 |
| 旧 recipe 租约（B4） | QA-only 重置+新 recipe+claim smoke test |

## 13. 测试计划

- **v26 验签器更新（M3）**：新建/更新 verify_official_run_v26.py，钉 v26 模型 SHA（913f30b9/813c83）、prefix 表示/字节（125,976/6 片）/SHA、metadata schema（acoustic-output.v1）；cold==resumed 硬门；**4779241b/21440 为 v24 CUPE 参考，不得用于 v26**。
- **本地回归**：四组（completion/checkpoints/hosted-retry/audio-processing）+ MCP 交付/绑定回写/旧 fence/幂等/读取豁免/manifest 契约（B2）/prefix 24576 边界（B1）。
- **前置实测（D1/M4）**：跨 run 持久性、4–8MiB 单次区间、Work run 上限、续租延迟、每编码 3 冷缓存+短/近限探针。
- **负例矩阵（M14）**：并发 claim、claim 响应丢失、保存前后崩溃、对象未发布、清理/接管竞态、重复完成块、过期凭证续期、录音 EOF/截断、撤销、同批坏 job 隔离、重录修订冲突、8MiB 边界、PTY>3000、base64 校验失败、部分 A（index0 后/前缀中/retry 后）、缓存失效；预期状态 -32009/lease_lost/out_of_order/checkpoint_corrupt/unavailable 等。
- **云验收**：A/B/C 官方 scheduled run；Chrome 双编码 §5.2；24h 唤醒。

## 14. 部署与回滚

- v26 部署隔离 QA（owner 放行后）；读回 version/deployment ID；刷新 Work 连接器工具目录。
- 回滚 v25（appgver_9591845c…）/v24/v23 保留；QA 无生产数据。
- 探针工具保留作诊断（D3）；catalog 冻结至 G5。

## 15. G3 通过判据（显式清单）

- [ ] A/B/C 同一官方周期任务/HJK job/recipe，三独立 scheduled run，语义符 §5.1（A 暂态 retry_wait/B 存块中断/C 续跑完成）。
- [ ] fence 单调增长（相对预期，重置后 1/2/3）；官方 run 引用（turn/message IDs）记录。
- [ ] 云端 cold==resumed 逐字节（HJK 实测 output SHA）。
- [ ] prefix 链 6 片完整、24576 边界、最长前缀恢复。
- [ ] 绑定回写单次（五元组，outputIndex=7），旧 fence 拒绝，回执丢失重放 duplicate=true 同回执，原题反馈仅一份。
- [ ] Chrome §5.2 双编码真实锚点回听（窗口/媒体误差/事件序列/交互/两份人工证据）。
- [ ] 24h ≥3 次官方唤醒≥86400s、subscriptionActive=true、队列公平、emptyQueueWakes 持久记录。
- [ ] **云预算（M4）**：§4.3 修订批准 + 每编码 3 冷缓存+探针实测达标（修订后预算）。
- [ ] **零逐次确认/无主机执行（M9）**：confirmations=0，无 Mac/tunnel/Chrome 执行。
- [ ] 证据封存映射 G5 完整 schema（32 文件+分片+四角色）。
- G3 通过不改变 G1/G5，不等于 D2 通过。

## 16. 实施步骤与分工（待 owner 放行代码）

1. Codex：D1 前置实测（跨 run 持久性/4–8MiB/Work 上限/续租延迟）+ B4 QA-only 租约重置 + 新 recipe 冻结 + claim smoke test。
2. Codex：实现 v26（MCP 交付集成 HJK 租约、A/B/C 契约语义、prefix 6 片链、精确 manifest、绑定回写复用、append-only event log、v26 验签器、证据导出）+ 本地回归 + 负例矩阵。
3. owner：批准 §4.3 修订（D1）+ v26 部署授权（D2）。
4. Codex：部署 v26 + 刷新连接器；队列 drain（M6）；跑 A/B/C + Chrome + 24h；落盘证据。
5. Claude 主导：逐项核验 §15；G3 通过后协调 G1/G5（D4）。

## 17. 决议（详见 DECISIONS.md，owner 授权按推荐继续）

- D1 预算：先测持久性；推荐 owner 批准 §4.3 证据化修订（冷缓存不可达，M4）；缓存优先但不谎称满足冷预算。
- D2 部署：推荐隔离 QA；**当前 HOLD**（先不改代码），待放行。
- D3 探针工具：保留作诊断。
- D4 G1/G5：G3 优先顺延；准备就绪，正式执行待 G3 + owner 安排语料/标注者/密钥。
