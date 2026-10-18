import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { TotalBaseError } from "@totalbase/errors";
import { portalAccessOf } from "@totalbase/permissions";
import { dataEnvelope, type JsonSchema, type RouteDoc } from "@totalbase/openapi";
import { extractBearerToken, requireUser } from "../auth-guards.js";
import { SESSION_REF, SESSION_SCHEMAS, USER_REF, USER_SCHEMA } from "../openapi-docs.js";

const TAG = ["auth"];
const doc = (openapi: RouteDoc) => ({ config: { openapi } });
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: "object", required, properties });
const STRING: JsonSchema = { type: "string" };
/** Done, nothing to return (Specification_Data_API.md §2.5). */
const noContent = { status: "204" as const };

/**
 * Whether the user's active roles grant API access -
 * required for every route here that hands out a session: the data-plane
 * login, invitation acceptance and the OAuth callback. The session was
 * already created by the time this runs; a user without API access has
 * it revoked immediately instead of receiving it. (The portal logs in
 * through /admin/api/auth/login, gated on admin/app access instead.)
 */
async function keepSessionIfApiAccess(context: AppContext, userId: string, sessionToken: string): Promise<boolean> {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
  if ((await context.roles.effectiveAccess(roleIds)).apiAccess) return true;
  await context.auth.sessions.revokeByToken(sessionToken);
  return false;
}

/** The portal's own provider sign-in: the same rule as its password sign-in (admin-auth.ts) - admin or app access. */
async function keepSessionIfPortalAccess(context: AppContext, userId: string, sessionToken: string): Promise<boolean> {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
  if (portalAccessOf(await context.roles.effectiveAccess(roleIds))) return true;
  await context.auth.sessions.revokeByToken(sessionToken);
  return false;
}

/**
 * Public Data-Plane authentication routes.
 * See Specification_Security.md §2.5.
 */
