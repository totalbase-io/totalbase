import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

const PREFIX = "audit-protected-columns-test";

/**
 * Regression (security defect): a Data API write on a TotalBase table
 * recorded the whole resulting row in the audit entry and the outbox event,
 * protected columns included - an administrator renaming a user stored that
 * user's password_hash in logs.payload, which delegated log readers
 * read through the Data API, and in the outbox, which webhooks deliver.
 * Audited writes keep the full resulting row minus Password and protected
 * columns (Security.md §11.3).
 */
describe("Audit and outbox never record protected columns", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let usersResource: string;
  let userId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const env = loadServerEnv();
    adminToken = (await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! })).token;
    usersResource = (await database.query<{ id: string }>(
      `SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'users'`,
    )).rows[0]!.id;
    for (const { id } of (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE email LIKE '${PREFIX}%'`)).rows) {
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    }
    userId = (await context.auth.users.create({ email: `${PREFIX}@example.com`, passwordHash: await hashPassword("a-strong-enough-password") })).id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await app.close();
  });

  it("an administrator's PATCH on users records the row without password_hash, in the log and the outbox", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/totalbase/table/users/${userId}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { data: { name: "Renamed" } },
    });
    expect(res.statusCode, res.body).toBe(200);

    const { rows: logs } = await database.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM totalbase.logs WHERE resource = $1 AND action = 'UPDATE' AND status = 'EXECUTED' AND payload ->> 'id' = $2`,
      [usersResource, userId],
    );
    expect(logs).toHaveLength(1);
    expect(logs[0]!.payload).toMatchObject({ id: userId, name: "Renamed", email: `${PREFIX}@example.com` });
    expect(logs[0]!.payload).not.toHaveProperty("password_hash");

    const { rows: events } = await database.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM totalbase.outbox WHERE resource = $1 AND payload ->> 'id' = $2`,
      [usersResource, userId],
    );
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(JSON.stringify(event.payload)).not.toContain("password_hash");
  });
});
