import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { whereParams, type AdminClient } from "./admin-client.js";
import { FULL_POLICY, refuseRemovedRoles, type McpPolicy } from "./policy.js";
import { ADDITIVE, IDEMPOTENT, jsonObject, listOf, passthrough, READ_ONLY, result } from "./tool-helpers.js";

/**
 * Users' accounts (Security.md §1, §2.9, §10.4): what isn't a
 * plain row write keeps its Admin API route - an account with a password or
 * an invitation, a user's whole role set, an invitation or a reset link.
 * Reading users, renaming or deactivating them stays write_records /
 * query_records on users.
 */

interface User { id: string; email: string; name: string | null; active: boolean; roles: string[]; hasPassword: boolean; emailVerifiedAt: string | null; lastLoginAt: string | null; lockedUntil: string | null }
interface LinkDelivery { delivered: boolean; actionUrl?: string }

const summary = (u: User) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  active: u.active,
  roles: u.roles,
  status: !u.active ? "INACTIVE" : u.hasPassword ? "ACTIVE" : "INVITED",
  ...(u.lastLoginAt && { lastLoginAt: u.lastLoginAt }),
  ...(u.lockedUntil && { lockedUntil: u.lockedUntil }),
});

/** A user as summary answers it; `extra` holds the project's own columns. */
const userOutput = {
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  active: z.boolean(),
  roles: z.array(z.unknown()),
  status: z.enum(["ACTIVE", "INVITED", "INACTIVE"]),
  lastLoginAt: z.string().optional(),
  lockedUntil: z.string().optional(),
  extra: jsonObject().optional(),
};
/** An invitation or reset link: sent, or handed back as `actionUrl` to deliver by hand. */
const linkOutput = passthrough("The link's delivery", { delivered: z.boolean().optional(), actionUrl: z.string().optional() });

const delivery = () =>
  z
    .enum(["email", "link"])
    .describe("'email' sends it through the instance's mail settings (SMTP_NOT_CONFIGURED when there are none); 'link' answers the single-use link for you to hand over");

/** `extra` as the user list's query: extra[<column>]=<value>. */
function extraQuery(extra: Record<string, string> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(extra ?? {}).map(([column, value]) => [`extra[${column}]`, value]));
}

/** Each user with the columns the project added to users (read through the Data API) - none added, as they were. */
async function withProjectColumns<T extends { id: string }>(client: AdminClient, users: T[]): Promise<(T & { extra?: Record<string, unknown> })[]> {
  if (users.length === 0) return users;
  const columns = (await client.get<{ name: string }[]>("/users/project-columns")).map((c) => c.name);
  if (columns.length === 0) return users;
  const rows = await client.data<Record<string, unknown>[]>("GET", "/totalbase/table/users", {
    query: { fields: ["id", ...columns].join(","), "where[id][_in]": users.map((u) => u.id).join(","), limit: String(users.length) },
  });
  const byId = new Map(rows.map((row) => [String(row["id"]), row]));
  return users.map((user) => ({ ...user, extra: Object.fromEntries(columns.map((c) => [c, byId.get(user.id)?.[c] ?? null])) }));
}

/** The roles a table of `role` rows grants an object (`users_roles` by user, `dataviews_roles` by DataView...) - read through the Data API. */
export async function heldRoles(client: AdminClient, table: string, column: string, id: string): Promise<string[]> {
  const rows = await client.data<{ role: string }[]>("GET", `/totalbase/table/${table}`, { query: { fields: "role", limit: "500", ...whereParams({ [column]: { _eq: id } }) } });
  return rows.map((row) => row.role);
}

