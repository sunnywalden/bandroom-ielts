"use client";
// Four-step writing loop UI (docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §3.1, §5).
import { useMemo, useState } from "react";
import type { WritingCards, WritingDelta, WritingIssue } from "@/lib/writing-feedback";
import type { WritingRecheckStatus } from "./feedback-model";
import { diffWords } from "./writing-diff";
import {
  CATEGORY_ZH, PRIORITY_ZH, RESULT_ZH, STEP_LABELS, MIN_WHY, segmentDraft, issueStates,
  type IssueState, type LoopStep,
} from "./writing-loop-model";
import "./writing-loop.css";

const STEPS: LoopStep[] = ["draft", "review", "revise", "reflect"];

export function WritingStepper({ step }: { step: LoopStep }) {
  const current = STEPS.indexOf(step);
  return <ol className="wl-steps" aria-label="写作步骤">
    {STEPS.map((key, index) => <li key={key} className={index < current ? "done" : index === current ? "current" : ""}
      aria-current={index === current ? "step" : undefined}>
      <span>{index + 1}</span>{STEP_LABELS[key]}
    </li>)}
  </ol>;
}

/** First draft rendered read-only with server-resolved anchors highlighted. */
export function AnnotatedDraft({ text, issues, active, onActivate }: {
  text: string; issues: WritingIssue[]; active?: string; onActivate: (id: string) => void;
}) {
  const segments = useMemo(() => segmentDraft(text, issues), [text, issues]);
  return <div className="wl-draft english-text" lang="en" aria-label="首稿（带批注）">
    {segments.map((segment, index) => segment.issue
      ? <mark key={index} id={`wl-anchor-${segment.issue.id}`}
          className={`wl-mark wl-${segment.issue.priority}${active === segment.issue.id ? " active" : ""}`}
          role="button" tabIndex={0} aria-label={`问题 ${segment.n}：${CATEGORY_ZH[segment.issue.category]}，${PRIORITY_ZH[segment.issue.priority]}`}
          onClick={() => onActivate(segment.issue!.id)}
          onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(segment.issue!.id); } }}>
          {segment.text}<sup>{segment.n}</sup>
        </mark>
      : <span key={index}>{segment.text}</span>)}
  </div>;
}

export function IssueCard({ issue, n, selected, onToggle, revealed, onReveal, active, onActivate, state }: {
  issue: WritingIssue; n: number; selected?: boolean; onToggle?: () => void;
  revealed: boolean; onReveal: () => void; active?: boolean; onActivate?: () => void; state?: IssueState;
}) {
  return <article id={`wl-card-${issue.id}`} className={`wl-card wl-${issue.priority}${active ? " active" : ""}`}
    onClick={onActivate}>
    <header>
      <span className="wl-n">{n}</span>
      <strong>{CATEGORY_ZH[issue.category]}</strong>
      <span className={`wl-badge wl-${issue.priority}`}>{PRIORITY_ZH[issue.priority]}</span>
      {state && <span className={`wl-state wl-${state}`}>{state === "changed" ? "已改动 · 待复核" : state === "untouched" ? "未改动" : "无原文定位"}</span>}
      {onToggle && <label className="wl-pick" onClick={event => event.stopPropagation()}>
        <input type="checkbox" checked={Boolean(selected)} onChange={onToggle}/>本次要改
      </label>}
    </header>
    <p className="wl-quote" lang="en">{issue.anchor ? `“${issue.quote}”` : `整体建议 · “${issue.quote}”`}</p>
    <p className="wl-prompt">{issue.prompt_zh}</p>
    <details className="wl-why"><summary>为什么</summary><p>{issue.why_zh}</p></details>
    {issue.suggestion
      ? revealed
        ? <p className="wl-suggestion" lang="en">参考改法：{issue.suggestion}</p>
        : <button type="button" className="sp-link" onClick={event => { event.stopPropagation(); onReveal(); }}>查看参考改法（会记录为“看过参考”）</button>
      : (issue.category === "TR" || issue.category === "CC") && <p className="wl-hint">论证与结构只给方向，不代写。</p>}
  </article>;
}

