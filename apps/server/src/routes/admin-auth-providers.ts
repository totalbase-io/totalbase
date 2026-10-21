import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AuthProviderConfig, AuthProviderType } from "@totalbase/auth";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, created, NO_CONTENT, object, ok, ref, UUID_PARAM } from "../openapi-admin-docs.js";
import { AUTH_PROVIDER_TYPE, AUTH_PROVIDERS_SCHEMAS } from "../openapi-admin-docs-users.js";

const ID_PARAM = { id: { ...UUID_PARAM, description: "The provider's id." } };
const CONFIGURATION_RULES =
  "`configuration.client_secret_key` must name an existing secret (create it with PUT /admin/api/secrets/{key} first) " +
  "and `allowed_redirect_urls` must list at least one URL unless `showOnSignIn` is on (the portal's own callback needs " +
  "no entry); an OIDC provider needs `issuer`. Violations are 400 " +
  "INVALID_AUTH_PROVIDER_PAYLOAD.";

interface AuthProviderBody {
  type: AuthProviderType;
  name: string;
  enabled?: boolean;
  showOnSignIn?: boolean;
  configuration: AuthProviderConfig;
}

function assertValidConfiguration(type: AuthProviderType, configuration: AuthProviderConfig | undefined, showOnSignIn: boolean): asserts configuration is AuthProviderConfig {
  if (typeof configuration !== "object" || configuration === null) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "configuration is required.");
  }
  if (!configuration.client_id?.trim()) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "client_id is required.");
  }
  if (!configuration.client_secret_key?.trim()) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "client_secret_key is required - create the secret under Settings > Secrets first.");
  }
  // The portal's own callback is always allowed, so a provider shown on the sign-in page may list none.
  if (!Array.isArray(configuration.allowed_redirect_urls) || (configuration.allowed_redirect_urls.length === 0 && !showOnSignIn)) {
    throw new TotalBaseError(
      "INVALID_AUTH_PROVIDER_PAYLOAD",
      "allowed_redirect_urls must list at least one URL - a provider with none, and not shown on the sign-in page, can never complete a login.",
    );
  }
  if (type === "OIDC" && !configuration.issuer?.trim()) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "An OIDC provider requires an issuer.");
  }
}

/** The client secret must exist now - otherwise the provider only fails later, at someone's sign-in. */
async function assertSecretExists(context: AppContext, key: string): Promise<void> {
  if (!(await context.secrets.exists(key))) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", `No secret named "${key}" - create it under Settings > Secrets first.`);
  }
}

/**
 * Admin CRUD for totalbase.providers (Security.md §2.11).
 * The public flow itself (redirect + callback) is
 * api-auth.ts - this is only configuration, admin-gated like every other
 * feature's settings surface.
 *
 * client_secret is never accepted or returned here as plaintext -
 * `configuration.client_secret_key` only ever references an existing
 * totalbase.secrets entry (create it under Settings > Secrets first),
 * same pattern as Integrations' secret headers and mailings'
 * smtp_password_secret_key.
 */
export function registerAdminAuthProvidersRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get("/admin/api/auth-providers", {
    preHandler,
    ...adminDoc("auth-providers", {
      summary: "List sign-in providers",
      description: "OAuth/OIDC providers (GOOGLE, GITHUB, OIDC), oldest first.",
      response: ok(arrayOf(ref("AuthProvidersProvider"))),
      schemas: AUTH_PROVIDERS_SCHEMAS,
    }),
  }, async () => ({
    data: await context.authProviders.list(),
  }));

  app.get<{ Params: { id: string } }>(
    "/admin/api/auth-providers/:id",
    {
      preHandler,
      ...adminDoc("auth-providers", {
        summary: "Get a sign-in provider",
        pathParameters: ID_PARAM,
        response: ok(ref("AuthProvidersProvider")),
        schemas: AUTH_PROVIDERS_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.authProviders.get(request.params.id) }),
  );

  app.post<{ Body: { data?: AuthProviderBody } | undefined }>("/admin/api/auth-providers", {
    preHandler,
    ...adminDoc("auth-providers", {
      summary: "Create a sign-in provider",
      description:
        "At most one GOOGLE and one GITHUB provider (409 AUTH_PROVIDER_NAME_DUPLICATE); any number of OIDC ones, each " +
        "reached at /api/auth/oauth/{slug} where the slug comes from its name. " + CONFIGURATION_RULES,
      requestBody: {
        schema: dataEnvelope(object({
          type: AUTH_PROVIDER_TYPE,
          name: { type: "string" },
          enabled: { type: "boolean", default: true },
          showOnSignIn: { type: "boolean", default: false, description: "Its button on the portal's sign-in page." },
          configuration: ref("AuthProvidersConfiguration"),
        }, ["type", "name", "configuration"])),
      },
      response: created(ref("AuthProvidersProvider")),
      schemas: AUTH_PROVIDERS_SCHEMAS,
    }),
  }, async (request, reply) => {
    const body = (request.body?.data ?? {}) as AuthProviderBody;
    if (!body.name?.trim()) throw new TotalBaseError("INVALID_NAME", "Name is required.");
    assertValidConfiguration(body.type, body.configuration, body.showOnSignIn === true);
    await assertSecretExists(context, body.configuration.client_secret_key);
    const created = await context.authProviders.create({
      type: body.type,
      name: body.name,
      enabled: body.enabled,
      showOnSignIn: body.showOnSignIn,
      configuration: body.configuration,
    });
    reply.code(201);
    return { data: created };
  });

  app.patch<{ Params: { id: string }; Body: { data?: Partial<AuthProviderBody> } | undefined }>(
    "/admin/api/auth-providers/:id",
    {
      preHandler,
      ...adminDoc("auth-providers", {
        summary: "Update a sign-in provider",
        description:
          "Only the fields sent change; `type` can't. `configuration`, when sent, replaces the whole object. " + CONFIGURATION_RULES,
        pathParameters: ID_PARAM,
        requestBody: {
          schema: dataEnvelope(object({
            name: { type: "string" },
            enabled: { type: "boolean" },
            showOnSignIn: { type: "boolean" },
            configuration: ref("AuthProvidersConfiguration"),
          })),
        },
        response: ok(ref("AuthProvidersProvider")),
        schemas: AUTH_PROVIDERS_SCHEMAS,
      }),
    },
    async (request) => {
      const body = request.body?.data;
      if (!body) throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "A request body { data } is required.");
      const current = await context.authProviders.get(request.params.id);
      const showOnSignIn = body.showOnSignIn ?? current.showOnSignIn;
      // Turning the button off checks the stored URLs too: a provider must still be able to complete a login.
      assertValidConfiguration(current.type, body.configuration ?? current.configuration, showOnSignIn);
      if (body.configuration) await assertSecretExists(context, body.configuration.client_secret_key);
      const updated = await context.authProviders.update(request.params.id, {
        name: body.name,
        enabled: body.enabled,
        showOnSignIn: body.showOnSignIn,
        configuration: body.configuration,
      });
      return { data: updated };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/admin/api/auth-providers/:id",
    {
      preHandler,
      ...adminDoc("auth-providers", {
        summary: "Delete a sign-in provider",
        description: "Users who signed in through it keep their accounts. 404 AUTH_PROVIDER_NOT_FOUND for an unknown id.",
        pathParameters: ID_PARAM,
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      await context.authProviders.delete(request.params.id);
      reply.code(204);
    },
  );

  // Read-only convenience for the admin UI: the exact slug/redirectUri
  // an admin needs to register with the provider's own console (Google
  // Cloud Console, GitHub OAuth App settings, ...), computed the same
  // way OAuthService does rather than duplicating that logic in the UI.
  app.get<{ Params: { id: string } }>(
    "/admin/api/auth-providers/:id/redirect-uri",
    {
      preHandler,
      ...adminDoc("auth-providers", {
        summary: "A provider's slug and callback URL",
        description: "The redirect URI to register in the provider's own console (Google Cloud, GitHub OAuth App, ...), built from system.public_url.",
        pathParameters: ID_PARAM,
        response: ok(ref("AuthProvidersRedirectUri")),
        schemas: AUTH_PROVIDERS_SCHEMAS,
      }),
    },
    async (request) => {
      const provider = await context.authProviders.get(request.params.id);
      const slug = context.authProviders.slugFor(provider);
      return { data: { slug, redirectUri: await context.oauth.redirectUriFor(slug) } };
    },
  );
}
