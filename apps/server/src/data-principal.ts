import type { DataPrincipal } from "@totalbase/mutations";
import { TotalBaseError } from "@totalbase/errors";
import type { FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { VIEW_AS_HEADER, viewAsFor } from "./view-as.js";
import { readRowByKey } from "./data-read.js";
import { readOrigin } from "./read-audit.js";
import { resolveTableResource } from "@totalbase/resources";
import { UUID_PATTERN } from "@totalbase/shared";
import { effectiveTimezone, ownTimezone } from "./display-preferences.js";

// The shape lives with the Data API writes that consume it; resolving it (sessions, tokens, execute_as) is HTTP/auth work and stays here.
export type { DataPrincipal };

/** Every API Key starts with it (@totalbase/users-apis's generateUserApiKey); a session token is 32 random bytes in base64url. */
const USER_API_KEY_PREFIX = "tb_";

/**
 * Resolves a Data Plane bearer token to either a user session or an API
 * Key - both use the same permission resolver (Data_API.md §1.1).
 *
 * Routed by shape: a token with the API Key prefix is looked up as a key
 * first, anything else only as a session (a key never lacks the prefix).
 * A prefixed token that is no key is still tried as a session - a random
 * session token can begin with "tb_" too - so what authenticates is
 * unchanged; only the usual case costs one lookup instead of two.
 */
export async function resolveDataPrincipal(context: AppContext, token: string, browserTimezone?: unknown, request?: FastifyRequest): Promise<DataPrincipal> {
  const principal = await withOnBehalfOf(context, await resolveCaller(context, token, browserTimezone), request);
  // See as (view-as.ts): an administrator's session previewing a role or a user - the resolver then decides with
  // their roles and their $USER. A token never previews.
  if (!request || request.headers[VIEW_AS_HEADER] === undefined) return principal;
  if (principal.principal.type !== "USER") throw new TotalBaseError("INVALID_VIEW_AS", "Only an administrator's session may see the App as someone else.");
  const target = await viewAsFor(context, request, principal.roleIds);
  return target ? { ...principal, roleIds: target.roleIds, userRow: target.userRow ?? principal.userRow } : principal;
}

export const ON_BEHALF_OF_HEADER = "x-totalbase-on-behalf-of";

/**
 * X-TotalBase-On-Behalf-Of (Security.md §10.3): the user the request is made for - an application's backend acting
 * because one of its users asked. The caller needs the ACT_ON_BEHALF capability (administrators have it) and must
 * be able to read the named user through their own grants on users - one read of that row by key, so a row filter
 * (`tenant = $USER.tenant`) keeps a service to its tenant. The request stays the caller's: their roles, their
 * grants, their `$USER.*`; the named user is recorded (audit, outbox, `totalbase.on_behalf_of_user_id`) and
 * nothing more. Refused: `403 ON_BEHALF_OF_DENIED`; a malformed id `400 INVALID_QUERY`.
 */
async function withOnBehalfOf(context: AppContext, principal: DataPrincipal, request: FastifyRequest | undefined): Promise<DataPrincipal> {
  const header = request?.headers[ON_BEHALF_OF_HEADER];
  if (header === undefined) return principal;
  const id = Array.isArray(header) ? header[0] : header;
  if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new TotalBaseError("INVALID_QUERY", `${ON_BEHALF_OF_HEADER} is a user id.`);
  const administrator = await context.roles.isAdministrator(principal.roleIds);
  if (!administrator && (await context.capabilityPermissions.resolve(principal.roleIds, "ACT_ON_BEHALF")) !== "ALLOW") {
    throw new TotalBaseError("ON_BEHALF_OF_DENIED", "Acting on behalf of a user needs the ACT_ON_BEHALF capability.");
  }
  try {
    const users = await resolveTableResource(context, "totalbase", "users", "GET");
    await readRowByKey(context, principal, users, id, readOrigin(request!));
  } catch {
    throw new TotalBaseError("ON_BEHALF_OF_DENIED", "You may act only on behalf of a user you can read.");
  }
  request!.onBehalfOf = id;
  return { ...principal, onBehalfOf: id };
}

async function resolveCaller(context: AppContext, token: string, browserTimezone?: unknown): Promise<DataPrincipal> {
  const looksLikeApiKey = token.startsWith(USER_API_KEY_PREFIX);
  if (looksLikeApiKey) {
    const principal = await resolveApiKeyPrincipal(context, token, browserTimezone);
    if (principal) return principal;
  }

  const sessionResult = await context.auth.sessions.validate(token);
  if (sessionResult) return sessionPrincipal(context, sessionResult, browserTimezone);

  throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid session or token.");
}

async function resolveApiKeyPrincipal(context: AppContext, token: string, browserTimezone: unknown): Promise<DataPrincipal | null> {
  const tokenResult = await context.usersApis.validate(token);
  // A plane="ADMIN" token reaches the Data API too while its owner is an
  // administrator (checked live, like the Admin API does) - it grants
  // nothing that token doesn't already hold, and lets one credential drive
  // both planes (Security.md §10: agents administer
  // through the Data API).
  if (!tokenResult || !(tokenResult.plane === "API" || (tokenResult.plane === "ADMIN" && (await context.roles.isAdministrator(tokenResult.roleIds))))) return null;
  // $USER.* is the token owner's real row, read live exactly as for a
  // session (Security.md §6.6) - never values baked into the token.
  const { rows } = await context.database.query<Record<string, unknown>>(
    `SELECT * FROM totalbase.users WHERE id = $1`,
    [tokenResult.userId],
  );
  return {
    principal: { type: "API_KEY", id: tokenResult.id },
    roleIds: tokenResult.roleIds,
    userRow: rows[0],
    actorUserId: tokenResult.userId,
    // A token is a program, not a person: the instance's zone, or the one its caller sends.
    timezone: await effectiveTimezone(context, undefined, browserTimezone),
  };
}

/**
 * The principal that queued an asynchronous call (Data_API.md
 * §10.4), resolved again when it runs: the user, or the token, as they are
 * now - a user deactivated, a token revoked or expired, a role lost since,
 * and the call runs with what is left (or not at all). Never a credential
 * stored with the execution.
 */
export async function resolveStoredPrincipal(context: AppContext, type: "USER" | "API_KEY", id: string): Promise<DataPrincipal> {
  let userId: string | undefined;
  let tokenPlane: string | undefined;
  if (type === "USER") {
    userId = id;
  } else {
    const { rows } = await context.database.query<{ user: string; plane: string }>(
      `SELECT a."user", a.plane FROM totalbase.tokens a
        WHERE a.id = $1 AND a.active AND a.revoked_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > now())`,
      [id],
    );
    userId = rows[0]?.user;
    tokenPlane = rows[0]?.plane;
  }
  const { rows } = userId
    ? await context.database.query<Record<string, unknown> & { active: boolean; can_login: boolean }>(`SELECT * FROM totalbase.users WHERE id = $1`, [userId])
    : { rows: [] };
  const userRow = rows[0];
  if (!userRow || !userRow.active || !userRow.can_login) throw new TotalBaseError("AUTHENTICATION_REQUIRED", "The caller that queued this call can no longer act.");
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(userRow.id as string);
  // A token still needs what its plane needs, checked live as on every request (UsersApisService.validate).
  if (type === "API_KEY" && (tokenPlane === "ADMIN" ? !(await context.roles.isAdministrator(roleIds)) : !(await context.roles.effectiveAccess(roleIds)).apiAccess)) {
    throw new TotalBaseError("AUTHENTICATION_REQUIRED", "The token that queued this call no longer reaches the Data API.");
  }
  return {
    principal: { type, id },
    roleIds,
    userRow,
    actorUserId: userRow.id as string,
    timezone: await effectiveTimezone(context, type === "USER" ? ownTimezone(userRow) : undefined, undefined),
  };
}

async function sessionPrincipal(context: AppContext, sessionResult: { user: { id: string }; userRow: Record<string, unknown> }, browserTimezone?: unknown): Promise<DataPrincipal> {
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(sessionResult.user.id);
  // The user's whole row, read by validate() in the same query as the session.
  const userRow = sessionResult.userRow;
  return {
    principal: { type: "USER", id: sessionResult.user.id },
    roleIds,
    userRow,
    actorUserId: sessionResult.user.id,
    timezone: await effectiveTimezone(context, ownTimezone(userRow), browserTimezone),
  };
}

/**
 * The principal of a session named by its id - a Realtime connection opened with a ticket (Security.md §2.10)
 * resolves its session this way before every delivery, under the same rules as by token: not revoked, not
 * expired, not idle past the timeout, its user active and able to sign in.
 */
export async function resolveSessionPrincipal(context: AppContext, sessionId: string): Promise<DataPrincipal> {
  const sessionResult = await context.auth.sessions.validateById(sessionId);
  if (!sessionResult) throw new TotalBaseError("AUTHENTICATION_REQUIRED", "Invalid session or token.");
  return sessionPrincipal(context, sessionResult);
}
