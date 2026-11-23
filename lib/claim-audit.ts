// Pure helper (no bindings) so it is unit-testable without the Worker runtime.
/** True only for a successful claim_next_review_task reply whose task is null
 * (queue empty). Anything unparseable or erroneous is treated as non-empty so
 * it stays audited (fail toward more audit, never less). */
export function isEmptyClaim(result: unknown): boolean {
  const r = result as { isError?: boolean; content?: { type?: string; text?: string }[] } | null;
  if (!r || r.isError || !Array.isArray(r.content) || r.content.length !== 1) return false;
  try {
    const body = JSON.parse(String(r.content[0]?.text ?? ""));
    return Boolean(body) && typeof body === "object" && body.task === null;
  } catch {
    return false;
  }
}
