import { describe, expect, it } from "vitest";
import { createDataEventQueue } from "./data-event-queue.js";

describe("createDataEventQueue", () => {
  it("runs at most `concurrency` dispatches at a time, in order, each id once while pending", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const releases: Array<() => void> = [];
    const queue = createDataEventQueue(async (id) => {
      active += 1;
      peak = Math.max(peak, active);
      order.push(id);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
    }, 2);

    for (const id of ["a", "b", "c", "a", "d"]) queue.enqueue(id);
    expect(queue.size).toBe(4); // the repeated "a" was dropped
    while (releases.length > 0 || queue.size > 0) {
      await Promise.resolve();
      releases.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(peak).toBe(2);
    expect(order).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps going after a dispatch rejects", async () => {
    const done: string[] = [];
    const queue = createDataEventQueue(async (id) => {
      if (id === "bad") throw new Error("boom");
      done.push(id);
    }, 1);
    queue.enqueue("bad");
    queue.enqueue("ok");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(done).toEqual(["ok"]);
    expect(queue.size).toBe(0);
  });
});
