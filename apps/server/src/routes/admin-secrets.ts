import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { dataEnvelope } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, NO_CONTENT, object, ok, ref } from "../openapi-admin-docs.js";
import { SECRETS_SCHEMAS } from "../openapi-admin-docs-users.js";
import { SECRET_SCOPES, validateSecretScope } from "@totalbase/secrets";
import { optionalData } from "../request-body.js";

const KEY_PARAM = { key: { description: "The secret's key, e.g. `mail.password`.", schema: { type: "string" } } };

/**
 * Central secret management (TotalBase secrets architecture doc: write-only
 * from any administrative surface - create/replace/delete and list
 * metadata only, never the value). Reusable across features: External
 * Endpoints today, SMTP/OAuth providers/authenticated webhooks later all
 * reference secrets created here by key instead of holding their own copy.
 */
export function registerAdminSecretsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get<{ Querystring: { scope?: string } }>("/admin/api/secrets", {
    preHandler,
    ...adminDoc("secrets", {
      summary: "List secrets",
      description: "Metadata only, ordered by key - a secret's value is never returned by any route. `scope` lists one feature's.",
      parameters: [{ name: "scope", in: "query", required: false, description: "Only the secrets of this feature.", schema: { type: "string", enum: [...SECRET_SCOPES] } }],
      response: ok(arrayOf(ref("SecretsMetadata"))),
      schemas: SECRETS_SCHEMAS,
    }),
  }, async (request) => ({ data: await context.secrets.list(request.query.scope === undefined ? undefined : validateSecretScope(request.query.scope)) }));

  app.put<{ Params: { key: string }; Body: { data?: { value?: unknown; scope?: unknown } } | undefined }>(
    "/admin/api/secrets/:key",
    {
      preHandler,
      ...adminDoc("secrets", {
        summary: "Create or replace a secret",
        description:
          "Stores `value` encrypted with the instance's master key for the one feature `scope` names, replacing any existing " +
          "value and scope together - only that feature decrypts it. 400 INVALID_SECRET_KEY for a malformed key, INVALID_SECRET_SCOPE for an unknown scope.",
        pathParameters: KEY_PARAM,
        requestBody: { schema: dataEnvelope(object({ value: { type: "string" }, scope: { type: "string", enum: [...SECRET_SCOPES] } }, ["value", "scope"])) },
        response: ok(ref("SecretsMetadata")),
        schemas: SECRETS_SCHEMAS,
      }),
    },
    async (request) => {
      const { value, scope } = optionalData(request.body);
      if (typeof value !== "string") throw new TotalBaseError("INVALID_QUERY", "Expected { data: { value, scope } } with a string value.");
      return { data: await context.secrets.set(request.params.key, value, validateSecretScope(scope)) };
    },
  );

  app.delete<{ Params: { key: string } }>("/admin/api/secrets/:key", {
    preHandler,
    ...adminDoc("secrets", {
      summary: "Delete a secret",
      description: "Anything still referencing the key fails when it next needs it. 404 SECRET_NOT_FOUND for an unknown key.",
      pathParameters: KEY_PARAM,
      response: NO_CONTENT,
    }),
  }, async (request, reply) => {
    if (!(await context.secrets.delete(request.params.key))) {
      throw new TotalBaseError("SECRET_NOT_FOUND", `Secret not found: ${request.params.key}`);
    }
    reply.code(204);
  });
}
