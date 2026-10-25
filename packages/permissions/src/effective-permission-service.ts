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
  /** Raw where_clause JSON per ALLOW role, to be parsed and OR-combined by the caller (Security.md §6.5). undefined = action denied. */
  rowFilterSources: RowFilterSource[] | undefined;
  /** Raw rule JSON + label per ALLOW role, to be parsed and AND-combined by the caller. undefined = action denied. */
  payloadCheckSources: PayloadCheckSource[] | undefined;
}

type FieldOverride = { field: string; effect: "ALLOW" | "DENY" };

/** One role's grant for a (resource, action) - at most one, UNIQUE (role, resource, action). */
interface Grant {
  role: string;
  effect: "ALLOW" | "DENY";
  whereClause: unknown;
  fieldOverrides: FieldOverride[];
  payloadChecks: PayloadCheckSource[];
}

/** A role the caller holds, and its ancestors above it (Security.md §9.5): `levels[0]` the role itself, then its parent, and on. */
interface Chain {
  held: string;
  levels: { role: string; active: boolean }[];
}

/**
 * One held role's decision for a (resource, action) under its ancestors' ceiling (Security.md §6.11): its own
 * DENY is a DENY; an ALLOW counts only while every ancestor - active - allows the same action too, else it
 * is UNDEFINED (the ceiling, not a DENY: another role of the caller may still allow). Its fields are those
 * every level allows, its row filter every level's AND-combined, its payload checks every level's.
 */
interface RoleDecision {
  role: string;
  decision: PermissionDecision;
  /** Whether the role itself has a grant row - the roles a view says the decision comes from. */
  granted: boolean;
  /** The ancestors whose grants bounded an ALLOW. */
  ceiling: string[];
  fieldDecision: (field: string) => PermissionDecision;
  /** Fields this role's own grant names - a view's candidates. */
  ownFields: string[];
  /** Every level's filter AND-combined in the filter grammar; null = every row. */
  where: unknown;
  payloadChecks: (PayloadCheckSource & { role: string })[];
}

function roleDecision(chain: Chain, grantOf: (role: string) => Grant | undefined): RoleDecision {
  const own = grantOf(chain.held);
  const none: RoleDecision = {
    role: chain.held, decision: "UNDEFINED", granted: own !== undefined, ceiling: [], fieldDecision: () => "UNDEFINED",
    ownFields: [], where: null, payloadChecks: [],
  };
  if (!own) return none;
  if (own.effect === "DENY") return { ...none, decision: "DENY" };
  const grants: Grant[] = [own];
  for (const level of chain.levels.slice(1)) {
    const grant = grantOf(level.role);
    if (!level.active || grant?.effect !== "ALLOW") return none;
    grants.push(grant);
  }
  const overrides = grants.map((grant) => new Map(grant.fieldOverrides.map((o) => [o.field, o.effect])));
  const filters = grants.map((grant) => grant.whereClause).filter((where) => where !== null && where !== undefined);
  return {
    role: chain.held,
    decision: "ALLOW",
    granted: true,
    ceiling: grants.slice(1).map((grant) => grant.role),
    fieldDecision: (field) => {
      const ownEffect = overrides[0]!.get(field);
      if (ownEffect === "DENY") return "DENY";
      return ownEffect === "ALLOW" && overrides.every((level) => level.get(field) === "ALLOW") ? "ALLOW" : "UNDEFINED";
    },
    ownFields: own.fieldOverrides.map((o) => o.field),
    where: filters.length === 0 ? null : filters.length === 1 ? filters[0] : { _and: filters },
    payloadChecks: grants.flatMap((grant) => grant.payloadChecks.map((check) => ({ ...check, role: grant.role }))),
  };
}

