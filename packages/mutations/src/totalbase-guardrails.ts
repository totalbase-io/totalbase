import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { rolesManagedBySql, type PermissionDecision } from "@totalbase/permissions";
import type { ResolvedResource } from "@totalbase/query-engine";

/**
 * Hard-coded privilege-escalation guardrails for the "expose totalbase
 * tables via the Data API" work (see the chat that designed this).
 *
 * RolesService already refuses to touch a reserved role, and never
 * sets admin_access (packages/permissions/src/roles-service.ts) -
 * but that's the Admin API's own path. The Data API's generic mutation
 * engine (executeCreate/executeUpdate/executeDelete in
 * mutation-service.ts, plus nested-write-service.ts and
 * transaction-service.ts) talks directly to whatever table is exposed
 * as a totalbase.resources row - it does not go through RolesService at
 * all, so once totalbase.roles/users_roles are exposed, a role holding
 * an ordinary CREATE/UPDATE grant on them (however that grant got
 * configured - row filters and field grants both operator-controlled)
 * would otherwise be able to mint or assign an admin role. This module
 * is the equivalent floor for that path: not configuration, always on,
 * regardless of what any role's permission grant says.
 */

/**
 * Columns on totalbase.roles the Data API must never be able to
 * set, no matter what field grants a role holds. All three access flags
 * are blocked, not just admin_access: the CHECK constraint already keeps
 * admin_access off non-reserved roles, but app_access/api_access decide
 * who can sign in at all - role access is managed through the Admin API
 * only.
 */
// `created_by` too: PostgreSQL records a role's creator itself, never the payload.
const ROLES_PROTECTED_COLUMNS = ["admin_access", "app_access", "api_access", "reserved", "created_by", "review_required"];

/**
 * Columns that must never be readable or writable through the Data API,
 * no matter what a role's field grant says - shown in the Admin UI's
 * field-grant checklist (disabled, with an explanatory tooltip) rather
 * than hidden, per the chat that designed this, but the actual
 * enforcement is entirely here, not in the UI.
 */
const PROTECTED_FIELDS: Record<string, string[]> = {
  "totalbase.users": ["password_hash"],
  "totalbase.sessions": ["token_hash"],
  "totalbase.emails_tokens": ["token_hash"],
  "totalbase.tokens": ["key_hash", "previous_key_hash"],
  "totalbase.secrets": ["ciphertext"],
  // Writing storage_key would repoint a file at another file's stored content.
  "totalbase.files": ["storage_provider", "storage_key"],
  // The Data API never exposes generated SQL (AGENTS.md section 20) - an
  // administrator reads it through the Admin API's log detail.
  "totalbase.logs": ["sql_text", "sql_params"],
};

/** Whether `schema.table.field` is a protected column (PROTECTED_FIELDS) - never readable or writable through the Data API. */
export function isProtectedField(schema: string, table: string, field: string): boolean {
  return PROTECTED_FIELDS[`${schema}.${table}`]?.includes(field) ?? false;
}

/** `row` without `root`'s protected columns (PROTECTED_FIELDS) - what an audit entry or an outbox event may record. */
export function withoutProtectedFields(root: ResolvedResource, row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  const protectedFields = PROTECTED_FIELDS[`${root.schema}.${root.table}`];
  if (!row || !protectedFields) return row;
  const clean = { ...row };
  for (const field of protectedFields) delete clean[field];
  return clean;
}

/**
 * Wraps an EffectivePermission's fieldDecision so a protected column
 * (see PROTECTED_FIELDS) always resolves to DENY, regardless of what
 * totalbase.permissions.field_overrides says - apply this everywhere
 * `permission.fieldDecision` is handed to the query engine (every
 * CREATE/READ/UPDATE call site), not just one of them, since each is
 * an independent path to the same columns.
 */
export function protectedFieldDecision(
  root: ResolvedResource,
  fieldDecision: (field: string) => PermissionDecision,
): (field: string) => PermissionDecision {
  const protectedFields = PROTECTED_FIELDS[`${root.schema}.${root.table}`];
  if (!protectedFields) return fieldDecision;
  return (field: string) => (protectedFields.includes(field) ? "DENY" : fieldDecision(field));
}

