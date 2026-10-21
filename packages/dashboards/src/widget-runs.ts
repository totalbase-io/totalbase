/**
 * How published widgets run under load (Dashboards.md §2.9, D24): their results reused for a while
 * (a cache behind an interface - in memory for now, per instance), identical requests at the same time waiting for one
 * execution, and at most N queries of one dashboard at once.
 */

/** Where widget results are kept between requests - an interface, so another store can take the memory's place. */
export interface WidgetResultCache<T> {
  get(key: string): T | undefined;
  set(key: string, value: T, ttlMs: number): void;
}

/**
 * The cache in this server's memory: each entry until it expires, the oldest dropped past `maxEntries` or past
 * `maxBytes` - a thousand wide results would otherwise be a thousand times a query's whole page in memory. An
 * entry's size is its JSON length at insert (an approximation of what it holds, cheap and good enough for a cap).
 */
export class MemoryWidgetResultCache<T> implements WidgetResultCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number; bytes: number }>();
  private bytes = 0;

  constructor(private readonly maxEntries = 1_000, private readonly maxBytes = 64 * 1024 * 1024) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= Date.now()) {
      this.remove(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    const bytes = JSON.stringify(value)?.length ?? 0;
    this.remove(key);
    // A result larger than the whole cache is never kept - it would only evict everything else for nothing.
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, expires: Date.now() + ttlMs, bytes });
    this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value!);
  }

  /** What the cache holds now - for tests and diagnostics. */
  get size(): { entries: number; bytes: number } {
    return { entries: this.entries.size, bytes: this.bytes };
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }
}

/** Identical requests at the same time share one run: the first runs, the rest wait for its result (or its error). */
export class SingleFlight<T> {
  private readonly running = new Map<string, Promise<T>>();

  run(key: string, work: () => Promise<T>): Promise<T> {
    const current = this.running.get(key);
    if (current) return current;
    const started = work().finally(() => this.running.delete(key));
    this.running.set(key, started);
    return started;
  }
}

/** At most `limit` runs at once per key (a dashboard) - the rest wait their turn, in order. */
export class KeyedSemaphore {
  private readonly active = new Map<string, number>();
  private readonly waiting = new Map<string, (() => void)[]>();

  async run<T>(key: string, limit: number, work: () => Promise<T>): Promise<T> {
    if ((this.active.get(key) ?? 0) >= limit) {
      await new Promise<void>((resolve) => {
        const queue = this.waiting.get(key) ?? [];
        queue.push(resolve);
        this.waiting.set(key, queue);
      });
    }
    this.active.set(key, (this.active.get(key) ?? 0) + 1);
    try {
      return await work();
    } finally {
      const left = (this.active.get(key) ?? 1) - 1;
      if (left === 0) this.active.delete(key);
      else this.active.set(key, left);
      const next = this.waiting.get(key)?.shift();
      if (this.waiting.get(key)?.length === 0) this.waiting.delete(key);
      next?.();
    }
  }
}

/** A request's identity for the cache: what it ran with, in a stable order. */
export function cacheKey(parts: Record<string, unknown>): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value as object).sort().map((k) => [k, stable((value as Record<string, unknown>)[k])]));
    return value;
  };
  return JSON.stringify(stable(parts));
}
