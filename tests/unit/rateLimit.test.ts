import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryRateLimiter, getRateLimiter, setRateLimiter } from "@/lib/rateLimit";

describe("InMemoryRateLimiter", () => {
  let limiter: InMemoryRateLimiter;

  beforeEach(() => {
    limiter = new InMemoryRateLimiter();
  });

  it("allows requests under the limit", async () => {
    const r1 = await limiter.hit("ip:1", 3, 1000);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);
  });

  it("blocks requests over the limit within the window", async () => {
    await limiter.hit("ip:1", 2, 1000);
    await limiter.hit("ip:1", 2, 1000);
    const r3 = await limiter.hit("ip:1", 2, 1000);
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("tracks keys independently", async () => {
    await limiter.hit("ip:1", 1, 1000);
    const other = await limiter.hit("ip:2", 1, 1000);
    expect(other.allowed).toBe(true);
  });

  it("resets a key so it is allowed again", async () => {
    await limiter.hit("ip:1", 1, 1000);
    const blocked = await limiter.hit("ip:1", 1, 1000);
    expect(blocked.allowed).toBe(false);

    await limiter.reset("ip:1");
    const afterReset = await limiter.hit("ip:1", 1, 1000);
    expect(afterReset.allowed).toBe(true);
  });

  it("allows requests again after the window expires", async () => {
    // Tiny window; wait past it.
    await limiter.hit("ip:1", 1, 10);
    const during = await limiter.hit("ip:1", 1, 10);
    expect(during.allowed).toBe(false);

    await new Promise((r) => setTimeout(r, 15));
    const after = await limiter.hit("ip:1", 1, 10);
    expect(after.allowed).toBe(true);
  });
});

describe("getRateLimiter singleton", () => {
  it("returns the same instance across calls", () => {
    setRateLimiter(null);
    expect(getRateLimiter()).toBe(getRateLimiter());
    setRateLimiter(null);
  });
});
