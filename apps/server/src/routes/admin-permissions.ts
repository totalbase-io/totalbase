import type { FastifyInstance } from "fastify";
import { grantAdvisories, type ResourceAction, type SetPermissionInput } from "@totalbase/permissions";
import { UUID_PATTERN } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import { assertFilterPathsResolve, filterFieldPaths, parseFilter } from "@totalbase/query-engine";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { applyTotalbaseDefaultGrants } from "../totalbase-default-grants.js";
import { copyRolePermissions } from "../copy-role-permissions.js";
import { dataEnvelope, type JsonSchema } from "@totalbase/openapi";
import { ADMIN_SCHEMAS, adminDoc, arrayOf, FILTER, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import { optionalData } from "../request-body.js";

const VALID_ACTIONS: ReadonlySet<string> = new Set(["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"]);

export function requireValidAction(action: string): ResourceAction {
  if (!VALID_ACTIONS.has(action)) {
    throw new TotalBaseError("INVALID_QUERY", `Unknown permission action: ${action}`);
  }
  return action as ResourceAction;
}

/**
 * A written grant's answer, with `meta.warnings` when it lets its role reach rows the role's own row filters
 * elsewhere keep from it (grantAdvisories, Security.md §6.5, §6.10) - advice, never a refusal.
 */
export function withAdvice<T>(body: { data: T }, warnings: string[]): { data: T; meta?: { warnings: string[] } } {
  return warnings.length > 0 ? { ...body, meta: { warnings } } : body;
}

/** A grant body's keys (PermissionBody) - parseGrant refuses any other. */
const GRANT_KEYS = ["effect", "where", "fields", "payloadChecks"] as const;

export interface PermissionBody {
  effect: "ALLOW" | "DENY";
  where?: unknown;
  fields?: { field: string; effect: "ALLOW" | "DENY" }[];
  /** "Payload checks" (totalbase.permissions.payload_checks) - role-scoped CREATE/UPDATE business-rule checks, not PostgreSQL CHECK constraints. */
  payloadChecks?: { rule: unknown; label?: string | null }[];
}

/** The documented shape of one grant's body - the single PUT's `data`, and each entry of the bulk PUT's `permissions`. */
export const GRANT_PROPERTIES: Record<string, JsonSchema> = {
  effect: { type: "string", enum: ["ALLOW", "DENY"] },
  where: { ...FILTER, type: ["object", "null"], description: "Row filter; null clears it." },
  fields: arrayOf(object({ field: { type: "string" }, effect: { type: "string", enum: ["ALLOW", "DENY"] } }, ["field", "effect"])),
  payloadChecks: arrayOf(object({ rule: FILTER, label: { type: ["string", "null"] } }, ["rule"])),
};

/**
 * A grant's body as PermissionsService takes it, its filters checked first:
 * the same grammar and the same parser the Data API uses for its own
 * where[...] params (shape, operators, depth), then every path they name
 * against the resource as PostgreSQL defines it now - a column, or a
 * dotted path over real foreign keys (assertFilterPathsResolve). Without
 * this, a typo or a missing foreign key saves and only fails later, at
 * request time, for whoever's role holds this grant. Payload checks share
 * the exact same grammar and get the exact same treatment.
 */
export async function parseGrant(context: AppContext, resourceId: string, body: unknown, options: { checkPaths?: boolean; extraKeys?: readonly string[] } = {}): Promise<SetPermissionInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TotalBaseError("INVALID_QUERY", "The grant goes in data.");
  // Only the keys a grant has (and the route's own - a bulk entry's resource and action, a shared grant's roleIds):
  // an unknown one refused by name, never dropped - a `deny_fields` that went unread left those columns allowed.
  const allowed = new Set<string>([...GRANT_KEYS, ...(options.extraKeys ?? [])]);
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TotalBaseError("INVALID_QUERY", `Unknown key${unknown.length > 1 ? "s" : ""} in the grant: ${unknown.join(", ")} - a grant takes ${[...allowed].join(", ")} (a field's DENY goes in fields: [{ "field": "<column>", "effect": "DENY" }]).`);
  }
  const grant = body as PermissionBody;
  if (grant.effect !== "ALLOW" && grant.effect !== "DENY") throw new TotalBaseError("INVALID_QUERY", "effect must be ALLOW or DENY.");
  // The shape, before anything is stored: a list of column names (["id", "name"]) reads as a list but is not
  // one - each entry names its field and its effect, so a DENY on one field can sit beside the ALLOWs.
  if (grant.fields !== undefined && !(Array.isArray(grant.fields) && grant.fields.every(isFieldGrant))) {
    throw new TotalBaseError("INVALID_QUERY", 'fields must be a list of { "field": "<column>", "effect": "ALLOW" | "DENY" } objects.');
  }
  if (grant.payloadChecks !== undefined && !(Array.isArray(grant.payloadChecks) && grant.payloadChecks.every(isPayloadCheck))) {
    throw new TotalBaseError("INVALID_QUERY", 'payloadChecks must be a list of { "rule": <filter>, "label"?: "<text>" } objects.');
  }
  const needsLimits = (grant.where !== undefined && grant.where !== null) || (grant.payloadChecks !== undefined && grant.payloadChecks.length > 0);
  if (needsLimits) {
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
    ]);
    if (grant.where !== undefined && grant.where !== null) parseFilter(grant.where, { maxFilterDepth, maxRelationDepth }, 0);
    for (const check of grant.payloadChecks ?? []) parseFilter(check.rule, { maxFilterDepth, maxRelationDepth }, 0);
  }
  const parsed: SetPermissionInput = {
    effect: grant.effect,
    where: grant.where,
    fields: grant.fields,
    payloadChecks: grant.payloadChecks?.map((v) => ({ rule: v.rule, label: v.label ?? null })),
  };
  if (options.checkPaths !== false) await assertGrantPathsResolve(context, resourceId, parsed);
  return parsed;
}

