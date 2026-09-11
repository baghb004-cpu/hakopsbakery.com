/**
 * A fixed window rate limiter.
 *
 * It lives in one process, which means it is a speed bump rather than a
 * defence: a distributed flood across many function instances walks past it.
 * That is an accepted limit, because the thing it is actually protecting
 * against here is one script hammering the mailing list form or the ZIP
 * checker from one address, and for that a per instance counter is enough.
 *
 * Netlify's own edge rate limiting is the right answer for the rest, and
 * Supabase can hold a shared counter once it exists. Neither changes this
 * interface.
 */

export interface RateLimitRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  /** Seconds until the window resets. Goes into the Retry-After header. */
  readonly retryAfterSeconds: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export interface RateLimiter {
  check(key: string, rule: RateLimitRule, now?: number): RateLimitResult;
  reset(): void;
}

export function createRateLimiter(): RateLimiter {
  const windows = new Map<string, Window>();

  return {
    check(key, rule, now = Date.now()) {
      /*
        Sweeping on write keeps the map from growing without bound in a warm
        container. The cost is paid by whoever is making the requests, which
        is the right person to pay it.
      */
      if (windows.size > 5_000) {
        for (const [existing, window] of windows) {
          if (window.resetAt <= now) windows.delete(existing);
        }
      }

      const window = windows.get(key);
      if (window === undefined || window.resetAt <= now) {
        windows.set(key, { count: 1, resetAt: now + rule.windowMs });
        return { allowed: true, remaining: rule.limit - 1, retryAfterSeconds: 0 };
      }

      window.count += 1;
      if (window.count > rule.limit) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)),
        };
      }
      return {
        allowed: true,
        remaining: rule.limit - window.count,
        retryAfterSeconds: 0,
      };
    },

    reset() {
      windows.clear();
    },
  };
}

/** Shared by every function in a warm container. */
let processLimiter: RateLimiter | null = null;

export function defaultRateLimiter(): RateLimiter {
  processLimiter ??= createRateLimiter();
  return processLimiter;
}
