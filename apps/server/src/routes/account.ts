import multipart from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { isTimezoneLocked, parsePreferencesPatch, resolveDisplayPreferences, type SessionStatusFilter } from "@totalbase/auth";
import type { AppContext } from "../context.js";
import { dataEnvelope, type JsonSchema, type RouteDoc } from "@totalbase/openapi";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { instanceDisplayDefaults } from "../display-preferences.js";
import { removeUserAvatar, uploadUserAvatar, useProviderAvatar } from "../user-avatars.js";
import { pageOf } from "../pagination.js";
import { optionalData } from "../request-body.js";

const MAX_PAGE_SIZE = 200;
const TAG = ["account"];
const STRING: JsonSchema = { type: "string" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const body = (properties: Record<string, JsonSchema>, required: string[] = []) => ({ schema: dataEnvelope({ type: "object", required, properties }), required: required.length > 0 });
const OBJECT: JsonSchema = { type: "object", additionalProperties: true };
const answers = (schema: JsonSchema = OBJECT) => ({ status: "200" as const, schema: dataEnvelope(schema) });
const NO_CONTENT = { status: "204" as const };
const CURRENT_PASSWORD: JsonSchema = { ...STRING, description: "The account's current password - not asked of an account that has none (OAuth only)." };
const CODE: JsonSchema = { ...STRING, description: "The six digits the authenticator app shows now." };
const RECOVERY_CODES = answers({ type: "object", required: ["recoveryCodes"], properties: { recoveryCodes: { type: "array", items: STRING, description: "Shown once." } } });
const SESSION_STATUSES: readonly SessionStatusFilter[] = ["ACTIVE", "EXPIRED", "REVOKED", "ALL"];

/**
 * My account (Security.md §4): a signed-in user manages their own account. Every route acts on the caller
 * only (no user id in the path) and needs a session, never a token - the way creating tokens on /api/tokens
 * is session-only. One implementation, mounted twice:
 *
 * - `/app/api/me/*` for the portal - admin or app access (not /admin/api, which stays Administrators-only,
 *   admin-access.test.ts);
 * - `/api/auth/account/*` for any session - a user with API access alone, signed in to a frontend of the
 *   project's own (Security.md §4.1), documented in OpenAPI.
 */
export function registerAccountRoutes(app: FastifyInstance, context: AppContext): void {
  const appAccess = requireAppAccess(context);
  mountAccountRoutes(app, context, {
    prefix: "/app/api/me",
    documented: false,
    async identify(request, reply) {
      await appAccess(request, reply);
      if (!request.adminSession) {
        throw new TotalBaseError("PERMISSION_DENIED", "Account settings need a signed-in session, not an API token.");
      }
      return { userId: request.admin!.id, sessionId: request.adminSession };
    },
  });
  mountAccountRoutes(app, context, {
    prefix: "/api/auth/account",
    documented: true,
    async identify(request) {
      const result = await context.auth.sessions.validate(extractBearerToken(request));
      if (!result) throw new TotalBaseError("SESSION_EXPIRED", "Session is invalid, expired, or revoked.");
      request.userId = result.user.id;
      return { userId: result.user.id, sessionId: result.session.id };
    },
  });
}

interface AccountCaller { userId: string; sessionId: string }

interface AccountMount {
  prefix: string;
  /** Whether the routes go in the Data API's OpenAPI document (`/api/*` only). */
  documented: boolean;
  /** Who calls, by their session - throws for anyone this mount doesn't take. */
  identify(request: FastifyRequest, reply: FastifyReply): Promise<AccountCaller>;
}

const callers = new WeakMap<FastifyRequest, AccountCaller>();

function mountAccountRoutes(app: FastifyInstance, context: AppContext, mount: AccountMount): void {
  const { prefix } = mount;
  const preHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    callers.set(request, await mount.identify(request, reply));
  };
  const me = (request: FastifyRequest) => callers.get(request)!.userId;
  const session = (request: FastifyRequest) => callers.get(request)!.sessionId;
  /** A route's options: the guard, and its OpenAPI entry where this mount is documented. */
  const route = (doc: Omit<RouteDoc, "tags" | "access">) =>
    ({ preHandler, ...(mount.documented && { config: { openapi: { ...doc, tags: TAG, access: "session" as const } } }) });

  async function account(userId: string) {
    const user = await context.auth.users.findForAdmin(userId);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userId);
    const [access, administrator, passwordMinLength, mfa, password] = await Promise.all([
      context.roles.effectiveAccess(roleIds),
      context.roles.holdsAdministratorsRole(roleIds),
      context.settings.get("auth.password_min_length"),
      context.auth.mfa.status(userId),
      context.auth.passwordStatus(userId),
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
      // Password expiration (Security.md §2.20): when it was set, and when auth.password_max_age_days ends it
      // (null with the setting off, or without a password).
      passwordChangedAt: password.changedAt,
      passwordExpiresAt: password.expiresAt,
      // Which personal access tokens this account can hold (UsersApisService's own rules).
      tokens: { api: access.apiAccess, admin: administrator },
      // Two-factor authentication (Security.md §2.17): on or not, recovery codes left, whether the instance requires it.
      mfa,
    };
  }

  /** An account with a password confirms with it; one without (OAuth only) has only its session to show. */
  async function confirmIdentity(userId: string, currentPassword: unknown): Promise<void> {
    const user = await context.auth.users.findForAdmin(userId);
    if (user?.hasPassword) await context.auth.assertCurrentPassword(userId, currentPassword);
  }

  app.get(`${prefix}`, route({ summary: "My account", description: "The signed-in user's account: identity, whether a password is set, when it was set and when it expires (`passwordChangedAt`, `passwordExpiresAt` - null unless auth.password_max_age_days is on), the token planes it can hold and its two-factor status.", response: answers() }), async (request) => ({ data: await account(me(request)) }));

  app.patch<{ Body: { data?: { name?: unknown } } | undefined }>(`${prefix}`, route({ summary: "Rename my account", requestBody: body({ name: STRING }, ["name"]), response: answers() }), async (request) => {
    const name = optionalData(request.body).name;
    if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "name is required.");
    await context.auth.users.update(me(request), { name });
    return { data: await account(me(request)) };
  });

  // The sign-in email: the current password confirms it's really the
  // user, and the new address stays unverified until they follow the
  // verification email - unlike the admin's change, which can vouch for it.
  app.put<{ Body: { data?: { email?: unknown; currentPassword?: unknown } } | undefined }>(`${prefix}/email`, route({ summary: "Change my sign-in email", description: "The new address stays unverified until its verification link is followed; the old one is told. `meta.verificationSent` says whether that email left.", requestBody: body({ email: { type: "string", format: "email" }, currentPassword: CURRENT_PASSWORD }, ["email", "currentPassword"]), response: answers() }), async (request) => {
    const data = optionalData(request.body);
    if (typeof data?.email !== "string") throw new TotalBaseError("INVALID_QUERY", "email is required.");
    await context.auth.assertCurrentPassword(me(request), data.currentPassword);
    const { user, previousEmail, changed } = await context.auth.users.changeEmail(me(request), data.email, { verified: false });
    request.auditMetadata = { previous_email: previousEmail, email: user.email };

    if (changed && previousEmail) await context.auth.notifyEmailChanged({ email: previousEmail, name: user.name }, user.email);
    let verificationError: string | undefined;
    if (changed) {
      try {
        await context.auth.sendEmailVerification(user.id, user.email);
      } catch (err) {
        // The person learns it wasn't sent, never the mail server's own words (its host, its answer) - those go to the log.
        request.log.warn({ err }, "verification email after an email change failed");
        verificationError = "The verification email could not be sent - ask an administrator to check the mail settings.";
      }
    }
    return {
      data: await account(user.id),
      meta: { verificationSent: changed && !verificationError, ...(verificationError && { verificationError }) },
    };
  });

  app.put<{ Body: { data?: { currentPassword?: unknown; password?: unknown; signOutOthers?: unknown } } | undefined }>(
    `${prefix}/password`,
    route({ summary: "Change my password", description: "Signs every other session out unless `signOutOthers` is false. A wrong `currentPassword` is `400 INVALID_CURRENT_PASSWORD`; the password the account already has is `400 PASSWORD_UNCHANGED`.", requestBody: body({ currentPassword: CURRENT_PASSWORD, password: STRING, signOutOthers: BOOLEAN }, ["currentPassword", "password"]), response: NO_CONTENT }),
    async (request, reply) => {
      const data = optionalData(request.body);
      const signOutOthers = data?.signOutOthers ?? true;
      if (typeof signOutOthers !== "boolean") throw new TotalBaseError("INVALID_QUERY", "signOutOthers must be true or false.");
      await context.auth.changeOwnPassword({
        userId: me(request),
        currentPassword: data?.currentPassword,
        password: data?.password,
        signOutOthers,
        keepSessionId: session(request),
      });
      request.auditMetadata = { sign_out_others: signOutOthers };
      reply.code(204);
    },
  );

  // Two-factor authentication (Security.md §2.17): set up (a secret for the app, then its first code
  // confirms it and the recovery codes are shown once), turn off, new recovery codes.
  app.post<{ Body: { data?: { currentPassword?: unknown } } | undefined }>(`${prefix}/mfa`, route({ summary: "Start setting up two-factor authentication", description: "Answers the secret for the authenticator app (and its `otpauth://` URI); nothing is on until `mfa/confirm` takes its first code.", requestBody: body({ currentPassword: CURRENT_PASSWORD }), response: { status: "201", schema: dataEnvelope(OBJECT) } }), async (request, reply) => {
    await confirmIdentity(me(request), optionalData(request.body).currentPassword);
    const user = await context.auth.users.findById(me(request));
    const enrollment = await context.auth.mfa.startEnrollment(me(request), user!.email);
    reply.code(201);
    return { data: enrollment };
  });

  app.post<{ Body: { data?: { code?: unknown } } | undefined }>(`${prefix}/mfa/confirm`, route({ summary: "Turn two-factor authentication on", description: "With the app's first code. Answers the recovery codes, once.", requestBody: body({ code: CODE }, ["code"]), response: RECOVERY_CODES }), async (request) => {
    const recoveryCodes = await context.auth.mfa.confirmEnrollment(me(request), optionalData(request.body).code);
    return { data: { recoveryCodes } };
  });

  app.post<{ Body: { data?: { currentPassword?: unknown; code?: unknown; recoveryCode?: unknown } } | undefined }>(
    `${prefix}/mfa/disable`,
    route({ summary: "Turn two-factor authentication off", description: "Confirmed with the password and a code - or a recovery code. Refused while the instance requires a second factor of this account.", requestBody: body({ currentPassword: CURRENT_PASSWORD, code: CODE, recoveryCode: STRING }), response: NO_CONTENT }),
    async (request, reply) => {
      const data = optionalData(request.body);
      await confirmIdentity(me(request), data?.currentPassword);
      await context.auth.mfa.disable(me(request), { code: data?.code, recoveryCode: data?.recoveryCode });
      await context.auth.notifyMfaDisabled(me(request));
      reply.code(204);
    },
  );

  app.post<{ Body: { data?: { code?: unknown } } | undefined }>(`${prefix}/mfa/recovery-codes`, route({ summary: "New recovery codes", description: "Replaces the unused ones. Answers them once.", requestBody: body({ code: CODE }, ["code"]), response: RECOVERY_CODES }), async (request) => {
    const recoveryCodes = await context.auth.mfa.regenerateRecoveryCodes(me(request), optionalData(request.body).code);
    return { data: { recoveryCodes } };
  });

  // Avatar - the same handling as the admin's (user-avatars.ts).
  app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1 } }); // user-avatars.ts enforces the real limit
    scoped.post(`${prefix}/avatar`, route({ summary: "Upload my avatar", description: "A PNG, JPEG or WebP image in the multipart field `file`; replaces the current one.", requestBody: { schema: { type: "object", required: ["file"], properties: { file: { type: "string", format: "binary" } } }, contentType: "multipart/form-data" }, response: answers({ type: "object", properties: { avatarUrl: STRING } }) }), async (request) => {
      const file = await request.file();
      if (!file) throw new TotalBaseError("FILE_UPLOAD_REQUIRED", "A multipart 'file' field is required.");
      const avatarUrl = await uploadUserAvatar(context, me(request), await file.toBuffer(), me(request));
      request.auditMetadata = { source: "upload" };
      return { data: { avatarUrl } };
    });
  });

  app.post(`${prefix}/avatar/provider`, route({ summary: "Use my sign-in provider's picture as my avatar", response: answers({ type: "object", properties: { avatarUrl: STRING } }) }), async (request) => {
    const avatarUrl = await useProviderAvatar(context, me(request));
    request.auditMetadata = { source: "provider" };
    return { data: { avatarUrl } };
  });

  app.delete(`${prefix}/avatar`, route({ summary: "Remove my avatar", response: NO_CONTENT }), async (request, reply) => {
    await removeUserAvatar(context, me(request));
    reply.code(204);
  });

  // The caller's own sessions, paged in PostgreSQL (same shape as the
  // admin's GET /admin/api/sessions?user=), the current one marked.
  app.get<{ Querystring: { status?: string; q?: string; limit?: string; offset?: string } }>(`${prefix}/sessions`, route({ summary: "My sessions", description: "The caller's own sessions, the current one marked `current`; `meta.total` and `meta.counts` by status.", parameters: [{ name: "status", in: "query", schema: { type: "string", enum: [...SESSION_STATUSES] }, description: "Default ACTIVE." }, { name: "q", in: "query", schema: STRING, description: "Case-insensitive substring of the IP or the user agent." }, { name: "limit", in: "query", schema: { type: "integer" } }, { name: "offset", in: "query", schema: { type: "integer" } }], response: answers({ type: "array", items: OBJECT }) }), async (request) => {
    const { limit, offset } = pageOf(request.query, { max: MAX_PAGE_SIZE, defaultLimit: 20 });
    const status = (request.query.status ?? "ACTIVE") as SessionStatusFilter;
    if (!SESSION_STATUSES.includes(status)) {
      throw new TotalBaseError("INVALID_QUERY", `status must be one of ${SESSION_STATUSES.join(", ")}.`);
    }
    const page = await context.auth.sessions.search({ user: me(request), status, q: request.query.q, limit, offset });
    return {
      data: page.sessions.map((row) => ({ ...row, current: row.id === session(request) })),
      meta: { total: page.total, counts: page.counts },
    };
  });

  // Another user's session id answers exactly like a missing one.
  app.delete<{ Params: { id: string } }>(`${prefix}/sessions/:id`, route({ summary: "Sign one of my sessions out", description: "Someone else's session id is `404`, like one that doesn't exist.", pathParameters: { id: { schema: { type: "string", format: "uuid" } } }, response: NO_CONTENT }), async (request, reply) => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.params.id);
    if (!uuid || !(await context.auth.sessions.revokeOwn(request.params.id, me(request)))) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "Session not found.");
    }
    reply.code(204);
  });

  app.post(`${prefix}/sessions/revoke-others`, route({ summary: "Sign out everywhere else", description: "Revokes every session of the account but the one making the request.", response: NO_CONTENT }), async (request, reply) => {
    await context.auth.sessions.revokeAllForUser(me(request), session(request));
    reply.code(204);
  });

  async function preferences(userId: string) {
    const [own, { userTimezone, ...instance }] = await Promise.all([context.auth.users.getPreferences(userId), instanceDisplayDefaults(context)]);
    const timezoneLocked = isTimezoneLocked({ timezone: instance.timezone, userTimezone });
    return { preferences: own, instance, effective: resolveDisplayPreferences(own, { ...instance, userTimezone }), timezoneLocked };
  }

  app.get(`${prefix}/preferences`, route({ summary: "My display preferences", description: "The account's own (`preferences`), the instance's defaults (`instance`) and what applies (`effective`).", response: answers() }), async (request) => ({ data: await preferences(me(request)) }));

  app.patch<{ Body: { data?: unknown } | undefined }>(`${prefix}/preferences`, route({ summary: "Change my display preferences", description: "The keys sent are merged in; `null` clears one back to the instance's default.", requestBody: { schema: dataEnvelope(OBJECT) }, response: answers() }), async (request) => {
    const patch = parsePreferencesPatch(request.body?.data);
    // Choosing a timezone while the organization sets everyone's - clearing one is always allowed.
    if (typeof patch.timezone === "string" && isTimezoneLocked(await instanceDisplayDefaults(context))) {
      throw new TotalBaseError("USER_TIMEZONE_LOCKED", "Your organization sets the timezone for everyone.");
    }
    await context.auth.users.updatePreferences(me(request), patch);
    return { data: await preferences(me(request)) };
  });
}