export function registerApiAuthRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: { email: string; password: string } }>(
    "/api/auth/login",
    doc({
      summary: "Sign in with email and password",
      description:
        "Returns a session token. Accounts without API access get the same 401 as a wrong password. With email verification " +
        "required, a correct password on an account whose email isn't verified is `403 EMAIL_NOT_VERIFIED` - resend the link " +
        "with `POST /api/auth/email/resend`.",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ email: { type: "string", format: "email" }, password: STRING }) },
      response: { status: "200", schema: dataEnvelope(SESSION_REF) },
      schemas: SESSION_SCHEMAS,
    }),
    async (request) => {
      request.auditMetadata = { email: request.body?.email };
      const result = await context.auth.login({
        email: request.body.email,
        password: request.body.password,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      }, (reason, details) => {
        // Only the audit log learns why - the caller gets the same 401.
        request.auditMetadata = {
          ...request.auditMetadata,
          reason,
          ...(details?.lockedNow && { locked_now: true }),
          ...(details?.userId && { user_id: details.userId }),
        };
      });
      // Same generic 401 as a wrong password - doesn't reveal that the
      // account exists but lacks API access.
      request.auditPrincipal = { type: "USER", id: result.user.id };
      if (!(await keepSessionIfApiAccess(context, result.user.id, result.token))) {
        request.auditMetadata = { ...request.auditMetadata, reason: "no_api_access" };
        throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid email or password.", { httpStatus: 401 });
      }
      return { data: result };
    },
  );

  app.post("/api/auth/logout", doc({
    summary: "Sign out (revoke the current session)",
    tags: TAG,
    access: "session",
    response: noContent,
  }), async (request, reply) => {
    const token = extractBearerToken(request);
    await context.auth.logout(token);
    return reply.code(204).send();
  });

  app.get(
    "/api/auth/me",
    {
      preHandler: requireUser(context),
      ...doc({ summary: "The signed-in user", tags: TAG, access: "session", response: { status: "200", schema: dataEnvelope(USER_REF) }, schemas: USER_SCHEMA }),
    },
    async (request) => {
      const user = await context.auth.users.findById(request.userId!);
      return { data: user };
    },
  );

  app.post<{ Body: { email: string; password: string; name?: string } }>(
    "/api/auth/register",
    doc({
      summary: "Create an account",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ email: { type: "string", format: "email" }, password: STRING, name: STRING }, ["email", "password"]) },
      response: { status: "200", schema: dataEnvelope(USER_REF) },
      schemas: USER_SCHEMA,
      // Listed only while public registration is on (auth.registration_enabled).
      visible: () => context.settings.get("auth.registration_enabled"),
    }),
    async (request) => {
      const user = await context.auth.register(request.body);
      return { data: user };
    },
  );

  app.post<{ Body: { email: string } }>(
    "/api/auth/password/forgot",
    doc({
      summary: "Request a password reset email",
      description: "Always succeeds, whether or not the email belongs to an account.",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ email: { type: "string", format: "email" } }) },
      response: noContent,
    }),
    async (request, reply) => {
      request.auditMetadata = { email: request.body?.email };
      await context.auth.requestPasswordReset(request.body.email);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    "/api/auth/password/reset",
    doc({
      summary: "Set a new password with a reset token",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ token: STRING, password: STRING }) },
      response: noContent,
    }),
    async (request, reply) => {
      await context.auth.resetPassword(request.body.token, request.body.password);
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { currentPassword: string; newPassword: string } }>(
    "/api/auth/password/change",
    {
      preHandler: requireUser(context),
      ...doc({
        summary: "Change the signed-in user's password",
        description: "A wrong `currentPassword` is `400 INVALID_CURRENT_PASSWORD` (the session itself is fine); an account with no password yet is `403 PERMISSION_DENIED` - it sets one through \"Forgot password\".",
        tags: TAG,
        access: "session",
        requestBody: { schema: object({ currentPassword: STRING, newPassword: STRING }) },
        response: noContent,
      }),
    },
    async (request, reply) => {
      await context.auth.changePassword(
        request.userId!,
        request.body.currentPassword,
        request.body.newPassword,
      );
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { token: string } }>(
    "/api/auth/email/verify",
    doc({
      summary: "Verify an email address with its token",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ token: STRING }) },
      response: noContent,
    }),
    async (request, reply) => {
      await context.auth.verifyEmail(request.body.token);
      return reply.code(204).send();
    },
  );

  // Signed in: the session's own account. Signed out - a sign-in just
  // refused with EMAIL_NOT_VERIFIED - by `{ email }`, answered like
  // "forgot password": always success, so it never tells whether an
  // account exists (AuthService.resendEmailVerification).
  app.post<{ Body: { email?: string } | undefined }>(
    "/api/auth/email/resend",
    doc({
      summary: "Resend the verification email",
      description:
        "With a session, to the signed-in account. Without one, to the account of `email` - always succeeds, whether or not " +
        "the email belongs to an unverified account. Nothing is sent for an address already verified.",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ email: { type: "string", format: "email" } }, []), required: false },
      response: noContent,
    }),
    async (request, reply) => {
      const bearer = request.headers.authorization ? extractBearerToken(request) : undefined;
      if (bearer) {
        const user = await context.auth.me(bearer);
        request.userId = user.id;
        await context.auth.resendEmailVerification(user.id);
      } else {
        const email = request.body?.email;
        if (typeof email !== "string" || email.trim() === "") throw new TotalBaseError("INVALID_QUERY", "email is required without a session.");
        request.auditMetadata = { email };
        await context.auth.resendEmailVerificationByEmail(email);
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Body: { token: string; password: string } }>(
    "/api/auth/invitations/accept",
    doc({
      summary: "Accept an invitation and set a password",
      description: "Returns a session only when the account has API access; otherwise just the user.",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ token: STRING, password: STRING }) },
      response: {
        status: "200",
        schema: dataEnvelope(object({ token: { type: "string", description: "Present only when the account has API access." }, user: USER_REF }, ["user"])),
      },
      schemas: USER_SCHEMA,
    }),
    async (request) => {
      const result = await context.auth.acceptInvitation(request.body.token, request.body.password);
      request.auditPrincipal = { type: "USER", id: result.user.id };
      // The account is ready either way; only a user with API access also
      // gets a session back (an app-only user signs in through the portal).
      if (!(await keepSessionIfApiAccess(context, result.user.id, result.token))) {
        return { data: { user: result.user } };
      }
      return { data: result };
    },
  );

  // OAuth/OIDC (Specification_Security.md §2.5). The caller's own system
  // links straight to this route with its own callback as `redirect_to`
  // (validated against that provider's admin-configured allowlist,
  // oauth-redirect.ts) - TotalBase is the only party that ever talks to
  // the provider or holds its client_secret. See OAuthService's doc
  // comment for the full handoff.
  app.get<{ Params: { provider: string }; Querystring: { redirect_to?: string } }>(
    "/api/auth/oauth/:provider",
    doc({
      summary: "Start an OAuth/OIDC sign-in",
      description:
        "Redirects to the provider. After sign-in the browser returns to `redirect_to` (which must be on the provider's " +
        "allowlist - or the portal's own `/admin/auth/oauth`, for a provider shown on the sign-in page) with " +
        "`#token=<session token>`, `#error=access_denied` for an account without API access (portal access for the portal's page), " +
        "`#error=email_required` when the provider shared no email for a first sign-in, or `#error=email_not_verified` " +
        "when email verification is required and neither the account nor the provider has verified its address.",
      tags: TAG,
      access: "public",
      pathParameters: { provider: { description: "The auth provider's name, as configured in Settings > Auth providers." } },
      parameters: [{ name: "redirect_to", in: "query", required: true, schema: { type: "string", format: "uri" } }],
      response: { status: "302", description: "Redirect to the provider's authorization page." },
    }),
    async (request, reply) => {
      const redirectTo = request.query.redirect_to;
      if (!redirectTo) {
        reply.code(400);
        return {
          errors: [{ source: "TOTALBASE", code: "OAUTH_REDIRECT_NOT_ALLOWED", message: "redirect_to is required." }],
        };
      }
      const authorizationUrl = await context.oauth.start(request.params.provider, redirectTo);
      return reply.redirect(authorizationUrl, 302);
    },
  );

  app.get<{ Params: { provider: string }; Querystring: { code?: string; state?: string; error?: string } }>(
    "/api/auth/oauth/:provider/callback",
    doc({
      summary: "OAuth/OIDC callback (called by the provider)",
      tags: TAG,
      access: "public",
      parameters: [
        { name: "code", in: "query", schema: STRING },
        { name: "state", in: "query", schema: STRING },
        { name: "error", in: "query", schema: STRING },
      ],
      response: { status: "302", description: "Redirect back to `redirect_to` with the token (or an error) in the fragment." },
    }),
    async (request, reply) => {
      if (request.query.error || !request.query.code || !request.query.state) {
        reply.code(400);
        return {
          errors: [{
            source: "TOTALBASE",
            code: "OAUTH_UPSTREAM_ERROR",
            message: request.query.error ?? "The provider did not return an authorization code.",
          }],
        };
      }
      const result = await context.oauth.callback(request.params.provider, request.query.code, request.query.state);
      const separatorFor = (url: string) => (url.includes("#") ? "&" : "#");
      if (result.error) {
        // No session: the provider shared no email for a new account
        // (email_required), the account can't sign in (access_denied), or
        // its email isn't verified while verification is required.
        if (result.error === "email_not_verified") {
          request.auditMetadata = { reason: "email_not_verified", user_id: result.userId };
        }
        return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}error=${result.error}`, 302);
      }
      request.auditPrincipal = { type: "USER", id: result.user.id };
      // The portal's own sign-in page needs portal access (admin or app), as a password sign-in there does;
      // an application's redirect needs API access.
      const kept = result.portal
        ? await keepSessionIfPortalAccess(context, result.user.id, result.token)
        : await keepSessionIfApiAccess(context, result.user.id, result.token);
      if (!kept) {
        // RFC 6749's own error code, in the fragment like the token would be.
        return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}error=access_denied`, 302);
      }
      // The token travels in the fragment, not the query string, so it
      // never reaches the caller's own server logs or a Referer header -
      // only client-side JS on redirectTo's page ever reads it.
      return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}token=${encodeURIComponent(result.token)}`, 302);
    },
  );
}
