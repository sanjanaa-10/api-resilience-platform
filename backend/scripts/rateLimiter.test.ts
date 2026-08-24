/**
 * Token bucket rate limiter unit tests — Node built-in test runner.
 * Run: npm test
 *
 * Exercises the PUBLIC middleware surface with mock req/res objects.
 * Refill/cleanup timing is tested by aging stored state directly (the same
 * elapsed-time math production uses), never by sleeping.
 */
import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';
import {
  TokenBucketRateLimiter,
  createTokenBucketRateLimiter,
} from '../src/services/rateLimiter.service';
import type { Request, Response } from 'express';

interface MockRes {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  setHeader(name: string, value: string): void;
  status(code: number): MockRes;
  json(payload: unknown): void;
}

function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: undefined,
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value;
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(payload) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

function makeReq(opts: { clientId?: string; ip?: string }): Request {
  return {
    header: (name: string): string | undefined =>
      name.toLowerCase() === 'x-client-id' ? opts.clientId : undefined,
    ip: opts.ip ?? '10.0.0.1',
    requestId: 'test-req-id',
    path: '/api/test',
  } as unknown as Request;
}

const limiters: TokenBucketRateLimiter[] = [];
function freshLimiter(capacity: number, refillRate: number): TokenBucketRateLimiter {
  const limiter = new TokenBucketRateLimiter(capacity, refillRate, 60_000);
  limiters.push(limiter);
  return limiter;
}
afterEach(() => {
  for (const limiter of limiters) limiter.stop();
  limiters.length = 0;
});

describe('token bucket middleware', () => {
  it('A. requests under the limit succeed and call next()', () => {
    const limiter = freshLimiter(5, 1);
    let nextCalled = 0;
    for (let i = 0; i < 5; i++) {
      const next = (): void => {
        nextCalled += 1;
      };
      limiter.middleware(makeReq({ clientId: 'a' }), makeRes() as unknown as Response, next);
    }
    assert.equal(nextCalled, 5);
  });

  it('B. burst above capacity: some pass, the rest get 429 RATE_LIMIT_EXCEEDED', () => {
    const limiter = freshLimiter(3, 1);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = makeRes();
      limiter.middleware(
        makeReq({ clientId: 'burst' }),
        res as unknown as Response,
        () => {},
      );
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses.slice(0, 3), [200, 200, 200]);
    assert.deepEqual(statuses.slice(3), [429, 429, 429]);
  });

  it('C. refill: tokens return after elapsed time (fractional math, no timers)', () => {
    const limiter = freshLimiter(2, 2); // 2 tokens/s
    for (let i = 0; i < 2; i++) {
      limiter.middleware(makeReq({ clientId: 'c' }), makeRes() as unknown as Response, () => {});
    }
    // Age the refill clock by 1s -> ~2 tokens should be available again
    const state = (
      limiter as unknown as { buckets: Map<string, { tokens: number; lastRefillAt: number }> }
    ).buckets.get('c');
    assert.ok(state);
    state.lastRefillAt -= 1;

    const res = makeRes();
    limiter.middleware(makeReq({ clientId: 'c' }), res as unknown as Response, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(state.tokens > 0 && state.tokens <= 2, true); // fractional remainder kept
  });

  it('D. different clients have fully independent buckets', () => {
    const limiter = freshLimiter(1, 1);
    const exhausted = makeRes();
    limiter.middleware(
      makeReq({ clientId: 'client-a' }),
      exhausted as unknown as Response,
      () => {},
    );
    const blocked = makeRes();
    limiter.middleware(
      makeReq({ clientId: 'client-a' }),
      blocked as unknown as Response,
      () => {},
    );
    assert.equal(blocked.statusCode, 429);

    const other = makeRes();
    limiter.middleware(
      makeReq({ clientId: 'client-b' }),
      other as unknown as Response,
      () => {},
    );
    assert.equal(other.statusCode, 200);
  });

  it('falls back to request IP when X-Client-ID is absent', () => {
    const limiter = freshLimiter(1, 1);
    limiter.middleware(makeReq({ ip: '203.0.113.9' }), makeRes() as unknown as Response, () => {});
    const buckets = (
      limiter as unknown as { buckets: Map<string, unknown> }
    ).buckets;
    assert.equal(buckets.has('203.0.113.9'), true);
  });
});

describe('rate limit response headers', () => {
  it('G. allowed responses carry RateLimit-Limit / Remaining / Reset', () => {
    const limiter = freshLimiter(7, 3);
    const res = makeRes();
    limiter.middleware(makeReq({ clientId: 'h' }), res as unknown as Response, () => {});
    assert.equal(res.headers['ratelimit-limit'], '7');
    assert.equal(Number(res.headers['ratelimit-remaining']), 6);
    assert.match(res.headers['ratelimit-reset'] ?? '', /^\d+$/);
  });

  it('G. rejected responses additionally carry Retry-After + error envelope', () => {
    const limiter = freshLimiter(1, 1);
    limiter.middleware(makeReq({ clientId: 'r' }), makeRes() as unknown as Response, () => {});
    const res = makeRes();
    limiter.middleware(makeReq({ clientId: 'r' }), res as unknown as Response, () => {});
    assert.equal(res.statusCode, 429);
    assert.equal(Number(res.headers['retry-after']), 1);
    assert.equal(
      (res.body as { error: { code: string } }).error.code,
      'RATE_LIMIT_EXCEEDED',
    );
    assert.equal(
      (res.body as { error: { requestId: string } }).error.requestId,
      'test-req-id',
    );
  });
});

describe('cleanup of inactive buckets', () => {
  it('F. aged-out client buckets disappear on sweep', () => {
    const limiter = freshLimiter(5, 1);
    limiter.middleware(makeReq({ clientId: 'ghost' }), makeRes() as unknown as Response, () => {});
    const buckets = (
      limiter as unknown as { buckets: Map<string, { lastRefillAt: number }> }
    ).buckets;
    assert.equal(buckets.size, 1);

    const state = buckets.get('ghost');
    assert.ok(state);
    state.lastRefillAt -= 400_000; // inactive for > expiry age

    limiter.runCleanup();
    assert.equal(buckets.size, 0);

    // A returning client simply starts from a full fresh bucket.
    const res = makeRes();
    limiter.middleware(makeReq({ clientId: 'ghost' }), res as unknown as Response, () => {});
    assert.equal(res.statusCode, 200);
  });
});

describe('createTokenBucketRateLimiter factory', () => {
  it('builds a limiter honoring env configuration', () => {
    const prevCapacity = process.env.RATE_LIMIT_CAPACITY;
    process.env.RATE_LIMIT_CAPACITY = '11';
    try {
      const limiter = createTokenBucketRateLimiter();
      limiters.push(limiter);
      const internals = limiter as unknown as { capacity: number };
      assert.equal(internals.capacity, 11);
    } finally {
      if (prevCapacity === undefined) delete process.env.RATE_LIMIT_CAPACITY;
      else process.env.RATE_LIMIT_CAPACITY = prevCapacity;
    }
  });
});