/**
 * The paths a grant's row filter and payload checks name, each a column of the resource or a dotted path over real
 * foreign keys (assertFilterPathsResolve). A delegated grant checks them after its ceiling (app-roles.ts): a path the
 * parent can't read is refused as beyond the ceiling, never answered with whether it exists.
 */
export async function assertGrantPathsResolve(context: AppContext, resourceId: string, grant: SetPermissionInput): Promise<void> {
  const filters = [grant.where, ...(grant.payloadChecks ?? []).map((check) => check.rule)].filter((filter) => filter !== undefined && filter !== null);
  if (filters.length === 0) return;
  if (!UUID_PATTERN.test(resourceId)) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${resourceId}`);
  const resource = await context.resourcesAdmin.get(resourceId);
  if (resource.type === "FUNCTION" || resource.status !== "ACTIVE") return;
  const [maxFilterDepth, maxRelationDepth] = await Promise.all([context.settings.get("api.max_filter_depth"), context.settings.get("api.max_relation_depth")]);
  const paths = filters.flatMap((filter) => filterFieldPaths(parseFilter(filter, { maxFilterDepth, maxRelationDepth }, 0)));
  await assertFilterPathsResolve(context.database, resource.postgresOid, resource.name, [...new Set(paths)]);
}

function isFieldGrant(value: unknown): value is { field: string; effect: "ALLOW" | "DENY" } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { field, effect } = value as { field?: unknown; effect?: unknown };
  return typeof field === "string" && field.length > 0 && (effect === "ALLOW" || effect === "DENY");
}

function isPayloadCheck(value: unknown): value is { rule: unknown; label?: string | null } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const { rule, label } = value as { rule?: unknown; label?: unknown };
  return rule !== undefined && (label === undefined || label === null || typeof label === "string");
}

/** A non-empty list of distinct role ids. */
export function parseRoleIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string" && UUID_PATTERN.test(id))) {
    throw new TotalBaseError("INVALID_QUERY", "roleIds must be a non-empty list of role ids.");
  }
  return [...new Set(value as string[])];
}

/**
 * Grant/revoke management (Administration.md §1: "Permissions").
 * These are the only endpoints that write totalbase.permissions,
 * including its field_overrides/payload_checks jsonb columns - the rows
 * EffectivePermissionService (used throughout the Data API) only ever
 * reads.
 */
export function registerAdminPermissionsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.put<{ Params: { role: string; resource: string; action: string }; Body: { data?: PermissionBody } }>(
    "/admin/api/roles/:role/resources/:resource/permissions/:action",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Grant or deny an action on a resource to a role",
        description:
          "Upserts the role's grant for (resource, action). DENY > ALLOW > undefined across roles; ALLOW row filters " +
          "OR-combine; payload checks AND-combine. `fields` replaces the field grants when present; a dotted field " +
          "(`position.title`) grants a relation traversal. `meta.warnings` advises (never refuses) when the grant reaches rows the role's row filter on another table keeps from it (Security.md §6.10).",
        pathParameters: { role: UUID_PARAM, resource: UUID_PARAM, action: { schema: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] } } },
        requestBody: { schema: dataEnvelope(object({ ...GRANT_PROPERTIES }, ["effect"])) },
        response: ok(ref("Permission")),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const action = requireValidAction(request.params.action);
      const permission = await context.permissions.set(request.params.role, request.params.resource, action, await parseGrant(context, request.params.resource, request.body?.data), { actorUserId: request.admin!.id });
      return withAdvice({ data: permission }, await grantAdvisories(context.database, request.params.role, request.params.resource, action));
    },
  );

  // Several of a role's grants at once - an agent granting a role its tables (grant_permissions) in one transaction.
  app.put<{ Params: { role: string }; Body: { data?: { permissions?: (PermissionBody & { resource?: string; action?: string })[] } } }>(
    "/admin/api/roles/:role/permissions",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Grant or deny several (resource, action) pairs to a role at once",
        description:
          "Upserts every grant in `permissions` for the role in one transaction - all of them, or none. Each entry is the " +
          "single grant's body plus its `resource` and `action`; grants the role holds on other (resource, action) pairs " +
          "are left as they are. Answers the grants in the order given. 404 when the role doesn't exist.",
        pathParameters: { role: UUID_PARAM },
        requestBody: {
          schema: dataEnvelope(object({
            permissions: arrayOf(object(
              { resource: UUID, action: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] }, ...GRANT_PROPERTIES },
              ["resource", "action", "effect"],
            )),
          }, ["permissions"])),
        },
        response: ok(arrayOf(ref("Permission"))),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const entries = optionalData(request.body).permissions;
      if (!Array.isArray(entries) || entries.length === 0) throw new TotalBaseError("INVALID_QUERY", "permissions must be a non-empty list.");
      if (!(await context.roles.findById(request.params.role))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
      const grants = [];
      for (const entry of entries) {
        if (typeof entry?.resource !== "string" || !UUID_PATTERN.test(entry.resource)) throw new TotalBaseError("INVALID_QUERY", "Each grant names its resource (a resource id).");
        const action = requireValidAction(String(entry.action));
        grants.push({ resourceId: entry.resource, action, input: await parseGrant(context, entry.resource, entry, { extraKeys: ["resource", "action"] }) });
      }
      const written = await context.permissions.setMany(request.params.role, grants, { actorUserId: request.admin!.id });
      const advice = (await Promise.all(grants.map((grant) => grantAdvisories(context.database, request.params.role, grant.resourceId, grant.action)))).flat();
      return withAdvice({ data: written }, advice);
    },
  );

  // One grant for several roles at once (Security.md §5.3) - the same role kept per site, granted alike.
  app.put<{ Params: { resource: string; action: string }; Body: { data?: PermissionBody & { roleIds?: unknown } } }>(
    "/admin/api/resources/:resource/permissions/:action",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Grant the same action on a resource to several roles",
        description:
          "Upserts the grant for each role in `roleIds`, in one transaction - all of them, or none. The body is the single " +
          "grant's plus `roleIds`. Answers the grants in the order given.",
        pathParameters: { resource: UUID_PARAM, action: { schema: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] } } },
        requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf(UUID), ...GRANT_PROPERTIES }, ["roleIds", "effect"])) },
        response: ok(arrayOf(ref("Permission"))),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const action = requireValidAction(request.params.action);
      const roleIds = parseRoleIdList(optionalData(request.body).roleIds);
      const grant = await parseGrant(context, request.params.resource, request.body?.data, { extraKeys: ["roleIds"] });
      const written = await context.permissions.setForRoles(roleIds, request.params.resource, action, grant, { actorUserId: request.admin!.id });
      const advice = [...new Set((await Promise.all(roleIds.map((roleId) => grantAdvisories(context.database, roleId, request.params.resource, action)))).flat())];
      return withAdvice({ data: written }, advice);
    },
  );

  app.delete<{ Params: { role: string; resource: string; action: string } }>(
    "/admin/api/roles/:role/resources/:resource/permissions/:action",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Remove a role's grant for an action",
        description: "404 when the role holds no grant for that action on the resource.",
        pathParameters: { role: UUID_PARAM, resource: UUID_PARAM, action: { schema: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] } } },
        response: NO_CONTENT,
      }),
    },
    async (request, reply) => {
      const action = requireValidAction(request.params.action);
      if (!(await context.permissions.delete(request.params.role, request.params.resource, action))) {
        throw new TotalBaseError("RESOURCE_NOT_FOUND", "Permission not found.");
      }
      reply.code(204);
    },
  );

  app.post<{ Params: { role: string } }>(
    "/admin/api/roles/:role/totalbase-defaults",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Apply the default permissions on TotalBase's own tables",
        description:
          "Gives the role what an ordinary App user needs on the totalbase schema (Security.md §10.5): read and " +
          "upload files and folders, changing or deleting only their own; read templates and roles; read and update their own " +
          "account (name, avatar_url, preferences) and assignments; read and sign out their own sessions. A default is written only " +
          "where the role has no grant for that table and action yet - one it has (broader, narrower or DENY) is kept and listed in " +
          "`kept` - so applying twice changes nothing; grants on other tables are left alone. `missing` lists tables with no " +
          "ACTIVE resource. No body.",
        pathParameters: { role: UUID_PARAM },
        response: ok(object({
          applied: arrayOf(object({ table: { type: "string" }, action: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE"] } }, ["table", "action"])),
          kept: arrayOf(object({ table: { type: "string" }, action: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE"] } }, ["table", "action"])),
          missing: arrayOf({ type: "string" }),
        }, ["applied", "kept", "missing"])),
      }),
    },
    async (request) => {
      if (!(await context.roles.findById(request.params.role))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
      return { data: await applyTotalbaseDefaultGrants(context, request.params.role) };
    },
  );

  // Copy another role's grants (Security.md §5.4): added or replacing, within the target's ceiling.
  app.post<{ Params: { role: string }; Body: { data?: { from?: unknown; replace?: unknown } } | undefined }>(
    "/admin/api/roles/:role/permissions/copy",
    {
      preHandler,
      ...adminDoc("permissions", {
        summary: "Copy another role's permissions",
        description:
          "Writes the `from` role's grants - each whole: action, effect, row filter, fields, payload checks - on this role, " +
          "in one transaction. Added by default: a grant this role already has for the same resource and action is kept " +
          "(`kept`); `replace: true` removes this role's grants first. A grant beyond this role's ceiling (its parent can't " +
          "take the action or use a field) isn't copied (`beyondCeiling`). Nothing else of the role is copied. Neither role " +
          "may be Administrators or Workflows (403); `from` the role itself, or no role, is 400.",
        pathParameters: { role: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ from: UUID, replace: { type: "boolean", default: false } }, ["from"])) },
        response: ok(object({
          copied: arrayOf(object({ resource: { type: "string" }, action: { type: "string" } }, ["resource", "action"])),
          kept: arrayOf(object({ resource: { type: "string" }, action: { type: "string" } }, ["resource", "action"])),
          beyondCeiling: arrayOf(object({ resource: { type: "string" }, action: { type: "string" } }, ["resource", "action"])),
        }, ["copied", "kept", "beyondCeiling"])),
      }),
    },
    async (request) => {
      const from = optionalData(request.body).from;
      const replace = optionalData(request.body).replace ?? false;
      if (typeof from !== "string" || !UUID_PATTERN.test(from)) throw new TotalBaseError("INVALID_QUERY", "from must be a role id.");
      if (typeof replace !== "boolean") throw new TotalBaseError("INVALID_QUERY", "replace must be true or false.");
      const result = await copyRolePermissions(context, request.params.role, from, { replace, actorUserId: request.admin!.id });
      request.auditMetadata = { from, replace, copied: result.copied.length, kept: result.kept.length, beyond_ceiling: result.beyondCeiling.length };
      return { data: result };
    },
  );

}
