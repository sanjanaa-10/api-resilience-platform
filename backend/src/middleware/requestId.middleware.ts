import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Upper bound so a hostile header cannot bloat logs or upstream headers. */
const MAX_CLIENT_REQUEST_ID_LENGTH = 128;

/**
 * Accepts the first X-Request-ID token, trimmed; anything empty or oversized
 * is discarded so a bad client falls back to a generated UUID.
 */
function normalizeClientRequestId(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const candidate = raw.split(',')[0]?.trim();
  if (candidate === undefined || candidate === '' || candidate.length > MAX_CLIENT_REQUEST_ID_LENGTH) {
    return undefined;
  }
  return candidate;
}

/**
 * Resolves the correlation id for every request:
 *   - reuse the client's X-Request-ID when valid (traceability across hops)
 *   - otherwise generate a UUID
 * The id is always echoed back via the X-Request-ID response header and its
 * origin (`client` | `gateway`) is recorded for observability.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const fromClient = normalizeClientRequestId(req.header('x-request-id'));
  const source = fromClient !== undefined ? ('client' as const) : ('gateway' as const);

  req.requestId = fromClient ?? randomUUID();
  req.requestIdSource = source;
  res.setHeader('X-Request-ID', req.requestId);

  next();
}
