import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  it("allows up to max requests then blocks with a retry hint", () => {
    const clock = 0;
    const limiter = createRateLimiter({ windowMs: 60_000, max: 3 }, "test", () => clock);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(true);
    const blocked = limiter.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(60);
  });

  it("refills after the window passes", () => {
    let clock = 0;
    const limiter = createRateLimiter({ windowMs: 10_000, max: 1 }, "test", () => clock);
    expect(limiter.check("k").allowed).toBe(true);
    expect(limiter.check("k").allowed).toBe(false);
    clock += 10_001;
    expect(limiter.check("k").allowed).toBe(true);
  });

  it("tracks keys independently", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 }, "test", () => 0);
    expect(limiter.check("a").allowed).toBe(true);
    expect(limiter.check("b").allowed).toBe(true);
    expect(limiter.check("a").allowed).toBe(false);
  });

  it("reset clears all buckets", () => {
    const limiter = createRateLimiter({ windowMs: 60_000, max: 1 }, "test", () => 0);
    expect(limiter.check("a").allowed).toBe(true);
    limiter.reset();
    expect(limiter.check("a").allowed).toBe(true);
  });
});