/**
 * Tables written by administrators only, whatever a role's grant on them
 * says (Security.md §10.2, §10.3). Readable under
 * ordinary permissions like any exposed table.
 *
 * - Rows that grant access: data permissions, the transactions
 *   capability, object access to DataViews, Dashboards, Workflows and the
 *   App menu, role managers, resource exposure - writing one IS granting
 *   access (for a dashboard, object access is the only gate).
 * - Rows that decide how the system behaves or who someone is: settings,
 *   sign-in providers and linked identities (a row linking a provider
 *   account to someone else's user is a sign-in as them), secrets, the
 *   columns kept out of the audit log, and TotalBase's own bookkeeping (migrations,
 *   outbox, idempotency keys, executions).
 */
const ADMIN_WRITTEN_TABLES = new Set([
  "permissions",
  "roles_capabilities",
  "dataviews_roles",
  "dashboards_roles",
  "workflows_roles",
  "menus",
  "roles_managers",
  // Which roles no user may hold together - a segregation-of-duties rule (Security.md §1.9).
  "roles_incompatibilities",
  "resources",
  "settings",
  "providers",
  "identities",
  "secrets",
  "audits_exclusions",
  "migrations",
  "outbox",
  "idempotency_keys",
  "executions",
  // An attestation of who holds a role (Security.md §1.8).
  "roles_reviews",
]);

/** Throws unless the caller is an administrator when `root` is an administrator-written table (see ADMIN_WRITTEN_TABLES). */
export async function assertAdminWrittenTable(
  isAdministrators: (roleIds: string[]) => Promise<boolean>,
  roleIds: string[],
  root: ResolvedResource,
): Promise<void> {
  if (root.schema !== "totalbase" || !ADMIN_WRITTEN_TABLES.has(root.table)) return;
  if (await isAdministrators(roleIds)) return;
  throw new TotalBaseError(
    "PERMISSION_DENIED",
    `totalbase.${root.table} is written by administrators only.`,
  );
}

/**
 * totalbase.settings is read through the Data API but written
 * only through the Admin API (PATCH /admin/api/settings/{group}) - by an
 * administrator too: that route checks every value against the settings
 * registry (type, bounds, known key) and keeps the settings a token may
 * not change (sql_console.token_access) to a signed-in session. A row
 * write here would skip both.
 */
export function assertNotSettingsWrite(root: ResolvedResource): void {
  if (root.schema !== "totalbase" || root.table !== "settings") return;
  throw new TotalBaseError(
    "PERMISSION_DENIED",
    "totalbase.settings is changed through the Admin API (/admin/api/settings), which validates every value.",
  );
}

// TotalBase's own tables live in the `totalbase` schema since migration
// 000084 - matching on `public` here silently disabled every guardrail
// below for the moved tables.
function isRolesTable(root: ResolvedResource): boolean {
  return root.schema === "totalbase" && root.table === "roles";
}
function isUsersRolesTable(root: ResolvedResource): boolean {
  return root.schema === "totalbase" && root.table === "users_roles";
}

/** An administrator sets a role's app/API access and whether it's reviewed through the Data API too; admin_access (reserved-only, a CHECK), reserved and created_by stay out of every payload. */
const ROLES_ADMIN_WRITABLE_COLUMNS = ["app_access", "api_access", "review_required"];

function isUsersTable(root: ResolvedResource): boolean {
  return root.schema === "totalbase" && root.table === "users";
}

/**
 * Columns on totalbase.users that are account security state or
 * the sign-in identity (Security.md §10.2): only an
 * administrator writes them through the Data API, whatever a role's field
 * grant says - on someone else's account and on one's own. A delegated
 * manager could otherwise verify an address, unlock an account an
 * administrator locked, reset the failed-login counter, turn an account
 * into one that can (or can't) sign in, forge the last sign-in, or change
 * an email and send a reset to the new address - signing in as that user,
 * with roles the manager doesn't hold. Email changes go through their own
 * routes (§2.12), accounts are created by invitation (§9.3).
 */
const USERS_ADMIN_WRITTEN_COLUMNS = ["email", "email_verified_at", "can_login", "locked_until", "failed_login_count", "last_login_at"];
/**
 * Set when an account is created, never changed through the Data API - by
 * anyone: an email change has its own route (§2.12), which retires the
 * links sent to the old address, notifies it, and asks for re-authentication
 * (§2.19) - a session left open must not hand over an account by email.
 */
