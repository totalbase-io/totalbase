import type { FastifyInstance, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { lockdownState, type LockdownState } from "@totalbase/settings";
import { isServerRequest } from "./admin-ui.js";
import { extractBearerToken } from "./auth-guards.js";
import { clientIp } from "./client-ip.js";
import type { AppContext } from "./context.js";

/**
 * Lockdown (Security.md §2.21): while it is on - now, or inside its scheduled or repeating window - the instance
 * answers administrators only (and the roles the operator listed) - or, read-only, everyone's reads. Decided here, once, for every request: by who calls, not by which path, since
 * the admin itself reads through the Data API. Nothing is stored when a window starts or ends; the state is
 * computed from the settings' cache on each request (settings/lockdown.ts).
 */

/** The lockdown now: its state, and what it does while it is on. */
export interface CurrentLockdown extends LockdownState {
  /** READ_ONLY (`lockdown.mode`): everyone's reads are answered, and only who gets in writes. */
  readOnly: boolean;
  /** The operator's message for whoever is refused. */
  message: string;
  /** Role ids answered beside Administrators. */
  allowedRoles: string[];
  /** Scheduled and event-driven workflows wait for its end. */
  pauseWorkflows: boolean;
  /** How long before a scheduled one its users are told; 0 = they are not. */
  noticeMinutes: number;
}

export async function currentLockdown(context: Pick<AppContext, "settings">): Promise<CurrentLockdown> {
  const [enabled, when, mode, from, until, schedule, minutes, timeZone, message, allowedRoles, pauseWorkflows, noticeMinutes] = await Promise.all([
    context.settings.get("lockdown.enabled"),
    context.settings.get("lockdown.when"),
    context.settings.get("lockdown.mode"),
    context.settings.get("lockdown.from"),
    context.settings.get("lockdown.until"),
    context.settings.get("lockdown.recurring_schedule"),
    context.settings.get("lockdown.recurring_minutes"),
    context.settings.get("system.timezone"),
    context.settings.get("lockdown.message"),
    context.settings.get("lockdown.allowed_roles"),
    context.settings.get("lockdown.pause_workflows"),
    context.settings.get("lockdown.notice_minutes"),
  ]);
  const state = lockdownState({ enabled, when, from, until, recurring: { schedule, minutes, timeZone: timeZone || "UTC" } }, Date.now());
  return { ...state, readOnly: mode === "READ_ONLY", message, allowedRoles, pauseWorkflows, noticeMinutes };
}

/**
 * Whether workflows wait (`lockdown.pause_workflows`, during a lockdown): the CRON tick skips its occurrences and
 * a database event stays PENDING in the outbox - the durable queue - until the fallback poll takes it after the
 * end (index.ts, context.ts). A run an administrator starts by hand is a request, and runs.
 */
export async function lockdownPausesWorkflows(context: Pick<AppContext, "settings">): Promise<boolean> {
  const state = await currentLockdown(context);
  return state.active && state.pauseWorkflows;
}

/** The refusal: 503, the operator's message after the fixed line, and - for a window - when it ends. */
export function lockdownError(state: CurrentLockdown): TotalBaseError {
  const line = state.readOnly ? "This instance is in lockdown, read-only: only administrators can change anything." : "This instance is in lockdown: only administrators are answered.";
  return new TotalBaseError("LOCKDOWN", `${line}${state.message ? ` ${state.message}` : ""}`, {
    meta: {
      mode: state.readOnly ? "READ_ONLY" : "FULL",
      ...(state.endsAt !== null && { until: new Date(state.endsAt).toISOString(), retryAfterSeconds: Math.max(1, Math.ceil((state.endsAt - Date.now()) / 1000)) }),
    },
  });
}

/** A credential as a WebSocket keeps it (realtime.ts): a token with the address it came from, or a session's id. */
type Credential = { token: string; address: string | undefined } | { session: string };

/** Whether these roles get in during this lockdown: Administrators, or a role the operator listed (`lockdown.allowed_roles`). */
async function rolesAdmitted(context: AppContext, state: CurrentLockdown, roleIds: string[]): Promise<boolean> {
  return roleIds.some((id) => state.allowedRoles.includes(id)) || context.roles.holdsAdministratorsRole(roleIds);
}

/**
 * Whether the credential gets in, as a lockdown asks. An administrator's: a session of a user holding
 * Administrators, or their plane="ADMIN" token - a plane="API" token of theirs never is: it is an integration,
 * which is what a lockdown stops. A listed role's (`lockdown.allowed_roles`): any session or token of a user
 * holding it - the operator chose to let them in, as themselves. An unknown, expired or refused credential is nobody's.
 */
export async function isAdmittedCredential(context: AppContext, state: CurrentLockdown, credential: Credential): Promise<boolean> {
  const listed = (roleIds: string[]) => roleIds.some((id) => state.allowedRoles.includes(id));
  const bySessionUser = async (userId: string) => rolesAdmitted(context, state, await context.roleAssignments.listEffectiveRolesForUser(userId));
  try {
    if ("session" in credential) {
      const session = await context.auth.sessions.validateById(credential.session);
      return session !== null && (await bySessionUser(session.user.id));
    }
    const { token, address } = credential;
    const byToken = async () => {
      const found = await context.usersApis.validate(token, address);
      if (!found) return null;
      return listed(found.roleIds) || (found.plane === "ADMIN" && (await context.roles.holdsAdministratorsRole(found.roleIds)));
    };
    const bySession = async () => {
      const found = await context.auth.sessions.validate(token);
      return found ? bySessionUser(found.user.id) : null;
    };
    // Routed by shape, as resolveDataPrincipal does: a token starts with "tb_", and a session token may too.
    return (token.startsWith("tb_") ? (await byToken()) ?? (await bySession()) : (await bySession()) ?? (await byToken())) === true;
  } catch {
    return false;
  }
}

/**
 * The lockdown's refusal for a credential, or null: no lockdown, or one that gets in. `write`: what is asked
 * changes something - a read-only lockdown refuses only that.
 */
export async function lockdownRefusal(context: AppContext, credential: Credential | null, write = false): Promise<TotalBaseError | null> {
  const state = await currentLockdown(context);
  if (!state.active || (state.readOnly && !write)) return null;
  return credential !== null && (await isAdmittedCredential(context, state, credential)) ? null : lockdownError(state);
}

/**
 * A sign-in's admission during a lockdown (the `admit` of login, its second step and its password step): a user
 * who holds neither Administrators nor a listed role is told so once the password matched, before a session or a
 * challenge exists.
 */
export async function assertLockdownAdmits(context: AppContext, roleIds: string[]): Promise<void> {
  const state = await currentLockdown(context);
  // Read-only: everyone signs in - a session is TotalBase's own record, not a change of the data.
  if (state.active && !state.readOnly && !(await rolesAdmitted(context, state, roleIds))) throw lockdownError(state);
}

/** Whether a lockdown keeps this user from signing in - for a sign-in that answers with a redirect (OAuth). */
export async function lockdownKeepsOut(context: AppContext, userId: string): Promise<boolean> {
  const state = await currentLockdown(context);
  if (!state.active || state.readOnly) return false;
  return !(await rolesAdmitted(context, state, await context.roleAssignments.listEffectiveRolesForUser(userId)));
}

/**
 * Answered to anyone during a lockdown: what an administrator needs to get in (the sign-in page's own reads, the
 * sign-in routes - which admit administrators only, assertLockdownAdmits - and the recovery of a forgotten
 * password, so a lockdown can never shut its own administrators out), signing out, and a link that is its own
 * credential for something an administrator made. Liveness and readiness stay too: a load balancer that saw the
 * instance as down would keep administrators out with everyone else.
 */
const OPEN_ROUTES = new Set([
  "GET /health/live",
  "GET /health/ready",
  "GET /api/instance",
  "GET /api/setup",
  "POST /api/setup",
  "POST /admin/api/auth/login",
  "POST /admin/api/auth/mfa/verify",
  "POST /admin/api/auth/password/renew",
  "POST /admin/api/auth/logout",
  "POST /api/auth/login",
  "POST /api/auth/mfa/enroll",
  "POST /api/auth/mfa/verify",
  "POST /api/auth/password/renew",
  "POST /api/auth/password/forgot",
  "POST /api/auth/password/reset",
  "POST /api/auth/logout",
  "GET /api/auth/oauth/:provider",
  "GET /api/auth/oauth/:provider/callback",
  "GET /admin/api/backups/:id/archive",
  // WebSockets authenticate by their first message as well as by the upgrade: every credential they take goes
  // through resolveSubscriberPrincipal (realtime.ts), which refuses during a lockdown.
  "GET /api/realtime",
  "GET /api/graphql",
]);

/**
 * Answered during a lockdown as to a visitor with no credential: a file's bytes, which the sign-in page needs
 * for the instance's mark and background - PUBLIC files only, whoever asks.
 */
const ANONYMOUS_ROUTES = new Set(["GET /api/totalbase/table/files/:id"]);

/**
 * Read-only (`lockdown.mode` READ_ONLY): what is a read. A GET is, by HTTP's own rule - but the one below, which
 * starts a workflow. Any other method is a write unless its route is listed here: reads that take a body (a
 * widget's data with its variables, a rendered PDF), the audit entry of a read (an export), and GraphQL, whose
 * mutations are refused where they run (routes/graphql.ts). A new POST route is a write until it is listed.
 * Calling a function is always a write: only PostgreSQL knows what it does.
 */
const READ_ROUTES = new Set([
  "POST /api/graphql",
  "POST /api/auth/realtime-ticket",
  "POST /api/totalbase/table/templates/:id/pdf",
  "POST /app/api/templates/preview-pdf",
  "POST /app/api/audit/events",
  "POST /app/api/dashboards/:slug/variables/:name/options",
  "POST /app/api/dashboards/:slug/widgets/:widgetId/data",
  "POST /app/api/dashboards/:slug/widgets/:widgetId/exports",
  "POST /embed/api/dashboard/variables/:name/options",
  "POST /embed/api/dashboard/widgets/:widgetId/data",
  "POST /embed/api/dashboard/widgets/:widgetId/exports",
]);
const WRITING_GETS = new Set(["GET /api/workflows/:slug/webhook"]);

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the gate on a request a read-only lockdown let through as a read: what it would refuse a write with. */
    lockdownReadOnly?: CurrentLockdown;
  }
}

