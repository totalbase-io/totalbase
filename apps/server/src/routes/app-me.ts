import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { isTimezoneLocked, parsePreferencesPatch, resolveDisplayPreferences, type SessionStatusFilter } from "@totalbase/auth";
import type { AppContext } from "../context.js";
import { requireAppAccess } from "../auth-guards.js";
import { instanceDisplayDefaults } from "../display-preferences.js";
import { removeUserAvatar, uploadUserAvatar, useProviderAvatar } from "../user-avatars.js";

const MAX_PAGE_SIZE = 200;
const SESSION_STATUSES: readonly SessionStatusFilter[] = ["ACTIVE", "EXPIRED", "REVOKED", "ALL"];

function pageOf(query: { limit?: string; offset?: string }, defaultLimit: number): { limit: number; offset: number } {
  const limit = query.limit === undefined ? defaultLimit : Number(query.limit);
  const offset = query.offset === undefined ? 0 : Number(query.offset);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    throw new TotalBaseError("INVALID_QUERY", `limit must be between 1 and ${MAX_PAGE_SIZE}.`);
  }
  if (!Number.isInteger(offset) || offset < 0) throw new TotalBaseError("INVALID_QUERY", "offset must be 0 or more.");
  return { limit, offset };
}

/**
 * My account (Specification_Security.md §4): a portal user -
 * admin or app access - manages their own account. Every route acts on
 * the caller only (no user id in the path) and needs a session: a
 * plane="ADMIN" token is refused, the way creating tokens on /api/tokens
 * is session-only. Under /app/api, not /admin/api, which stays
 * Administrators-only (admin-access.test.ts).
 */
