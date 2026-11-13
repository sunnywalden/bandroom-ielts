# Bandroom G3 · Chrome §5.2 原题回听测试计划（M10）

2026-11-13（UTC）。本计划只覆盖隔离 QA 站的原题回听与媒体事件证据；不部署、不改服务端、不接触生产/学习者数据。Chrome 是唯一浏览器（Safari 已从本次验收移除）。所有数值必须实测记录；未执行的用例标记 failed/blocked，不得写 passed。

## 1. 前置条件

- C 已完成：`write_qa_text_feedback` 单次提交成功，`read_qa_text_answer` 返回 `kind="acoustic_diagnostic"`、`quoteForWrite="[原声录音]"`、`feedback` 与 manifest 一致，completion receipt 的 `recipeSha256/runId/fence/outputSha256/outputIndex=7/recordingSha256` 与 C 报告一致，且原题反馈仅一份。
- 原题页在 A 开始前关闭，直到 C 回写与回执核对完成才打开（`site-event-export.json.clientOperationsDuringClosure=[]`）。关闭/重开各留 receipt 与 UTC。
- owner 登录隔离 QA origin；记录 Chrome 版本、OS、设备、音频输出设备；不使用本机脚本/隧道代执行浏览器动作。
- 记录页面实际引用的 `recordingId`、`recordingSha256`、`feedbackId`、`receiptId`，三者须与 `offline.json.feedbackReceipt` 一致。

## 2. 录音与来源（不得伪造浏览器采集）

### 2.1 主录音（MP4/AAC）
- HJK 原题 `recording.m4a`：441,322 B，SHA-256 `55ecb210cf3490448df0372344d2618086709bf2c6112e6f6354e18ac6b232d1`。
- 解码媒体时长参考 68.699728 s（与 manifest `duration` 一致）；浏览器以实际 `media.duration` 为准并记录 `durationMs`。

### 2.2 WebM/Opus 第二录音对象（M10）
由同一 HJK 源转码，作为第二录音对象/第二 QA job；不得声称是浏览器采集。建议命令（在本机或隔离构建机执行，记录 ffmpeg 版本）：

```
ffmpeg -hide_banner -y -i recording.m4a -map 0:a:0 -vn \
  -c:a libopus -b:a 96k -ar 48000 -application audio \
  -fflags +bitexact -flags:a +bitexact recording.webm
```

必须记录：源 SHA、输出字节数、输出 SHA-256、`ffprobe` 的 codec/duration/sample_rate/channels、Opus pre-skip 与 container start time、转码命令原文。通过隔离 QA 既有提交路径创建第二 job（不得覆盖 HJK job），记录 `secondJobId`、`recordingSha256`。跨编码回听时把同一人工锚点映射到 WebM 时间轴，记录 ±150 ms 内是否一致。

### 2.3 §4.3 探针片段
- 30–45 s 与 165–180 s 各一条，MP4/AAC 与 WebM/Opus 各一份；来源须有许可/隔离授权，记录源文件 SHA 与转码命令。
- 每种编码至少 3 次空缓存冷启（独立 official run），记录下载/准备/解码/ASR/声学/候选/校验/回写各阶段秒数、`coldBytes`、进程树峰值、环境指纹、处理器、源端限制观察。
- 预算口径沿用契约 §4.3，但 v26 实测吞吐使「下载+安装≤300 s」不可达（M4）；按 owner 批准的证据化修订记录实际值，不得把未达标写成达标。

## 3. 浏览器插桩

在回听页面控制台注入（只读观察，不改页面逻辑），把事件写入可导出的数组：

```js
(() => {
  const media = document.querySelector('audio, video');
  if (!media) throw new Error('no media element');
  const events = [];
  const t0 = performance.now();
  const push = (type) => events.push({
    type,
    mediaTimeMs: Math.round(media.currentTime * 1000),
    elapsedMs: Math.round(performance.now() - t0),
  });
  for (const type of ['loadedmetadata', 'seeked', 'playing', 'pause', 'ended']) {
    media.addEventListener(type, () => push(type));
  }
  window.__qaMediaEvents = events;
  window.__qaMedia = media;
})();
```

导出前确认 `loadedmetadata` 存在、`elapsedMs` 单调不减、`mediaTimeMs` 在 `[0, durationMs]`。截图/录屏仅作辅助，不替代事件数组。

## 4. 回听窗口与媒体时间

对每个反馈锚点：

- 替换/添音（S/I）：`start = max(0, startMs - 500)`，`end = endMs + 500`。
- 漏音（D）：`start = max(0, anchorMs - 750)`，`end = anchorMs + 750`。
- 裁剪到原声时长，并保留最短有效窗口：`stop = min(durationMs, max(start + 300, end))`，且 `stop > playing.mediaTimeMs`。
- 事件序列必须为 `loadedmetadata → seeked → playing → (pause|ended)`；`loadedmetadata.elapsedMs ≤ seeked.elapsedMs ≤ playing.elapsedMs < stop.elapsedMs`。
- `seeked.mediaTimeMs`、`playing.mediaTimeMs` 与 `start` 的误差 ≤150 ms；`stop.mediaTimeMs` 与 `stop` 的误差 ≤150 ms；`stop.mediaTimeMs > playing.mediaTimeMs`。
- 16 kHz 样本号到媒体 PTS 的映射：记录采集/解码时基、编码预滚（AAC priming / Opus pre-skip）、首帧偏移与 edit list。映射误差计入 150 ms 判定；不得用样本号直接冒充媒体时间。

三个真值锚点（truth SHA-256 `394fcb74a4221278aa7df02ead49a3743da6293c527617c7f973b1a52c062e28`）：

