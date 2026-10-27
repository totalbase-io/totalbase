import type { Database, Queryable } from "@totalbase/database";
import type { ResourceAction } from "./effective-permission-service.js";

export interface PermissionFieldGrant {
  field: string;
  effect: "ALLOW" | "DENY";
}

/**
 * "Payload checks" (see chat, and totalbase.permissions.payload_checks'
 * column comment): a role-scoped CREATE/UPDATE business-rule check, not a
 * PostgreSQL CHECK constraint - only enforced through TotalBase's own
 * write paths. `rule` is the same filter-object grammar as
 * `where_clause` (_and/_or/_not, per-field {_operator: value}).
 */
export interface PermissionPayloadCheck {
  rule: unknown;
  label: string | null;
}

export interface Permission {
  id: string;
  role: string;
  resource: string;
  action: ResourceAction;
  effect: "ALLOW" | "DENY";
  whereClause: unknown;
  fields: PermissionFieldGrant[];
  payloadChecks: PermissionPayloadCheck[];
}

export interface SetPermissionInput {
  effect: "ALLOW" | "DENY";
  /** undefined = leave the row filter untouched only on create; explicit null clears it. Always replaced when provided. */
  where?: unknown;
  /** When provided, replaces the full field-grant set for this permission. Omitted = leave field grants untouched. */
  fields?: PermissionFieldGrant[] | undefined;
  /** When provided, replaces the full payload-check set for this permission. Omitted = leave payload checks untouched. */
  payloadChecks?: PermissionPayloadCheck[] | undefined;
}

interface PermissionRow {
  id: string;
  role: string;
  resource: string;
  action: ResourceAction;
  effect: "ALLOW" | "DENY";
  where_clause: unknown;
  field_overrides: PermissionFieldGrant[];
  payload_checks: PermissionPayloadCheck[];
}

const PERMISSION_COLUMNS = "id, role, resource, action, effect, where_clause, field_overrides, payload_checks";

/**
 * Admin CRUD for totalbase.permissions, including its
 * field_overrides/payload_checks jsonb columns (Security.md §5.3:
 * "PUT/DELETE /roles/{role}/resources/{resource}/permissions/{action}").
 * This is the only way to grant/revoke access short of hand-editing the
 * database - @totalbase/permissions' EffectivePermissionService only
 * reads.
 */
export class PermissionsService {
  constructor(private readonly database: Database) {}

  private toPermission(row: PermissionRow): Permission {
    const { where_clause, field_overrides, payload_checks, ...rest } = row;
    return { ...rest, whereClause: where_clause, fields: field_overrides, payloadChecks: payload_checks };
  }

  async get(roleId: string, resourceId: string, action: ResourceAction): Promise<Permission | null> {
    const { rows } = await this.database.query<PermissionRow>(
      `SELECT ${PERMISSION_COLUMNS} FROM totalbase.permissions
       WHERE role = $1 AND resource = $2 AND action = $3`,
      [roleId, resourceId, action],
    );
    const row = rows[0];
    return row ? this.toPermission(row) : null;
  }

  async listForRole(roleId: string): Promise<Permission[]> {
    const { rows } = await this.database.query<PermissionRow>(
      `SELECT ${PERMISSION_COLUMNS} FROM totalbase.permissions
       WHERE role = $1 ORDER BY resource, action`,
      [roleId],
    );
    return rows.map((row) => this.toPermission(row));
  }

  /**
   * Upserts one (role, resource, action) permission - the atomic unit Security.md §5.3 describes.
   * `actorUserId`: who grants it - recorded as `granted_by` (Security.md §5.1).
   */
  async set(
    roleId: string,
    resourceId: string,
    action: ResourceAction,
    input: SetPermissionInput,
    options: { actorUserId?: string | undefined } = {},
  ): Promise<Permission> {
    return this.database.transaction((client) => this.setOn(client, roleId, resourceId, action, input), { actorUserId: options.actorUserId });
  }