export function ReviewPanel({ draft, cards, selected, onToggle, revealed, onReveal }: {
  draft: string; cards: WritingCards; selected: string[]; onToggle: (id: string) => void;
  revealed: string[]; onReveal: (id: string) => void;
}) {
  const [active, setActive] = useState<string>();
  const activate = (id: string) => {
    setActive(id);
    document.getElementById(`wl-card-${id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const priorities = cards.summary.priorities.map(id => cards.issues.findIndex(issue => issue.id === id) + 1).filter(n => n > 0);
  return <div className="wl-review">
    <div className="wl-left">
      <AnnotatedDraft text={draft} issues={cards.issues} active={active} onActivate={activate}/>
      {priorities.length > 0 && <p className="wl-hint">本稿优先：{priorities.map(n => `#${n}`).join("、")}</p>}
      <p className="wl-next"><strong>下一步</strong>{cards.summary.next_step_zh}</p>
    </div>
    <div className="wl-cards" aria-live="polite">
      {cards.issues.map((issue, index) => <IssueCard key={issue.id} issue={issue} n={index + 1}
        selected={selected.includes(issue.id)} onToggle={() => onToggle(issue.id)}
        revealed={revealed.includes(issue.id)} onReveal={() => onReveal(issue.id)}
        active={active === issue.id} onActivate={() => {
          setActive(issue.id);
          document.getElementById(`wl-anchor-${issue.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }}/>)}
    </div>
  </div>;
}

export const RECHECK_LIMIT = 5;

export function RevisionChecklist({ original, revised, cards, selected, why, onWhy, revealed, onReveal,
  rechecks = [], onRecheck, recheckStatus }: {
  original: string; revised: string; cards: WritingCards; selected: string[];
  why: Record<string, string>; onWhy: (id: string, value: string) => void;
  revealed: string[]; onReveal: (id: string) => void;
  rechecks?: WritingRecheckStatus[]; onRecheck?: (id: string) => void; recheckStatus?: string;
}) {
  const used = rechecks.length;
  const chosen = cards.issues.filter(issue => selected.includes(issue.id));
  const states = useMemo(() => issueStates(original, revised, chosen), [original, revised, chosen]);
  if (!chosen.length) return <p className="wl-hint">没有勾选问题：本次按自己的判断修改，并在下方写一句补充说明。</p>;
  return <div className="wl-checklist" aria-label="本次要改">
    {recheckStatus && <p className="wl-hint" role="status">{recheckStatus}</p>}
    {chosen.map(issue => {
      const n = cards.issues.indexOf(issue) + 1;
      const needWhy = issue.priority === "must" && states[issue.id] === "changed";
      return <div key={issue.id} className="wl-check-item">
        <IssueCard issue={issue} n={n} revealed={revealed.includes(issue.id)} onReveal={() => onReveal(issue.id)} state={states[issue.id]}/>
        {(needWhy || states[issue.id] !== "untouched") && <label className="ex-label wl-why-input">
          {needWhy ? "为什么这样改（必填，一句话）" : "为什么这样改（选填）"}
          <input value={why[issue.id] ?? ""} maxLength={160} onChange={event => onWhy(issue.id, event.target.value)}
            placeholder="例如：people 是复数，谓语用原形" aria-invalid={needWhy && (why[issue.id] ?? "").trim().length < MIN_WHY}/>
        </label>}
        {onRecheck && issue.anchor && states[issue.id] === "changed" && <RecheckRow
          latest={rechecks.filter(row => row.issue === issue.id).at(-1)} used={used}
          onRecheck={() => onRecheck(issue.id)}/>}
      </div>;
    })}
  </div>;
}

function RecheckRow({ latest, used, onRecheck }: { latest?: WritingRecheckStatus; used: number; onRecheck: () => void }) {
  const pending = latest && latest.state !== "completed" && latest.state !== "needs_attention" && latest.state !== "blocked";
  return <div className="wl-recheck" aria-live="polite">
    {latest?.result
      ? <p><strong>单项快检：{RESULT_ZH[latest.result]}</strong> {latest.why_zh}
          <small className="wl-hint">（快检时的版本；以提交后复核为准）</small></p>
      : pending ? <p className="wl-hint">快检中…通常几十秒内返回。</p>
      : latest ? <p className="wl-hint">这次快检没有完成，可以再试一次。</p> : null}
    <button type="button" className="sp-link" disabled={Boolean(pending) || used >= RECHECK_LIMIT} onClick={onRecheck}>
      我改好了吗？（{used}/{RECHECK_LIMIT}）
    </button>
  </div>;
}

export function DiffView({ original, revised }: { original: string; revised: string }) {
  const ops = useMemo(() => diffWords(original, revised), [original, revised]);
  return <p className="wl-diff english-text" lang="en" aria-label="首稿与二稿的差异">
    {ops.map((op, index) => op.type === "equal" ? <span key={index}>{op.text} </span>
      : op.type === "del" ? <del key={index}>{op.text}</del> : <ins key={index}>{op.text}</ins>)}
  </p>;
}

export function ReflectPanel({ original, revised, delta, firstCards, revealed, focus, rechecksUsed = 0 }: {
  original: string; revised: string; delta?: WritingDelta; firstCards?: WritingCards; revealed: string[]; focus?: string;
  rechecksUsed?: number;
}) {
  const label = (id: string) => {
    const index = firstCards?.issues.findIndex(issue => issue.id === id) ?? -1;
    const issue = index >= 0 ? firstCards!.issues[index] : undefined;
    return issue ? `#${index + 1} ${CATEGORY_ZH[issue.category]} · “${issue.quote}”` : id;
  };
  return <div className="wl-reflect">
    {delta && <section aria-label="逐条判定">
      <h3>改好了没有</h3>
      <ul className="wl-verdicts">{delta.verdicts.map(verdict => <li key={verdict.issue} className={`wl-v-${verdict.result}`}>
        <strong>{RESULT_ZH[verdict.result]}</strong>
        {verdict.result === "resolved" && !revealed.includes(verdict.issue) && <span className="wl-own">未看参考</span>}
        <span className="wl-v-label" lang="en">{label(verdict.issue)}</span>
        <p>{verdict.why_zh}</p>
        {verdict.adjusted && <small className="wl-hint">按原文核对后的结论</small>}
      </li>)}</ul>
      {delta.issues.length > 0 && <>
        <h3>二稿新出现</h3>
        <ul className="wl-verdicts">{delta.issues.map(issue => <li key={issue.id} className="wl-v-new">
          <strong>{CATEGORY_ZH[issue.category]} · {PRIORITY_ZH[issue.priority]}</strong>
          <span className="wl-v-label" lang="en">“{issue.quote}”</span><p>{issue.why_zh}</p>
        </li>)}</ul>
      </>}
      <p className="wl-next"><strong>下次带走一条</strong>{delta.summary.carry_forward_zh}</p>
      {rechecksUsed > 0 && <p className="wl-hint">本稿使用了 {rechecksUsed} 次快检。</p>}
    </section>}
    {focus && <div className="ex-feedback"><strong>本次修改说明</strong><p>{focus}</p></div>}
    <details className="ex-details" open={!delta}><summary>首稿 → 二稿差异</summary><DiffView original={original} revised={revised}/></details>
  </div>;
}
