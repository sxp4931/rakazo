import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter } from "./rate-limit.js";

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

describe("clientKey", () => {
  it("prefers the remote socket address", async () => {
    const app = new Hono();
    app.get("/x", (c) => c.json({ key: clientKey(c) }));
    const res = await app.request("/x", {}, { remote: { address: "203.0.113.7" } } as never);
    expect(await res.json()).toEqual({ key: "203.0.113.7" });
  });

  it("falls back to the first forwarded address, then unknown", async () => {
    const app = new Hono();
    app.get("/x", (c) => c.json({ key: clientKey(c) }));
    const forwardedRes = await app.request("/x", {
      headers: { "x-forwarded-for": "198.51.100.2, 203.0.113.9" },
    });
    expect(await forwardedRes.json()).toEqual({ key: "198.51.100.2" });
    const unknownRes = await app.request("/x");
    expect(await unknownRes.json()).toEqual({ key: "unknown" });
  });
});

describe("rate limiter middleware", () => {
  it("returns 429 with Retry-After past the limit", async () => {
    const clock = 0;
    const limiter = createRateLimiter({ windowMs: 30_000, max: 2 }, "test", () => clock);
    const app = new Hono();
    app.use(limiter.middleware);
    app.get("/x", (c) => c.json({ ok: true }));

    expect((await app.request("/x")).status).toBe(200);
    expect((await app.request("/x")).status).toBe(200);
    const blocked = await app.request("/x");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("30");
    expect(await blocked.json()).toEqual({ error: "too many requests" });
  });
});
