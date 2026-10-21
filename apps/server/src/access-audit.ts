import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AuditStatus } from "@totalbase/audit";
import { isRedactedKey, type Principal } from "@totalbase/shared";
import type { AppContext } from "./context.js";

/**
 * Audit of access-related events (Security.md §11: "Always
 * audit ... AUTH-related events"): sign-in and everything that decides who
 * can do what - users, roles, permissions, tokens, sessions, auth
 * settings, providers, secrets. One `AUTH` row per request to a route in
 * ACCESS_EVENTS, success or not (a failed or denied attempt is exactly
 * what an access review needs to see), written after the response is
 * sent so it never slows or fails the request itself.
 *
 * Unlike a Data API mutation, these are Admin API configuration changes
 * made through their own services, so the row is written right after the
 * change commits rather than inside its transaction.
 *
 * Routes add what only they know through the request:
 * - `auditPrincipal`: who acted, when the request itself doesn't say (a
 *   successful sign-in, before any session exists);
 * - `auditMetadata`: extra facts - a sign-in's email, a role change's
 *   before/after (`roles_added` / `roles_removed`, which the Members tab's
 *   access history queries).
 */

declare module "fastify" {
  interface FastifyRequest {
    auditPrincipal?: Principal;
    auditMetadata?: Record<string, unknown>;
    /**
     * The event and status when the route's own would mislead: a correct password answered with an MFA
     * challenge is `auth.mfa_challenge`, EXECUTED - a step of a sign-in, neither a sign-in nor a refusal.
     */
    auditOutcome?: { event: string; status: AuditStatus };
    /** The error code/message sent back, captured for the audit row. */
    auditError?: { code?: string | undefined; message?: string | undefined };
  }
}

/** "METHOD /route/pattern" -> event name, for every access-related mutation. */
export const ACCESS_EVENTS: Record<string, string> = {
  // Sign-in and self-service (public / data plane)
  "POST /api/auth/login": "auth.login",
  "POST /api/auth/logout": "auth.logout",
  "POST /api/auth/register": "auth.register",
  "POST /api/auth/password/forgot": "auth.password_forgot",
  "POST /api/auth/password/reset": "auth.password_reset",
  "POST /api/auth/password/change": "auth.password_change",
  "POST /api/auth/email/verify": "auth.email_verify",
  "POST /api/auth/email/resend": "auth.email_resend",
  "POST /api/auth/invitations/accept": "auth.invitation_accept",
  "GET /api/auth/oauth/:provider/callback": "auth.oauth_login",
  // Two-factor authentication (Security.md §2.17): the second step of a sign-in, and setting it up there
  "POST /api/auth/mfa/verify": "auth.mfa_verify",
  "POST /api/auth/mfa/enroll": "auth.mfa_enroll",
  "POST /api/tokens": "token.create",
  "DELETE /api/tokens/:id": "token.delete",
  "POST /api/tokens/:id/rotate": "token.rotate",
  "POST /api/tokens/:id/revoke": "token.revoke",
  // My account (a portal user's own account, Security.md §4)
  "PATCH /app/api/me": "account.update",
  "PUT /app/api/me/email": "account.email_change",
  "PUT /app/api/me/password": "account.password_change",
  "POST /app/api/me/avatar": "account.avatar_set",
  "POST /app/api/me/avatar/provider": "account.avatar_set",
  "DELETE /app/api/me/avatar": "account.avatar_remove",
  "DELETE /app/api/me/sessions/:id": "session.revoke",
  "POST /app/api/me/sessions/revoke-others": "account.sessions_revoke",
  "POST /app/api/me/mfa": "account.mfa_start",
  "POST /app/api/me/mfa/confirm": "account.mfa_enable",
  "POST /app/api/me/mfa/disable": "account.mfa_disable",
  "POST /app/api/me/mfa/recovery-codes": "account.mfa_recovery_codes",
  // Portal sign-in
  "POST /admin/api/auth/login": "auth.portal_login",
  "POST /admin/api/auth/logout": "auth.portal_logout",
  "POST /admin/api/auth/mfa/verify": "auth.portal_mfa_verify",
  // Users
  "POST /admin/api/users": "user.create",
  "PUT /admin/api/users/:id/email": "user.email_change",
  "PUT /admin/api/users/:id/password": "user.password_set",
  "POST /admin/api/users/:id/avatar": "user.avatar_set",
  "POST /admin/api/users/:id/avatar/provider": "user.avatar_set",
  "DELETE /admin/api/users/:id/avatar": "user.avatar_remove",
  "DELETE /admin/api/users/:id": "user.delete",
  "POST /admin/api/users/:id/invite": "user.invite",
  "POST /admin/api/users/:id/reset-password": "user.password_reset",
  "PUT /admin/api/users/:id/roles": "user.roles_set",
  "DELETE /admin/api/users/:id/mfa": "user.mfa_reset",
  // Delegated user administration (Security.md §9.3)
  "POST /app/api/users/invitations": "user.invite",
  "DELETE /app/api/users/:id": "user.delete",
  "POST /app/api/users/:id/invite": "user.invite",
  "POST /app/api/users/:id/reset-password": "user.password_reset",
  // Roles and permissions
  "PUT /admin/api/roles/:role/resources/:resource/permissions/:action": "permission.set",
  "PUT /admin/api/roles/:role/permissions": "permission.set",
  "DELETE /admin/api/roles/:role/resources/:resource/permissions/:action": "permission.clear",
  // Object access (Security.md §7): who may open a published DataView or Dashboard, invoke a Workflow
  "PUT /admin/api/dataviews/:id/roles": "dataview.roles_set",
  "PUT /admin/api/dashboards/:id/roles": "dashboard.roles_set",
  "PUT /admin/api/workflows/:id/roles": "workflow.roles_set",
  // Tokens and sessions (admin oversight)
  "POST /admin/api/tokens": "token.create",
  "POST /admin/api/tokens/:id/rotate": "token.rotate",
  // Configuration that decides access
  "PATCH /admin/api/settings/:group": "settings.update",
  "DELETE /admin/api/settings/:group/:key": "settings.reset",
  "PUT /admin/api/system-emails/:slot": "system_email.update",
  "DELETE /admin/api/system-emails/:slot": "system_email.reset",
  "POST /admin/api/auth-providers": "auth_provider.create",
  "PATCH /admin/api/auth-providers/:id": "auth_provider.update",
  "DELETE /admin/api/auth-providers/:id": "auth_provider.delete",
  "PUT /admin/api/secrets/:key": "secret.set",
  "DELETE /admin/api/secrets/:key": "secret.delete",
};

