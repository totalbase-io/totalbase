import type { Database } from "@totalbase/database";
import { adminRoleIds, holdsAdminAccess } from "./admin-roles.js";
import { resolveEffect, type PermissionDecision } from "./permission-resolver.js";

const FULL_ACCESS: EffectivePermission = {
  action: "ALLOW",
  fieldDecision: () => "ALLOW",
  rowFilterSources: [],
  payloadCheckSources: [],
};

export type ResourceAction = "CREATE" | "READ" | "UPDATE" | "DELETE" | "EXECUTE";

/** A row filter to be OR-combined across ALLOW grants and re-parsed by the query engine. */
export interface RowFilterSource {
  effect: "ALLOW" | "DENY";
  whereClause: unknown;
}

/**
 * "Payload checks" (totalbase.permissions.payload_checks - see its
 * column comment): a role-scoped CREATE/UPDATE business-rule check, evaluated
 * against the resulting row - not a PostgreSQL CHECK constraint. Only
 * meaningful for CREATE/UPDATE; harmless (and simply unused) for other
 * actions. Every ALLOW grant's checks apply (AND, unlike rowFilterSources'
 * OR) - each is its own labeled condition, not alternative ways in.
 */
export interface PayloadCheckSource {
  rule: unknown;
  label: string | null;
}

export interface EffectivePermission {
  action: PermissionDecision;
  /** Only meaningful when action === "ALLOW". */
  fieldDecision: (field: string) => PermissionDecision;
  /** Raw where_clause JSON per ALLOW grant, to be parsed and OR-combined by the caller (Specification_Security.md §6.5). undefined = action denied. */
  rowFilterSources: RowFilterSource[] | undefined;
  /** Raw rule JSON + label per ALLOW grant, to be parsed and AND-combined by the caller. undefined = action denied. */
  payloadCheckSources: PayloadCheckSource[] | undefined;
}

/**
 * The single effective permission resolver (Specification_Security.md §6).
 * Used consistently by the Data API, OpenAPI, relation access,
 * field access, and mutations (AGENTS.md section 6, @totalbase/permissions).
 */
export class EffectivePermissionService {

  constructor(private readonly database: Database) {}

  /**
   * Any active role with admin_access (formerly access = 'ADMIN' / is_admin)
   * bypasses totalbase.permissions entirely and gets full
   * access. It must not depend on any row ever existing in
   * totalbase.permissions for it. The set of admin role ids is
   * resolved once and cached per instance: ADMIN is restricted to
   * reserved roles (a CHECK constraint), which no request can edit, so
   * the set can't change at runtime.
   */
  async isAdministrators(roleIds: string[]): Promise<boolean> {
    return holdsAdminAccess(this.database, roleIds);
  }

  async resolve(roleIds: string[], resourceId: string, action: ResourceAction): Promise<EffectivePermission> {
    if (roleIds.length === 0) {
      return { action: "UNDEFINED", fieldDecision: () => "UNDEFINED", rowFilterSources: undefined, payloadCheckSources: undefined };
    }

    if (await this.isAdministrators(roleIds)) {
      return FULL_ACCESS;
    }

    const { rows: permissionRows } = await this.database.query<{
      id: string;
      effect: "ALLOW" | "DENY";
      where_clause: unknown;
      field_overrides: { field: string; effect: "ALLOW" | "DENY" }[];
      payload_checks: PayloadCheckSource[];
    }>(
      `SELECT id, effect, where_clause, field_overrides, payload_checks FROM totalbase.permissions
       WHERE role = ANY($1) AND resource = $2 AND action = $3`,
      [roleIds, resourceId, action],
    );

    const actionDecision = resolveEffect(permissionRows.map((r) => ({ effect: r.effect })));

    if (actionDecision !== "ALLOW") {
      return { action: actionDecision, fieldDecision: () => "UNDEFINED", rowFilterSources: undefined, payloadCheckSources: undefined };
    }

    const grantsByField = new Map<string, { effect: "ALLOW" | "DENY" }[]>();
    for (const row of permissionRows) {
      for (const override of row.field_overrides) {
        const list = grantsByField.get(override.field) ?? [];
        list.push({ effect: override.effect });
        grantsByField.set(override.field, list);
      }
    }

    const fieldDecision = (field: string): PermissionDecision => {
      const grants = grantsByField.get(field);
      return grants ? resolveEffect(grants) : "UNDEFINED";
    };

    const rowFilterSources: RowFilterSource[] = permissionRows
      .filter((r) => r.effect === "ALLOW")
      .map((r) => ({ effect: r.effect, whereClause: r.where_clause }));

    const payloadCheckSources: PayloadCheckSource[] = permissionRows.flatMap((r) => r.payload_checks);

    return { action: actionDecision, fieldDecision, rowFilterSources, payloadCheckSources };
  }

