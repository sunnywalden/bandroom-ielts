// Browser-side client for the pronunciation profile tools. The tools take the
// userId from the authenticated session; the browser never sends a userId.
//
// The same-origin MCP endpoint is the existing browser-accessible tool surface
// (app/mcp/route.ts). The three tools must be registered in MCP_TOOL_SCOPES by
// the server workstream; until then the endpoint answers 403 and the UI shows
// a non-destructive "not available" message.

import type { Verdict } from './pronunciation-review';

export type PronunciationToolName =
  | 'record_pronunciation_verdict'
  | 'read_pronunciation_profile'
  | 'reset_pronunciation_profile';

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class PronunciationToolError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PronunciationToolError';
    this.code = code;
  }
}

let requestId = 0;

function messageFor(code: string): string {
  if (code === 'sign_in_required') return '登录状态已变化，请重新登录后重试。';
  if (code === 'tool_not_available') return '当前账号暂未启用这项功能。';
  if (code === 'network') return '网络暂时不可用，请稍后重试。';
  if (code === 'invalid_response') return '服务器返回的内容无法读取，请稍后重试。';
  return '暂时无法完成这项操作，请稍后重试。';
}

function rpcErrorCode(value: unknown): string {
  const code = typeof value === 'number' ? value : undefined;
  if (code === -32001) return 'sign_in_required';
  if (code === -32003) return 'tool_not_available';
  return 'tool_error';
}

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function callPronunciationTool<T>(
  name: PronunciationToolName,
  args: Record<string, unknown>,
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl('/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++requestId, method: 'tools/call', params: { name, arguments: args } }),
    });
  } catch {
    throw new PronunciationToolError('network', messageFor('network'));
  }
  if (response.status === 401) throw new PronunciationToolError('sign_in_required', messageFor('sign_in_required'));
  if (response.status === 403) throw new PronunciationToolError('tool_not_available', messageFor('tool_not_available'));
  const body = await readBody(response);
  const root = body !== null && typeof body === 'object' ? body as Record<string, unknown> : null;
  if (!response.ok || !root) throw new PronunciationToolError('tool_error', messageFor('tool_error'));
  const error = root.error !== null && typeof root.error === 'object' ? root.error as Record<string, unknown> : null;
  if (error) {
    const code = rpcErrorCode(error.code);
    throw new PronunciationToolError(code, messageFor(code));
  }
  const result = root.result !== null && typeof root.result === 'object' ? root.result as Record<string, unknown> : null;
  const content = Array.isArray(result?.content) ? result.content : [];
  const text = content
    .map(item => item !== null && typeof item === 'object' ? (item as Record<string, unknown>).text : undefined)
    .find((value): value is string => typeof value === 'string');
  if (result?.isError) {
    let payload: unknown = text;
    try { payload = text ? JSON.parse(text) : null; } catch { /* Plain-text tool errors remain readable below. */ }
    const row = payload !== null && typeof payload === 'object' ? payload as Record<string, unknown> : null;
    const code = typeof row?.error === 'string' ? row.error : 'tool_error';
    throw new PronunciationToolError(code, typeof text === 'string' && text ? text : messageFor(code));
  }
  if (text === undefined) throw new PronunciationToolError('invalid_response', messageFor('invalid_response'));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new PronunciationToolError('invalid_response', messageFor('invalid_response'));
  }
}

// The payload intentionally contains only the candidate and the verdict. The
// server attaches `isCatchTrial` from its own candidate row; the browser cannot
// claim or discover it.
export function recordPronunciationVerdict(
  candidateId: string,
  verdict: Verdict,
  fetchImpl?: FetchLike,
): Promise<unknown> {
  return callPronunciationTool('record_pronunciation_verdict', { candidateId, verdict }, fetchImpl);
}

export function readPronunciationProfile(fetchImpl?: FetchLike): Promise<unknown> {
  return callPronunciationTool('read_pronunciation_profile', {}, fetchImpl);
}

export function resetPronunciationProfile(fetchImpl?: FetchLike): Promise<unknown> {
  return callPronunciationTool('reset_pronunciation_profile', {}, fetchImpl);
}