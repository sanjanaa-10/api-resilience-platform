/**
 * Minimal zero-dependency HTTP client for upstream calls, shared by the
 * proxy service and the health monitor.
 *
 * Classification contract:
 *  - 'response'      upstream answered (any status) within the deadline
 *  - 'timeout'       AbortSignal fired before a complete response
 *  - 'network-error' connection refused / DNS / socket reset etc.
 */
export interface UpstreamRequestInit {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  timeoutMs: number;
}

export type UpstreamCallResult =
  | { kind: 'response'; status: number; bodyText: string; durationMs: number }
  | { kind: 'timeout'; durationMs: number }
  | { kind: 'network-error'; durationMs: number; errorMessage: string };

/**
 * Node surfaces connection failures as `TypeError: fetch failed` with the
 * real cause (often an AggregateError of ECONNREFUSED/EHOSTUNREACH) buried
 * in `.cause` — dig it out so logs and API consumers see actionable detail.
 */
function describeFetchError(error: unknown): string {
  const base = error instanceof Error ? error.message : String(error);
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof AggregateError && cause.errors.length > 0) {
    const inner = cause.errors
      .map((entry) => (entry instanceof Error ? entry.message : String(entry)))
      .join('; ');
    return `${base} (${inner})`;
  }
  if (cause instanceof Error) return `${base} (${cause.message})`;
  return base;
}

export async function callUpstream(url: string, init: UpstreamRequestInit): Promise<UpstreamCallResult> {
  const startedAt = process.hrtime.bigint();
  const elapsedMs = (): number =>
    Number((Number(process.hrtime.bigint() - startedAt) / 1_000_000).toFixed(2));

  try {
    const response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: init.headers,
      signal: AbortSignal.timeout(init.timeoutMs),
    });
    const bodyText = await response.text();
    return {
      kind: 'response',
      status: response.status,
      bodyText,
      durationMs: elapsedMs(),
    };
  } catch (error) {
    const durationMs = elapsedMs();
    const name = (error as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { kind: 'timeout', durationMs };
    }
    return { kind: 'network-error', durationMs, errorMessage: describeFetchError(error) };
  }
}

export type JsonResult = { ok: true; value: unknown } | { ok: false };

/** Never throws — malformed upstream bodies become a normal result. */
export function tryParseJson(text: string): JsonResult {
  if (text.trim() === '') return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