  /**
   * Bulk variant of resolve(): every action, for every given resource, in
   * one query instead of one resolve() call per (resource, action) pair.
   * Built for the Admin UI's "effective permissions" views
   * (Specification_Admin_UI.md §11.4, gap #1) - a straightforward
   * aggregation over the same totalbase.permissions rows resolve() reads,
   * no new permission logic. Also reports which role(s) contributed a
   * grant to each decision, so the UI can explain "why" (including DENY
   * grants, which explain a denial despite another role's ALLOW), and
   * (when ALLOW) which fields are effectively readable/writable - purely
   * informational for this view, unlike resolve()'s fieldDecision(field)
   * which the Data API calls per-field to actually gate a request.
   */
  async resolveBulk(roleIds: string[], resourceIds: string[]): Promise<Map<string, Record<ResourceAction, BulkActionDecision>>> {
    const result = new Map<string, Record<ResourceAction, BulkActionDecision>>();
    for (const resourceId of resourceIds) result.set(resourceId, emptyBulkDecisions());
    if (roleIds.length === 0 || resourceIds.length === 0) return result;

    if (await this.isAdministrators(roleIds)) {
      // Whichever of the caller's roles is ADMIN - could be more than one
      // (Administrators and the Workflows system role).
      const adminIds = await adminRoleIds(this.database);
      const grantingRoles = roleIds.filter((id) => adminIds.has(id));
      for (const resourceId of resourceIds) {
        result.set(resourceId, {
          CREATE: { decision: "ALLOW", roles: grantingRoles, fields: undefined, rowFilters: undefined, payloadChecks: undefined },
          READ: { decision: "ALLOW", roles: grantingRoles, fields: undefined, rowFilters: undefined, payloadChecks: undefined },
          UPDATE: { decision: "ALLOW", roles: grantingRoles, fields: undefined, rowFilters: undefined, payloadChecks: undefined },
          DELETE: { decision: "ALLOW", roles: grantingRoles, fields: undefined, rowFilters: undefined, payloadChecks: undefined },
          EXECUTE: { decision: "ALLOW", roles: grantingRoles, fields: undefined, rowFilters: undefined, payloadChecks: undefined },
        });
      }
      return result;
    }

    const { rows } = await this.database.query<{
      id: string;
      resource: string;
      action: ResourceAction;
      role: string;
      effect: "ALLOW" | "DENY";
      field_overrides: { field: string; effect: "ALLOW" | "DENY" }[];
      where_clause: unknown;
      payload_checks: PayloadCheckSource[];
    }>(
      `SELECT id, resource, action, role, effect, field_overrides, where_clause, payload_checks FROM totalbase.permissions
       WHERE role = ANY($1) AND resource = ANY($2)`,
      [roleIds, resourceIds],
    );

    const fieldsByPermissionId = new Map<string, { field: string; effect: "ALLOW" | "DENY" }[]>();
    for (const row of rows) {
      fieldsByPermissionId.set(row.id, row.field_overrides);
    }

    const grouped = new Map<string, BulkGrant[]>();
    for (const row of rows) {
      const key = `${row.resource} ${row.action}`;
      const list = grouped.get(key) ?? [];
      list.push({ id: row.id, effect: row.effect, role: row.role, whereClause: row.where_clause, payloadChecks: row.payload_checks });
      grouped.set(key, list);
    }

    const allowGroupKeys = new Set<string>();
    for (const [key, grants] of grouped) {
      if (resolveEffect(grants.map((g) => ({ effect: g.effect }))) === "ALLOW") {
        allowGroupKeys.add(key);
      }
    }

    // Physical column order (pg_attribute.attnum), not alphabetical - same
    // convention as @totalbase/pg-catalog's relation-detail.ts. Only fetched
    // for resources that actually have an ALLOW group with fields to sort.
    const columnOrderByResourceId = new Map<string, Map<string, number>>();
    const resourceIdsWithFields = new Set([...allowGroupKeys].map((key) => key.split(" ")[0]!));
    if (resourceIdsWithFields.size > 0) {
      const { rows: resourceRows } = await this.database.query<{ id: string; postgres_oid: number }>(
        `SELECT id, postgres_oid FROM totalbase.resources WHERE id = ANY($1) AND type IN ('TABLE', 'VIEW')`,
        [[...resourceIdsWithFields]],
      );
      if (resourceRows.length > 0) {
        const { rows: attrRows } = await this.database.query<{ attrelid: number; attname: string }>(
          `SELECT attrelid, attname FROM pg_attribute
           WHERE attrelid = ANY($1) AND attnum > 0 AND NOT attisdropped
           ORDER BY attrelid, attnum`,
          [resourceRows.map((r) => r.postgres_oid)],
        );
        const orderByOid = new Map<number, Map<string, number>>();
        for (const row of attrRows) {
          const order = orderByOid.get(row.attrelid) ?? new Map<string, number>();
          order.set(row.attname, order.size);
          orderByOid.set(row.attrelid, order);
        }
        for (const r of resourceRows) {
          const order = orderByOid.get(r.postgres_oid);
          if (order) columnOrderByResourceId.set(r.id, order);
        }
      }
    }

    for (const [key, grants] of grouped) {
      const [resourceId, action] = key.split(" ") as [string, ResourceAction];
      const entry = result.get(resourceId);
      if (!entry) continue; // resource not in the requested set; ignore.
      entry[action] = {
        decision: resolveEffect(grants.map((g) => ({ effect: g.effect }))),
        roles: [...new Set(grants.map((g) => g.role))],
        fields: allowGroupKeys.has(key) ? fieldsFor(grants, fieldsByPermissionId, columnOrderByResourceId.get(resourceId)) : undefined,
        ...(allowGroupKeys.has(key) ? restrictionsFor(grants) : { rowFilters: undefined, payloadChecks: undefined }),
      };
    }

    return result;
  }
}