const MAX_STRING = 500;

/** What the caller sent: a `{ data }` envelope's content (Data_API.md §2.5); an auth route's own fields as they are. */
function bodyContent(body: unknown): unknown {
  return typeof body === "object" && body !== null && !Array.isArray(body) && Object.keys(body).length === 1 && "data" in body
    ? (body as { data: unknown }).data
    : body;
}

/** A request body safe to store: credentials redacted, long strings (template bodies) truncated. */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[…]";
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeForAudit(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        isRedactedKey(key) ? "[redacted]" : sanitizeForAudit(item, depth + 1),
      ]),
    );
  }
  return value;
}

function statusFor(code: number): AuditStatus {
  if (code < 400) return "EXECUTED";
  return code === 401 || code === 403 ? "DENIED" : "FAILED";
}

function principalFor(request: FastifyRequest): Principal {
  if (request.auditPrincipal) return request.auditPrincipal;
  if (request.admin) return { type: "ADMIN", id: request.admin.id };
  if (request.userId) return { type: "USER", id: request.userId };
  // Nobody authenticated yet (a failed sign-in, a password-reset request):
  // the metadata says who it was about, when the route knows.
  return { type: "USER", id: null };
}

export function registerAccessAudit(app: FastifyInstance, context: AppContext): void {
  app.addHook("onRequest", async (request) => {
    (request as FastifyRequest & { auditStartedAt?: Date }).auditStartedAt = new Date();
  });

  // Keep the error the caller got - onResponse no longer sees the payload.
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode >= 400 && typeof payload === "string" && ACCESS_EVENTS[`${request.method} ${request.routeOptions.url}`]) {
      try {
        const first = (JSON.parse(payload) as { errors?: Array<{ code?: string; message?: string }> }).errors?.[0];
        if (first) request.auditError = { code: first.code, message: first.message };
      } catch {
        // Not JSON - nothing more to capture.
      }
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const routeEvent = ACCESS_EVENTS[`${request.method} ${request.routeOptions.url}`];
    if (!routeEvent) return;
    const event = request.auditOutcome?.event ?? routeEvent;
    const startedAt = (request as FastifyRequest & { auditStartedAt?: Date }).auditStartedAt ?? new Date();
    try {
      await context.audit.record(context.database, {
        requestId: request.id,
        principal: principalFor(request),
        action: "AUTH",
        status: request.auditOutcome?.status ?? statusFor(reply.statusCode),
        source: request.url.startsWith("/admin/") ? "admin" : "auth",
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        payload: request.body === undefined ? undefined : sanitizeForAudit(bodyContent(request.body)),
        metadata: {
          event,
          params: request.params,
          statusCode: reply.statusCode,
          // An admin acting through a plane="ADMIN" token: the principal
          // stays the user, the token used is recorded alongside.
          ...(request.adminToken && { token: request.adminToken }),
          ...request.auditMetadata,
        },
        error: request.auditError,
        startedAt,
        finishedAt: new Date(),
      });
    } catch (err) {
      request.log.error({ err, event }, "Could not write the access audit entry");
    }
  });
}
