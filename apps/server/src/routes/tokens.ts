import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { UserApiPlane } from "@totalbase/users-apis";
import type { AppContext } from "../context.js";
import { dataEnvelope, type RouteDoc } from "@totalbase/openapi";
import { requireUser } from "../auth-guards.js";
import { TOKEN_SCHEMAS } from "../openapi-docs.js";

const TOKEN = { $ref: "#/components/schemas/ApiToken" };
const TOKEN_WITH_KEY = { $ref: "#/components/schemas/ApiTokenWithKey" };
const TTL_DAYS = { type: "integer", minimum: 1, maximum: 3650, description: "Lifetime in days; api_keys.default_ttl_days when omitted - every token expires." };
/** Every token route is session-only (requireUser) and acts on the caller's own tokens. */
const doc = (openapi: Omit<RouteDoc, "tags" | "access">) => ({
  config: { openapi: { tags: ["tokens"], access: "session" as const, schemas: TOKEN_SCHEMAS, ...openapi } },
});

/**
 * Self-service personal access tokens (totalbase.tokens, migration
 * 000024): any user manages their own tokens here, scoped to their own
 * id. plane="API" tokens inherit the caller's own data-plane roles
 * (nothing to grant here - UsersApisService resolves them live).
 * plane="ADMIN" is only accepted if the caller currently holds the
 * Administrators role (checked by the service, not here).
 */
export function registerTokensRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireUser(context);

  app.get("/api/tokens", {
    preHandler,
    ...doc({ summary: "List your API tokens", response: { status: "200", schema: dataEnvelope({ type: "array", items: TOKEN }) } }),
  }, async (request) => ({
    data: await context.usersApis.listForUser(request.userId!),
  }));

  app.post<{ Body: { data?: { name: string; description?: string | null; plane?: UserApiPlane; ttlDays?: number } } | undefined }>(
    "/api/tokens",
    {
      preHandler,
      ...doc({
        summary: "Create an API token",
        description: "The plain key is returned only in this response. `plane: admin` requires the Administrators role.",
        requestBody: {
          schema: dataEnvelope({
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" },
              description: { type: ["string", "null"] },
              plane: { type: "string", enum: ["API", "ADMIN"], default: "API" },
              ttlDays: TTL_DAYS,
            },
          }),
        },
        response: { status: "201", schema: dataEnvelope(TOKEN_WITH_KEY) },
      }),
    },
    async (request, reply) => {
      const body = request.body?.data;
      if (!body) throw new TotalBaseError("INVALID_QUERY", "A request body { data } is required.");
      const { plainKey, userApi } = await context.usersApis.create({
        userId: request.userId!,
        name: body.name,
        description: body.description,
        plane: body.plane ?? "API",
        ttlDays: body.ttlDays,
      });
      reply.code(201);
      // The plaintext token is returned exactly once and never again.
      return { data: { ...userApi, key: plainKey } };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/tokens/:id",
    { preHandler, ...doc({ summary: "Delete one of your API tokens", response: { status: "204" } }) },
    async (request, reply) => {
      await assertOwnToken(context, request.userId!, request.params.id);
      await context.usersApis.delete(request.params.id);
      reply.code(204);
    },
  );

  // Body `{ data: { ttlDays? } }` - the regenerated token's new lifetime.
  app.post<{ Params: { id: string }; Body: { data?: { ttlDays?: number; graceHours?: number } } | undefined }>(
    "/api/tokens/:id/rotate",
    {
      preHandler,
      ...doc({
        summary: "Rotate an API token (issue a new key)",
        requestBody: { required: false, schema: dataEnvelope({ type: "object", properties: { ttlDays: TTL_DAYS, graceHours: { type: "integer", minimum: 0, maximum: 168, default: 0, description: "How long the old secret keeps working (0: it stops at once; at most 168 hours, never past its own expiry)." } } }) },
        response: { status: "200", schema: dataEnvelope(TOKEN_WITH_KEY) },
      }),
    },
    async (request) => {
      await assertOwnToken(context, request.userId!, request.params.id);
      const { plainKey, userApi } = await context.usersApis.rotate(request.params.id, request.body?.data?.ttlDays, request.body?.data?.graceHours);
      return { data: { ...userApi, key: plainKey } };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/tokens/:id/revoke",
    {
      preHandler,
      ...doc({ summary: "Revoke an API token", response: { status: "204" } }),
    },
    async (request, reply) => {
      await assertOwnToken(context, request.userId!, request.params.id);
      await context.usersApis.revoke(request.params.id);
      reply.code(204);
    },
  );
}

async function assertOwnToken(context: AppContext, userId: string, tokenId: string): Promise<void> {
  const userApi = await context.usersApis.findById(tokenId);
  if (!userApi || userApi.user !== userId) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "Token not found.");
  }
}