/** Same DENY>ALLOW field precedence as resolve()'s fieldDecision, applied to every field mentioned across the group's grants at once. */
function fieldsFor(
  grants: { id: string }[],
  fieldsByPermissionId: Map<string, { field: string; effect: "ALLOW" | "DENY" }[]>,
  columnOrder: Map<string, number> | undefined,
): string[] {
  const grantsByField = new Map<string, { effect: "ALLOW" | "DENY" }[]>();
  for (const grant of grants) {
    for (const { field, effect } of fieldsByPermissionId.get(grant.id) ?? []) {
      const list = grantsByField.get(field) ?? [];
      list.push({ effect });
      grantsByField.set(field, list);
    }
  }
  const fields: string[] = [];
  for (const [field, fieldGrants] of grantsByField) {
    if (resolveEffect(fieldGrants) === "ALLOW") fields.push(field);
  }
  if (!columnOrder) return fields.sort();
  // Direct columns in physical (attnum) order first; anything columnOrder
  // doesn't know about - a relation-traversal field like "manager.name"
  // (Specification_Admin_UI.md §11.3), which names a column on a related table, not this one -
  // sorts alphabetically after them.
  return fields.sort((a, b) => {
    const rankA = columnOrder.get(a);
    const rankB = columnOrder.get(b);
    if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
    if (rankA !== undefined) return -1;
    if (rankB !== undefined) return 1;
    return a.localeCompare(b);
  });
}

export interface BulkActionDecision {
  decision: PermissionDecision;
  /** IDs of every role (from the requested set) with a grant row for this (resource, action) - ALLOW or DENY. */
  roles: string[];
  /** Effectively granted columns, sorted - only present when decision === "ALLOW". Informational (see resolveBulk's doc comment); the Data API still gates access per-request via resolve()'s fieldDecision. */
  fields: string[] | undefined;
  /**
   * When ALLOW is limited to some rows: each ALLOW grant's where_clause
   * (OR-combined, as buildRowFilter does). undefined = every row - not
   * ALLOW, or at least one ALLOW grant has no filter, which makes the OR
   * unrestricted.
   */
  rowFilters: { role: string; where: unknown }[] | undefined;
  /** Every payload check that applies (AND-combined, as resolve() gathers them), with the role it comes from. undefined unless ALLOW with at least one. */
  payloadChecks: { role: string; label: string | null; rule: unknown }[] | undefined;
}

interface BulkGrant {
  id: string;
  effect: "ALLOW" | "DENY";
  role: string;
  whereClause: unknown;
  payloadChecks: PayloadCheckSource[];
}

/** The row filter and payload checks an ALLOW decision carries - the same sources resolve() hands the Data API, summarized per role. */
function restrictionsFor(grants: BulkGrant[]): Pick<BulkActionDecision, "rowFilters" | "payloadChecks"> {
  const allows = grants.filter((g) => g.effect === "ALLOW");
  const unrestricted = allows.some((g) => g.whereClause === null || g.whereClause === undefined);
  const checks = grants.flatMap((g) => (g.payloadChecks ?? []).map((c) => ({ role: g.role, label: c.label, rule: c.rule })));
  return {
    rowFilters: unrestricted ? undefined : allows.map((g) => ({ role: g.role, where: g.whereClause })),
    payloadChecks: checks.length > 0 ? checks : undefined,
  };
}

function emptyBulkDecisions(): Record<ResourceAction, BulkActionDecision> {
  return {
    CREATE: { decision: "UNDEFINED", roles: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined },
    READ: { decision: "UNDEFINED", roles: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined },
    UPDATE: { decision: "UNDEFINED", roles: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined },
    DELETE: { decision: "UNDEFINED", roles: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined },
    EXECUTE: { decision: "UNDEFINED", roles: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined },
  };
}
