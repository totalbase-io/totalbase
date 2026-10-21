import { describe, expect, it, vi } from "vitest";
import { cacheKey, KeyedSemaphore, MemoryWidgetResultCache, SingleFlight } from "./widget-runs.js";

/** How published widgets run under load (Dashboards.md §2.9, D24). */
describe("widget runs (D24)", () => {
  it("keeps a result until it expires, and drops the oldest past its size", () => {
    vi.useFakeTimers();
    const cache = new MemoryWidgetResultCache<number>(2);
    cache.set("a", 1, 1_000);
    expect(cache.get("a")).toBe(1);
    vi.advanceTimersByTime(1_001);
    expect(cache.get("a")).toBeUndefined();
    cache.set("a", 1, 1_000);
    cache.set("b", 2, 1_000);
    cache.set("c", 3, 1_000);
    expect([cache.get("a"), cache.get("b"), cache.get("c")]).toEqual([undefined, 2, 3]);
    cache.set("d", 4, 0);
    expect(cache.get("d")).toBeUndefined();
    vi.useRealTimers();
  });

  it("shares one run among identical requests at the same time - its error too", async () => {
    const flight = new SingleFlight<number>();
    let runs = 0;
    const work = () => new Promise<number>((resolve) => setTimeout(() => resolve(++runs), 10));
    expect(await Promise.all([flight.run("k", work), flight.run("k", work), flight.run("k", work)])).toEqual([1, 1, 1]);
    expect(await flight.run("k", work)).toBe(2);
    const failing = () => Promise.reject(new Error("boom"));
    await expect(Promise.all([flight.run("e", failing), flight.run("e", failing)])).rejects.toThrow("boom");
  });

  it("runs at most N of one dashboard at once, the rest in order; another dashboard isn't held", async () => {
    const gate = new KeyedSemaphore();
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const work = (n: number) => async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(n);
      active -= 1;
      return n;
    };
    const other = gate.run("other", 1, async () => "free");
    const all = await Promise.all(Array.from({ length: 10 }, (_, n) => gate.run("d", 4, work(n))));
    expect(all).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(4);
    expect(order.slice(4)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(await other).toBe("free");
    await expect(gate.run("d", 1, () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await gate.run("d", 1, async () => "after")).toBe("after");
  });

  it("keys a request by what it ran with, whatever the order", () => {
    expect(cacheKey({ a: 1, values: { x: [1, 2], y: "b" } })).toBe(cacheKey({ values: { y: "b", x: [1, 2] }, a: 1 }));
    expect(cacheKey({ values: { x: [1, 2] } })).not.toBe(cacheKey({ values: { x: [2, 1] } }));
  });
});
