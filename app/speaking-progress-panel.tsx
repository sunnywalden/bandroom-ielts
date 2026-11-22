"use client";

// P0-5: read-only vertical speaking progress. Every number comes from a
// server-side scorecard projection; the client never computes a composite or a
// confidence interval. Status labels stay attached to each metric so a
// reference or suggestive value is never mistaken for a calibrated one.
import { useEffect, useMemo, useState } from "react";
import "./speaking.css";
import { activeFocus } from "./speaking-focus";
import type { ProgressPoint, ProgressStatus, SpeakingProgress } from "../lib/speaking-progress";

const STATUS_LABEL: Record<ProgressStatus, string> = {
  calibrated: "已校准",
  reference: "参考指标",
  suggestive: "提示性",
  unavailable: "不可用",
};

type MetricKey = "speechRatio" | "longPauseRatio" | "grammarIssues" | "selfListenWords";
const METRICS: Array<{ key: MetricKey; title: string; note: string; format: (value: number) => string }> = [
  { key: "speechRatio", title: "语音占比", note: "校准口径：说完的话占作答时长的比例。", format: value => `${Math.round(value * 100)}%` },
  { key: "longPauseRatio", title: "长停顿占比", note: "校准口径：长停顿占作答时长的比例。", format: value => `${Math.round(value * 100)}%` },
  { key: "grammarIssues", title: "语法问题数", note: "参考指标：教练标出的问题条数，不是错误率。", format: value => `${value}` },
  { key: "selfListenWords", title: "建议回听词数", note: "提示性：已确认自听的词，只表示你实际听过的范围。", format: value => `${value}` },
];

type LoadState = "loading" | "ready" | "failed";

function useProgress() {
  const [data, setData] = useState<SpeakingProgress | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  useEffect(() => {
    let live = true;
    fetch("/api/speaking/progress", { cache: "no-store", credentials: "same-origin" })
      .then(response => {
        if (!response.ok) throw Error(String(response.status));
        return response.json() as Promise<SpeakingProgress>;
      })
      .then(value => {
        if (!live) return;
        if (!value || !Array.isArray(value.points)) throw Error("shape");
        setData(value);
        setState("ready");
      })
      .catch(() => { if (live) setState("failed"); });
    return () => { live = false; };
  }, []);
  return { data, state };
}

function series(points: ProgressPoint[], key: MetricKey) {
  return points
    .filter(point => point[key] !== null)
    .slice()
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-12)
    .map(point => ({ at: point.createdAt, value: point[key] as number, status: point.statuses[key] }));
}

function formatDate(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? value.slice(0, 10) : value;
}

function Sparkline({ title, values, format }: { title: string; values: Array<{ at: string; value: number }>; format: (value: number) => string }) {
  if (!values.length) return <p className="sp-progress-empty">还没有这项数据。</p>;
  const width = 220, height = 56, pad = 5;
  const max = Math.max(...values.map(item => item.value), 0.000001);
  const min = 0;
  const x = (index: number) => values.length === 1 ? width / 2 : pad + (index / (values.length - 1)) * (width - pad * 2);
  const y = (value: number) => height - pad - ((value - min) / (max - min || 1)) * (height - pad * 2);
  const path = values.map((item, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(item.value).toFixed(1)}`).join(" ");
  const last = values[values.length - 1];
  return <div className="sp-spark">
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${title}趋势：${values.length} 个样本，最近 ${format(last.value)}`}>
      <line x1={pad} x2={width - pad} y1={height - pad} y2={height - pad} className="sp-spark-axis" />
      {values.length > 1 && <path d={path} className="sp-spark-line" />}
      {values.map((item, index) => <circle key={item.at + index} cx={x(index)} cy={y(item.value)} r={values.length === 1 ? 3 : 2.2} className="sp-spark-dot">
        <title>{`${formatDate(item.at)} · ${format(item.value)}`}</title>
      </circle>)}
    </svg>
    <small>{values.length < 2 ? "至少 2 个样本才会连线。" : `${formatDate(last.at)} 最近`}</small>
  </div>;
}