/** Refuses a write made inside a request the gate let through as a read (a GraphQL mutation). */
export function assertLockdownAllowsWrite(request: FastifyRequest): void {
  if (request.lockdownReadOnly) throw lockdownError(request.lockdownReadOnly);
}

function routeKey(request: FastifyRequest): string {
  return `${request.method === "HEAD" ? "GET" : request.method} ${request.routeOptions.url ?? ""}`;
}

/** The credential the request carries, or null. */
function requestCredential(request: FastifyRequest): Credential | null {
  try {
    return { token: extractBearerToken(request), address: clientIp(request) };
  } catch {
    return null;
  }
}

/**
 * The gate: registered after the hardening hooks, so CORS, the request limits and the rate limit come first. With
 * no lockdown it costs its cached settings; during one, a caller's credential is looked up here before its
 * route does - a new route is closed unless it is listed above.
 */
export function registerLockdown(app: FastifyInstance, context: AppContext): void {
  app.addHook("onRequest", async (request) => {
    if (!isServerRequest(request)) return;
    const state = await currentLockdown(context);
    if (!state.active) return;
    const route = routeKey(request);
    if (OPEN_ROUTES.has(route)) return;
    const credential = requestCredential(request);
    if (credential !== null && (await isAdmittedCredential(context, state, credential))) return;
    if (state.readOnly) {
      const read = request.method === "GET" || request.method === "HEAD" ? !WRITING_GETS.has(route) : READ_ROUTES.has(route);
      if (!read) throw lockdownError(state);
      request.lockdownReadOnly = state;
      return;
    }
    if (ANONYMOUS_ROUTES.has(route)) {
      delete request.headers.authorization;
      delete request.headers.cookie;
      return;
    }
    throw lockdownError(state);
  });
}
