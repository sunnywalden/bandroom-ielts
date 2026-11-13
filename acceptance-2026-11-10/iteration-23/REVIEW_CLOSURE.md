# v26 方案评审闭环表

2026-11-13（UTC）。独立评审（只读 Agent）+ 主导复核。所有发现已在 [V26_SOLUTION_DESIGN.md](V26_SOLUTION_DESIGN.md)（rev2）闭环；**未改代码、未部署**（owner 指示）。决议见 [DECISIONS.md](DECISIONS.md)。

## Blockers（全部闭环）

| ID | 问题 | 闭环措施 | 设计落点 |
| --- | --- | --- | --- |
| B1 | prefix 125,976 B 超 checkpoint part 上限 24,576 B，单片必拒 | prefix 切 6 片（index1..6，≤24576/片）+ metadata index0；A 后 nextIndex=7；B 读 index0..6 重组校验 prefixSha；outputIndex=7；加 checkpoint-chain manifest（partCount/逐片 SHA/prefixSha）+ 24576 B 边界测试 | §4/§5 |
| B2 | output manifest 缺服务端必需字段、feedback/marker 不精确 | 钉死 schema=`bandroom.qa.acoustic-output.v1`、recordingSha256/recipeSha256/runId/fence、coldOutputSha256==resumedOutputSha256（64-hex）、windows≥1、duration∈(0,181]；feedback===output.feedback 且 startsWith「声学链路验收（不代表纠音盲测达标）。」、长 10–800；markers≤6 各 source=human_annotation/truthSha256=394fcb74…/word≤80/0≤start<end≤duration；加 completeAcousticFeedback 契约测试 | §4B/§6 |
| B3 | A/B/C 角色不符契约 §5.1（原设计 A 存前缀/B 续跑完成/C 仅重放） | 重构为契约语义：A=首领取+注入 recording-read 暂态+retry_wait；B=接管+存一个前缀块（仍有剩余）+中断；C=接管+fence 增长+读 B 检查点+续跑+cold==resumed+完成+模拟回执丢失。暂态为编排层 client-declared recording_read_failed（服务端无声学读故障钩子，明确披露） | §4 |
| B4 | recipeSha256 未冻结到现有 HJK 租约（602a745b 旧 CUPE），新值 claim unavailable | 定义 v26 规范 recipe 描述串（int8 模型 SHA+ORT+窗参数+mode）→新 recipeSha256；owner 授权 QA-only 租约重置（删 HJK 旧 qa_acoustic_leases/parts 测试残留）→新 recipe 从 fence1 起；A 前 claim smoke test | §2/§4/§16 |

## Majors（全部闭环）

| ID | 问题 | 闭环措施 | 落点 |
| --- | --- | --- | --- |
| M1 | 绝对 fence 预期错（HJK 已 fence2） | 租约重置后 A=1/B=2/C=3；用相对预期+fence 单调增长断言，记录实测值 | §4/§15 |
| M2 | 云 SHA（487a9db6 等）是合成夹具非 HJK | 标明 F3–F5 SHA 仅适用合成夹具；HJK 只断言 in-run cold==resumed，记录实际 HJK PCM/output SHA；移除 487a9db6 作 HJK 预期 | §2/§4C |
| M3 | verify_official_run.py 钉 CUPE/旧 prefix，v26 会误失败 | 增 v26 验签器更新任务：钉 v26 模型/prefix 表示/字节/SHA/metadata schema；cold==resumed 硬门；4779241b/21440 为 v24 CUPE 参考不得用于 v26 | §13/§16 |
| M4 | §4.3 冷缓存预算不可达（300s≈20MiB<48MiB 模型）；"稳态满足"臆造；预算未入判据 | 明言冷缓存预算以此载荷/吞吐不可达；预算入 §15；要求每编码 3 次冷缓存+30–45s/165–180s 探针；测 4–8MiB 区间+Work run 上限；推荐 owner 批准 §4.3 证据化修订（D1）；删除"缓存满足 §4.3" | §3/§15 |
| M5 | G5 证据 schema 不全 | 枚举 32 常规文件+acoustic-NN.bin（N=acoustic-recovery.json resumed 长度 1–24）；official-run-history 嵌 emptyQueueWakes；offline.json 嵌 fairness；四角色（G3 需 work-auditor+site-auditor）；runtime-bundle.zip/gates.json/release-gates.json；manifest schemaVersion/protocol/route/sourceTreeSha 绑定；验签器 dry-run | §10 |
| M6 | 无队列清空机制 | owner 授权 QA-only drain：2 text reviews 经写路径完成；5 acoustic fixtures 经 v26 流程/cleanup 完成或清理；前后 read_qa_status 记录；HJK 标记/移除定义 | §8 |
| M7 | 订阅续期触发/存活证据未定；pendingCount=0 可假空 | 持久订阅过期观测；明确续期调用（subscribe_to_events/update_subscription）+节奏；每次 24h 唤醒须 subscriptionActive=true 才接受 pendingCount=0 | §8/§9 |
| M8 | 无官方 run 引用（server runId≠平台 runId） | 官方引用源=Work run history/turn/message IDs（userTurnId/assistantMessageId/turnKey）入 official-run-history.json；server runId/fence 为独立内部绑定 | §4/§10 |
| M9 | 缺"零逐次确认/无主机执行"判据 | §15 加 confirmations=0 + A/B/C 期间无 Mac 网络/tunnel/Chrome；证据字段+官方 run log/site/executor exports | §11/§15 |
| M10 | Chrome 计划薄于 §5.2；webm 来源未定 | 扩至契约：S/I±500ms、D±750ms、媒体时误差≤150ms、loadedmetadata→seeked→playing→stop、pause/refresh/re-entry/slow metadata/rapid clicks、两份人工证据文件、双编码；webm 由同一 HJK 源转码（第二录音对象/job）注明来源；加 §4.3 探针 | §7 |
| M11 | 部分 A/崩溃恢复未定 | nextIndex+已验证片状态机；B 对缺失前缀片重算/重存再续跑；崩溃注入测试（index0 后/前缀中/retry 后） | §4/§5/§13 |
| M12 | B 冷缓存漏交付；交付/租约顺序矛盾 | 每个需推理 run 显式 reuse-or-deliver+install；先 claim 立 fence→租约下交付+续租；A 暂态读失败在交付前；测持久/非持久两路径 | §3/§4 |
| M13 | 无持久唤醒历史（probe 表覆盖） | 增 append-only site event log（或导出 Work run history）：UTC/pendingCount/pendingAcoustics/subscriptionActive；emptyQueueWakes 入 official-run-history.json | §8/§10 |
| M14 | 测试缺必需负例 | 负例矩阵补：并发 claim/claim 响应丢失/保存前后崩溃/对象未发布/清理接管竞态/重复完成块/过期凭证续期/录音 EOF 截断/撤销/同批坏 job 隔离/重录修订冲突/8MiB 边界/PTY>3000/base64 校验失败/部分 A/缓存失效，附预期状态码 | §13 |