const USERS_CREATE_ONLY_COLUMNS = ["email"];
/** Never written through the Data API, by anyone: the one account that keeps the instance administered (§1.6). */
const USERS_PROTECTED_COLUMNS = ["owner"];

/**
 * Throws if a CREATE/UPDATE payload touches a guarded column - a request to
 * just not set one is not the same as a request to clear/keep it, so key
 * *presence* is what's blocked, not merely a truthy value. Called on every
 * payload that reaches a row: an insert, an update, and the conflict
 * branch of an upsert.
 *
 * - totalbase.roles: the access flags, reserved and created_by;
 *   an administrator may set app_access/api_access.
 * - totalbase.users: owner never; the security-state and
 *   identity columns (USERS_ADMIN_WRITTEN_COLUMNS) by an administrator only;
 *   email on a CREATE only (USERS_CREATE_ONLY_COLUMNS).
 *
 * `operation`: UPDATE for a PATCH, a transaction's update and an upsert's
 * DO UPDATE branch; CREATE otherwise.
 */
export function assertGuardedColumnsWriteAllowed(
  root: ResolvedResource,
  item: Record<string, unknown>,
  caller?: Pick<WriteCaller, "administrator">,
  operation: "CREATE" | "UPDATE" = "CREATE",
): void {
  if (isUsersTable(root)) {
    if (operation === "UPDATE") {
      for (const column of USERS_CREATE_ONLY_COLUMNS) {
        if (column in item) {
          throw new TotalBaseError(
            "PERMISSION_DENIED",
            `An account's ${column} changes with PUT /admin/api/users/{id}/email, not through the Data API.`,
          );
        }
      }
    }
    for (const column of [...USERS_PROTECTED_COLUMNS, ...USERS_ADMIN_WRITTEN_COLUMNS]) {
      if (!(column in item)) continue;
      if (caller?.administrator && USERS_ADMIN_WRITTEN_COLUMNS.includes(column)) continue;
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        USERS_PROTECTED_COLUMNS.includes(column)
          ? `The "${column}" column on totalbase.users cannot be set through the Data API.`
          : `The "${column}" column on totalbase.users is written by administrators only.`,
      );
    }
    return;
  }
  if (!isRolesTable(root)) return;
  for (const column of ROLES_PROTECTED_COLUMNS) {
    if (caller?.administrator && ROLES_ADMIN_WRITABLE_COLUMNS.includes(column)) continue;
    // admin_access/reserved false is every role but the reserved ones (CHECK NOT admin_access OR reserved), and a
    // reserved role can't be changed this way at all (roles_reserved_unchanged) - stating the default is no write.
    if ((column === "admin_access" || column === "reserved") && item[column] === false) continue;
    if (column in item) {
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        `The "${column}" column on totalbase.roles cannot be set through the Data API.`,
      );
    }
  }
}

/**
 * The field-decision form of assertGuardedColumnsWriteAllowed, for documentation
 * only (the generated OpenAPI's write bodies): DENY on the columns that
 * assertion rejects for this caller - so a non-administrator's document
 * never lists the administrator-written account columns or the role
 * access flags, and an administrator's keeps what they may write.
 * Enforcement stays in assertGuardedColumnsWriteAllowed.
 */
export function guardedColumnsWriteFieldDecision(
  root: ResolvedResource,
  fieldDecision: (field: string) => PermissionDecision,
  caller: Pick<WriteCaller, "administrator">,
  operation: "CREATE" | "UPDATE" = "CREATE",
): (field: string) => PermissionDecision {
  if (isUsersTable(root)) {
    return (field: string) =>
      USERS_PROTECTED_COLUMNS.includes(field) ||
      (operation === "UPDATE" && USERS_CREATE_ONLY_COLUMNS.includes(field)) ||
      (!caller.administrator && USERS_ADMIN_WRITTEN_COLUMNS.includes(field))
        ? "DENY"
        : fieldDecision(field);
  }
  if (!isRolesTable(root)) return fieldDecision;
  return (field: string) =>
    ROLES_PROTECTED_COLUMNS.includes(field) && !(caller.administrator && ROLES_ADMIN_WRITABLE_COLUMNS.includes(field)) ? "DENY" : fieldDecision(field);
}

