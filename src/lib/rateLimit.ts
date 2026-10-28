/**
 * Rate limiter behind an interface.
 *
 * v1 ships an in-memory implementation. A Redis-backed one can be dropped in
 * later by implementing the same `RateLimiter` interface and swapping the
 * factory — no call sites change (this is the same seam pattern as LLMProvider
 * and ProductSource, kept intentionally small).
 */

export interface RateLimitResult {
  allowed: boolean;
  /** Requests still available in the current window. */
  remaining: number;
  /** Seconds until the current window resets. */
  resetSeconds: number;
}

export interface RateLimiter {
  /**
   * Record a hit for `key`. Returns whether the request is allowed under the
   * given limit within the window.
   */
  hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult>;
  /** Clear a key (e.g. after a successful login resets lockout counters). */
  reset(key: string): Promise<void>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/** In-memory, per-process rate limiter. Good enough for a single instance. */
export class InMemoryRateLimiter implements RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    const now = Date.now();
    this.maybeSweep(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      const fresh: Bucket = { count: 1, resetAt: now + windowMs };
      this.buckets.set(key, fresh);
      return {
        allowed: true,
        remaining: limit - 1,
        resetSeconds: Math.ceil(windowMs / 1000),
      };
    }

    bucket.count += 1;
    const allowed = bucket.count <= limit;
    return {
      allowed,
      remaining: Math.max(0, limit - bucket.count),
      resetSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  /** Drop expired buckets occasionally to avoid unbounded growth. */
  private maybeSweep(now: number): void {
    if (now - this.lastSweep < 60_000) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

let instance: RateLimiter | null = null;

/** Singleton accessor (swap implementation here when Redis arrives). */
export function getRateLimiter(): RateLimiter {
  if (!instance) instance = new InMemoryRateLimiter();
  return instance;
}

/** Test helper to inject/reset the limiter. */
export function setRateLimiter(limiter: RateLimiter | null): void {
  instance = limiter;
}
