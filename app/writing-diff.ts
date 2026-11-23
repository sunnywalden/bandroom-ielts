// Deterministic word-level diff + anchor tracking for the second-draft loop
// (docs/experience-upgrade-realtime-feedback-revision-2026-11-22.md §4.4).
// Pure and dependency-free: shared by the browser (live "已改动" state, diff
// view) and the server (the `untouched` verdict rule). Tokens are runs of
// non-whitespace; comparison is exact (case and punctuation sensitive), so any
// edit inside an anchor counts as a change.

export type Token = { text: string; start: number; end: number };
export type DiffOp = { type: "equal" | "del" | "ins"; text: string };
export type Span = { start: number; end: number };

export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  for (const match of text.matchAll(/\S+/g)) {
    out.push({ text: match[0], start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return out;
}

// Classic LCS table over tokens. Essays are a few hundred words, so the
// O(n·m) table is small (a 600×600 essay pair is 360k cells).
const MAX_CELLS = 4_000_000;

/** Pairs [i, j] of matched token indices (strictly increasing in both). */
export function lcsPairs(a: Token[], b: Token[]): Array<[number, number]> {
  const n = a.length, m = b.length;
  if (!n || !m) return [];
  if (n * m > MAX_CELLS) return greedyPairs(a, b);
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] = a[i].text === b[j].text
        ? table[(i + 1) * width + j + 1] + 1
        : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i].text === b[j].text) { pairs.push([i, j]); i++; j++; }
    else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// Fallback for pathological sizes: forward greedy matching (still monotone).
function greedyPairs(a: Token[], b: Token[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    for (let k = j; k < Math.min(b.length, j + 50); k++) {
      if (a[i].text === b[k].text) { pairs.push([i, k]); j = k + 1; break; }
    }
  }
  return pairs;
}

export function diffWords(original: string, revised: string): DiffOp[] {
  const a = tokenize(original), b = tokenize(revised);
  const pairs = lcsPairs(a, b);
  const ops: DiffOp[] = [];
  const push = (type: DiffOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += " " + text;
    else ops.push({ type, text });
  };
  let i = 0, j = 0;
  for (const [pi, pj] of [...pairs, [a.length, b.length] as [number, number]]) {
    while (i < pi) push("del", a[i++].text);
    while (j < pj) push("ins", b[j++].text);
    if (pi < a.length && pj < b.length) { push("equal", a[pi].text); i = pi + 1; j = pj + 1; }
  }
  return ops;
}

export type AnchorState = { state: "untouched" | "changed"; span: Span | null };

/**
 * Map an anchor span of the original onto the revision.
 * `untouched` only when every original token overlapping the span is matched,
 * the matched revision tokens are consecutive, and nothing was inserted
 * between them. Anything else (edit, insertion, deletion) is `changed`.
 * `span` is the revision span for untouched anchors, or the nearest location
 * for changed ones (null when the whole region disappeared at the edges).
 */
export function trackAnchor(original: string, revised: string, anchor: Span,
  cache?: { a: Token[]; b: Token[]; pairs: Array<[number, number]> }): AnchorState {
  const a = cache?.a ?? tokenize(original), b = cache?.b ?? tokenize(revised);
  const pairs = cache?.pairs ?? lcsPairs(a, b);
  const inside: number[] = [];
  a.forEach((token, index) => { if (token.end > anchor.start && token.start < anchor.end) inside.push(index); });
  if (!inside.length) return { state: "changed", span: null };
  const map = new Map(pairs);
  const matched = inside.map(index => map.get(index));
  const allMatched = matched.every((value): value is number => value !== undefined);
  if (allMatched) {
    const consecutive = matched.every((value, k) => k === 0 || value === (matched[k - 1] as number) + 1);
    if (consecutive) {
      const first = b[matched[0] as number], last = b[matched[matched.length - 1] as number];
      return { state: "untouched", span: { start: first.start, end: last.end } };
    }
  }
  // Nearest revision location: between the last matched token before the
  // anchor and the first matched token after it.
  const before = pairs.filter(([i]) => i < inside[0]).pop();
  const after = pairs.find(([i]) => i > inside[inside.length - 1]);
  const start = before ? b[before[1]].end : 0;
  const end = after ? b[after[1]].start : revised.length;
  return { state: "changed", span: end > start ? { start, end } : null };
}

export function trackAnchors(original: string, revised: string, anchors: Span[]): AnchorState[] {
  const a = tokenize(original), b = tokenize(revised);
  const cache = { a, b, pairs: lcsPairs(a, b) };
  return anchors.map(anchor => trackAnchor(original, revised, anchor, cache));
}

/**
 * Resolve a quoted anchor inside `text` (server-side; the model never supplies
 * offsets). Exact match first; if the quote occurs more than once,
 * `contextBefore` must disambiguate it. Returns null when absent or ambiguous.
 */
export function resolveAnchor(text: string, quote: string, contextBefore = ""): Span | null {
  if (!quote) return null;
  const hits: number[] = [];
  for (let from = 0; ; ) {
    const index = text.indexOf(quote, from);
    if (index < 0) break;
    hits.push(index);
    from = index + 1;
  }
  if (!hits.length) return null;
  if (hits.length === 1) return { start: hits[0], end: hits[0] + quote.length };
  const context = contextBefore.trimEnd();
  if (!context) return null;
  const narrowed = hits.filter(index => text.slice(0, index).trimEnd().endsWith(context));
  return narrowed.length === 1 ? { start: narrowed[0], end: narrowed[0] + quote.length } : null;
}
