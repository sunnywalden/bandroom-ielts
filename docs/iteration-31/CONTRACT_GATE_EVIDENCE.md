# Grounded-prosody 队列完成契约门 — 封存证据

- 日期：2026-11-20（UTC）
- 依据：`CONTRACT_GATE.md`（criteria 冻结）+ `SPEAKING_QUEUE_COMPLETION_DESIGN_rev3.md`。
- release 版本：`grounded-prosody-v1`（契约/完整性门通过；**非**质量门——G1 全协议 FAIL / G2 历史 / T2 退役记录不动）。
- 交付：PR #44 → main `a653a59`；Worker `1441b142-b9d1-4acc-a281-40520c856363`；观察窗 #19（canonical+mirror）`2026-11-21T07:06Z`。

## 1. 代码交付

| 项 | 值 |
|---|---|
| PR / merge | #44 → main `a653a59` |
| 分支 | `claude/bandroom-speaking-queue-contract`（含合并 main 解冲突 `94d404c`） |
| 服务端 commit | `bced5fe` + merge |
| runner commit | `ec02b42` + merge |
| 工作区 | 隔离 worktree `.p2b-wiring-checkout`（避开并发 speaking-redesign，合并时保留双方） |

## 2. 测试证据（全绿，2026-11-20）

合并 main（含并发 speaking-redesign PR #41）后重跑：

| 套件 | 结果 |
|---|---|
| grounded-completion（真实 SQLite + transfer route） | **32 checks PASS** |
| review-tools | **118 PASS** |
| review-tasks | **77 PASS** |
| calibration（Miniflare D1） | **109 PASS** |
| claim-any | **8 PASS** |
| tenant-isolation（写侧跨租户矩阵） | **11 PASS** |
| runner 全套 | **313 passed**（含 test_review_transfer 7、multitenant grounded e2e） |

CG-1…9 映射见 `CONTRACT_GATE.md`；安全评审修复（completed replay 短路 + altered-replay 不改校准态）由 grounded-completion ⑩ 覆盖。

## 3. 部署验证（live Worker 1441b142）

- 未认证请求 → **302** CF Access ✓
- `/mcp` tools/list → **20 工具**（含 complete_review_task）✓
- C5 `read_study_session` → 非 error ✓
- grounded 分支可达：`complete_review_task` 携 grounded schema 对 fake task → `task_not_found`（证明部署代码含类且 service token 可达；类内逻辑由 grounded-completion 32 覆盖）✓
- runner 手动 run（新代码，multi_tenant=false）→ **exit 0，fatal=false，processed=0，audioMode=grounded** ✓
- GROUNDED_* env 绑定确认（部署输出：`GROUNDED_ANALYSIS_VERSION`/`GROUNDED_RELEASED_VERSIONS="grounded-prosody-v1"`）✓

## 4. 诚实边界

- **线上零行为变化**：multi_tenant 仍 false；owner 路径（add_coach_feedback）逐字节不变；队列路径 dormant。GROUNDED_* env 已设但无调用方（multi_tenant 未启用）→ queue speaking 仍 fail-closed。
- **live 全链路**（真实 speaking 任务 + runner 端到端）需 multi_tenant=true（阶段4，受许可②/合规门）或 owner 真实口语提交；当前证据=真实 server 代码 + transfer route 集成 + runner 单元/produce/transfer 分别验证 + deploy smoke。
- **契约门 ≠ 质量门**：本证据不声称发音/韵律质量 PASS。

## 5. owner sign-off

- owner（2026-11-20）:「授予所需的所有权限，并行推荐这3项」→ 授权 ①契约门封存+sign-off ②push/PR/merge ③阶段3部署（设 GROUNDED_* env + 部署 + 观察窗）。
- **sign-off 范围**：批准 `grounded-prosody-v1` 经**契约/完整性门** release（录音绑定 + decoded 验证 + 恒 T1+T3 + 候选幂等 + owner 隔离 + 无伪造）。**不**构成质量门通过，**不**启用 multi_tenant（阶段4 仍需 owner + 许可②/合规门）。
- 未做：push 以外的生产启用；multi_tenant=true；旧 personal 数据相关操作。

## 6. 回滚

- redeploy 前 Worker `7cf214c1`（dist from main 5ee2824 的构建）；接地窗回滚。GROUNDED_* env 为附加 var，可移除；无 D1 迁移。
- prod config 备份：`~/.config/bandroom/wrangler.prod.json.bak-20261120T070506Z`。
---

## 7. A2 修订 + 阶段4 受控验证（2026-11-20 后续）