export function registerUserTools(server: McpServer, client: AdminClient, policy: McpPolicy = FULL_POLICY): void {
  server.registerTool(
    "list_users",
    {
      title: "List users",
      description: "Users with their status (ACTIVE, INVITED - no password yet, INACTIVE) and role ids, searched by name or email and filtered by role, or by a column the project added to users (extra: {sucursal: '<id>'}, '' for none) - each user comes with those columns' values. For TotalBase's other columns, query_records on totalbase / users.",
      inputSchema: {
        q: z.string().optional().describe("Part of the name or email"),
        status: z.enum(["ACTIVE", "INVITED", "INACTIVE"]).optional(),
        role_id: z.string().optional().describe("Only users holding this role (list_roles)"),
        extra: z.record(z.string(), z.string()).optional().describe("Columns the project added to users, each equal to this value ('' = no value)"),
        limit: z.number().int().min(1).max(200).default(50),
        offset: z.number().int().min(0).default(0),
      },
      outputSchema: listOf(z.object(userOutput)),
      annotations: READ_ONLY,
    },
    async ({ q, status, role_id, extra, limit, offset }) => {
      const query = { limit: String(limit), offset: String(offset), ...(q && { q }), ...(status && { status }), ...(role_id && { role: role_id }), ...extraQuery(extra) };
      const users = (await client.get<User[]>("/users", query)).map(summary);
      return result(await withProjectColumns(client, users));
    },
  );

  server.registerTool(
    "create_user",
    {
      title: "Create user",
      description:
        "Create a user account with its roles in one transaction. With a password it is ready to sign in (its email counts as verified). Without one it is INVITED: pass invite to send the person a single-use link to set their own password - by email, or as a link for you to hand over. A duplicate email is UNIQUE_VIOLATION. Roles decide everything the user may do: an App user's role needs app_access and its grants (grant_permission, apply_default_permissions).",
      inputSchema: {
        email: z.string().email(),
        name: z.string().max(200).optional(),
        password: z.string().optional().describe("At least auth.password_min_length characters; omit to invite instead - never invent one the person doesn't know"),
        role_ids: z.array(z.string()).optional().describe("Role ids to assign (list_roles)"),
        extra: z.record(z.string(), z.unknown()).optional().describe("Columns the project added to users (e.g. {sucursal: '<id>'}) - written through the Data API, so PostgreSQL's CHECKs and foreign keys decide"),
        invite: delivery().optional().describe("Without a password: send the invitation at once - 'email' or 'link'"),
      },
      outputSchema: { ...userOutput, invitation: linkOutput.optional() },
      annotations: ADDITIVE,
    },
    async ({ email, name, password, role_ids, extra, invite }) => {
      const user = await client.post<User>("/users", { data: { email, ...(name && { name }), ...(password && { password }), ...(role_ids && { roleIds: role_ids }) } });
      // The project's own columns: a row write like any other - the user exists even if one is refused, the error says which.
      if (extra && Object.keys(extra).length > 0) await client.data("PATCH", `/totalbase/table/users/${user.id}`, { body: { data: extra } });
      const invitation = !password && invite ? await client.post<LinkDelivery>(`/users/${user.id}/invite`, { data: { delivery: invite } }) : undefined;
      return result({ ...summary(user), ...(invitation && { invitation }) });
    },
  );

  server.registerTool(
    "set_user_roles",
    {
      title: "Set user roles",
      description:
        "Replace a user's whole role set (roles left out are removed), audited as one change. The instance owner always keeps Administrators. To add or remove one role only, write_records on users_roles ({user, role}) works too.",
      inputSchema: { user_id: z.string().describe("The user's id (list_users)"), role_ids: z.array(z.string()).describe("Every role the user should hold") },
      outputSchema: { user: z.string(), roles: z.array(z.string()) },
      annotations: IDEMPOTENT,
    },
    async ({ user_id, role_ids }) => {
      await refuseRemovedRoles(policy, "Replacing the user's roles", role_ids, () => heldRoles(client, "users_roles", "user", user_id));
      await client.put(`/users/${user_id}/roles`, { data: { roleIds: role_ids } });
      return result({ user: user_id, roles: role_ids });
    },
  );

  server.registerTool(
    "send_user_link",
    {
      title: "Send invitation or reset",
      description:
        "Issue a single-use link for a user: an invitation (set a first password - an INVITED account) or a password reset. Any earlier link of the same kind stops working.",
      inputSchema: {
        user_id: z.string().describe("The user's id (list_users)"),
        kind: z.enum(["invitation", "reset"]),
        delivery: delivery().default("email"),
      },
      outputSchema: linkOutput,
      annotations: ADDITIVE,
    },
    async ({ user_id, kind, delivery: how }) =>
      result(await client.post<LinkDelivery>(`/users/${user_id}/${kind === "invitation" ? "invite" : "reset-password"}`, { data: { delivery: how } })),
  );
}