/** The same check from one ancestor reached through two held roles applies once. */
function distinctChecks<T extends PayloadCheckSource>(checks: T[]): T[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = JSON.stringify([check.rule, check.label]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Across the caller's roles (Security.md §6.2, §6.4): any DENY wins, else any ALLOW. */
function combinedFieldDecision(allowed: RoleDecision[]): (field: string) => PermissionDecision {
  return (field) => resolveEffect(allowed.flatMap((d) => {
    const decision = d.fieldDecision(field);
    return decision === "UNDEFINED" ? [] : [{ effect: decision }];
  }));
}

/**
 * The single effective permission resolver (Security.md §6).
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

  /**
   * The held roles' chains and every grant along them for the given resources (and action), in one query:
   * a recursive walk up `roles.parent` - at most four levels (`roles_parent_valid`) - joined to the grants.
   */
  private async chainsAndGrants(roleIds: string[], resourceIds: string[], action?: ResourceAction) {
    const { rows } = await this.database.query<{
      held: string;
      role: string;
      depth: number;
      active: boolean;
      resource: string | null;
      action: ResourceAction | null;
      effect: "ALLOW" | "DENY" | null;
      where_clause: unknown;
      field_overrides: FieldOverride[] | null;
      payload_checks: PayloadCheckSource[] | null;
    }>(
      `WITH RECURSIVE chain AS (
         SELECT r.id AS held, r.id AS role, 0 AS depth, r.parent, true AS active
         FROM totalbase.roles r WHERE r.id = ANY($1::uuid[])
         UNION ALL
         SELECT c.held, p.id, c.depth + 1, p.parent, p.active
         FROM chain c JOIN totalbase.roles p ON p.id = c.parent WHERE c.depth < 8
       )
       SELECT c.held, c.role, c.depth, c.active, g.resource, g.action, g.effect, g.where_clause, g.field_overrides, g.payload_checks
       FROM chain c
       LEFT JOIN totalbase.permissions g ON g.role = c.role AND g.resource = ANY($2::uuid[]) AND ($3::text IS NULL OR g.action = $3)
       ORDER BY c.held, c.depth`,
      [roleIds, resourceIds, action ?? null],
    );
    const chains = new Map<string, Chain>();
    const grants = new Map<string, Grant>();
    for (const row of rows) {
      const chain = chains.get(row.held) ?? { held: row.held, levels: [] };
      if (!chain.levels.some((level) => level.role === row.role)) chain.levels.push({ role: row.role, active: row.active });
      chains.set(row.held, chain);
      if (row.effect && row.resource && row.action) {
        grants.set(`${row.role} ${row.resource} ${row.action}`, {
          role: row.role,
          effect: row.effect,
          whereClause: row.where_clause,
          fieldOverrides: row.field_overrides ?? [],
          payloadChecks: row.payload_checks ?? [],
        });
      }
    }
    return {
      chains: [...chains.values()],
      grantOf: (resource: string, resourceAction: ResourceAction) => (role: string) => grants.get(`${role} ${resource} ${resourceAction}`),
    };
  }

  async resolve(roleIds: string[], resourceId: string, action: ResourceAction): Promise<EffectivePermission> {
    if (roleIds.length === 0) {
      return { action: "UNDEFINED", fieldDecision: () => "UNDEFINED", rowFilterSources: undefined, payloadCheckSources: undefined };
    }

    if (await this.isAdministrators(roleIds)) {
      return FULL_ACCESS;
    }

    const { chains, grantOf } = await this.chainsAndGrants(roleIds, [resourceId], action);
    const decisions = chains.map((chain) => roleDecision(chain, grantOf(resourceId, action)));
    const actionDecision = resolveEffect(decisions.flatMap((d) => (d.decision === "UNDEFINED" ? [] : [{ effect: d.decision }])));

    if (actionDecision !== "ALLOW") {
      return { action: actionDecision, fieldDecision: () => "UNDEFINED", rowFilterSources: undefined, payloadCheckSources: undefined };
    }

    const allowed = decisions.filter((d) => d.decision === "ALLOW");
    return {
      action: actionDecision,
      fieldDecision: combinedFieldDecision(allowed),
      rowFilterSources: allowed.map((d) => ({ effect: "ALLOW", whereClause: d.where })),
      payloadCheckSources: distinctChecks(allowed.flatMap((d) => d.payloadChecks)).map(({ rule, label }) => ({ rule, label })),
    };
  }

  /**
   * Bulk variant of resolve(): every action, for every given resource, in
   * one query instead of one resolve() call per (resource, action) pair.
   * Built for the Admin UI's "effective permissions" views
   * (Admin_UI.md §11.4, gap #1) - the same per-role decisions resolve()
   * makes, ceiling included, no new permission logic. Also reports which
   * role(s) contributed a grant to each decision, so the UI can explain
   * "why" (including DENY grants, which explain a denial despite another
   * role's ALLOW), the ancestors whose ceiling bounded it, and (when ALLOW)
   * which fields are effectively readable/writable - purely informational
   * for this view, unlike resolve()'s fieldDecision(field) which the Data
   * API calls per-field to actually gate a request.
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
      const all = (): BulkActionDecision => ({ decision: "ALLOW", roles: grantingRoles, ceiling: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined });
      for (const resourceId of resourceIds) {
        result.set(resourceId, { CREATE: all(), READ: all(), UPDATE: all(), DELETE: all(), EXECUTE: all() });
      }
      return result;
    }

    const { chains, grantOf } = await this.chainsAndGrants(roleIds, resourceIds);
    const columnOrderByResourceId = await this.columnOrders(resourceIds);

    for (const resourceId of resourceIds) {
      const entry = result.get(resourceId)!;
      for (const action of ACTIONS) {
        const decisions = chains.map((chain) => roleDecision(chain, grantOf(resourceId, action)));
        const granted = decisions.filter((d) => d.granted);
        if (granted.length === 0) continue;
        const decision = resolveEffect(decisions.flatMap((d) => (d.decision === "UNDEFINED" ? [] : [{ effect: d.decision }])));
        const allowed = decisions.filter((d) => d.decision === "ALLOW");
        const ceiling = [...new Set(granted.flatMap((d) => d.ceiling))];
        if (decision !== "ALLOW") {
          entry[action] = { decision, roles: granted.map((d) => d.role), ceiling, fields: undefined, rowFilters: undefined, payloadChecks: undefined };
          continue;
        }
        const fieldDecision = combinedFieldDecision(allowed);
        const candidates = [...new Set(allowed.flatMap((d) => d.ownFields))];
        const checks = distinctChecks(allowed.flatMap((d) => d.payloadChecks));
        entry[action] = {
          decision,
          roles: granted.map((d) => d.role),
          ceiling,
          fields: sortFields(candidates.filter((field) => fieldDecision(field) === "ALLOW"), columnOrderByResourceId.get(resourceId)),
          rowFilters: allowed.some((d) => d.where === null) ? undefined : allowed.map((d) => ({ role: d.role, where: d.where })),
          payloadChecks: checks.length > 0 ? checks.map(({ role, label, rule }) => ({ role, label, rule })) : undefined,
        };
      }
    }
    return result;
  }

  /**
   * Physical column order (pg_attribute.attnum), not alphabetical - same
   * convention as @totalbase/pg-catalog's relation-detail.ts.
   */
  private async columnOrders(resourceIds: string[]): Promise<Map<string, Map<string, number>>> {
    const orders = new Map<string, Map<string, number>>();
    const { rows: resourceRows } = await this.database.query<{ id: string; postgres_oid: number }>(
      `SELECT id, postgres_oid FROM totalbase.resources WHERE id = ANY($1) AND type IN ('TABLE', 'VIEW')`,
      [resourceIds],
    );
    if (resourceRows.length === 0) return orders;
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
      if (order) orders.set(r.id, order);
    }
    return orders;
  }
}

