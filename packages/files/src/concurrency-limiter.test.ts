import { describe, expect, it } from "vitest";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";

describe("ConcurrencyLimiter", () => {
  it("runs at most `max` at once, and the rest wait their turn instead of failing", async () => {
    const limiter = new ConcurrencyLimiter();
    let running = 0;
    let peak = 0;
    const task = async (n: number) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 10));
      running--;
      return n;
    };
    const results = await Promise.all(Array.from({ length: 14 }, (_, n) => limiter.run(4, () => task(n), 5_000)));
    expect(results).toEqual(Array.from({ length: 14 }, (_, n) => n));
    expect(peak).toBe(4);
  });

  it("gives up with TRANSFORM_TIMEOUT when no turn comes within the wait", async () => {
    const limiter = new ConcurrencyLimiter();
    const slow = limiter.run(1, () => new Promise((resolve) => setTimeout(resolve, 100)), 1_000);
    await expect(limiter.run(1, async () => "late", 10)).rejects.toMatchObject({ code: "TRANSFORM_TIMEOUT" });
    await slow;
    // The one that gave up never takes a slot.
    await expect(limiter.run(1, async () => "next", 10)).resolves.toBe("next");
  });
});
