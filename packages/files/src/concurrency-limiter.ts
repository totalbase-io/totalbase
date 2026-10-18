import { TotalBaseError } from "@totalbase/errors";

/**
 * In-memory semaphore bounding concurrent image transformations
 * (files.transforms.max_concurrent), ported from @totalbase/assets.
 * Single-process scope only - a multi-instance deployment needs a shared
 * coordination mechanism, out of scope for v1.
 *
 * Past the limit a request waits its turn, in order, rather than failing: a
 * page showing a dozen photos asks for them all at once (an org chart, a
 * card grid), and each should get its derivative a moment later, not an
 * error. A request that can't start within `waitMs` is TRANSFORM_TIMEOUT.
 */
export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  /**
   * `max` is read fresh on every call rather than fixed at construction -
   * the shared `active` counter is what actually enforces the limit
   * across calls, so this stays consistent with every other files.*
   * setting being read live rather than cached at composition-root time.
   */
  async run<T>(max: number, fn: () => Promise<T>, waitMs: number): Promise<T> {
    if (this.active >= max) await this.wait(waitMs);
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private wait(waitMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const turn = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(turn);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new TotalBaseError("TRANSFORM_TIMEOUT", "Too many image transformations in progress; try again shortly."));
      }, waitMs);
      this.waiting.push(turn);
    });
  }
}