  /**
   * Upserts several of one role's grants in one transaction - all of them,
   * or none (an agent granting a role its tables at once; one PUT instead
   * of one per grant). Each is `set`'s own upsert; answered in the order
   * given.
   */
  async setMany(
    roleId: string,
    grants: { resourceId: string; action: ResourceAction; input: SetPermissionInput }[],
    options: { actorUserId?: string | undefined } = {},
  ): Promise<Permission[]> {
    return this.database.transaction(async (client) => {
      const permissions: Permission[] = [];
      for (const grant of grants) permissions.push(await this.setOn(client, roleId, grant.resourceId, grant.action, grant.input));
      return permissions;
    }, { actorUserId: options.actorUserId });
  }

  /** The same grant on one (resource, action) for several roles, in one transaction - all of them, or none. */
  async setForRoles(
    roleIds: string[],
    resourceId: string,
    action: ResourceAction,
    input: SetPermissionInput,
    options: { actorUserId?: string | undefined } = {},
  ): Promise<Permission[]> {
    return this.database.transaction(async (client) => {
      const permissions: Permission[] = [];
      for (const roleId of roleIds) permissions.push(await this.setOn(client, roleId, resourceId, action, input));
      return permissions;
    }, { actorUserId: options.actorUserId });
  }

  private async setOn(client: Queryable, roleId: string, resourceId: string, action: ResourceAction, input: SetPermissionInput): Promise<Permission> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO totalbase.permissions (role, resource, action, effect, where_clause)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (role, resource, action)
       DO UPDATE SET effect = excluded.effect, where_clause = excluded.where_clause, updated_at = now()
       RETURNING id`,
      [roleId, resourceId, action, input.effect, input.where !== undefined ? JSON.stringify(input.where) : null],
    );
    const permissionId = rows[0]!.id;

    if (input.fields !== undefined) {
      const sorted = [...input.fields].sort((a, b) => a.field.localeCompare(b.field));
      await client.query(
        `UPDATE totalbase.permissions SET field_overrides = $2, updated_at = now() WHERE id = $1`,
        [permissionId, JSON.stringify(sorted)],
      );
    }

    if (input.payloadChecks !== undefined) {
      await client.query(
        `UPDATE totalbase.permissions SET payload_checks = $2, updated_at = now() WHERE id = $1`,
        [permissionId, JSON.stringify(input.payloadChecks)],
      );
    }

    const { rows: permissionRows } = await client.query<PermissionRow>(
      `SELECT ${PERMISSION_COLUMNS} FROM totalbase.permissions WHERE id = $1`,
      [permissionId],
    );
    return this.toPermission(permissionRows[0]!);
  }

  /**
   * Copies grants of one role to another in one transaction - all of them, or none. `grantIds`: which of the
   * source's (the caller leaves out what it won't copy). Added: a grant the target already has for the same
   * resource and action is kept (PostgreSQL's ON CONFLICT decides, nothing is read first); `replace`: the
   * target's grants are removed first. Answers the (resource, action) pairs written.
   */
  async copyGrants(
    targetRoleId: string,
    sourceRoleId: string,
    grantIds: string[],
    options: { replace: boolean, actorUserId?: string | undefined },
  ): Promise<{ resource: string; action: ResourceAction }[]> {
    return this.database.transaction(async (client) => {
      if (options.replace) await client.query(`DELETE FROM totalbase.permissions WHERE role = $1`, [targetRoleId]);
      const { rows } = await client.query<{ resource: string; action: ResourceAction }>(
        `INSERT INTO totalbase.permissions (role, resource, action, effect, where_clause, field_overrides, payload_checks)
         SELECT $1, resource, action, effect, where_clause, field_overrides, payload_checks
         FROM totalbase.permissions WHERE role = $2 AND id = ANY($3::uuid[])
         ON CONFLICT (role, resource, action) DO NOTHING
         RETURNING resource, action`,
        [targetRoleId, sourceRoleId, grantIds],
      );
      return rows;
    }, { actorUserId: options.actorUserId });
  }

  /** Whether there was such a grant to remove. */
  async delete(roleId: string, resourceId: string, action: ResourceAction): Promise<boolean> {
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.permissions WHERE role = $1 AND resource = $2 AND action = $3`,
      [roleId, resourceId, action],
    );
    return rowCount > 0;
  }
}
