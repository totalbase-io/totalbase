import { Database, loadDatabaseConfigFromEnv, type Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * `totalbase.instance` is a singleton whose `id` is the installation's
 * stable identifier (Specification.md §10.1): its id is
 * immutable (trigger `instance_protect_id_trg`) and the row can't be
 * deleted (rule `instance_no_delete`), so a stray statement can't
 * change or erase the instance's identity. Each check runs in a transaction
 * that is rolled back - it never leaves a row behind, and a database without
 * one yet gets its own for the check.
 */
describe("instance protection (integration)", () => {
  let database: Database;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
  });

  afterAll(async () => {
    await database.close();
  });

  /** Thrown to roll the check back; a TotalBaseError, which `Database.transaction` rethrows as is. */
  class Rollback extends TotalBaseError {
    constructor() {
      super("INTERNAL_ERROR", "rollback the check");
    }
  }

  /** Runs `fn` against the instance row (the existing one, or one inserted for the check) and rolls everything back. */
  async function withInstance(fn: (client: Queryable, instanceId: string) => Promise<void>): Promise<void> {
    await database
      .transaction(async (client) => {
        const existing = await client.query<{ id: string }>(`SELECT id FROM totalbase.instance`);
        const instanceId = existing.rows[0]?.id ?? (await client.query<{ id: string }>(`INSERT INTO totalbase.instance DEFAULT VALUES RETURNING id`)).rows[0]!.id;
        await fn(client, instanceId);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  }

  const ids = async (client: Queryable) => (await client.query<{ id: string }>(`SELECT id FROM totalbase.instance`)).rows.map((row) => row.id);

  it("lets anything but the id change", async () => {
    await withInstance(async (client, instanceId) => {
      const { rowCount } = await client.query(`UPDATE totalbase.instance SET updated_at = now() WHERE id = $1`, [instanceId]);
      expect(rowCount).toBe(1);
    });
  });

  it("refuses changing the id", async () => {
    await withInstance(async (client, instanceId) => {
      await client.query(`SAVEPOINT attempt`);
      await expect(client.query(`UPDATE totalbase.instance SET id = gen_random_uuid() WHERE id = $1`, [instanceId])).rejects.toThrow(/instance\.id is immutable/);
      await client.query(`ROLLBACK TO SAVEPOINT attempt`);
      expect(await ids(client)).toEqual([instanceId]);
    });
  });

  it("ignores a DELETE - the row outlives the statement", async () => {
    await withInstance(async (client, instanceId) => {
      const { rowCount } = await client.query(`DELETE FROM totalbase.instance WHERE id = $1`, [instanceId]);
      expect(rowCount).toBe(0);
      expect(await ids(client)).toEqual([instanceId]);
    });
  });
});
