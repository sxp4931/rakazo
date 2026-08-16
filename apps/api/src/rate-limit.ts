import type { Context, MiddlewareHandler } from "hono";

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

export function clientKey(c: Context): string {
  const remote = (c.env as { remote?: { address?: string } } | undefined)?.remote?.address;
  if (remote) return remote;
  // Without the node adapter's socket info we are behind a reverse proxy and
  // must trust its X-Forwarded-For; a directly exposed API treats this as
  // spoofable, which only widens the key space an attacker needs to rotate.
  const forwarded = c.req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();
  return "unknown";
}

export function createRateLimiter(
  rule: RateLimitRule,
  prefix: string,
  now: () => number = Date.now,
): {
  middleware: MiddlewareHandler;
  check: (key: string) => RateLimitResult;
  reset: () => void;
} {
  const buckets = new Map<string, Bucket>();

  function check(key: string): RateLimitResult {
    const timestamp = now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= timestamp) {
      buckets.set(key, { count: 1, resetAt: timestamp + rule.windowMs });
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
    middleware: async (c, next) => {
      const result = check(`${prefix}:${clientKey(c)}`);
      if (!result.allowed) {
        c.header("Retry-After", String(result.retryAfterSec));
        return c.json({ error: "too many requests" }, 429);
      }
      await next();
    },
    check,
    reset: () => buckets.clear(),
  };
}
