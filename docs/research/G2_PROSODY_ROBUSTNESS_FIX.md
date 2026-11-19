# G2-prosody 鲁棒性缺口彻底修复可行性方案

日期：2026-11-19 · 状态：**可行性方案，待放行，未改代码**
缺口实测：跨编码/加噪重测一致性 **0.75<0.9**（mp3 8/8、aac 6/8、噪声 4/8）。失败主因是 **pause_count 抖动**（时长基本稳定）。

## 1. 根因
`runner/prosody.py` 用 **噪声地板百分位(p10 capped)+Schmitt 触发** 做能量静音检测。加白噪/aac 伪影抬高噪声地板 → low/high 阈值漂移 → 低能量语音（擦音/塞音闭锁）与静音边界混淆 → pause 合并/分裂 → count 抖动。能量法在低 SNR 下**原理上**难分语音/噪声。

## 2. 修复路线（可行、本地、零边际成本）
### F1 主路线：学习式 VAD（Silero）pause 时间线
- 引入 **Silero VAD**（MIT、ONNX ~2MB、Mac CPU、env 已有 onnxruntime 1.32）。输出语音概率→滞回+最小时长→speech 段；**pause=段间间隙≥min_pause**。学习式 VAD 对 mild 噪声/编码显著更稳健。
- `prosody.analyze_wav` 增 `pause_mode="vad"`（默认仍 waveform_only 向后兼容）；G2 用 vad；校准乘数映射为 VAD 阈值钩子。
- 需下载 silero ONNX（网络、MIT）；资产不分发入仓（脚本入仓、模型本地）。
### F2 备路线：纯 DSP 硬化（若 VAD 不可用）
- 高通去编码低频、更稳健噪声地板（quiet-frame 众数/低百分位）、加大 bridge/merge 容差、min pause/speech。零下载，但低 SNR 上界有限。

## 3. 预注册验证（不 tune-to-pass）
- 条件：original / mp3@64k / aac@64k / ogg / 白噪(SNR≈20dB)。
- 指标：pause_count 精确一致率、时长误差≤2%、pause 边界 IoU；**retest_consistency≥0.9**。
- **tune/validate 分离**：在子集 A 调算法，在**held-out 子集 B** 验证；B 不参与调参。
- 任一条件<0.9 → 如实 FAIL，迭代算法（不降阈值）；若重噪下仍不足，披露 SNR 适用范围。

## 4. 集成与部署
- 改 `runner/prosody.py`（vad 模式）+ `grounded_audio.analyze_calibrated` 表面 VAD pauses 为 calibrated + 测试（重测/跨编码/加噪/held-out）。
- 验证通过后部署 runner（重置观察窗，开新窗）；G2-prosody 以 vad 模式重跑重测达标→PASS。

## 5. 成本/风险/诚实
- 成本：F1 ~1–2 工日 + 模型下载；F2 ~0.5–1 工日；零边际调用费。
- 风险：VAD 对重噪/远场仍有限→披露范围；不降 0.9；不 tune 验证集。
- 诚实：G2-prosody 只在验证达标后声明 PASS；否则 FAIL+范围披露。

## 6. 待决策
- D-1 主路线 F1（Silero VAD）？备 F2。
- D-2 批准预注册验证协议（tune/validate 分离、≥0.9）？
- D-3 验证通过后部署 runner（开新窗）？
