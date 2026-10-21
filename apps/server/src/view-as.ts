import type { FastifyInstance, FastifyRequest } from "fastify";
import { DENIED_FOR_CALLER, TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";

/**
 * See as (Security.md §8.4): an administrator opens the App as a role or a user sees it. The admin
 * sends `X-TotalBase-View-As: role:<id>` or `user:<id>` on its App and Data API requests; the caller's role set is
 * replaced - and, for a user, `$USER` is theirs - before the Permission Resolver runs, so a preview is the real
 * evaluation, never a second path. Only an administrator's own session may ask; a preview never writes.
 */
export const VIEW_AS_HEADER = "x-totalbase-view-as";

export interface ViewAsTarget {
  kind: "role" | "user";
  id: string;
  name: string;
  roleIds: string[];
  /** A user's row - their `$USER`; null for a role, whose `$USER` stays the administrator's. */
  userRow: Record<string, unknown> | null;
  /** The target's roles by name - what a refusal names while previewing ("No READ grant on ... for Technician"). */
  roleNames: string[];
}

/** The preview a request ran under, once resolved - read by the error handler to name the role a refusal is about. */
const PREVIEWS = new WeakMap<FastifyRequest, ViewAsTarget>();
export function viewAsTargetOf(request: FastifyRequest): ViewAsTarget | undefined {
  return PREVIEWS.get(request);
}

async function roleNamesOf(context: AppContext, roleIds: string[]): Promise<string[]> {
  const { rows } = await context.database.query<{ name: string }>(`SELECT name FROM totalbase.roles WHERE id = ANY($1::uuid[]) ORDER BY name`, [roleIds]);
  return rows.map((r) => r.name);
}

const PATTERN = /^(role|user):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/** The header as asked - null without one. */
function asked(request: FastifyRequest): { kind: "role" | "user"; id: string } | null {
  const value = request.headers[VIEW_AS_HEADER];
  if (typeof value !== "string" || value === "") return null;
  const match = PATTERN.exec(value.trim());
  if (!match) throw new TotalBaseError("INVALID_VIEW_AS", `${VIEW_AS_HEADER} is role:<id> or user:<id>.`);
  return { kind: match[1]!.toLowerCase() as "role" | "user", id: match[2]! };
}

/** Who a preview shows: an active role, or an active user with their effective roles. */
export async function loadViewAsTarget(context: AppContext, kind: "role" | "user", id: string): Promise<ViewAsTarget> {
  if (kind === "role") {
    const { rows } = await context.database.query<{ name: string }>(`SELECT name FROM totalbase.roles WHERE id = $1 AND active`, [id]);
    if (!rows[0]) throw new TotalBaseError("INVALID_VIEW_AS", "No active role with that id.");
    return { kind, id, name: rows[0].name, roleIds: [id], userRow: null, roleNames: [rows[0].name] };
  }
  const { rows } = await context.database.query<Record<string, unknown>>(`SELECT * FROM totalbase.users WHERE id = $1 AND active`, [id]);
  const userRow = rows[0];
  if (!userRow) throw new TotalBaseError("INVALID_VIEW_AS", "No active user with that id.");
  const name = (typeof userRow["name"] === "string" && userRow["name"]) || String(userRow["email"]);
  const roleIds = await context.roleAssignments.listEffectiveRolesForUser(id);
  return { kind, id, name, roleIds, userRow, roleNames: await roleNamesOf(context, roleIds) };
}

/**
 * The preview a request asks for, once its real caller is known: null without the header; refused when the
 * caller isn't an administrator (a header never widens anyone's access - it only narrows an administrator's).
 */
export async function viewAsFor(context: AppContext, request: FastifyRequest, callerRoleIds: string[]): Promise<ViewAsTarget | null> {
  const target = asked(request);
  if (!target) return null;
  if (!(await context.roles.isAdministrator(callerRoleIds))) throw new TotalBaseError("INVALID_VIEW_AS", "Only an administrator may see the App as someone else.");
  const loaded = await loadViewAsTarget(context, target.kind, target.id);
  PREVIEWS.set(request, loaded);
  return loaded;
}

/** A refusal while previewing names the previewed roles in place of "your roles" - the administrator's fix at once. */
export function nameRolesInRefusal(request: FastifyRequest, message: string): string {
  const target = PREVIEWS.get(request);
  if (!target || !message.endsWith(` ${DENIED_FOR_CALLER}.`)) return message;
  const who = target.roleNames.length ? target.roleNames.join(", ") : `${target.name} (no roles)`;
  return `${message.slice(0, -(DENIED_FOR_CALLER.length + 1))}for ${who}.`;
}

/** What a preview may still send: signing out, the administrator's own grid layout, and a PDF rendered to look at. */
const ALLOWED_WRITES = [/^\/api\/auth\/logout$/, /^\/app\/api\/dataviews\/[^/]+\/user-prefs$/, /^\/app\/api\/templates\/preview-pdf$/];

/** A preview never writes: every other non-read request to the App or the Data API carrying the header is refused. */
export function registerViewAsGuard(app: FastifyInstance): void {
  app.addHook("onRequest", async (request) => {
    if (request.headers[VIEW_AS_HEADER] === undefined) return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const path = request.url.split("?")[0]!;
    if (!path.startsWith("/api/") && !path.startsWith("/app/api/")) return;
    if (ALLOWED_WRITES.some((pattern) => pattern.test(path))) return;
    throw new TotalBaseError("VIEW_AS_READ_ONLY", "Seeing the App as someone else is read-only: nothing is saved.");
  });
}
