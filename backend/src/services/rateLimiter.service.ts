import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/**
 * Token bucket state for a single client.
 *
 * Invariants:
 *   0 <= tokens <= capacity
 *   tokens is decremented by 1 on each accepted request.
 *   tokens are refilled from elapsed time since lastRefillAt.
 */
interface BucketState {
  tokens: number;
  lastRefillAt: number; // unix timestamp in seconds (deterministic calc)
}

/** Payload delivered to the observability hook when a client is throttled. */
export interface RateLimitRejectionInfo {
  requestId: string | undefined;
  clientId: string;
  path: string;
  retryAfterSeconds: number;
  limit: number;
}

/**
 * Optional constructor hook so the composition root can mirror rejections
 * into the resilience event stream. Hook failures are swallowed: rate
 * limiting must never break because observability does.
 */
export type RateLimitRejectionListener = (info: RateLimitRejectionInfo) => void;

/**
 * Core token bucket rate limiter.
 *
 * Invariants:
 *   - capacity: max tokens the bucket can hold
 *   - refillRate: tokens added per second
 *   - buckets: clientId -> BucketState mapping (in-memory)
 *
 * Refill is deterministic and time-based: no per-client timers.
 * Tokens are calculated from elapsed time since last refill.
 */
export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillRate: number; // tokens per second
  private readonly cleanupIntervalMs: number;
  private readonly onRejected?: RateLimitRejectionListener;
  private buckets: Map<string, BucketState> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  /**
   * @param capacity       maximum tokens the bucket can hold
   * @param refillRate     tokens added per second
   * @param cleanupIntervalMs how often to purge inactive buckets (ms)
   * @param onRejected     optional observability hook (rejections only)
   */
  constructor(
    capacity: number,
    refillRate: number,
    cleanupIntervalMs = 60_000,
    onRejected?: RateLimitRejectionListener,
  ) {
    this.capacity = capacity;
    this.refillRate = refillRate;
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.onRejected = onRejected;

    // Kick off periodic cleanup so inactive buckets don't grow forever.
    // This runs once at startup and then every cleanupIntervalMs.
    this.scheduleCleanup();
  }

  /** Schedule periodic bucket cleanup. unref'd so tests/process exit cleanly. */
  private scheduleCleanup(): void {
    const run = () => this.cleanup();
    run(); // immediate first pass
    this.cleanupTimer = setInterval(run, this.cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  /** Stop the background sweeper (graceful shutdown / test teardown). */
  stop(): void {
    if (this.cleanupTimer !== null) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /** Manual sweep — same purge the interval runs; exposed for tests. */
  runCleanup(): void {
    this.cleanup();
  }

  /** Remove buckets that have had no activity for a long time. */
  private cleanup(): void {
    const now = Date.now();
    const expiryThreshold = 300_000; // 5 minutes of inactivity

    for (const [clientId, state] of this.buckets) {
      if (now - state.lastRefillAt > expiryThreshold) {
        this.buckets.delete(clientId);
      }
    }
  }

  /** Recalculate tokens based on elapsed time since last refill. */
  private refill(state: BucketState): number {
    const now = Date.now() / 1_000; // seconds
    const elapsedSeconds = now - state.lastRefillAt;
    const newTokens = elapsedSeconds * this.refillRate;
    return Math.min(this.capacity, state.tokens + newTokens);
  }

  /** Extract client identity from the request. */
  private getClientId(req: Request): string {
    // Priority 1: X-Client-ID header
    const clientIdFromHeader = req.header('x-client-id');
    if (clientIdFromHeader) {
      return clientIdFromHeader.trim();
    }

    // Priority 2: fallback to request IP
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    return ip;
  }

  /** Get or create the bucket state for a client. */
  private getBucket(clientId: string): BucketState {
    if (!this.buckets.has(clientId)) {
      this.buckets.set(clientId, {
        tokens: this.capacity,
        lastRefillAt: Date.now() / 1_000,
      });
    }
    return this.buckets.get(clientId)!;
  }

  /** Attempt to consume one token. Returns true if allowed. */
  private tryConsume(clientId: string): { allowed: boolean; state: BucketState } {
    const state = this.getBucket(clientId);
    const available = this.refill(state);

    if (available >= 1) {
      state.tokens = available - 1; // consume 1 token
      state.lastRefillAt = Date.now() / 1_000; // reset refill clock
      return { allowed: true, state };
    }

    // Not enough tokens — keep current state unchanged (lastRefillAt stays)
    return { allowed: false, state };
  }

  /** Express middleware. */
  middleware(
    req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    const clientId = this.getClientId(req);
    const { allowed, state } = this.tryConsume(clientId);

    const now = Date.now() / 1_000; // seconds
    const resetAt = Math.floor(state.lastRefillAt + this.capacity / this.refillRate);
    const remaining = Math.max(0, Math.floor(state.tokens));

    if (!allowed) {
      // Compute Retry-After: time until at least 1 token is available.
      // We need (1 - state.tokens) / refillRate seconds from lastRefillAt.
      const tokensNeeded = 1 - state.tokens;
      const retryAfter = Math.ceil(tokensNeeded / this.refillRate);

      logger.info('rate_limit_rejected', {
        requestId: req.requestId,
        clientId,
        allowed: false,
        remaining: 0,
        limit: this.capacity,
        path: req.path,
        timestamp: now,
        retryAfterSeconds: retryAfter,
      });

      if (this.onRejected !== undefined) {
        try {
          this.onRejected({
            requestId: req.requestId,
            clientId,
            path: req.path,
            retryAfterSeconds: retryAfter,
            limit: this.capacity,
          });
        } catch (error) {
          console.error(`[rateLimiter] rejection observer failed: ${(error as Error).message}`);
        }
      }

      res.status(429);
      res.setHeader('RateLimit-Limit', String(this.capacity));
      res.setHeader('RateLimit-Remaining', '0');
      res.setHeader('RateLimit-Reset', String(resetAt));
      res.setHeader('Retry-After', String(retryAfter));

      const errorBody = {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: 'Too many requests',
          requestId: req.requestId,
          retryAfterSeconds: retryAfter,
        },
      };
      res.json(errorBody);
      return;
    }

    // Allowed — set headers even when limit > 0
    logger.info('rate_limit_allowed', {
      requestId: req.requestId,
      clientId,
      allowed: true,
      remaining,
      limit: this.capacity,
      path: req.path,
      timestamp: now,
    });

    res.setHeader('RateLimit-Limit', String(this.capacity));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(resetAt));

    next();
  }
}

