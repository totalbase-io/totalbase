import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { TotalBaseError } from "@totalbase/errors";
import { portalAccessOf } from "@totalbase/permissions";
import type { LoginFailureReason, SignInAdmission } from "@totalbase/auth";
import type { FastifyRequest } from "fastify";
import { dataEnvelope, type JsonSchema, type RouteDoc } from "@totalbase/openapi";
import { extractBearerToken, requireUser } from "../auth-guards.js";
import { SESSION_REF, SESSION_SCHEMAS, USER_REF, USER_SCHEMA } from "../openapi-docs.js";

const TAG = ["auth"];
const doc = (openapi: RouteDoc) => ({ config: { openapi } });
const object = (properties: Record<string, JsonSchema>, required = Object.keys(properties)): JsonSchema => ({ type: "object", required, properties });
const STRING: JsonSchema = { type: "string" };
/** Done, nothing to return (Data_API.md §2.5). */
const noContent = { status: "204" as const };

/**
 * Whether the user's active roles grant API access - required for every route here that hands out a session:
 * the data-plane login and its MFA step, invitation acceptance and the OAuth callback. (The portal signs in
 * through /admin/api/auth/login, gated on admin/app access instead.)
 */
export async function hasApiAccess(context: AppContext, userId: string): Promise<boolean> {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
  return (await context.roles.effectiveAccess(roleIds)).apiAccess;
}

/** The portal's rule (admin-auth.ts): admin or app access. */
export async function hasPortalAccess(context: AppContext, userId: string): Promise<boolean> {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
  return portalAccessOf(await context.roles.effectiveAccess(roleIds)) !== null;
}

/** The data-plane sign-in's admission: checked before a session or an MFA challenge exists. */
export function apiAdmission(context: AppContext): SignInAdmission {
  return async (userId) => ((await hasApiAccess(context, userId)) ? null : "no_api_access");
}

/** Only the audit log learns why a sign-in was refused - the caller gets the same 401. */
export function recordSignInFailure(request: FastifyRequest) {
  return (reason: LoginFailureReason, details?: { lockedNow?: boolean; userId?: string }) => {
    request.auditMetadata = {
      ...request.auditMetadata,
      reason,
      ...(details?.lockedNow && { locked_now: true }),
      ...(details?.userId && { user_id: details.userId }),
    };
  };
}

/** Who passed the password step of a sign-in that now waits for its second factor. */
export function recordSecondStep(request: FastifyRequest) {
  return (userId: string) => {
    request.auditPrincipal = { type: "USER", id: userId };
  };
}

/**
 * A correct password answered with an MFA challenge (MFA_REQUIRED / MFA_ENROLLMENT_REQUIRED, 403): audited as
 * the step it is, `auth.mfa_challenge` EXECUTED, not as a refused sign-in - then rethrown for the caller.
 */
export function auditMfaChallenge(request: FastifyRequest, error: unknown): never {
  if (error instanceof TotalBaseError && (error.code === "MFA_REQUIRED" || error.code === "MFA_ENROLLMENT_REQUIRED")) {
    request.auditOutcome = { event: "auth.mfa_challenge", status: "EXECUTED" };
    request.auditMetadata = { ...request.auditMetadata, mfa: error.code === "MFA_REQUIRED" ? "VERIFY" : "ENROLL" };
  }
  throw error;
}

/** The body of a sign-in's second step - an authentication route's own fields, not the `data` envelope. */
interface MfaVerifyBody { challenge?: unknown; code?: unknown; recoveryCode?: unknown }

const MFA_VERIFY_BODY: JsonSchema = {
  type: "object",
  required: ["challenge"],
  properties: {
    challenge: { type: "string", description: "The `meta.challenge` of the sign-in's MFA_REQUIRED or MFA_ENROLLMENT_REQUIRED error." },
    code: { type: "string", description: "The six digits the authenticator app shows now." },
    recoveryCode: { type: "string", description: "Instead of `code`: one of the account's unused recovery codes (VERIFY only)." },
  },
};

