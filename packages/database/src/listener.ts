import pg from "pg";
import type { DatabaseConfig } from "./config.js";
import { quoteIdentifier } from "./identifiers.js";
import type { Queryable } from "./database.js";

/** What a `LISTEN` on one channel calls back. */
export interface ListenHandlers {
  /** A notification's payload, as `pg_notify` sent it - delivered only after the sending transaction committed. */
  onNotification(payload: string): void;
  /**
   * The connection came back after a loss. Notifications sent while it was away are not replayed -
   * PostgreSQL keeps none for a session that isn't listening - so whatever they would have said is unknown.
   */
  onReconnect(): void;
  /** The connection was lost or a reconnect failed (it keeps retrying). */
  onError?(error: unknown): void;
}

/** A running `LISTEN`; `close()` ends it and its connection. */
export interface Subscription {
  close(): Promise<void>;
}

const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * `LISTEN` on its own connection, outside the pool: a session that listens has to stay open, and a pooled
 * connection is handed to whoever asks next. One per process and channel (Foundations.md §4.6). Lost, it
 * reconnects with a growing delay and reports `onReconnect` once it listens again.
 */
export async function listen(config: DatabaseConfig, channel: string, handlers: ListenHandlers): Promise<Subscription> {
  let client: pg.Client | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  const connect = async (): Promise<void> => {
    const next = new pg.Client({
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      keepAlive: true,
      connectionTimeoutMillis: config.poolConnectionTimeoutMs,
    });
    next.on("notification", (message) => {
      if (message.channel === channel) handlers.onNotification(message.payload ?? "");
    });
    next.on("error", (error) => {
      handlers.onError?.(error);
      lost(next);
    });
    next.on("end", () => lost(next));
    try {
      await next.connect();
      await next.query(`LISTEN ${quoteIdentifier(channel)}`);
    } catch (error) {
      next.removeAllListeners();
      await next.end().catch(() => undefined);
      throw error;
    }
    client = next;
  };

  const lost = (which: pg.Client) => {
    if (closed || client !== which) return;
    client = null;
    which.removeAllListeners();
    which.end().catch(() => undefined);
    scheduleReconnect();
  };

  const scheduleReconnect = () => {
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]!;
    attempt += 1;
    retryTimer = setTimeout(() => {
      connect().then(
        () => {
          attempt = 0;
          if (closed) void client?.end();
          else handlers.onReconnect();
        },
        (error: unknown) => {
          handlers.onError?.(error);
          if (!closed) scheduleReconnect();
        },
      );
    }, delay);
  };

  await connect();
  return {
    async close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      const current = client;
      client = null;
      if (current) {
        current.removeAllListeners();
        await current.end().catch(() => undefined);
      }
    },
  };
}

/**
 * `pg_notify(channel, payload)` on `client` - inside a transaction it is sent at COMMIT and never on
 * ROLLBACK, which is what makes it a safe invalidation signal (Foundations.md §4.6).
 */
export async function notify(client: Queryable, channel: string, payload: string): Promise<void> {
  await client.query(`SELECT pg_notify($1, $2)`, [channel, payload]);
}