/**
 * Factory: create Express middleware from configuration.
 *
 * Environment variables (optional, with defaults):
 *   RATE_LIMIT_CAPACITY    = 20   (max tokens per bucket)
 *   RATE_LIMIT_REFILL_RATE = 10   (tokens per second)
 *   RATE_LIMIT_CLEANUP_INTERVAL_MS = 60000 (how often to purge inactive buckets, ms)
 */
export function createTokenBucketRateLimiter(
  options: { onRejected?: RateLimitRejectionListener } = {},
): TokenBucketRateLimiter {
  const capacity = Number(process.env.RATE_LIMIT_CAPACITY ?? 20);
  const refillRate = Number(process.env.RATE_LIMIT_REFILL_RATE ?? 10);
  const cleanupIntervalMs = Number(
    process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS ?? 60_000,
  );

  if (!Number.isInteger(capacity) || capacity < 1) {
    console.error(
      `[rateLimiter] Invalid RATE_LIMIT_CAPACITY "${process.env.RATE_LIMIT_CAPACITY}" — using default 20`,
    );
  }
  if (!Number.isInteger(refillRate) || refillRate < 0.1) {
    console.error(
      `[rateLimiter] Invalid RATE_LIMIT_REFILL_RATE "${process.env.RATE_LIMIT_REFILL_RATE}" — using default 10`,
    );
  }
  if (!Number.isInteger(cleanupIntervalMs) || cleanupIntervalMs < 1000) {
    console.error(
      `[rateLimiter] Invalid RATE_LIMIT_CLEANUP_INTERVAL_MS "${process.env.RATE_LIMIT_CLEANUP_INTERVAL_MS}" — using default 60000`,
    );
  }

  return new TokenBucketRateLimiter(
    capacity,
    refillRate,
    cleanupIntervalMs,
    options.onRejected,
  );
}