/**
 * Public Data-Plane authentication routes.
 * See Security.md §2.5.
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
      // Without API access: the same generic 401 as a wrong password - it doesn't reveal the account exists.
      const result = await context.auth.login({
        email: request.body.email,
        password: request.body.password,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        surface: "API",
        admit: apiAdmission(context),
      }, recordSignInFailure(request), recordSecondStep(request)).catch((error: unknown) => auditMfaChallenge(request, error));
      request.auditPrincipal = { type: "USER", id: result.user.id };
      return { data: result };
    },
  );

  // Two-factor authentication's second step (Security.md §2.17).
  app.post<{ Body: { challenge?: unknown } }>(
    "/api/auth/mfa/enroll",
    doc({
      summary: "Set up an authenticator app during sign-in",
      description:
        "For an MFA_ENROLLMENT_REQUIRED sign-in (the instance requires two-factor authentication and the account has none): a new " +
        "secret and its `otpauth://` link (a QR code's content) for the app. Finish with `POST /api/auth/mfa/verify` and the app's " +
        "first code. 401 INVALID_MFA_CHALLENGE when the challenge is expired, used or not an enrollment.",
      tags: TAG,
      access: "public",
      requestBody: { schema: object({ challenge: STRING }) },
      response: { status: "200", schema: dataEnvelope(object({ secret: STRING, otpauthUrl: STRING })) },
    }),
    async (request) => ({ data: await context.auth.mfa.startChallengeEnrollment(request.body?.challenge) }),
  );

  app.post<{ Body: MfaVerifyBody }>(
    "/api/auth/mfa/verify",
    doc({
      summary: "Finish a sign-in with a two-factor code",
      description:
        "The second step after `403 MFA_REQUIRED` (or `MFA_ENROLLMENT_REQUIRED`, after `POST /api/auth/mfa/enroll`): the challenge " +
        "and the app's current code, or a recovery code. Returns the session, as a sign-in does; `recoveryCodes` only when this " +
        "step finished an enrollment - shown once. A wrong code is 401 INVALID_MFA_CODE and counts toward the account's lockout; " +
        "an expired, used or exhausted challenge is 401 INVALID_MFA_CHALLENGE - sign in again.",
      tags: TAG,
      access: "public",
      requestBody: { schema: MFA_VERIFY_BODY },
      response: {
        status: "200",
        schema: dataEnvelope({
          allOf: [SESSION_REF, object({ recoveryCodes: { type: ["array", "null"], items: STRING } })],
        }),
      },
      schemas: SESSION_SCHEMAS,
    }),
    async (request) => {
      const result = await context.auth.completeMfaSignIn({
        challenge: request.body?.challenge,
        code: request.body?.code,
        recoveryCode: request.body?.recoveryCode,
        surface: "API",
        admit: apiAdmission(context),
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      }, recordSignInFailure(request));
      request.auditPrincipal = { type: "USER", id: result.user.id };
      if (result.usedRecoveryCode) request.auditMetadata = { ...request.auditMetadata, recovery_code: true };
      if (result.recoveryCodes) request.auditMetadata = { ...request.auditMetadata, enrolled: true };
      return { data: { token: result.token, user: result.user, recoveryCodes: result.recoveryCodes } };
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
      // gets a session back (an app-only user signs in through the portal) - and
      // not one the instance requires a second factor for: they set it up at
      // their first sign-in (Security.md §2.17).
      if (!(await hasApiAccess(context, result.user.id)) || (await context.auth.mfa.required(result.user.id))) {
        await context.auth.sessions.revokeByToken(result.token);
        return { data: { user: result.user } };
      }
      return { data: result };
    },
  );

  // OAuth/OIDC (Security.md §2.5). The caller's own system
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
        "allowlist - or the portal's own `/auth/oauth`, for a provider shown on the sign-in page) with " +
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
      // The portal's own sign-in page needs portal access (admin or app), as a password sign-in there does;
      // an application's redirect needs API access - checked before any session or MFA challenge exists.
      const result = await context.oauth.callback(
        request.params.provider,
        request.query.code,
        request.query.state,
        (userId, portal) => (portal ? hasPortalAccess(context, userId) : hasApiAccess(context, userId)),
      );
      const separatorFor = (url: string) => (url.includes("#") ? "&" : "#");
      if (result.error) {
        // No session: the provider shared no email for a new account
        // (email_required), the account can't sign in (access_denied), or
        // its email isn't verified while verification is required.
        if (result.error === "email_not_verified") {
          request.auditMetadata = { reason: "email_not_verified", user_id: result.userId };
        } else if (result.error === "access_denied" && result.userId) {
          request.auditMetadata = { reason: result.portal ? "no_portal_access" : "no_api_access", user_id: result.userId };
        }
        return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}error=${result.error}`, 302);
      }
      request.auditPrincipal = { type: "USER", id: result.user.id };
      if (result.mfa) {
        // A second factor is due (Security.md §2.17): the page completes the challenge with
        // POST /api/auth/mfa/verify (/admin/api/auth/mfa/verify for the portal), in the fragment like a token.
        request.auditOutcome = { event: "auth.mfa_challenge", status: "EXECUTED" };
        request.auditMetadata = { ...request.auditMetadata, mfa: result.mfa.purpose };
        const fragment = `mfa_challenge=${encodeURIComponent(result.mfa.challenge)}&mfa_purpose=${result.mfa.purpose}`;
        return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}${fragment}`, 302);
      }
      // The token travels in the fragment, not the query string, so it
      // never reaches the caller's own server logs or a Referer header -
      // only client-side JS on redirectTo's page ever reads it.
      return reply.redirect(`${result.redirectTo}${separatorFor(result.redirectTo)}token=${encodeURIComponent(result.token)}`, 302);
    },
  );
}
