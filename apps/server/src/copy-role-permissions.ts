import type { Permission, ResourceAction } from "@totalbase/permissions";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";

export interface CopiedGrant {
  /** `schema.name` of the resource. */
  resource: string;
  action: ResourceAction;
}

export interface CopyPermissionsResult {
  copied: CopiedGrant[];
  /** Added, not replaced: the target already had a grant for the resource and action - its own is kept. */
  kept: CopiedGrant[];
  /** Beyond the target's ceiling (its parent, Security.md §6.11): never applied, so not copied. */
  beyondCeiling: CopiedGrant[];
}

/**
 * Copies a role's grants to another (Security.md §5.4) - its table, view and function permissions whole
 * (action, effect, row filter, fields, payload checks), nothing else of the role. Added to the target's own
 * grants (a clash keeps the target's), or `replace`-ing them. A grant the target's parent can't give - an action
 * it can't take, a field it can't use - is left out and listed: the resolver would cut it on every request. The
 * Administrators and Workflows roles are never a source (their access bypasses grants) or a target.
 */
export async function copyRolePermissions(
  context: AppContext,
  targetId: string,
  sourceId: string,
  options: { replace: boolean, actorUserId: string },
): Promise<CopyPermissionsResult> {
  const [target, source] = await Promise.all([context.roles.findById(targetId), context.roles.findById(sourceId)]);
  if (!target) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
  if (!source) throw new TotalBaseError("INVALID_QUERY", "from must be another role's id.");
  if (sourceId === targetId) throw new TotalBaseError("INVALID_QUERY", "A role's permissions can't be copied from itself.");
  for (const role of [target, source]) {
    if (role.reserved || role.adminAccess) {
      throw new TotalBaseError("PERMISSION_DENIED", `The "${role.name}" role bypasses permissions: nothing to copy from or to it.`);
    }
  }

  const grants = await context.permissions.listForRole(sourceId);
  const withinCeiling: Permission[] = [];
  const beyond: Permission[] = [];
  for (const grant of grants) {
    if (target.parent && !(await withinParent(context, target.parent, grant))) beyond.push(grant);
    else withinCeiling.push(grant);
  }
  const written = await context.permissions.copyGrants(targetId, sourceId, withinCeiling.map((g) => g.id), options);
  const wasWritten = new Set(written.map((w) => `${w.resource}:${w.action}`));

  const names = await resourceNames(context, grants.map((g) => g.resource));
  const named = (g: Permission): CopiedGrant => ({ resource: names.get(g.resource) ?? g.resource, action: g.action });
  return {
    copied: withinCeiling.filter((g) => wasWritten.has(`${g.resource}:${g.action}`)).map(named),
    kept: withinCeiling.filter((g) => !wasWritten.has(`${g.resource}:${g.action}`)).map(named),
    beyondCeiling: beyond.map(named),
  };
}

/** The same test as a delegated grant's (app-roles.ts): the parent may take the action and use each allowed field. A DENY never exceeds. */
async function withinParent(context: AppContext, parent: string, grant: Permission): Promise<boolean> {
  if (grant.effect !== "ALLOW") return true;
  const ceiling = await context.effectivePermissions.resolve([parent], grant.resource, grant.action);
  if (ceiling.action !== "ALLOW") return false;
  return grant.fields.every((f) => f.effect !== "ALLOW" || ceiling.fieldDecision(f.field) === "ALLOW");
}

async function resourceNames(context: AppContext, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const { rows } = await context.database.query<{ id: string; name: string }>(
    `SELECT id, schema || '.' || name AS name FROM totalbase.resources WHERE id = ANY($1::uuid[])`,
    [[...new Set(ids)]],
  );
  return new Map(rows.map((row) => [row.id, row.name]));
}
