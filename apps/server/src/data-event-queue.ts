/**
 * Runs outbox data-event dispatches at most `concurrency` at a time, in
 * arrival order, each id once while it is queued or running. A bulk write
 * commits hundreds of events at once; dispatching them all in parallel took
 * every pooled connection and stalled the API's own requests behind them.
 * The outbox itself is the durable queue - an event dropped here (process
 * exit) is picked up by the fallback poll.
 */
export function createDataEventQueue(dispatch: (outboxEventId: string) => Promise<void>, concurrency: number) {
  const waiting: string[] = [];
  const known = new Set<string>();
  let running = 0;

  const pump = () => {
    while (running < concurrency && waiting.length > 0) {
      const id = waiting.shift()!;
      running += 1;
      dispatch(id)
        .catch(() => undefined)
        .finally(() => {
          running -= 1;
          known.delete(id);
          pump();
        });
    }
  };

  return {
    enqueue(outboxEventId: string): void {
      if (known.has(outboxEventId)) return;
      known.add(outboxEventId);
      waiting.push(outboxEventId);
      pump();
    },
    /** Queued plus running - for tests and diagnostics. */
    get size(): number {
      return known.size;
    },
  };
}