export function registerAppMeRoutes(app: FastifyInstance, context: AppContext): void {
  const appAccess = requireAppAccess(context);
  const preHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    await appAccess(request, reply);
    if (!request.adminSession) {
      throw new TotalBaseError("PERMISSION_DENIED", "Account settings need a signed-in session, not an API token.");
    }
  };
  const me = (request: FastifyRequest) => request.admin!.id;

  async function account(userId: string) {
    const user = await context.auth.users.findForAdmin(userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
    const [access, administrator, passwordMinLength] = await Promise.all([
      context.roles.effectiveAccess(roleIds),
      context.roles.holdsAdministratorsRole(roleIds),
      context.settings.get("auth.password_min_length"),
    ]);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      avatarUrl: user.avatarUrl,
      emailVerifiedAt: user.emailVerifiedAt,
      createdAt: user.createdAt,
      hasPassword: user.hasPassword,
      lastLoginAt: user.lastLoginAt,
      providerAvatar: user.providerAvatar,
      // The password form checks it as the user types (an app user can't read /admin/api/settings).
      passwordMinLength,
      // Which personal access tokens this account can hold (UsersApisService's own rules).
      tokens: { api: access.apiAccess, admin: administrator },
    };
  }

  app.get("/app/api/me", { preHandler }, async (request) => ({ data: await account(me(request)) }));

  app.patch<{ Body: { data?: { name?: unknown } } | undefined }>("/app/api/me", { preHandler }, async (request) => {
    const name = request.body?.data?.name;
    if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
    await context.auth.users.update(me(request), { name });
    return { data: await account(me(request)) };
  });

  // The sign-in email: the current password confirms it's really the
  // user, and the new address stays unverified until they follow the
  // verification email - unlike the admin's change, which can vouch for it.
  app.put<{ Body: { data?: { email?: unknown; currentPassword?: unknown } } | undefined }>("/app/api/me/email", { preHandler }, async (request) => {
    const body = request.body?.data;
    if (typeof body?.email !== "string") throw new TotalBaseError("INVALID_QUERY", "email is required.");
    await context.auth.assertCurrentPassword(me(request), body.currentPassword);
    const { user, previousEmail, changed } = await context.auth.users.changeEmail(me(request), body.email, { verified: false });
    request.auditMetadata = { previous_email: previousEmail, email: user.email };

    if (changed && previousEmail) await context.auth.notifyEmailChanged({ email: previousEmail, name: user.name }, user.email);
    let verificationError: string | undefined;
    if (changed) {
      try {
        await context.auth.sendEmailVerification(user.id, user.email);
      } catch (err) {
        verificationError = err instanceof TotalBaseError ? err.message : "The verification email could not be sent.";
      }
    }
    return {
      data: await account(user.id),
      meta: { verificationSent: changed && !verificationError, ...(verificationError && { verificationError }) },
    };
  });

  app.put<{ Body: { data?: { currentPassword?: unknown; password?: unknown; signOutOthers?: unknown } } | undefined }>(
    "/app/api/me/password",
    { preHandler },
    async (request, reply) => {
      const body = request.body?.data;
      const signOutOthers = body?.signOutOthers ?? true;
      if (typeof signOutOthers !== "boolean") throw new TotalBaseError("INVALID_QUERY", "signOutOthers must be true or false.");
      await context.auth.changeOwnPassword({
        userId: me(request),
        currentPassword: body?.currentPassword,
        password: body?.password,
        signOutOthers,
        keepSessionId: request.adminSession!,
      });
      request.auditMetadata = { sign_out_others: signOutOthers };
      reply.code(204);
    },
  );

  // Avatar - the same handling as the admin's (user-avatars.ts).
  app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1 } }); // user-avatars.ts enforces the real limit
    scoped.post("/app/api/me/avatar", { preHandler }, async (request) => {
      const file = await request.file();
      if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
      const avatarUrl = await uploadUserAvatar(context, me(request), await file.toBuffer(), me(request));
      request.auditMetadata = { source: "upload" };
      return { data: { avatarUrl } };
    });
  });

  app.post("/app/api/me/avatar/provider", { preHandler }, async (request) => {
    const avatarUrl = await useProviderAvatar(context, me(request));
    request.auditMetadata = { source: "provider" };
    return { data: { avatarUrl } };
  });

  app.delete("/app/api/me/avatar", { preHandler }, async (request, reply) => {
    await removeUserAvatar(context, me(request));
    reply.code(204);
  });

  // The caller's own sessions, paged in PostgreSQL (same shape as the
  // admin's GET /admin/api/sessions?user=), the current one marked.
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>("/app/api/me/sessions", { preHandler }, async (request) => {
    const { limit, offset } = pageOf(request.query, 20);
    const status = (request.query.status ?? "ACTIVE") as SessionStatusFilter;
    if (!SESSION_STATUSES.includes(status)) {
      throw new TotalBaseError("INVALID_QUERY", `status must be one of ${SESSION_STATUSES.join(", ")}.`);
    }
    const page = await context.auth.sessions.search({ user: me(request), status, q: request.query.q, limit, offset });
    return {
      data: page.sessions.map((row) => ({ ...row, current: row.id === request.adminSession })),
      meta: { total: page.total, counts: page.counts },
    };
  });

  // Another user's session id answers exactly like a missing one.
  app.delete<{ Params: { id: string } }>("/app/api/me/sessions/:id", { preHandler }, async (request, reply) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id);
    if (!uuid || !(await context.auth.sessions.revokeOwn(request.params.id, me(request)))) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "Session not found.");
    }
    reply.code(204);
  });

  app.post("/app/api/me/sessions/revoke-others", { preHandler }, async (request, reply) => {
    await context.auth.sessions.revokeAllForUser(me(request), request.adminSession);
    reply.code(204);
  });

  async function preferences(userId: string) {
    const [own, { userTimezone, ...instance }] = await Promise.all([context.auth.users.getPreferences(userId), instanceDisplayDefaults(context)]);
    const timezoneLocked = isTimezoneLocked({ timezone: instance.timezone, userTimezone });
    return { preferences: own, instance, effective: resolveDisplayPreferences(own, { ...instance, userTimezone }), timezoneLocked };
  }

  app.get("/app/api/me/preferences", { preHandler }, async (request) => ({ data: await preferences(me(request)) }));

  app.patch<{ Body: { data?: unknown } | undefined }>("/app/api/me/preferences", { preHandler }, async (request) => {
    const patch = parsePreferencesPatch(request.body?.data);
    // Choosing a timezone while the organization sets everyone's - clearing one is always allowed.
    if (typeof patch.timezone === "string" && isTimezoneLocked(await instanceDisplayDefaults(context))) {
      throw new TotalBaseError("USER_TIMEZONE_LOCKED", "Your organization sets the timezone for everyone.");
    }
    await context.auth.users.updatePreferences(me(request), patch);
    return { data: await preferences(me(request)) };
  });
}
