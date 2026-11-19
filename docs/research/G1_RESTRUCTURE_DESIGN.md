# G1 完全重构设计 rev2（无人工标注者版本）

日期：2026-11-19 · 状态：**设计 rev2，实施暂停待放行**
前提：无两名独立人工标注者（owner 确认）。
评审闭环：`G1_RESTRUCTURE_REVIEW.md`（BL1–6/MJ1–9/mn1–7 全接受或部分接受，无驳回）。rev2 已逐条落地。

## 1. 为什么可以无人工（且诚实）
人工双标注=独立复评+评审者间信度。替代：跨家族机器盲评（结构独立复评）+ 机器信度统计 + **客观锚点承担效度** + owner 仅作矛盾 sanity。**一致性不等于效度**：面板可高置信地错；因此效度只由不依赖评审者的锚点支撑，claim scope 相应收窄。

## 2. 层（G1-R）
- **L0 客观**：禁止总分断言；文本不上发音；HJK 锚点必须**带时间且在 2s 内命中**（修复 obs_ms=None 自动通过）；引文核验区分 **learner-quote 与 suggested-correction**（结构化标记，仅前者判虚构）；缺 truth/audio/必要夹具 → **fail-closed，不得 PASS**；报告 `anchor_coverage`（full/partial），partial 不得 PASS。
- **L1 跨家族文本盲评**（≥3 家族）+ **音频独立复听**。**音频独立性有限**：教练与音频评审同家族异档 → 音频层**不声称跨家族**，仅作 evidence。critical 采用**多数规则**：≥2 评审或仲裁确认才算 critical；单评审 critical 记 advisory。音频 critical 仅由音频评审给出，文本评审不得因「听不到」判 critical。
- **L2 基线对照（描述性）**：对 Work 历史基线报告估计值+聚类 bootstrap CI；**不再授予非劣效声明**（4 v 7 未配对、欠功效、混杂）。仅当配对/足够样本且另行预注册时恢复 NI。
- **L3 红队**：独立家族，须给出可演示证据（引文/音素/语法/嵌入指令）或第二家族佐证，否则 advisory，不单独否决。
- **L4 owner 抽查（可选）**：预注册子集的三态/评分；**仅作矛盾 sanity**——与面板 critical 冲突时升级人工复核，**不得把 FAIL 改判 PASS**；缺失不阻塞运行。

## 3. 统计（诚实、保守）
- 单元=attempt/speaker，非录音伪重复；相同音频字节按哈希**保留最早、丢弃后者**并记录 `dropped_duplicate`。
- 一致性门：**within-1 比例**（经验阈值 0.7，标注「无功效依据」）为必要非充分；Fleiss κ 仅描述性，不作门（流行度敏感，实测近一致 κ=0.25）。
- CI：聚类 bootstrap；小样本用 **BCa 或明确标注百分位法偏窄**。
- 报告 n、CI 宽度与 `underpowered` 标记；样本不足时 PASS 仅标「指示性」，不得对外作达标声明。
- 锚点覆盖不足（partial）或任一必要夹具缺失 → 不得 PASS。

## 4. 治理与可复现
- **单次预注册分析**：冻结面板、模型、seed、rubric、阈值、边际、子集；**禁止重跑选购结论**；重评须新预注册 + 归档旧判定 + 终止承诺。
- 仲裁显式归一（含 `scores[dim]` 回退）；仍 >1 分歧 → ESCALATE。
- 封存实际模型 id、请求/响应、响应 hash、时间戳、prompt、raw、**SHA256SUMS**，保证可复现。
- 缺必需输入 fail-closed；不写 PASS。

## 5. 声明（防误读）
- PASS 标签固定为 **`G1-automated(machine-panel)`**，附 `claim_scope`：「跨家族机器盲评 + 客观锚点；非人工标注门；owner 仅最终升级」。
- 报告同时呈现 `human_annotators=0` 与 `owner_anchor`（true/false）。
- 对外文档不得将 PASS 表述为「人工盲测通过」。

## 6. 实施（暂停，待放行）
- 模块 `runner/gate1_restructured.py`（复用已封存 AG1 helper，不改 AG1 证据）。
- 离线测试：信度/BCa/判定/去重/锚点/fail-closed。
- 真实运行：eval-dir=iteration-24/gate1-evaluation-v2，truth=iteration-20/qa-work-fixture/truth.json，证据封入 iteration-26/g1-restructured-evidence；报告含模型版本与 SHA256SUMS。
- 更新 Wiki Quality-Gates 与记忆；按项目流程提交 PR。

## 7. 边界与预期
- 机器面板≠人工双标注；PASS 仅声明机器盲评+锚点达标。对外「人工盲测」声明仍需人工，不在本重构范围。
- 不降低标准、不制造数据、不放宽阈值；既有真实结论（文本好、音频弱于基线、HJK 被证伪）保留，G1-R 很可能仍 FAIL/ESCALATE（音频差距）——这是诚实结果。
- 欠功效下不宣称非劣效；音频不宣称跨家族。

## 8. 决策点（待 owner 放行）
- D-1 是否接受 rev2 与「L2 降级为描述性」。
- D-2 是否提供 owner 抽查子集（可选）。
- D-3 放行实施 + 真实运行 + 提交。