**受控 live 验证发现 A1 blocker**：`isCanonicalOrigin`（`lib/route-guard.ts:99`）拒绝任何 `.workers.dev` host → 二进制 transfer 端点恒 403 `untrusted_origin`。故 **A1 decoded-checkpoint 在当前 workers.dev 部署不可行**。owner 重新裁决 **Z-2 A1→A2**（owner-only；U-BL-2 跨租户本就不可能）。

**A2 变更**（PR #46 → main `350b56a`；Worker `958114d7`）：
- 服务端 grounded 分支移除 `requireDecodedInput`；保留 recordingSha256 ↔ R2 digest ↔ **snapshot.recording** 三方绑定（与 owner 路径同级完整性，加 snapshot 纵深）。
- runner 移除 transfer 调用；`review_transfer.py` 保留供未来自定义域名/A1。

**受控 live 端到端（真实 D1/R2/env/A2 Worker）PASS**：注入临时 owner 口语任务（复用现有录音 digest）→ claim（fence1）→ `complete_review_task` grounded → receipt `c43a877b…` → 幂等 replay duplicate → 存储 tier T3 + candidateId + 1 候选行 → 合成行/对象全清理（0 残留）。

**阶段4 cutover（owner-only）**：prod runner 代码同步合并 main + `multi_tenant=true`（外部域名保持关闭）；手动 run `mode=multi_tenant` exit0 fatal=false；launchd 下一轮生效。备份 `~/.bandroom-runner-prod/runner.bak-20261120T071710Z` + `wrangler.prod.json.bak-20261120T070506Z`。

**观察窗 #20** `958114d7` `2026-11-21T07:17Z`（canonical+mirror；评估器 exit0 不提前判定）。

**边界**：外部多用户仍未开启（需许可②/合规门 + per-tenant service identity）。live 首用=owner 下一次真实口语提交。

**安全硬化（PR #47 → main `3662b11`；Worker `6bb7e03a`）**：自动化安全评审发现 A2 snapshot 绑定为条件式（缺 recording 时跳过=fail-open）→ 修为**无条件**（缺 digest → `recording_unbound`；不匹配 → `recording_mismatch`），加 grounded-completion ⑪ 回归（35 checks）。A2 移除 decoded-PCM checkpoint 为 owner 已裁 Z-2 的**显式披露取舍**（transfer 在 workers.dev 不可达）；完整性级别=recordingSha256↔R2 digest↔snapshot，与已上线 owner 路径（submittedRecording）同级。reviewer 的"fail closed 禁用队列 speaking"替代被 owner 否决（违背阶段4）。硬化后受控 live 验证再 PASS（receipt 559bf546…）；观察窗 #21（6bb7e03a，canonical+mirror）。

## 8. 队列路径受控演练汇总（真实生产，2026-11-20）

三路径均经真实生产验证（合成任务/录音 digest，隔离后清理；非真实用户数据）：

| 路径 | 方式 | 结果 |
|---|---|---|
| **口语 grounded（A2）** | 注入合成 owner 口语任务（复用现有录音 digest）→ 直驱 MCP claim→complete | receipt `c43a877b…`（A2）/ `559bf546…`（硬化后）；幂等 replay duplicate；存储 tier T3 + candidateId + 1 候选行；清理 0 残留 |
| **文本（runner 端到端）** | 注入合成文本任务 → **真实 prod runner**（multi_tenant，launchd lock 串行）→ LLM `complete_text` → `complete_review_task` 文本分支 | **`processed=1` exit0 fatal=false**；任务 `completed`，receipt `67566005…`，`analysis_version=None`，`analysis_json=None`（文本正确）；teacher_feedback 1 行；LLM 正确改正时态错误；清理 0 残留 |
| **launchd 调度** | 观察 `~/.bandroom-runner-prod/logs/` | 切换后首轮 `65a11752` `mode=multi_tenant`（batchCap 3/perUserCap 2.0），`processed=0`（队列空）；~300s 节奏；无 error |
| **安全硬化** | PR #47 → Worker `6bb7e03a` | 无条件 snapshot 绑定（`recording_unbound`/`recording_mismatch`）；grounded-completion ⑪（35 checks）；硬化后口语受控验证再 PASS |

**说明**：上述 receipt（c43a877b/559bf546/67566005）属**受控演练制品**，演练后连同合成行/story/对象一并清理，不在生产留存。真实首次使用=owner 下一次真实提交。
**边界**：外部多用户仍关闭（许可②/合规门 + per-tenant service identity）；T2 退役；契约门 ≠ 质量门。观察窗 #21（`6bb7e03a`）运行中。