/** Throws if a row a DELETE on totalbase.roles just removed (RETURNING) was reserved or an admin role. */
export function assertRolesDeleteAllowed(root: ResolvedResource, row: Record<string, unknown>): void {
  if (!isRolesTable(root)) return;
  if (row["admin_access"] === true || row["reserved"] === true) {
    throw new TotalBaseError(
      "PERMISSION_DENIED",
      "A reserved or administrative role cannot be deleted through the Data API.",
    );
  }
}

/**
 * Throws if a CREATE/UPDATE on totalbase.users_roles would assign a
 * user to a reserved or ADMIN role - the other half of the same
 * guardrail: even with no write access to roles.admin_access itself,
 * assigning a user to the *existing* Administrators role is the
 * identical escalation. Silently returns
 * if `role` is missing/not a string - a malformed payload fails for
 * its own reasons (NOT NULL violation, compileInsert's own validation)
 * without this needing to duplicate that.
 */
export async function assertUserRoleAssignmentAllowed(
  database: Queryable,
  root: ResolvedResource,
  item: Record<string, unknown>,
  caller?: WriteCaller,
): Promise<void> {
  // A role row's parent rides on the same call sites - every payload that reaches a row.
  await assertRoleParentAllowed(database, root, item, caller);
  if (!isUsersRolesTable(root)) return;
  const roleId = item["role"];
  if (typeof roleId !== "string") return;
  await assertRolesAssignable(database, [roleId], caller);
}

/**
 * The assignment guardrail for a set of roles at once - a Data API row
 * write (one role) and an invitation that assigns several
 * (/app/api/users/invitations) share it: never a reserved or
 * administrative role, whoever the caller is; and a non-administrator
 * (`caller` given) only a role they created or one of their roles manages.
 * One query per rule, however many roles.
 */
export async function assertRolesAssignable(database: Queryable, roleIds: string[], caller?: WriteCaller | undefined): Promise<void> {
  if (roleIds.length === 0) return;
  if (caller && !caller.administrator && (await assignableRoleIds(database, caller, roleIds)).length !== new Set(roleIds).size) {
    throw new TotalBaseError(
      "PERMISSION_DENIED",
      "You can only assign roles you created, roles one of your roles manages, or roles below the ones you manage.",
    );
  }
  const { rows } = await database.query(
    `SELECT 1 FROM totalbase.roles WHERE id = ANY($1::uuid[]) AND (admin_access OR reserved) LIMIT 1`,
    [roleIds],
  );
  if (rows.length > 0) {
    throw new TotalBaseError(
      "PERMISSION_DENIED",
      "A user cannot be assigned to a reserved or administrative role through the Data API.",
    );
  }
}

/**
 * Who is writing, for the rules that depend on it (Security.md §9.4):
 * an administrator is exempt; anyone else acts as
 * `actorUserId` holding `roleIds`.
 */
export interface WriteCaller {
  administrator: boolean;
  actorUserId: string | undefined;
  roleIds: string[];
}

export async function resolveWriteCaller(
  isAdministrators: (roleIds: string[]) => Promise<boolean>,
  dataPrincipal: { roleIds: string[]; actorUserId?: string | undefined },
): Promise<WriteCaller> {
  return {
    administrator: await isAdministrators(dataPrincipal.roleIds),
    actorUserId: dataPrincipal.actorUserId,
    roleIds: dataPrincipal.roleIds,
  };
}

/**
 * The roles a non-administrator may assign (or remove): those they
 * created, and those one of their roles manages (`roles_managers`)
 * - never any other, whatever their grant on the assignments table says.
 * `among` narrows the answer to those ids. Not for administrators, who
 * assign every role.
 */
export async function assignableRoleIds(
  database: Queryable,
  caller: Pick<WriteCaller, "actorUserId" | "roleIds">,
  among?: string[],
): Promise<string[]> {
  const { rows } = await database.query<{ id: string }>(
    `SELECT r.id FROM totalbase.roles r
     WHERE ($3::uuid[] IS NULL OR r.id = ANY($3::uuid[])) AND (
       (r.created_by IS NOT NULL AND r.created_by = $1::uuid)
       OR EXISTS (SELECT 1 FROM totalbase.roles_managers m WHERE m.role = r.id AND m.manager = ANY($2::uuid[]))
       OR r.id IN ${rolesManagedBySql("$2")}
     )`,
    [caller.actorUserId ?? null, caller.roleIds, among ?? null],
  );
  return rows.map((row) => row.id);
}

