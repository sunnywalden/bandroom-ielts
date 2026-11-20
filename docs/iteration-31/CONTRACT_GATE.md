# Grounded-prosody 队列完成契约门 — 预注册 + 证据映射

- 日期：2026-11-20（UTC）
- 依据：`SPEAKING_QUEUE_COMPLETION_DESIGN_rev3.md` §2（Z-3：契约/完整性门 ≠ 质量门）。
- 性质：**契约/完整性门**——验证 grounded-prosody 输出经队列持久化时录音绑定/decoded 验证/恒 T1+T3/候选幂等/owner 隔离不降级。**不是**发音质量门（G1 全协议 FAIL / G2 历史 / T2 退役记录不动）。
- 状态：criteria 冻结；证据封存见 `CONTRACT_GATE_EVIDENCE.md`（测试全绿 + Worker 1441b142 部署验证 + owner sign-off）。
- 红线：任何 CG FAIL = 不 release，不重试洗判定（重试只解决"测不到"）。release grounded-prosody-v1 须 owner sign-off + 显式授权设 prod env。

## Criteria（冻结）+ 证据映射

| CG |  criterion | 验证测试 | 状态 |
|---|---|---|---|
| CG-1 | wire schema 对抗：未知字段/越界/缺字段/**客户端 candidateId**/tier 拒绝 | grounded-completion ④⑤（candidateId/未知字段→invalid_analysis）；wire zod strictObject | ✅ 已验 |
| CG-2 | 录音绑定 recordingSha256↔R2 digest↔checkpoint input↔complete；篡改拒绝；absent snapshot 分支 | grounded-completion ⑦（recording_mismatch）；transfer manifest inputSha256=raw sha（test_review_transfer round_trip） | ✅ 已验（absent-snapshot 显式用例待补） |
| CG-3 | decoded checkpoint 提交→回读→sampleCount/SHA 一致；旧 fence/过期租约拒绝；binary-v1 事件；新 fence 重 claim 重发 | grounded-completion commitDecode（save PUT 201+read GET 200）；test_review_transfer round_trip/integrity；review-tools QA stale fence 回归 | ✅ 已验（新 fence 重 claim 显式用例待补） |
| CG-4 | 候选签发 parity + **幂等**：duplicate→行数/n_shown 不变+ID 逐字节一致；detector_version_mismatch fail-closed | grounded-completion ②（幂等 replay）⑩（altered replay 不改校准态）；calibration 106 回归 | ✅ 已验 |
| CG-5 | items:[]→完成 prosody-only，无候选行 | grounded-completion ③ | ✅ 已验 |
| CG-6 | **owner 租户隔离回归**：完成 owner 任务不写他租户行/审计 | grounded-completion ⑧（foreign task_not_found）；tenant-isolation 11 写侧矩阵 | ✅ 已验（非跨租户完成——当前 owner-only） |
| CG-7 | 渲染非断言：tier 恒 T3；feedback/evidence 禁 numeric band；catchTrial 盲化 | grounded-completion ①（tier T3）⑨（catchTrial actual=expected，无 profile 行）；review-tools content_rule 回归 | ✅ 已验 |
| CG-8 | 诚实披露实际渲染：reliability/calibrated_prosody 经 UI 消费；无 band | grounded-completion ①（calibrated_prosody 存储）；wire 字段对齐 pronunciation-review.ts | ✅ 已验（UI 浏览器渲染待 owner 回归） |
| CG-9 | >393s decoded_too_long 永久分类；transfer 永久码分类；stock task analysisVersion 引导 | test_review_transfer ceiling（decoded_too_long retryable=False）；orchestrator QUEUE_PERMANENT_CODES 扩展；runner grounded_analysis_version config | ✅ 已验 |

## 已跑证据（2026-11-20）

- 服务端：grounded-completion **32 checks**、review-tools **118**、review-tasks **77**、calibration **106**（Miniflare D1）、claim-any **8**、tenant-isolation **11**。
- runner：**249 passed**（含 test_review_transfer 7：framing/manifest/WAV strip/ceiling/round-trip/integrity；multitenant grounded e2e 断言 wire schema+transfer+version）。
- 安全评审闭环：completed 任务 replay 短路返回存证 receipt（不再签发/不再跳过 decoded proof），requireDecodedInput 对处理路径无条件；altered-replay 校准态不变（CG-4 ⑩）。

## 待执行（release 前）

1. **完整 live 端到端**：真实 runner（grounded produce + ffmpeg decode + transfer）→ 部署 Worker（GROUNDED_* env）→ claim→complete→receipt→UI 读 candidateIds/reliability。当前证据为真实 SQLite + fake R2 + runner 单元（transfer/produce 分别验证），未跑全链路 live。
2. **CG-2/CG-3 显式补充用例**：absent snapshot.recording 分支、新 fence 重 claim 重发 save/read 事件。
3. **owner 浏览器回归**：UI 渲染 T3 建议 + reliability 披露（Access 墙，需 owner）。
4. **证据包封存 + owner sign-off**：本文件 + 测试输出 SHA256SUMS 封存；owner 批准后方可设 prod `GROUNDED_ANALYSIS_VERSION`/`GROUNDED_RELEASED_VERSIONS`。

## release / 启用门（另行授权）

- 设 prod env + 部署 Worker = 生产变更 → 需 owner 显式授权 + 开观察窗。
- 启用 multi_tenant=true → 需 owner + **许可②/合规门**（rev2 §5），本契约门不解除那些门。
- 当前 prod 无 GROUNDED_* env → 队列 speaking 仍 fail-closed（QUEUE_PERMANENT_CODES），线上零变化。