import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { loadDatabaseConfigFromEnv } from "./config.js";
import { notify } from "./listener.js";

const CHANNEL = `listener_test_${process.pid}`;

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Database.listen (integration)", () => {
  let database: Database;

  beforeAll(() => {
    database = new Database(loadDatabaseConfigFromEnv());
  });

  afterAll(async () => {
    await database.close();
  });

  it("delivers a notification sent in a transaction at COMMIT, and never one rolled back", async () => {
    const received: string[] = [];
    const subscription = await database.listen(CHANNEL, { onNotification: (payload) => received.push(payload), onReconnect: () => undefined });
    try {
      await database
        .transaction(async (client) => {
          await notify(client, CHANNEL, "rolled-back");
          throw new Error("abort");
        })
        .catch(() => undefined);
      await database.transaction(async (client) => {
        await notify(client, CHANNEL, "committed");
        // Not yet: PostgreSQL holds it until COMMIT.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toEqual([]);
      });
      await until(() => received.length > 0);
      expect(received).toEqual(["committed"]);
    } finally {
      await subscription.close();
    }
  });

  it("reconnects after its connection is terminated, reports it, and listens again", async () => {
    const received: string[] = [];
    let reconnects = 0;
    const subscription = await database.listen(CHANNEL, { onNotification: (payload) => received.push(payload), onReconnect: () => (reconnects += 1) });
    try {
      // The listening session, found by what it waits on; terminated as an administrator would.
      const { rows } = await database.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity WHERE query = $1 AND pid <> pg_backend_pid()`,
        [`LISTEN "${CHANNEL}"`],
      );
      expect(rows.length).toBe(1);
      await database.query(`SELECT pg_terminate_backend($1)`, [rows[0]!.pid]);
      await until(() => reconnects === 1);
      await notify(database, CHANNEL, "after");
      await until(() => received.includes("after"));
    } finally {
      await subscription.close();
    }
  });
});
