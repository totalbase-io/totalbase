import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { portalAccessOf } from "@totalbase/permissions";
import type { AppContext } from "../context.js";
import { assignableRoleIds } from "@totalbase/mutations";
import { COMPANIONS, delegatedModuleActions } from "../delegated-modules.js";
import { ADMIN_SCHEMAS, adminDoc, object, ok, ref } from "../openapi-admin-docs.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { effectiveDisplayPreferences } from "../display-preferences.js";
import { auditMfaChallenge, recordSecondStep, recordSignInFailure } from "./api-auth.js";
import type { SignInAdmission, User } from "@totalbase/auth";

/** The portal's admission: admin or app access, checked before a session or an MFA challenge exists. */
function portalAdmission(context: AppContext): SignInAdmission {
  return async (userId) => {
    const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
    return portalAccessOf(await context.roles.effectiveAccess(roleIds)) ? null : "no_portal_access";
  };
}

/** What the portal's sign-in returns about the user - `access` is a routing hint, re-checked on every request. */
async function adminProfile(context: AppContext, user: User) {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(user.id);
  const access = portalAccessOf(await context.roles.effectiveAccess(roleIds));
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, active: user.active, access };
}

/**
 * Control Plane authentication. Since admins and users became one identity, "logging in as
 * admin" is just AuthService.login() against totalbase.users -
 * there is no separate admin identity anymore. Login requires admin or
 * app access (RolesService.effectiveAccess) - a user
 * without either gets the same generic 401 as a wrong password. The
 * response carries `access` so the portal knows whether to open the
 * admin or the app; it's only a routing hint - every request re-checks
 * access server-side.
 */
