import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AppContext } from "./context.js";
import { callerRoleIds, callerRoles } from "./caller-roles.js";
import { setupTestApp } from "./test-support.js";

/** A request's caller roles are resolved once, however many checks ask (an App DataView's route asks four times). */
describe("callerRoles", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let userId: string;

  beforeAll(async () => {
    ({ app, context } = await setupTestApp());
    userId = (await context.auth.users.create({ email: `caller-roles-${Date.now()}@example.com`, name: "Caller" })).id;
  });

  afterAll(async () => {
    await context.database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    await app.close();
  });

  const requestOf = () => ({ admin: { id: userId }, headers: {} }) as unknown as FastifyRequest;

  it("asks PostgreSQL once per request, and again for another request", async () => {
    const spy = vi.spyOn(context.roleAssignments, "listEffectiveRolesForUser");
    try {
      const request = requestOf();
      const [a, b, c] = await Promise.all([callerRoles(context, request), callerRoles(context, request), callerRoleIds(context, request)]);
      expect(a).toBe(b);
      expect(c).toEqual(a.administrator ? null : a.roleIds);
      expect(spy).toHaveBeenCalledTimes(1);
      await callerRoles(context, requestOf());
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
  });
});
