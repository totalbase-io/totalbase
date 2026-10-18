import { describe, expect, it } from "vitest";
import { loadDatabaseConfigFromEnv } from "./config.js";
import { Database } from "./database.js";

describe("Database.reconfigurePool (integration)", () => {
  it("rebuilds the pool only when a pool setting changes, and keeps working", async () => {
    const database = new Database(loadDatabaseConfigFromEnv());
    try {
      const defaults = loadDatabaseConfigFromEnv();
      const same = {
        poolMax: defaults.poolMax,
        poolIdleTimeoutMs: defaults.poolIdleTimeoutMs,
        poolConnectionTimeoutMs: defaults.poolConnectionTimeoutMs,
        poolMaxLifetimeMs: defaults.poolMaxLifetimeMs,
      };
      expect(await database.reconfigurePool(same)).toBe(false);
      expect(await database.reconfigurePool({ ...same, poolMax: 3 })).toBe(true);
      // Several statements at once through the rebuilt, smaller pool.
      const results = await Promise.all(Array.from({ length: 6 }, (_, i) => database.query<{ n: number }>("SELECT $1::int AS n", [i])));
      expect(results.map((r) => r.rows[0]!.n)).toEqual([0, 1, 2, 3, 4, 5]);
    } finally {
      await database.close();
    }
  });
});
