import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeRequestHash, IdempotencyService } from "./idempotency-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("@totalbase/idempotency (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let idempotency: IdempotencyService;
  let principal: string;
  /** Every principal this file used - its rows are deleted in afterAll. */
  const principals: string[] = [];

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    idempotency = new IdempotencyService(database, settings);
  });

  beforeEach(() => {
    principal = randomUUID();
    principals.push(principal);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.idempotency_keys WHERE principal = ANY($1)`, [principals]);
    await database.close();
  });

  const scope = (key: string) => ({
    principalType: "USER" as const,
    principal,
    operationScope: "table:public.invoices:create",
    key,
  });

  it("executes the operation once and returns its response", async () => {
    let calls = 0;
    const response = await idempotency.run(scope("k1"), "POST", { amount: 100 }, async () => {
      calls++;
      return { status: 201, body: { id: "invoice-1" } };
    });
    expect(calls).toBe(1);
    expect(response).toEqual({ status: 201, body: { id: "invoice-1" } });
  });

  it("replays the recorded response on retry without re-executing", async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      return { status: 201, body: { id: "invoice-2" } };
    };
    await idempotency.run(scope("k2"), "POST", { amount: 200 }, fn);
    const replay = await idempotency.run(scope("k2"), "POST", { amount: 200 }, fn);
    expect(calls).toBe(1);
    expect(replay).toEqual({ status: 201, body: { id: "invoice-2" } });
  });

  it("rejects a reused key with a different request body", async () => {
    await idempotency.run(scope("k3"), "POST", { amount: 300 }, async () => ({ status: 201, body: {} }));
    await expect(
      idempotency.run(scope("k3"), "POST", { amount: 999 }, async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" } satisfies Partial<TotalBaseError>);
  });

  it("rejects a concurrent request with the same key still in progress", async () => {
    await database.query(
      `INSERT INTO totalbase.idempotency_keys
         (key, principal_type, principal, operation_scope, request_hash, expires_at)
       VALUES ('k4', 'USER', $1, 'table:public.invoices:create', $2, now() + interval '1 hour')`,
      [principal, computeRequestHash("POST", "table:public.invoices:create", { amount: 400 })],
    );
    await expect(
      idempotency.run(scope("k4"), "POST", { amount: 400 }, async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_REQUEST_IN_PROGRESS" } satisfies Partial<TotalBaseError>);
  });

  it("releases the key on failure so a genuine retry is not blocked", async () => {
    await expect(
      idempotency.run(scope("k5"), "POST", { amount: 500 }, async () => {
        throw new TotalBaseError("INVALID_QUERY", "boom");
      }),
    ).rejects.toThrow("boom");

    let calls = 0;
    const response = await idempotency.run(scope("k5"), "POST", { amount: 500 }, async () => {
      calls++;
      return { status: 201, body: { id: "invoice-5" } };
    });
    expect(calls).toBe(1);
    expect(response.body).toEqual({ id: "invoice-5" });
  });

  it("allows the same key across two unrelated operation scopes", async () => {
    const a = await idempotency.run(
      { ...scope("shared-key"), operationScope: "table:public.invoices:create" },
      "POST",
      { x: 1 },
      async () => ({ status: 201, body: { id: "a" } }),
    );
    const b = await idempotency.run(
      { ...scope("shared-key"), operationScope: "table:public.payments:create" },
      "POST",
      { x: 1 },
      async () => ({ status: 201, body: { id: "b" } }),
    );
    expect(a.body).toEqual({ id: "a" });
    expect(b.body).toEqual({ id: "b" });
  });

  it("bypasses idempotency entirely when idempotency.enabled is false", async () => {
    await settings.setGroup("idempotency", { enabled: false });
    try {
      let calls = 0;
      const fn = async () => {
        calls++;
        return { status: 201, body: { call: calls } };
      };
      const first = await idempotency.run(scope("k6"), "POST", { amount: 600 }, fn);
      const second = await idempotency.run(scope("k6"), "POST", { amount: 600 }, fn);
      expect(calls).toBe(2);
      expect(first.body).toEqual({ call: 1 });
      expect(second.body).toEqual({ call: 2 });
    } finally {
      await settings.setGroup("idempotency", { enabled: true });
    }
  });

  it("does not cache a response above idempotency.max_response_bytes, and rejects replay explicitly", async () => {
    await settings.set("idempotency.max_response_bytes", 100);
    try {
      let calls = 0;
      const bigBody = { blob: "x".repeat(200) };
      const first = await idempotency.run(scope("k7"), "POST", { amount: 700 }, async () => {
        calls++;
        return { status: 201, body: bigBody };
      });
      expect(calls).toBe(1);
      expect(first.body).toEqual(bigBody); // the caller of the original request still gets the real response

      // A retry must not re-execute the operation, but also cannot
      // replay a body that was never cached.
      await expect(
        idempotency.run(scope("k7"), "POST", { amount: 700 }, async () => {
          calls++;
          return { status: 201, body: bigBody };
        }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_RESPONSE_TOO_LARGE_TO_REPLAY" } satisfies Partial<TotalBaseError>);
      expect(calls).toBe(1); // never re-executed
    } finally {
      await settings.set("idempotency.max_response_bytes", 65_536);
    }
  });

  it("still caches and replays a response at or under the configured max size", async () => {
    await settings.set("idempotency.max_response_bytes", 100);
    try {
      let calls = 0;
      const smallBody = { ok: true };
      const fn = async () => {
        calls++;
        return { status: 201, body: smallBody };
      };
      await idempotency.run(scope("k8"), "POST", { amount: 800 }, fn);
      const replay = await idempotency.run(scope("k8"), "POST", { amount: 800 }, fn);
      expect(calls).toBe(1);
      expect(replay.body).toEqual(smallBody);
    } finally {
      await settings.set("idempotency.max_response_bytes", 65_536);
    }
  });

  const expire = (key: string) =>
    database.query(
      `UPDATE totalbase.idempotency_keys SET expires_at = now() - interval '1 second'
       WHERE principal_type = 'USER' AND principal = $1 AND operation_scope = $2 AND key = $3`,
      [principal, "table:public.invoices:create", key],
    );

  it("treats an expired key as unused: the request runs again instead of replaying", async () => {
    let calls = 0;
    const fn = async () => ({ status: 201, body: { call: ++calls } });
    await idempotency.run(scope("k9"), "POST", { amount: 900 }, fn);
    await expire("k9");
    const again = await idempotency.run(scope("k9"), "POST", { amount: 900 }, fn);
    expect(calls).toBe(2);
    expect(again.body).toEqual({ call: 2 });
    // ... and the new run is the one replayed from now on.
    const replay = await idempotency.run(scope("k9"), "POST", { amount: 900 }, fn);
    expect(calls).toBe(2);
    expect(replay.body).toEqual({ call: 2 });
  });

  it("accepts an expired key with a different body (no IDEMPOTENCY_KEY_REUSED)", async () => {
    await idempotency.run(scope("k10"), "POST", { amount: 1 }, async () => ({ status: 201, body: {} }));
    await expire("k10");
    await expect(
      idempotency.run(scope("k10"), "POST", { amount: 2 }, async () => ({ status: 201, body: { second: true } })),
    ).resolves.toEqual({ status: 201, body: { second: true } });
  });

  it("an expired IN_PROGRESS key taken over can't be completed by its original holder", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const first = idempotency.run(scope("k11"), "POST", { amount: 11 }, async () => {
      await held;
      return { status: 201, body: { from: "first" } };
    });
    // Wait for the first run to hold the key, instead of a fixed sleep.
    for (let i = 0; i < 200; i += 1) {
      const { rows } = await database.query(`SELECT 1 FROM totalbase.idempotency_keys WHERE principal = $1 AND key = 'k11'`, [principal]);
      if (rows.length > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await expire("k11");
    const second = await idempotency.run(scope("k11"), "POST", { amount: 11 }, async () => ({ status: 201, body: { from: "second" } }));
    expect(second.body).toEqual({ from: "second" });
    release();
    await first;
    const replay = await idempotency.run(scope("k11"), "POST", { amount: 11 }, async () => ({ status: 201, body: { from: "third" } }));
    expect(replay.body).toEqual({ from: "second" });
  });

  it("purgeExpired deletes expired keys only", async () => {
    await idempotency.run(scope("k12"), "POST", {}, async () => ({ status: 201, body: {} }));
    await idempotency.run(scope("k13"), "POST", {}, async () => ({ status: 201, body: {} }));
    await expire("k12");
    expect(await idempotency.purgeExpired()).toBeGreaterThanOrEqual(1);
    const { rows } = await database.query<{ key: string }>(
      `SELECT key FROM totalbase.idempotency_keys WHERE principal = $1 ORDER BY key`,
      [principal],
    );
    expect(rows.map((r) => r.key)).toEqual(["k13"]);
  });
});