## Minors（全部闭环）

| ID | 闭环 | 落点 |
| --- | --- | --- |
| m1 | read_qa_recording_bytes 文本 content 含 base64（服务端行为）；§11 改为"交付字节仅经 read_qa_probe_blob structuredContent（文本仅元数据）；录音读取须 run 纪律不回显文本 content"，并标记服务端 metadata-only 改进项 | §11 |
| m2 | 完成回执用 read_qa_text_answer/completionReceipt；jobId 用 recover_qa_reviews；read_qa_status 不返回二者 | §4 |
| m3 | 24h pendingCount=0 须绑 subscriptionActive=true | §8 |
| m4 | truth.json 非 probe 资产，留主导/验签器；仅锚点+truthSha256 嵌入 manifest | §2 |
| m5 | 移除 service-only download=1 回退（Envoy 挡）；MCP-only | §4 |
| m6 | F6 声明收窄为一次 15,360 B index0 往返+旧 fence 拒绝+scratch 清理 | §0/§5 |
| m7 | 续租延迟已实测 3.6/5.2/2.7/2.1s，引用 | §3 |
| m8 | 声学完成仅需 verified（不查 expires_at）；仅非声学事件投递/读需未过期订阅 | §9 |
| m9 | F2/F3–F5/F6 主 JSON 未本地字节核验；标 provenance 限制，依赖本地 SHA 核验的 readback | §0/§10 |
| m10 | runPattern 仅小写 hex UUID；声明格式并先校验 | §4 |
| m11 | duration 用解码媒体时长 68.699728s（一致） | §7 |
| m12 | G3 证据需 work-auditor+site-auditor 两角色签名 | §10 |

## 评审确认正确（保留）

固定制品 SHA/尺寸、交付集 75,446,950 B/25 次/4MiB、F1 下界 4MiB/8MiB 失败、F2 1067.528s/4.044MiB/min/4 次续租、F3–F5 合成夹具 SHA/859 窗/4295 帧/张量形状、F6 15,360 B 往返/lease_lost/remainingObjects=0、HJK 解码 1,099,196 样本/912fcde5/859 窗、真值锚点（3.360/11.440/55.209724）、§6 五元组绑定/outputIndex1–8191/单事务/重放/旧 fence/读取豁免、read_qa_probe_blob owner-only/pinned/4MiB/元数据文本、诊断模式非 G2、G3≠D2、隔离边界。

## 闭环状态

B1–B4、M1–M14、m1–m12 **全部闭环**（设计 rev2）。待 owner 放行代码后实施；实施第一步为 D1 前置实测（跨 run 持久性）+ B4 租约重置 + claim smoke test。
