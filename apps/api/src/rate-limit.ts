export interface RateLimitRule {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
  remaining: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

const MAX_TRACKED_KEYS = 50_000;

export function createRateLimiter(
  rule: RateLimitRule,
  prefix: string,
  now: () => number = Date.now,
): {
  check: (key: string) => RateLimitResult;
  reset: () => void;
} {
  const buckets = new Map<string, Bucket>();

  function check(key: string): RateLimitResult {
    const timestamp = now();
    const scopedKey = `${prefix}:${key}`;
    const bucket = buckets.get(scopedKey);
    if (!bucket || bucket.resetAt <= timestamp) {
      buckets.set(scopedKey, { count: 1, resetAt: timestamp + rule.windowMs });
      if (buckets.size > MAX_TRACKED_KEYS) sweep(timestamp);
      return { allowed: true, retryAfterSec: 0, remaining: rule.max - 1 };
    }
    if (bucket.count >= rule.max) {
      return {
        allowed: false,
        retryAfterSec: Math.ceil((bucket.resetAt - timestamp) / 1000),
        remaining: 0,
      };
    }
    bucket.count += 1;
    return { allowed: true, retryAfterSec: 0, remaining: rule.max - bucket.count };
  }

  function sweep(timestamp: number) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }

  return {
    check,
    reset: () => buckets.clear(),
  };
}
