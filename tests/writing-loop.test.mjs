// Phase 1 writing loop: deterministic diff/anchors, issue-card validation,
// incremental second-draft verdict rules and unified content rules.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = pathToFileURL(process.cwd() + "/");
registerHooks({
  resolve(spec, ctx, next) {
    if (ctx.parentURL?.startsWith(root.href) && !ctx.parentURL.includes("node_modules")) {
      if (spec.startsWith("@/")) return { url: new URL(spec.slice(2) + ".ts", root).href, shortCircuit: true };
      if (spec.startsWith(".") && !spec.endsWith(".ts") && !spec.endsWith(".mjs"))
        return { url: new URL(spec + ".ts", ctx.parentURL).href, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});
const diff = await import("../app/writing-diff.ts");
const wf = await import("../lib/writing-feedback.ts");
const rules = await import("../lib/content-rules.ts");

const DRAFT = "Nowadays many people believes that cities are crowded. It is good for society. Many people believes it.";

test("resolveAnchor: exact, ambiguous without context, disambiguated with context, absent", () => {
  assert.deepEqual(diff.resolveAnchor(DRAFT, "It is good for society."), { start: 55, end: 78 });
  assert.equal(diff.resolveAnchor(DRAFT, "people believes"), null, "two hits and no context → no anchor");
  const second = diff.resolveAnchor(DRAFT, "people believes", "society. Many");
  assert.equal(DRAFT.slice(second.start, second.end), "people believes");
  assert.ok(second.start > 60);
  assert.equal(diff.resolveAnchor(DRAFT, "not in text"), null);
  assert.equal(diff.resolveAnchor(DRAFT, ""), null);
});

test("trackAnchor: untouched survives edits elsewhere; any edit inside is changed", () => {
  const anchor = diff.resolveAnchor(DRAFT, "It is good for society.");
  const editedElsewhere = DRAFT.replace("Nowadays many people believes", "Today, many people believe");
  const kept = diff.trackAnchor(DRAFT, editedElsewhere, anchor);
  assert.equal(kept.state, "untouched");
  assert.equal(editedElsewhere.slice(kept.span.start, kept.span.end), "It is good for society.");
  const editedInside = DRAFT.replace("It is good for society.", "It is good for society, for example by cutting commutes.");
  assert.equal(diff.trackAnchor(DRAFT, editedInside, anchor).state, "changed");
  const inserted = DRAFT.replace("It is good", "It is clearly good");
  assert.equal(diff.trackAnchor(DRAFT, inserted, anchor).state, "changed", "an insertion inside the span is a change");
  const deleted = DRAFT.replace(" It is good for society.", "");
  assert.equal(diff.trackAnchor(DRAFT, deleted, anchor).state, "changed");
  // The same words appearing elsewhere must not fake an "untouched" state.
  const moved = DRAFT.replace("It is good for society.", "It is helpful.") + " It is good for society.";
  assert.equal(diff.trackAnchor(DRAFT, moved, anchor).state, "changed",
    "re-adding the original words elsewhere does not make the edited spot untouched");
});

test("diffWords marks deletions and insertions", () => {
  const ops = diff.diffWords("many people believes that", "many people believe that");
  assert.deepEqual(ops, [
    { type: "equal", text: "many people" }, { type: "del", text: "believes" },
    { type: "ins", text: "believe" }, { type: "equal", text: "that" },
  ]);
  assert.deepEqual(diff.diffWords("", "new text"), [{ type: "ins", text: "new text" }]);
});

const cards = {
  mode: "cards",
  issues: [
    { id: "i1", category: "GRA", priority: "must", quote: "people believes", context_before: "Nowadays many",
      prompt_zh: "主语是复数，谓语要怎么变？", why_zh: "people 为复数。", suggestion: "people believe" },
    { id: "i2", category: "TR", priority: "should", quote: "It is good for society.",
      prompt_zh: "“好”具体体现在哪里？", why_zh: "论点缺少具体例子。", suggestion: "It is good because ..." },
    { id: "i3", category: "LR", priority: "nice", quote: "invented phrase",
      prompt_zh: "换个词？", why_zh: "用词重复。", suggestion: null },
  ],
  summary: { priorities: ["i1", "i2", "zz"], next_step_zh: "每个论点后补一个具体例子。" },
};

test("validateWritingCards resolves anchors server-side and forbids rewriting arguments", () => {
  const out = wf.validateWritingCards(cards, DRAFT);
  assert.equal(out.schema, wf.WRITING_SCHEMA);
  assert.equal(DRAFT.slice(out.issues[0].anchor.start, out.issues[0].anchor.end), "people believes");
  assert.equal(out.issues[0].anchor.start, 14, "context picks the first occurrence");
  assert.equal(out.issues[1].suggestion, null, "TR/CC never carry a rewrite");
  assert.equal(out.issues[2].anchor, null, "an absent quote becomes general advice, not an invented position");
  assert.deepEqual(out.summary.priorities, ["i1", "i2"], "unknown priority ids are dropped, max 2");
  assert.match(wf.composeWritingText(out), /【语法·必改】“people believes”/);
});

test("validateWritingCards rejects bad schema, duplicate ids and band numbers", () => {
  assert.throws(() => wf.validateWritingCards({ mode: "cards", issues: [] , summary: { next_step_zh: "x" } }, DRAFT), /invalid_writing|too_small|>=1/);
  assert.throws(() => wf.validateWritingCards({ ...cards, issues: [cards.issues[0], cards.issues[0]] }, DRAFT),
    e => e.code === "invalid_writing");
  assert.throws(() => wf.validateWritingCards({ ...cards, summary: { priorities: [], next_step_zh: "这篇写作 band 6.5，继续努力" } }, DRAFT),
    e => e.code === "content_rule_violation");
});

test("validateWritingDelta: deterministic untouched wins and resolved needs a verbatim quote", () => {
  const first = wf.validateWritingCards(cards, DRAFT);
  const revision = DRAFT.replace("Nowadays many people believes", "Nowadays many people believe");
  const out = wf.validateWritingDelta({
    mode: "delta",
    verdicts: [
      { issue: "i1", result: "resolved", evidence_quote: "many people believe that", why_zh: "主谓一致已改正。" },
      { issue: "i2", result: "resolved", evidence_quote: "It is good for society.", why_zh: "已补充例子。" },
      { issue: "i3", result: "partial", evidence_quote: "not in revision", why_zh: "部分。" },
      { issue: "unknown", result: "resolved", why_zh: "?" },
    ],
    issues: [{ id: "1", category: "GRA", priority: "should", quote: "cities are crowded", prompt_zh: "冠词？", why_zh: "x", suggestion: "the cities" }],
    summary: { carry_forward_zh: "检查主谓一致。" },
  }, revision, DRAFT, { feedbackId: "rt:first", issues: first.issues });
  const v = Object.fromEntries(out.verdicts.map(item => [item.issue, item]));
  assert.equal(v.i1.result, "resolved");
  assert.equal(v.i1.local, "changed");
  assert.equal(v.i2.result, "untouched", "the model cannot claim an unchanged sentence was fixed");
  assert.equal(v.i2.adjusted, true);
  assert.equal(v.i3.result, "unresolved", "a non-verbatim evidence quote downgrades the verdict");
  assert.equal(v.unknown, undefined);
  assert.equal(out.issues[0].id, "n1", "new issues never collide with first-draft ids");
  assert.equal(out.baseFeedbackId, "rt:first");
});

test("validateWritingDelta fills a verdict for every untouched anchored issue", () => {
  const first = wf.validateWritingCards(cards, DRAFT);
  const out = wf.validateWritingDelta({ mode: "delta", verdicts: [], issues: [], summary: { carry_forward_zh: "继续。" } },
    DRAFT + " Extra sentence.", DRAFT, { feedbackId: "rt:first", issues: first.issues });
  assert.deepEqual(out.verdicts.map(v => [v.issue, v.result]), [["i1", "untouched"], ["i2", "untouched"]]);
});

test("content rules: text stages may not carry a band number; speaking criterion bands unaffected", () => {
  const v = (feedback, stage) => rules.coachingContentViolation({ feedback, evidence: "", stage })?.code ?? null;
  assert.equal(v("写作 6.5 分", "write"), "uncalibrated_band");
  assert.equal(v("This essay is band 7", "write"), "uncalibrated_band");
  assert.equal(v("Task 2 score: 6", "write"), "uncalibrated_band");
  assert.equal(v("Your argument needs a clearer position.", "write"), null);
  assert.equal(v("Pronunciation 6.5", "write"), "unstructured_pronunciation");
  assert.equal(v("Fluency band 6 for this fragment", "speak"), null);
  assert.equal(v("This essay is band 7", undefined), null, "legacy speaking-only call keeps old behaviour");
  assert.equal(rules.citesLearnerText("原文 “believes”", "people believes that"), true);
  assert.equal(rules.citesLearnerText("Good job overall.", "people believes that"), false);
  assert.equal(rules.citesLearnerText("anything", "!!"), true);
});

const model = await import("../app/writing-loop-model.ts");

test("loop step follows the saved entry and the learner's explicit start", () => {
  assert.equal(model.loopStep({ revising: false }), "draft");
  assert.equal(model.loopStep({ original: "a", revising: false }), "review");
  assert.equal(model.loopStep({ original: "a", revising: true }), "revise");
  assert.equal(model.loopStep({ original: "a", revised: "b", revising: true }), "reflect");
});

test("segmentDraft skips overlapping and out-of-range anchors", () => {
  const issue = (id, start, end) => ({ id, category: "GRA", priority: "must", quote: "", anchor: { start, end }, prompt_zh: "", why_zh: "", suggestion: null });
  const segments = model.segmentDraft("abcdefghij", [issue("a", 2, 5), issue("b", 4, 7), issue("c", 8, 30), { ...issue("d", 0, 0), anchor: null }]);
  assert.deepEqual(segments.map(s => [s.text, s.issue?.id ?? null, s.n ?? null]), [["ab", null, null], ["cde", "a", 1], ["fghij", null, null]]);
});

test("revisionGate: unchanged, untouched selection, must-why, note-only and composed focus", () => {
  const first = wf.validateWritingCards(cards, DRAFT);
  const base = { original: DRAFT, issues: first.issues, selected: ["i1", "i2"], why: {}, note: "" };
  assert.equal(model.revisionGate({ ...base, revised: DRAFT }).reason, "二稿还和首稿一样。");
  const elsewhere = DRAFT + " New closing sentence.";
  assert.match(model.revisionGate({ ...base, revised: elsewhere }).reason, /勾选的问题还没有改动/);
  assert.equal(model.revisionGate({ ...base, revised: elsewhere, note: "加了结论句" }).ready, true, "a note is enough");
  const fixed = DRAFT.replace("people believes that", "people believe that");
  const missing = model.revisionGate({ ...base, revised: fixed });
  assert.match(missing.reason, /必改项 #1/);
  const ok = model.revisionGate({ ...base, revised: fixed, why: { i1: "people 是复数" } });
  assert.equal(ok.ready, true);
  assert.equal(ok.focus, "改了：#1 语法：people 是复数");
  assert.deepEqual(ok.issues, [{ id: "i1", state: "changed", why: "people 是复数" }, { id: "i2", state: "untouched", why: "" }]);
  assert.equal(model.revisionGate({ ...base, selected: [], revised: fixed }).reason, "写一句补充说明：这次改了什么。");
  assert.deepEqual(model.defaultSelection(first), ["i1", "i2"]);
  assert.deepEqual(model.parseList("not json"), []);
  assert.deepEqual(model.parseWhy('{"i1":"x","i2":3}'), { i1: "x" });
});