async function assertRoleAssignable(database: Queryable, roleId: string, caller: WriteCaller): Promise<void> {
  if (caller.administrator) return;
  if ((await assignableRoleIds(database, caller, [roleId])).length === 0) {
    throw new TotalBaseError(
      "PERMISSION_DENIED",
      "You can only assign roles you created, roles one of your roles manages, or roles below the ones you manage.",
    );
  }
}

/** Throws if a DELETE on totalbase.users_roles just removed (RETURNING) a role the caller may not assign. */
export async function assertAssignmentDeleteAllowed(
  database: Queryable,
  root: ResolvedResource,
  row: Record<string, unknown>,
  caller: WriteCaller,
): Promise<void> {
  if (!isUsersRolesTable(root) || typeof row["role"] !== "string") return;
  await assertRoleAssignable(database, row["role"], caller);
}

/**
 * A non-administrator renames or deletes only a role they created, or one
 * below the roles they manage (Security.md §9.5) - never one they hold -
 * checked on the row the UPDATE/DELETE returned, inside its transaction,
 * so a refusal rolls it back.
 */
export async function assertRoleOwnership(database: Queryable, root: ResolvedResource, row: Record<string, unknown>, caller: WriteCaller): Promise<void> {
  if (!isRolesTable(root) || caller.administrator) return;
  if (caller.actorUserId && row["created_by"] === caller.actorUserId) return;
  if (typeof row["id"] === "string" && !caller.roleIds.includes(row["id"])) {
    const { rows } = await database.query(`SELECT 1 WHERE $1::uuid IN ${rolesManagedBySql("$2")}`, [row["id"], caller.roleIds]);
    if (rows.length > 0) return;
  }
  throw new TotalBaseError("PERMISSION_DENIED", "You can only change or delete roles you created, or roles below the ones you manage.");
}

/**
 * Where a non-administrator places a role (Security.md §9.5): its `parent`, on a create or an update, is one of
 * the roles they manage or a role below them - so the new role, and its ceiling, stay inside their scope. A
 * root (no parent) is theirs to create as before, granted nothing until an administrator grants it; making an
 * existing role a root is an administrator's. The tree's shape itself is PostgreSQL's (`roles_parent_valid`).
 */
async function assertRoleParentAllowed(database: Queryable, root: ResolvedResource, item: Record<string, unknown>, caller?: WriteCaller): Promise<void> {
  if (!isRolesTable(root) || !caller || caller.administrator || !("parent" in item)) return;
  const parent = item["parent"];
  if (typeof parent === "string") {
    const { rows } = await database.query(`SELECT 1 WHERE $1::uuid IN ${rolesManagedBySql("$2", { withManagers: true })}`, [parent, caller.roleIds]);
    if (rows.length > 0) return;
  }
  throw new TotalBaseError("PERMISSION_DENIED", "A role goes under one of the roles you manage, or a role below them.");
}

/**
 * Access-related tables whose Data API writes carry an event name in their
 * audit entry, like the Admin API's access events ("role.update",
 * "token.delete") - so the Logs security views, which filter by event,
 * keep showing them once these writes moved onto the Data API
 * (Security.md §10).
 */
const ACCESS_EVENT_PREFIXES: Record<string, string> = {
  users: "user",
  roles: "role",
  users_roles: "assignment",
  roles_managers: "role_manager",
  permissions: "permission",
  dataviews_roles: "dataview_role",
  dashboards_roles: "dashboard_role",
  tokens: "token",
  sessions: "session",
  roles_reviews: "access_review",
};

/** The access event a Data API write on `root` records, e.g. "role.update" - undefined for any other table. */
export function accessEventFor(root: Pick<ResolvedResource, "schema" | "table">, action: "CREATE" | "UPDATE" | "DELETE"): string | undefined {
  const prefix = root.schema === "totalbase" ? ACCESS_EVENT_PREFIXES[root.table] : undefined;
  return prefix ? `${prefix}.${action.toLowerCase()}` : undefined;
}

