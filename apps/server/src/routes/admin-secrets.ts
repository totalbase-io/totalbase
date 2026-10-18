import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { dataEnvelope } from "@totalbase/openapi";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, NO_CONTENT, object, ok, ref } from "../openapi-admin-docs.js";
import { SECRETS_SCHEMAS } from "../openapi-admin-docs-users.js";

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

  app.get("/admin/api/secrets", {
    preHandler,
    ...adminDoc("secrets", {
      summary: "List secrets",
      description: "Metadata only, ordered by key - a secret's value is never returned by any route.",
      response: ok(arrayOf(ref("SecretsMetadata"))),
      schemas: SECRETS_SCHEMAS,
    }),
  }, async () => ({ data: await context.secrets.list() }));

  app.put<{ Params: { key: string }; Body: { data?: { value?: unknown } } | undefined }>(
    "/admin/api/secrets/:key",
    {
      preHandler,
      ...adminDoc("secrets", {
        summary: "Create or replace a secret",
        description:
          "Stores `value` encrypted with the instance's master key, replacing any existing value. Other features " +
          "(auth providers, SMTP, integrations) reference it by key. 400 INVALID_SECRET_KEY for a malformed key.",
        pathParameters: KEY_PARAM,
        requestBody: { schema: dataEnvelope(object({ value: { type: "string" } }, ["value"])) },
        response: ok(ref("SecretsMetadata")),
        schemas: SECRETS_SCHEMAS,
      }),
    },
    async (request) => {
      const value = request.body?.data?.value;
      if (typeof value !== "string") throw new TotalBaseError("INVALID_QUERY", "Expected { data: { value } } with a string value.");
      return { data: await context.secrets.set(request.params.key, value) };
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
