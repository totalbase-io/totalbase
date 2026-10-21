import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { createTestApiToken, setupTestApp } from "./test-support.js";

/**
 * Route-level acceptance tests for the Execution status endpoint
 * (Data_API.md §10.3).
 */
describe("Executions status endpoint", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let roleId: string;
  let apiKeyPlain: string;
  let apiKeyId: string;
  let apiKeyUserId: string;
  let otherApiKeyPlain: string;
  let otherApiKeyId: string;
  let otherApiKeyUserId: string;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    const role = await context.roles.create("exec-pkg-test-role", { apiAccess: true });
    roleId = role.id;
    const created = await createTestApiToken(context, {
      name: "exec-pkg-test-key",
      roleId,
      email: "exec-pkg-test-key@example.com",
    });
    apiKeyPlain = created.plainKey;
    apiKeyId = created.tokenId;
    apiKeyUserId = created.userId;
    const other = await createTestApiToken(context, {
      name: "exec-pkg-test-key-other",
      roleId,
      email: "exec-pkg-test-key-other@example.com",
    });
    otherApiKeyPlain = other.plainKey;
    otherApiKeyId = other.tokenId;
    otherApiKeyUserId = other.userId;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.executions WHERE principal = ANY($1)`, [[apiKeyId, otherApiKeyId]]);
    await database.query(`DELETE FROM totalbase.users WHERE id = ANY($1)`, [[apiKeyUserId, otherApiKeyUserId]]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await app.close();
    await database.close();
  });

  function get(id: string, token: string) {
    return app.inject({ method: "GET", url: `/api/executions/${id}`, headers: { authorization: `Bearer ${token}` } });
  }

  it("returns 404 for an execution that does not exist", async () => {
    const res = await get("00000000-0000-0000-0000-000000000000", apiKeyPlain);
    expect(res.statusCode).toBe(404);
  });

  it("lets the creating principal see pending/completed/failed states, and hides it from another principal", async () => {
    const created = await context.executions.create({
      type: "TEST",
      principalType: "API_KEY",
      principal: (await context.usersApis.validate(apiKeyPlain))!.id,
      request: { x: 1 },
    });

    const pending = await get(created.id, apiKeyPlain);
    expect(pending.statusCode).toBe(200);
    expect(pending.json().data.status).toBe("PENDING");
    expect(pending.json().data).toMatchObject({ result: null, error: null });

    const denied = await get(created.id, otherApiKeyPlain);
    expect(denied.statusCode).toBe(404);

    context.executionExecutors["TEST"] = async () => ({ done: true });
    await context.executionsWorker.processBatch(10);

    const completed = await get(created.id, apiKeyPlain);
    expect(completed.json().data.status).toBe("COMPLETED");
    expect(completed.json().data.result).toEqual({ done: true });
  });
});
