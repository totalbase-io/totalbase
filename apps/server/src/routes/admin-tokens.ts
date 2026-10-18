import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { UserApiPlane } from "@totalbase/users-apis";
import type { AppContext } from "../context.js";
import { isUuid, parseUserFilter } from "./user-filter.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, created, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import { TOKENS_SCHEMAS } from "../openapi-admin-docs-users.js";

const TTL_DAYS = { type: "integer", minimum: 1, maximum: 3650, description: "Lifetime in days; api_keys.default_ttl_days when omitted." };

/**
 * Admin oversight of every user's personal access tokens
 * (totalbase.tokens). A user manages their own
 * tokens through the self-service /api/tokens routes (tokens.ts);
 * this is the Control Plane's view across all users - e.g. auditing who
 * holds a plane="ADMIN" token, or revoking one without needing that
 * user's own session.
 */
const MAX_IDS = 100;

export function registerAdminTokensRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.post<{ Body: { data?: { userId: string; name: string; description?: string | null; plane?: UserApiPlane; ttlDays?: number } } | undefined }>(
    "/admin/api/tokens",
    {
      preHandler,
      ...adminDoc("tokens", {
        summary: "Issue a personal access token for a user",
        description:
          "The plaintext `key` is returned only in this response. A token has no roles of its own: `plane: \"API\"` " +
          "acts with the user's live roles (which must grant API access), `plane: \"ADMIN\"` requires the user to hold " +
          "the Administrators role - both re-checked on every use. System accounts can't hold tokens (403). A name " +
          "already used by that user is 409 USER_API_NAME_DUPLICATE. List, revoke or delete tokens through the Data API.",
        requestBody: {
          schema: dataEnvelope(object({
            userId: UUID,
            name: { type: "string", maxLength: 32 },
            description: { type: ["string", "null"], maxLength: 128 },
            plane: { type: "string", enum: ["API", "ADMIN"], default: "API" },
            ttlDays: TTL_DAYS,
          }, ["userId", "name"])),
        },
        response: created(ref("TokensIssued")),
        schemas: TOKENS_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const body = request.body?.data;
      if (!body) throw new TotalBaseError("INVALID_QUERY", "A request body { data } is required.");
      const { plainKey, userApi } = await context.usersApis.create({
        userId: body.userId,
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

  // Body `{ data: { ttlDays? } }` - the regenerated token's new lifetime.
  app.post<{ Params: { id: string }; Body: { data?: { ttlDays?: number; graceHours?: number } } | undefined }>(
    "/admin/api/tokens/:id/rotate",
    {
      preHandler,
      ...adminDoc("tokens", {
        summary: "Regenerate a token",
        description:
          "A new secret and a new expiry (`ttlDays` from now), keeping the token's name, access and history; the old " +
          "secret stops working at once, or after `graceHours` (`previousExpiresAt`). Works on an expired token, never on a revoked one (404). The new plaintext " +
          "`key` is returned only in this response.",
        pathParameters: { id: { ...UUID_PARAM, description: "The token's id." } },
        requestBody: { schema: dataEnvelope(object({ ttlDays: TTL_DAYS, graceHours: { type: "integer", minimum: 0, maximum: 168, default: 0, description: "How long the old secret keeps working (0: it stops at once; at most 168 hours, never past its own expiry)." } })), required: false },
        response: ok(ref("TokensIssued")),
        schemas: TOKENS_SCHEMAS,
      }),
    },
    async (request) => {
      const { plainKey, userApi } = await context.usersApis.rotate(request.params.id, request.body?.data?.ttlDays, request.body?.data?.graceHours);
      return { data: { ...userApi, key: plainKey } };
    },
  );

}