const ACTIONS: ResourceAction[] = ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"];

function sortFields(fields: string[], columnOrder: Map<string, number> | undefined): string[] {
  if (!columnOrder) return fields.sort();
  // Direct columns in physical (attnum) order first; anything columnOrder
  // doesn't know about - a relation-traversal field like "manager.name"
  // (Admin_UI.md §11.3), which names a column on a related table, not this one -
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
  /** The ancestors (Security.md §9.5) whose grants bound the requested roles' - empty for roles without a parent. */
  ceiling: string[];
  /** Effectively granted columns, sorted - only present when decision === "ALLOW". Informational (see resolveBulk's doc comment); the Data API still gates access per-request via resolve()'s fieldDecision. */
  fields: string[] | undefined;
  /**
   * When ALLOW is limited to some rows: each ALLOW role's filter, its
   * ancestors' AND-combined into it (OR-combined across roles, as
   * buildRowFilter does). undefined = every row - not ALLOW, or at least
   * one ALLOW role has no filter, which makes the OR unrestricted.
   */
  rowFilters: { role: string; where: unknown }[] | undefined;
  /** Every payload check that applies (AND-combined, as resolve() gathers them), with the role it comes from - an ancestor's included. undefined unless ALLOW with at least one. */
  payloadChecks: { role: string; label: string | null; rule: unknown }[] | undefined;
}

function emptyBulkDecisions(): Record<ResourceAction, BulkActionDecision> {
  const none = (): BulkActionDecision => ({ decision: "UNDEFINED", roles: [], ceiling: [], fields: undefined, rowFilters: undefined, payloadChecks: undefined });
  return { CREATE: none(), READ: none(), UPDATE: none(), DELETE: none(), EXECUTE: none() };
}