| 词 | 类型 | start (s) | end (s) | 回听窗口 |
| --- | --- | ---: | ---: | --- |
| business | 替换 | 3.360 | 3.660 | 2.860–4.160 |
| and | 漏音 | 11.440 | 11.740 | 10.690–12.490 |
| suitcase | 添音 | 55.209724 | 55.509724 | 54.709724–56.009724 |

每个锚点由两名人工分别回听并记录实发音/听到的词；模型标记只用于定位，不作为纠音结论（加窗 posterior 在窗边界非无缝，边界帧 cosine≈0.76）。

## 5. 交互矩阵（Chrome）

| 用例 | 操作 | 通过条件 |
| --- | --- | --- |
| playback | 打开原题，播放并定位到锚点 | 事件序列与 ±150 ms 达标；反馈/回执/录音身份一致 |
| pause | 播放中暂停再继续 | pause 事件 mediaTime 合理；恢复后仍能定位 |
| refresh | 回写后刷新页面 | 反馈仍在、仅一份；receipt 可读回 |
| reopen | 关闭标签页后重入 | 同一 feedback/receipt/recording；无重复反馈 |
| slow-loadedmetadata | 限速/大文件使 metadata 延迟 | `loadedmetadata` 仍先于 `seeked`；不提前 seek |
| repeat-marker | 连续快速点击同一标记 | 每次 seeked/playing 事件顺序正确；无错位/卡死 |
| double-click | 快速双击提交/标记 | 不产生重复反馈或重复回执 |
| final-chunk | 最后录音分片提交 | 提交成功、时长完整、无截断 |
| save-delay | 保存延迟/弱网 | 有明确状态与重试；不丢草稿 |
| api-failure | 接口失败 | 显示可恢复错误；重试后成功 |
| session-expired | 登录过期 | 重新登录后继续；不丢反馈 |
| multiple-tabs | 双标签并发 | 单份反馈；旧标签不覆盖新状态 |
| stale-retake-callback | 重录后的旧回调 | 旧回调被拒绝；新修订生效 |
| archive | 学习档案/进度 | Day 12 完成状态、Day 13 解锁与成绩/反馈保留 |

每个用例在 `browser-acceptance.json.cases.<name>` 记录 `status`（passed/failed/blocked）与 `receipt`（截图/哈希/说明）。`learnerBaselineBefore/After` 必须相等，且含 `part2Recording/scores/feedback/day12Status/day13Unlocked`；`rollbackVerified=true`。

## 6. 两份人工证据文件

### 6.1 `browser-acceptance.json`
至少包含：candidate 绑定字段（`sourceSha/buildSha256/analysisVersion/environmentId/route/sourceTreeSha/runtimeBundleSha256/modelWeightsSha256/configSha256`）、SUBJECT 字段（`jobId/taskId/attemptId/attemptRevision/recordingId/recordingSha256/inputBytes/analysisVersion`）、`feedbackId`、`receiptId`、`browsers.Chrome.version`、`cases`（上表 14 项）、`learnerBaselineBefore/After`、`rollbackVerified`。

### 6.2 `browser-playback-events.json`
```json
{
  "reviews": {
    "Chrome": {
      "jobId": "...", "taskId": "...", "attemptId": "...", "attemptRevision": 1,
      "recordingId": "...", "recordingSha256": "...", "inputBytes": 441322,
      "analysisVersion": "...", "feedbackId": "...", "receiptId": "...",
      "version": "<Chrome version>",
      "error": {"wordIndex": 0, "phoneIndex": 0, "kind": "substitution",
                 "target": "business", "actual": "<heard actual>",
                 "startMs": 3360, "endMs": 3660},
      "reviewerId": "<reviewer A>", "heardWord": "business", "heardActual": "<heard actual>",
      "events": [
        {"type": "loadedmetadata", "mediaTimeMs": 0, "elapsedMs": 120},
        {"type": "seeked", "mediaTimeMs": 2860, "elapsedMs": 900},
        {"type": "playing", "mediaTimeMs": 2860, "elapsedMs": 960},
        {"type": "pause", "mediaTimeMs": 4160, "elapsedMs": 2300}
      ]
    }
  },
  "timelineChecks": [
    {"browser": "Chrome", "encoding": "mp4/aac", "recordingSha256": "...", "durationMs": 170000,
     "version": "<Chrome version>",
     "markers": [
       {"position": "first", "startMs": 1000, "stopMs": 4000, "events": ["..."]},
       {"position": "middle", "startMs": 80000, "stopMs": 83000, "events": ["..."]},
       {"position": "tail", "startMs": 165000, "stopMs": 168000, "events": ["..."]}
     ]},
    {"browser": "Chrome", "encoding": "webm/opus", "recordingSha256": "...", "durationMs": 170000,
     "version": "<Chrome version>", "markers": ["..."]}
  ]
}
```
约束：`reviews.Chrome` 绑定主反馈；`timelineChecks` 必须恰好两条、编码分别为 `mp4/aac` 与 `webm/opus`、`recordingSha256` 互异且不同于主录音、时长 30–180 s、标记为 first/middle/tail 且落在各自三分段内。两份文件都由 site-auditor 角色签名前的真实人工回听产生。

## 7. 判定与披露

- 通过：主反馈回执一致；三锚点 S/I±500 ms、D±750 ms 窗口内 seek/stop 误差 ≤150 ms；事件序列完整；交互矩阵 14 项 passed；双编码 timelineChecks 完整；两份证据文件与 receipt 绑定。
- 披露：G3 只验传输/恢复/回听机制，不是 G2 模型合格或 G1 盲测；加窗 posterior 边界有伪影，标记来自人工真值而非模型结论。
- 任何未执行的用例、未取得的媒体事件或未实测的转码参数，记录为 blocked/failed 与原因；不得补造。