function StatusChip({ status }: { status: ProgressStatus }) {
  return <span className={`sp-status sp-status-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function SpeakingProgressPanel({ entry }: { entry: Record<string, string> }) {
  const { data, state } = useProgress();
  const [metric, setMetric] = useState<MetricKey>("speechRatio");
  const rows = useMemo(() => data ? METRICS.map(item => ({ ...item, values: series(data.points, item.key) })) : [], [data]);
  const current = rows.find(row => row.key === metric);
  return <section className="card pad sp-progress" aria-labelledby="sp-progress-title">
    <div className="sp-top"><span className="eyebrow">Speaking evidence</span><span className="sp-tag">只读聚合</span></div>
    <h2 id="sp-progress-title">口语纵向证据</h2>
    <p className="sp-help">这里只汇总教练已返回的评分卡数值。没有综合分，也不把参考指标包装成成绩。发音分数继续不显示。</p>
    {state === "loading" && <p role="status" className="sp-note">正在读取最近 180 天的评分卡证据…</p>}
    {state === "failed" && <p role="status" className="sp-message">进步数据暂时不可用；已有作答和评价不受影响。稍后重新打开本页即可重试。</p>}
    {data && <>
      <dl className="sp-progress-counts">
        <div><dt>评分卡样本</dt><dd>{data.points.length}</dd></div>
        <div><dt>历史反馈无指标</dt><dd>{data.legacyCount}</dd></div>
        <div><dt>观察窗口</dt><dd>{data.windowDays} 天</dd></div>
        <div><dt>语音占比样本</dt><dd>{data.metricCounts.speechRatio}</dd></div>
      </dl>
      {data.legacyCount > 0 && <p className="sp-note">{data.legacyCount} 条历史反馈没有评分卡指标，已计入总数但不参与趋势。</p>}
      {data.truncated && <p className="sp-note" role="status">样本超过 200 条，本页只显示最近 200 条。</p>}
      {!data.points.length
        ? <p className="sp-note">还没有可对齐的评分卡证据。完成一次口语批改后，这里会出现第一个点。</p>
        : <>
          <div className="sp-progress-tabs" role="tablist" aria-label="选择证据指标">
            {rows.map(row => <button key={row.key} type="button" role="tab" aria-selected={metric === row.key}
              className={metric === row.key ? "chosen" : ""} onClick={() => setMetric(row.key)}>{row.title}<small>n={row.values.length}</small></button>)}
          </div>
          {current && <div className="sp-progress-chart">
            <div className="sp-top"><b>{current.title}</b>{current.values.length ? <StatusChip status={current.values[current.values.length - 1].status}/> : <StatusChip status="unavailable"/>}</div>
            <Sparkline title={current.title} values={current.values} format={current.format}/>
            <p className="sp-note">{current.note}</p>
            {current.values.length > 0 && <p className="sp-progress-latest">最近值 <b>{current.format(current.values[current.values.length - 1].value)}</b> · 样本 {current.values.length} 条。数值只描述已返回的评语，不代表官方成绩。</p>}
          </div>}
        </>}
      <FocusSummary entry={entry}/>
    </>}
  </section>;
}

function FocusSummary({ entry }: { entry: Record<string, string> }) {
  const focus = useMemo(() => activeFocus(entry.speakingFocus), [entry.speakingFocus]);
  return <div className="sp-progress-focus">
    <h3>当前练习焦点</h3>
    {focus ? <><p>{focus.text_zh}</p><p className="sp-note">{focus.source?.attemptId ? "来自已返回的教练证据；由你在上一节确认保留。" : "来自练习主题，不是诊断结论。"}</p></>
      : <p className="sp-note">还没有固定的练习焦点。完成一节口语自评后可以选定一个。</p>}
  </div>;
}

export function WeeklySpeakingCard({ entry }: { entry: Record<string, string> }) {
  const { data, state } = useProgress();
  const focus = useMemo(() => activeFocus(entry.speakingFocus), [entry.speakingFocus]);
  const latest = data?.points[0];
  const week = useMemo(() => {
    if (!data) return 0;
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    return data.points.filter(point => Date.parse(point.createdAt) >= cutoff).length;
  }, [data]);
  return <section className="card pad sp-weekly" aria-labelledby="sp-weekly-title">
    <div className="sp-top"><span className="eyebrow">This week</span><span className="sp-tag">口语</span></div>
    <h2 id="sp-weekly-title">本周口语证据</h2>
    {state === "loading" && <p className="sp-note">正在读取…</p>}
    {state === "failed" && <p className="sp-note">进步数据暂时不可用；练习与批改不受影响。</p>}
    {data && <>
      <dl className="sp-weekly-grid">
        <div><dt>本周新评分卡</dt><dd>{week}</dd></div>
        <div><dt>窗口内已批改</dt><dd>{data.points.length + data.legacyCount}</dd></div>
        <div><dt>语音占比最近值</dt><dd>{latest?.speechRatio === null || latest?.speechRatio === undefined ? "—" : `${Math.round(latest.speechRatio * 100)}%`}</dd></div>
        <div><dt>长停顿占比最近值</dt><dd>{latest?.longPauseRatio === null || latest?.longPauseRatio === undefined ? "—" : `${Math.round(latest.longPauseRatio * 100)}%`}</dd></div>
        <div><dt>建议回听词数</dt><dd>{latest?.selfListenWords ?? "—"}</dd></div>
      </dl>
      <p className="sp-note">最近值与样本量只来自已返回的评分卡；“—”表示暂无校准证据。建议回听词数是提示性计数。</p>
      {focus ? <p className="sp-weekly-focus"><span>当前焦点</span>{focus.text_zh}</p> : <p className="sp-note">还没有固定练习焦点。</p>}
    </>}
  </section>;
}
