import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { portalAccessOf } from "@totalbase/permissions";
import type { AppContext } from "../context.js";
import { assignableRoleIds } from "@totalbase/mutations";
import { COMPANIONS, delegatedModuleActions } from "../delegated-modules.js";
import { ADMIN_SCHEMAS, adminDoc, object, ok, ref } from "../openapi-admin-docs.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { effectiveDisplayPreferences } from "../display-preferences.js";

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
      }, (reason, details) => {
        // Only the audit log learns why - the caller gets the same 401.
        request.auditMetadata = {
          ...request.auditMetadata,
          reason,
          ...(details?.lockedNow && { locked_now: true }),
          ...(details?.userId && { user_id: details.userId }),
        };
      });

      const roleIds = await context.roleAssignments.listEffectiveRolesForUser(user.id);
      const access = portalAccessOf(await context.roles.effectiveAccess(roleIds));
      request.auditPrincipal = { type: "USER", id: user.id };
      if (!access) {
        request.auditMetadata = { ...request.auditMetadata, reason: "no_portal_access" };
        await context.auth.sessions.revokeByToken(token);
        throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid email or password.", { httpStatus: 401 });
      }

      return {
        data: {
          token,
          admin: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, active: user.active, access },
        },
      };
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
              language: { type: "string", description: "The UI's language: the user's, else the instance's (Specification_Admin_UI.md §14)." },
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
        // The delegated modules this user's rail shows, and what they may do in each (Specification_Security.md §9.2).
        // assignableRoles: for a non-administrator who may assign roles, the
        // ones the guardrails let them (Specification_Security.md §9.4) - so a screen offers only those.
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
