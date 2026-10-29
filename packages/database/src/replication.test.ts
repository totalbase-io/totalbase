import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "./database.js";
import { loadDatabaseConfigFromEnv } from "./config.js";
import type { ReplicatedTransaction } from "./replication.js";
import type { Subscription } from "./listener.js";

const SCHEMA = `replication_test_${process.pid}`;
const PUBLICATION = `replication_test_${process.pid}`;

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("Database.replicate (integration)", () => {
  let database: Database;
  let subscription: Subscription;
  let maxKeys = 100;
  const received: ReplicatedTransaction[] = [];
  const oid: Record<string, number> = {};

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await database.query(`CREATE SCHEMA "${SCHEMA}"`);
    await database.query(`CREATE TABLE "${SCHEMA}".items (id int PRIMARY KEY, name text)`);
    await database.query(`CREATE TABLE "${SCHEMA}".events (id int, at date, PRIMARY KEY (id, at)) PARTITION BY RANGE (at)`);
    await database.query(`CREATE TABLE "${SCHEMA}".events_2026 PARTITION OF "${SCHEMA}".events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01')`);
    await database.query(`CREATE TABLE "${SCHEMA}".tags (id text PRIMARY KEY)`);
    await database.query(`CREATE TABLE "${SCHEMA}".unpublished (id int PRIMARY KEY)`);
    await database.query(
      `CREATE PUBLICATION "${PUBLICATION}" FOR TABLE "${SCHEMA}".items, "${SCHEMA}".events, "${SCHEMA}".tags WITH (publish_via_partition_root = true)`,
    );
    for (const table of ["items", "events", "tags"]) {
      const { rows } = await database.query<{ oid: number }>(`SELECT $1::regclass::oid AS oid`, [`"${SCHEMA}".${table}`]);
      oid[table] = Number(rows[0]!.oid);
    }
    subscription = await database.replicate(
      { publication: PUBLICATION, maxKeys: () => maxKeys },
      { onTransaction: (transaction) => received.push(transaction), onReconnect: () => undefined },
    );
  });

  afterAll(async () => {
    await subscription?.close();
    await database.query(`DROP PUBLICATION IF EXISTS "${PUBLICATION}"`);
    await database.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await database.close();
  });

  /** Runs `sql` and waits for the transaction that touches `table`. */
  async function next(table: string, sql: string[]): Promise<ReplicatedTransaction> {
    const from = received.length;
    await database.transaction(async (client) => {
      for (const statement of sql) await client.query(statement);
    });
    await until(() => received.slice(from).some((transaction) => transaction.has(oid[table]!)));
    return received.slice(from).find((transaction) => transaction.has(oid[table]!))!;
  }

  it("decodes one committed transaction's inserts, updates and deletes by key, per table", async () => {
    const transaction = await next("items", [
      `INSERT INTO "${SCHEMA}".items VALUES (1, 'a'), (2, 'b'), (3, 'c')`,
      `UPDATE "${SCHEMA}".items SET name = 'B' WHERE id = 2`,
      `DELETE FROM "${SCHEMA}".items WHERE id = 3`,
      `INSERT INTO "${SCHEMA}".tags VALUES ('x''y')`,
    ]);
    expect(transaction.get(oid.items!)).toEqual({
      insert: { keys: ["1", "2", "3"], overflow: false },
      update: { keys: ["2"], overflow: false },
      delete: { keys: ["3"], overflow: false },
      truncate: false,
    });
    expect(transaction.get(oid.tags!)!.insert.keys).toEqual(["x'y"]);
  });

  it("never delivers a rolled-back write, nor a table outside the publication", async () => {
    const from = received.length;
    await database
      .transaction(async (client) => {
        await client.query(`INSERT INTO "${SCHEMA}".items VALUES (50, 'rolled back')`);
        throw new Error("abort");
      })
      .catch(() => undefined);
    await database.query(`INSERT INTO "${SCHEMA}".unpublished VALUES (1)`);
    await next("items", [`INSERT INTO "${SCHEMA}".items VALUES (51, 'committed')`]);
    const keys = received.slice(from).flatMap((transaction) => transaction.get(oid.items!)?.insert.keys ?? []);
    expect(keys).toEqual(["51"]);
  });

  it("an update that changes the key is a delete of the old key and an update of the new", async () => {
    const transaction = await next("items", [`UPDATE "${SCHEMA}".items SET id = 10 WHERE id = 1`]);
    expect(transaction.get(oid.items!)!.delete.keys).toEqual(["1"]);
    expect(transaction.get(oid.items!)!.update.keys).toEqual(["10"]);
  });

  it("past maxKeys, keeps no key - only the overflow", async () => {
    maxKeys = 2;
    try {
      const transaction = await next("items", [`INSERT INTO "${SCHEMA}".items SELECT g, 'bulk' FROM generate_series(100, 104) g`]);
      expect(transaction.get(oid.items!)!.insert).toEqual({ keys: [], overflow: true });
    } finally {
      maxKeys = 100;
    }
  });

  it("a partition's change arrives under its partitioned table; a composite key is an overflow", async () => {
    const transaction = await next("events", [`INSERT INTO "${SCHEMA}".events VALUES (1, '2026-05-01')`]);
    expect(transaction.get(oid.events!)!.insert).toEqual({ keys: [], overflow: true });
  });

  it("reports a truncate", async () => {
    const transaction = await next("items", [`TRUNCATE "${SCHEMA}".items`]);
    expect(transaction.get(oid.items!)!.truncate).toBe(true);
  });

  it("acknowledges what it decoded: its temporary slot holds no WAL back", async () => {
    await next("items", [`INSERT INTO "${SCHEMA}".items VALUES (200, 'last')`]);
    // The acknowledgment travels after the transaction's delivery.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const { rows } = await database.query<{ temporary: boolean; behind: string }>(
      `SELECT temporary, pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)::text AS behind
       FROM pg_replication_slots WHERE slot_name LIKE $1`,
      [`totalbase_realtime_${process.pid}_%`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.temporary).toBe(true);
    // Only WAL written after the last acknowledgment (other sessions' writes, this query's own) - never ours.
    expect(Number(rows[0]!.behind)).toBeLessThan(1_000_000);
  });

  it("drops its slot with the connection", async () => {
    await subscription.close();
    // The backend drops it as it exits, a moment after the socket closed.
    let remaining = 1;
    const poll = async () => {
      const started = Date.now();
      while (Date.now() - started < 5_000) {
        const { rows } = await database.query(`SELECT 1 FROM pg_replication_slots WHERE slot_name LIKE $1`, [`totalbase_realtime_${process.pid}_%`]);
        remaining = rows.length;
        if (remaining === 0) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await poll();
    expect(remaining).toBe(0);
  });
});

describe("Database.replicate while a transaction is open (integration)", () => {
  it("gives up creating its slot after slotTimeoutMs instead of waiting for the transaction to end", async () => {
    const database = new Database(loadDatabaseConfigFromEnv());
    let release!: () => void;
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    // A transaction with an xid, open in another session: creating a slot waits for it.
    const open = database.transaction(async (client) => {
      await client.query("SELECT pg_catalog.txid_current()");
      holding();
      await new Promise<void>((resolve) => (release = resolve));
    });
    try {
      await held;
      const started = Date.now();
      await expect(
        database.replicate({ publication: PUBLICATION, maxKeys: () => 1, slotTimeoutMs: 300 }, { onTransaction: () => undefined, onReconnect: () => undefined }),
      ).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(5_000);
      // PostgreSQL ended the wait itself: no walsender of ours is left waiting on the transaction, no slot made.
      const waiting = async () =>
        (await database.query(`SELECT 1 FROM pg_stat_activity WHERE application_name = 'totalbase realtime' AND wait_event_type = 'Lock'`)).rows.length;
      for (let tries = 0; tries < 50 && (await waiting()) > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await waiting()).toBe(0);
    } finally {
      release();
      await open;
      await database.close();
    }
  });
});
