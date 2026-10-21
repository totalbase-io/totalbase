import type { FastifyInstance } from "fastify";
import type { ResourceAction, SetPermissionInput } from "@totalbase/permissions";
import { UUID_PATTERN } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import { parseFilter } from "@totalbase/query-engine";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { applyTotalbaseDefaultGrants } from "../totalbase-default-grants.js";
import { dataEnvelope, type JsonSchema } from "@totalbase/openapi";
import { ADMIN_SCHEMAS, adminDoc, arrayOf, FILTER, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";

const VALID_ACTIONS: ReadonlySet<string> = new Set(["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"]);

function requireValidAction(action: string): ResourceAction {
  if (!VALID_ACTIONS.has(action)) {
    throw new TotalBaseError("INVALID_QUERY", `Unknown permission action: ${action}`);
  }
  return action as ResourceAction;
}

interface PermissionBody {
  effect: "ALLOW" | "DENY";
  where?: unknown;
  fields?: { field: string; effect: "ALLOW" | "DENY" }[];
  /** "Payload checks" (totalbase.permissions.payload_checks) - role-scoped CREATE/UPDATE business-rule checks, not PostgreSQL CHECK constraints. */
  payloadChecks?: { rule: unknown; label?: string | null }[];
}

/** The documented shape of one grant's body - the single PUT's `data`, and each entry of the bulk PUT's `permissions`. */
const GRANT_PROPERTIES: Record<string, JsonSchema> = {
  effect: { type: "string", enum: ["ALLOW", "DENY"] },
  where: { ...FILTER, type: ["object", "null"], description: "Row filter; null clears it." },
  fields: arrayOf(object({ field: { type: "string" }, effect: { type: "string", enum: ["ALLOW", "DENY"] } }, ["field", "effect"])),
  payloadChecks: arrayOf(object({ rule: FILTER, label: { type: ["string", "null"] } }, ["rule"])),
};

/**
 * A grant's body as PermissionsService takes it, its filters checked first.
 * Structural-only validation - same grammar and the same parser the
 * Data API uses for its own where[...] params (parseFilter only
 * checks shape/operators/depth, not field existence - that's the
 * compiler's job, and doesn't apply here since this is stored, not
 * run against a resource yet). Without this, a malformed where
 * silently saves and only fails later, at request time, for
 * whoever's role holds this grant - see the chat that added this.
 * Payload checks share the exact same grammar and get the exact
 * same treatment - each check is its own filter, checked the same way.
 */
async function parseGrant(context: AppContext, body: unknown): Promise<SetPermissionInput> {
  if (!body || typeof body !== "object") throw new TotalBaseError("INVALID_QUERY", "The grant goes in data.");
  const grant = body as PermissionBody;
  const needsLimits = (grant.where !== undefined && grant.where !== null) || (grant.payloadChecks !== undefined && grant.payloadChecks.length > 0);
  if (needsLimits) {
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
    ]);
    if (grant.where !== undefined && grant.where !== null) parseFilter(grant.where, { maxFilterDepth, maxRelationDepth }, 0);
    for (const check of grant.payloadChecks ?? []) parseFilter(check.rule, { maxFilterDepth, maxRelationDepth }, 0);
  }
  return {
    effect: grant.effect,
    where: grant.where,
    fields: grant.fields,
    payloadChecks: grant.payloadChecks?.map((v) => ({ rule: v.rule, label: v.label ?? null })),
  };
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
          "(`position.title`) grants a relation traversal.",
        pathParameters: { role: UUID_PARAM, resource: UUID_PARAM, action: { schema: { type: "string", enum: ["CREATE", "READ", "UPDATE", "DELETE", "EXECUTE"] } } },
        requestBody: { schema: dataEnvelope(object({ ...GRANT_PROPERTIES }, ["effect"])) },
        response: ok(ref("Permission")),
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request) => {
      const action = requireValidAction(request.params.action);
      const permission = await context.permissions.set(request.params.role, request.params.resource, action, await parseGrant(context, request.body?.data));
      return { data: permission };
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
      const entries = request.body?.data?.permissions;
      if (!Array.isArray(entries) || entries.length === 0) throw new TotalBaseError("INVALID_QUERY", "permissions must be a non-empty list.");
      if (!(await context.roles.findById(request.params.role))) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
      const grants = [];
      for (const entry of entries) {
        if (typeof entry?.resource !== "string" || !UUID_PATTERN.test(entry.resource)) throw new TotalBaseError("INVALID_QUERY", "Each grant names its resource (a resource id).");
        const action = requireValidAction(String(entry.action));
        grants.push({ resourceId: entry.resource, action, input: await parseGrant(context, entry) });
      }
      return { data: await context.permissions.setMany(request.params.role, grants) };
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

}