export function registerAdminAuthRoutes(app: FastifyInstance, context: AppContext): void {
  app.post<{ Body: { email: string; password: string } }>(
    "/admin/api/auth/login",
    {
      config: {
        public: true,
        openapi: {
          summary: "Sign in to the admin",
          tags: ["auth"],
          access: "public",
          requestBody: { schema: object({ email: { type: "string", format: "email" }, password: { type: "string" } }, ["email", "password"]) },
          response: ok(object({ token: { type: "string" }, admin: ref("AdminProfile") })),
          schemas: ADMIN_SCHEMAS,
        },
      },
    },
    async (request) => {
      request.auditMetadata = { email: request.body?.email };
      const { token, user } = await context.auth.login({
        email: request.body.email,
        password: request.body.password,
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        surface: "PORTAL",
        admit: portalAdmission(context),
      }, recordSignInFailure(request), recordSecondStep(request)).catch((error: unknown) => auditMfaChallenge(request, error));
      request.auditPrincipal = { type: "USER", id: user.id };
      return { data: { token, admin: await adminProfile(context, user) } };
    },
  );

  // The portal's second step (Security.md §2.17) - the same as /api/auth/mfa/verify, answered like the
  // portal's sign-in; an enrollment challenge is started with /api/auth/mfa/enroll.
  app.post<{ Body: { challenge?: unknown; code?: unknown; recoveryCode?: unknown } }>(
    "/admin/api/auth/mfa/verify",
    {
      config: {
        public: true,
        openapi: {
          summary: "Finish signing in to the admin with a two-factor code",
          description:
            "After `403 MFA_REQUIRED` or `MFA_ENROLLMENT_REQUIRED` from `POST /admin/api/auth/login`: the challenge and the app's code " +
            "(or a recovery code). `recoveryCodes` only when this step finished an enrollment - shown once. 401 INVALID_MFA_CODE, " +
            "401 INVALID_MFA_CHALLENGE.",
          tags: ["auth"],
          access: "public",
          requestBody: {
            schema: object({ challenge: { type: "string" }, code: { type: "string" }, recoveryCode: { type: "string" } }, ["challenge"]),
          },
          response: ok(object({ token: { type: "string" }, admin: ref("AdminProfile"), recoveryCodes: { type: ["array", "null"], items: { type: "string" } } })),
          schemas: ADMIN_SCHEMAS,
        },
      },
    },
    async (request) => {
      const result = await context.auth.completeMfaSignIn({
        challenge: request.body?.challenge,
        code: request.body?.code,
        recoveryCode: request.body?.recoveryCode,
        surface: "PORTAL",
        admit: portalAdmission(context),
        ip: request.ip,
        userAgent: request.headers["user-agent"],
      }, recordSignInFailure(request));
      request.auditPrincipal = { type: "USER", id: result.user.id };
      if (result.usedRecoveryCode) request.auditMetadata = { ...request.auditMetadata, recovery_code: true };
      if (result.recoveryCodes) request.auditMetadata = { ...request.auditMetadata, enrolled: true };
      return { data: { token: result.token, admin: await adminProfile(context, result.user), recoveryCodes: result.recoveryCodes } };
    },
  );

  app.post("/admin/api/auth/logout", adminDoc("auth", {
    summary: "Sign out of the admin",
    response: { status: "204" },
  }), async (request, reply) => {
    const token = extractBearerToken(request);
    await context.auth.logout(token);
    return reply.code(204).send();
  });

  app.get(
    "/admin/api/auth/me",
    {
      preHandler: requireAppAccess(context),
      ...adminDoc("auth", {
        summary: "The signed-in admin",
        response: ok({
          allOf: [ref("AdminProfile"), object({
            environment: { type: "string" },
            publicUrl: { type: "string", format: "uri" },
            display: object({
              timezone: { type: "string", description: "IANA zone; empty = the browser's." },
              dateFormat: { type: "string", description: "date-fns pattern; empty = the raw value." },
              timeFormat: { type: "string" },
              datetimeFormat: { type: "string" },
              language: { type: "string", description: "The UI's language: the user's, else the instance's (Admin_UI.md §14)." },
            }),
            modules: { type: "array", items: { type: "string", enum: ["users", "roles", "files", "templates", "logs"] }, description: "Delegated modules this user's rail shows." },
            moduleActions: {
              type: "object",
              description: "Per delegated module, the actions the user may take on its table.",
              additionalProperties: { type: "array", items: { type: "string", enum: ["READ", "CREATE", "UPDATE", "DELETE"] } },
            },
            assignableRoles: { type: ["array", "null"], items: { type: "string", format: "uuid" }, description: "For a non-administrator who may assign roles: the roles they may assign (created by them, or managed by one of their roles). Null otherwise - an administrator assigns every role." },
          })],
        }),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    // environment rides along with the admin profile rather than a
    // separate endpoint - the navbar's environment badge needs it exactly
    // when it already fetches the session, and it's not sensitive enough
    // to warrant its own auth-gated route.
    // publicUrl likewise: system.public_url with its env fallback already
    // resolved, for screens that show absolute API URLs (Endpoints).
    // display: the caller's effective timezone/date formats (their My
    // account preferences over Settings > General) - an app user can't
    // read /admin/api/settings, so every portal user gets them here.
    async (request) => ({
      data: {
        ...request.admin,
        access: request.access,
        environment: context.nodeEnv,
        publicUrl: await context.auth.mailer.publicUrl(),
        display: await effectiveDisplayPreferences(context, request.admin!.id),
        // The delegated modules this user's rail shows, and what they may do in each (Security.md §9.2).
        // assignableRoles: for a non-administrator who may assign roles, the
        // ones the guardrails let them (Security.md §9.4) - so a screen offers only those.
        ...(await (async () => {
          const roleIds = await context.roleAssignments.listEffectiveRolesForUser(request.admin!.id);
          const moduleActions = await delegatedModuleActions(context, roleIds);
          const assignableRoles = request.access !== "ADMIN" && moduleActions.assignments
            ? await assignableRoleIds(context.database, { actorUserId: request.admin!.id, roleIds })
            : null;
          return { modules: Object.keys(moduleActions).filter((key) => !(COMPANIONS as string[]).includes(key)), moduleActions, assignableRoles };
        })()),
      },
    }),
  );
}
