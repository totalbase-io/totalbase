import type { FastifyReply, FastifyRequest } from "fastify";
import type { RouteDoc } from "@totalbase/openapi";
import type { Admin } from "@totalbase/auth";
import { portalAccessOf, type PortalAccess } from "@totalbase/permissions";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";

export function extractBearerToken(request: FastifyRequest): string {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Missing bearer token.");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Missing bearer token.");
  }
  return token;
}

/** Fastify decorations set by requireUser/requireAdmin preHandlers. */
declare module "fastify" {
  interface FastifyRequest {
    userId?: string;
    admin?: Admin;
    /** Which portal the caller opens (ADMIN or APP), set by requireAdmin/requireAppAccess. */
    access?: PortalAccess;
    /** The plane="ADMIN" token the caller authenticated with (tokens.id), absent for a session - audit entries record it as `metadata.token`. */
    adminToken?: string;
    /** The caller's own session id, when authenticated by a session (not a token). */
    adminSession?: string;
  }
  interface FastifyContextConfig {
    /** Route answers without a bearer token (e.g. login) - documented as `security: []` in the Admin OpenAPI. */
    public?: boolean;
    /** OpenAPI documentation for a fixed `/api/*` route (auth, tokens, files, ...) - docs only, never validation. */
    openapi?: RouteDoc;
  }
}

/** Factory: builds a preHandler that authenticates a user bearer session. */
export function requireUser(context: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearerToken(request);
    const user = await context.auth.me(token);
    request.userId = user.id;
  };
}

/**
 * Shared token->Admin resolution for both requireAdmin and
 * requireAppAccess below - a user session, or a totalbase.tokens
 * token with plane="ADMIN" - differing only in which role check
 * `assertRole` performs. Checked live on every request, not cached at
 * login/token-creation time, so a role change immediately locks out
 * both the session and every admin-plane token affected by it.
 */
async function resolveAdmin(
  context: AppContext,
  token: string,
  assertRole: (context: AppContext, roleIds: string[]) => Promise<PortalAccess>,
): Promise<{ admin: Admin; access: PortalAccess; token?: string; session?: string }> {
  // Routed by shape, as resolveDataPrincipal does: a personal access token starts with "tb_", a session token
  // is base64url - so a token is looked up as a token first, a session as a session, not both every time.
  const fromToken = async () => {
    const tokenResult = await context.usersApis.validate(token);
    if (!tokenResult || tokenResult.plane !== "ADMIN") return null;
    // usersApis.validate() already re-checks Administrators membership
    // live for plane="ADMIN" tokens (returns null otherwise), but the
    // check is repeated here for defense in depth and to load the
    // projected Admin shape.
    const access = await assertRole(context, tokenResult.roleIds);
    const user = await context.auth.users.findById(tokenResult.userId);
    if (!user) throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid session or token.");
    return { admin: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, active: user.active }, access, token: tokenResult.id };
  };
  const fromSession = async () => {
    const sessionResult = await context.auth.sessions.validate(token);
    if (!sessionResult) return null;
    const roleIds = await context.roleAssignments.listEffectiveRolesForUser(sessionResult.user.id);
    const access = await assertRole(context, roleIds);
    const { user } = sessionResult;
    return { admin: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, active: user.active }, access, session: sessionResult.session.id };
  };
  // A session token can begin with "tb_" too (base64url), so the other path is still the fallback.
  const resolved = token.startsWith("tb_") ? (await fromToken()) ?? (await fromSession()) : (await fromSession()) ?? (await fromToken());
  if (resolved) return resolved;

  throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid session or token.");
}

/**
 * Factory: builds a preHandler that authenticates a Control Plane
 * caller and requires the active Administrators role (not merely the
 * admin_access flag, which the Workflows system role also has). This
 * gates every `/admin/api/*` route except login/logout/me - see
 * admin-access.test.ts, which checks every registered route.
 */
export function requireAdmin(context: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearerToken(request);
    const resolved = await resolveAdmin(context, token, assertAdminAccess);
    request.admin = resolved.admin;
    request.access = resolved.access;
    if (resolved.token) request.adminToken = resolved.token;
    if (resolved.session) request.adminSession = resolved.session;
  };
}

/**
 * Factory: builds a preHandler looser than requireAdmin - accepts app or
 * admin access. Gates the app surface (`/app/api/*`)
 * and GET /admin/api/auth/me, which the portal needs to decide whether
 * to show the admin or the app. A caller with neither flag is rejected
 * here, the same way it can't log into the portal at all.
 */
export function requireAppAccess(context: AppContext) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    const token = extractBearerToken(request);
    const resolved = await resolveAdmin(context, token, assertAppAccess);
    request.admin = resolved.admin;
    request.access = resolved.access;
    if (resolved.token) request.adminToken = resolved.token;
    if (resolved.session) request.adminSession = resolved.session;
  };
}

async function assertAdminAccess(context: AppContext, roleIds: string[]): Promise<PortalAccess> {
  // The Administrators role itself, not just the admin_access flag: the
  // Workflows system role carries that flag too (for its data bypass) and
  // must never reach the Admin API.
  if (!(await context.roles.holdsAdministratorsRole(roleIds))) {
    throw new TotalBaseError("PERMISSION_DENIED", "This action requires the Administrators role.");
  }
  return "ADMIN";
}

async function assertAppAccess(context: AppContext, roleIds: string[]): Promise<PortalAccess> {
  const access = portalAccessOf(await context.roles.effectiveAccess(roleIds));
  if (!access) {
    throw new TotalBaseError("PERMISSION_DENIED", "This action requires app access.");
  }
  return access;
}
