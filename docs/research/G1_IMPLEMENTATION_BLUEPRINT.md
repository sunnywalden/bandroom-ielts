# G1-R 实施规格（方案，不含代码改动）

日期：2026-11-19 · 状态：**方案完成，未改任何产品代码**
配套：rev2 设计 `G1_RESTRUCTURE_DESIGN.md`（SHA 36a00625）、评审闭环 `G1_RESTRUCTURE_REVIEW.md`（SHA 93b2b440）。
本文把 rev2 落成可执行的实施规格（函数职责、判定表、报告 schema、测试与验收），供放行后照做；**不放行则不改代码**。

## 1. 范围与前提
- 仅新增本地评测工具与测试；不进 Worker 包、不触生产、不重置观察窗。
- 无独立人工标注者；owner 抽查可选且仅作矛盾 sanity。
- 输入：`--eval-dir`（feedbacks/attempts/snapshot/audio）、`--truth`、可选 `--owner-anchor`。

## 2. 文件与职责（放行后才创建/修改）
- `runner/gate1_restructured.py`：协议实现（复用 AG1 helper，不改动已封存 AG1 证据）。
- `runner/tests/test_gate1_restructured.py`：离线单元测试（无网络）。
- `docs/wiki/Quality-Gates.md`：更新 G1-R 定义（PASS 标签与 claim scope）。
- `iteration-26/g1-restructured-evidence/`：报告、raw、SHA256SUMS（本地证据，不入公开仓）。

## 3. 算法规格
### L0 客观
1. 复用 AG1 客观检查（总分断言、文本不上发音、引文核验）。
2. **引文策略**：仅当 `response_text` 存在；ratio<0.2 = 明确虚构（阻塞），0.2≤ratio<0.4 = advisory（不阻塞）。区分 learner-quote 与 suggested-correction 依赖结构化标记；无标记时按上述阈值保守处理。
3. **HJK 锚点**：必须有 ≥1 个**带时间且在 2s 内**的命中；否则 `anchor_untimed_or_missing` 阻塞。报告 `anchor_coverage`（full/partial）。
4. **fail-closed**：缺 truth/audio/必需夹具 → 直接 ERROR，不产出 PASS。

### L1 盲评
1. 文本 ≥3 跨家族评审 + 独立音频复听（音频同家族异档，**不声称跨家族**）。
2. **critical 多数规则**：≥2 名文本评审判 critical 才算 critical；单评审 = advisory；音频 critical 由音频评审给出并单列，不并入文本多数。
3. 音频 critical 不得由文本评审以「听不到」为由给出。
4. 信度：within-1 比例（经验阈值 0.7，必要非充分）+ Fleiss κ（描述性）。

### L2 基线对照（描述性）
- 对 Work 基线报告每维与总体估计值 + 聚类 bootstrap CI；**不作为 PASS 条件**，不授予非劣效声明。

### L3 红队
- 结论须附可演示证据（引文/音素/语法/嵌入指令）或第二家族佐证；否则 advisory，不单独否决。

### L4 owner 抽查（可选）
- 子集三态/评分；仅矛盾 sanity：与面板 critical 冲突→ESCALATE 人工复核；**不可 FAIL→PASS**。

## 4. 判定表（预注册）
| 条件 | 结果 |
|---|---|
| 缺必要输入 | ERROR（不写 PASS） |
| L0 阻塞项 / anchor_coverage=partial | FAIL |
| L1 overall<3.5 或 critical 多数样本≥2 或 within-1<0.7 | FAIL |
| L3 有可证伪项 | FAIL |
| 仲裁仍>1 分歧 或 owner 矛盾 | ESCALATE |
| 全部通过 | PASS（欠功效时标 `[indicative]`） |

## 5. 统计规格
- 单元=attempt/speaker；音频按内容哈希去重（保留最早、丢弃后者并记录）。
- Bootstrap：聚类重采样；小样本用 BCa 或注明百分位法偏窄。
- 预注册：within-1=0.7（经验）、n<8 标 `underpowered`、seed 固定。
- 报告 n、CI 宽度、模型 id。

## 6. 报告 schema（关键字段）
`protocol, seed, verdict, gate1_label, claim_scope, human_annotators(0), owner_anchor, prereg, model_ids,
 anchor_coverage, dropped_duplicate, L0{issues,pass}, L1{sample_means,overall_mean,overall_mean_ci,
 reliability{within1_fraction,fleiss_kappa},critical_majority,pass}, L2{descriptive,per_dim,overall_ci,pass:null},
 L3{falsified,advisory,pass}, L4{owner_anchor,contradictions}, disagreements, arbitration, unresolved, escalate,
 underpowered`

## 7. 封存与可复现
- 写 `report.json`、`raw-evidence.json`、`SHA256SUMS`；记录实际模型 id、请求/响应、响应 hash、时间。
- 单次预注册分析；禁止重跑选购结论；重评须新预注册 + 归档旧判定 + 终止承诺。

## 8. 测试规格
- 单元：within-1（一致/分歧）、Fleiss κ（全一致/流行度敏感）、bootstrap CI（常量/含均值）、NI CI（相等/显著优）、锚点（带/不带时间）、去重（同/异哈希）、critical 多数、引文策略、fail-closed、判定表各分支。
- 运行验收：真实 eval-dir 产出 report + SHA256SUMS；标签与 claim_scope 正确；欠功效标注；音频层不声称跨家族。
- 负向：缺 truth/audio 必须 ERROR；禁止 PASS。

## 9. 运行与验证步骤（放行后）
1. 填充/校验夹具与 truth。
2. 离线测试全绿。
3. 真实运行（DashScope key 私有）；封证据。
4. 人工复核报告标签与 CI；更新 Wiki Quality-Gates。
5. 按项目流程提交 PR（代码+测试+wiki），文档留私有。

## 10. 回滚
- 纯新增本地工具：回滚=revert 提交；无生产/无观察窗影响。

## 11. 验收标准（方案完成度）
- rev2 + 评审闭环 + 本规格三份文档齐备；判定表/统计/封存/测试可照做；无代码改动。

## 12. 映射
- BL1→§3/§5；BL2→§3(L2)；BL3→§3(L1)；BL4→§3(L1)；BL5→§4；BL6→§7；MJ1→§3(L0)；MJ2→§3(L0)；MJ3→§3(L4)；MJ4→§5；MJ5→§5；MJ6→§3(L3)；MJ7→§7；MJ8→§3(L1)；MJ9→§6；mn1–mn7→§5/§6/§8。

## 13. 未决/风险
- 机器面板的效度仍受限（锚点覆盖）；对外「人工盲测」声明不在本方案。
- 欠功效下 PASS 仅指示性；音频真实差距预计导致 FAIL/ESCALATE。
- 放行前不改任何代码。