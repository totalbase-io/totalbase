import { getFunctionDetail } from "@totalbase/pg-catalog";
import type { Database } from "@totalbase/database";
import type { EffectivePermission, EffectivePermissionService, PermissionDecision, ResourceAction } from "@totalbase/permissions";
import { SchemaContext, type ResolvedResource } from "@totalbase/query-engine";
import { getPasswordColumns } from "@totalbase/resources";
import { buildFunctionSpec, type FunctionClass } from "./function-spec.js";
import { commonDocumentParts, ensureUniqueOperationIds } from "./common-components.js";
import type { JsonSchema, OpenApiDocument, OpenApiDocumentOptions, PathItem } from "./openapi-types.js";
import { addDocumentedRoutes, type DocumentedRoute } from "./route-docs.js";
import { buildTableOrViewSpec } from "./table-view-spec.js";
import { buildWorkflowPaths, type WorkflowEndpoint } from "./workflow-spec.js";

interface ResourceRow {
  id: string;
  postgres_oid: number;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  exposed_methods: string[];
  function_class: FunctionClass | null;
  require_idempotency_key: boolean;
}

/** The HTTP verb each permission action maps to - a ResourceAction is only actually reachable if its verb is in exposed_methods (admin's per-verb ceiling, resource-resolver.ts). */
const ACTION_METHOD: Record<ResourceAction, string> = {
  CREATE: "POST",
  READ: "GET",
  UPDATE: "PATCH",
  DELETE: "DELETE",
  EXECUTE: "POST",
};

export interface PublicOpenApiOptions extends OpenApiDocumentOptions {
  /**
   * The same always-on field floor the Data API applies at every call site
   * (apps/server's totalbase-guardrails.ts: password_hash, token_hash, ...
   * are DENY whatever a grant says; roles' access flags can't be
   * written), so the document never lists a column the API would refuse.
   */
  guardFieldDecision?: (
    resource: ResolvedResource,
    action: ResourceAction,
    decision: (field: string) => PermissionDecision,
  ) => (field: string) => PermissionDecision;
  /** A session (USER) or an API key: session-only fixed routes are left out for the latter. Default USER. */
  principalType?: "USER" | "API_KEY";
  /** Fixed routes (auth, tokens, files, ...) documented through their Fastify `config.openapi`. */
  routes?: DocumentedRoute[];
  /** The workflows this principal may invoke. */
  workflows?: WorkflowEndpoint[];
  /** openapi.include_examples: sample values on column and argument schemas. */
  includeExamples?: boolean | undefined;
  /** idempotency.enabled: off, the Idempotency-Key header is ignored - a resource's requirement too. Default on. */
  idempotencyEnabled?: boolean | undefined;
}

/**
 * Builds the public Data API OpenAPI document for one principal, listing
 * only resources/actions/fields that principal's effective permissions
 * actually grant (Specification_Data_API.md §14.1: "principal-effective spec").
 */
export async function buildPublicOpenApiSpec(
  database: Database,
  effectivePermissions: EffectivePermissionService,
  roleIds: string[],
  options: PublicOpenApiOptions,
): Promise<OpenApiDocument> {
  const { rows } = await database.query<ResourceRow>(
    `SELECT id, postgres_oid, "schema", name, type, exposed_methods, function_class, require_idempotency_key FROM totalbase.resources
     WHERE status = 'ACTIVE' AND exposed_methods <> '{}'
     ORDER BY "schema", name`,
  );

  const schemaContext = new SchemaContext(database);
  const paths: Record<string, PathItem> = {};
  const schemas: Record<string, JsonSchema> = {};

  for (const row of rows) {
    const requireIdempotencyKey = row.require_idempotency_key && options.idempotencyEnabled !== false;
    if (row.type === "FUNCTION") {
      if (!row.exposed_methods.includes(ACTION_METHOD.EXECUTE)) continue;
      const permission = await effectivePermissions.resolve(roleIds, row.id, "EXECUTE");
      if (permission.action !== "ALLOW") continue;
      const detail = await getFunctionDetail(database, row.postgres_oid);
      const { path, pathItem } = buildFunctionSpec({
        schema: row.schema, name: row.name, detail, functionClass: row.function_class ?? "UNCLASSIFIED", includeExamples: options.includeExamples,
        requireIdempotencyKey,
      });
      // Multiple overloads share one path; OpenAPI has no native way to
      // express "same path, different body by argument-name-set" - the
      // first resolved overload's shape wins (documented simplification).
      if (!paths[path]) paths[path] = pathItem;
      continue;
    }

    const actions: ResourceAction[] = row.type === "TABLE" ? ["CREATE", "READ", "UPDATE", "DELETE"] : ["READ"];
    const allowed = new Set<ResourceAction>();
    const permissionByAction = new Map<ResourceAction, EffectivePermission>();
    for (const action of actions) {
      if (!row.exposed_methods.includes(ACTION_METHOD[action])) continue;
      const permission = await effectivePermissions.resolve(roleIds, row.id, action);
      if (permission.action === "ALLOW") {
        allowed.add(action);
        permissionByAction.set(action, permission);
      }
    }
    if (allowed.size === 0) continue;

    const resource = await schemaContext.loadRoot(row.schema, row.name, row.postgres_oid);
    const guard = options.guardFieldDecision ?? ((_resource, _action, decision) => decision);
    const fieldDecisions: Partial<Record<ResourceAction, (field: string) => PermissionDecision>> = {};
    for (const [action, permission] of permissionByAction) fieldDecisions[action] = guard(resource, action, permission.fieldDecision);

    const { paths: resourcePaths, schemas: resourceSchemas } = buildTableOrViewSpec({
      schema: row.schema,
      name: row.name,
      type: row.type,
      resource,
      allowedActions: allowed,
      fieldDecisions,
      passwordColumns: await getPasswordColumns(database, row.id),
      includeExamples: options.includeExamples,
      requireIdempotencyKey,
    });
    Object.assign(paths, resourcePaths);
    Object.assign(schemas, resourceSchemas);
  }

  await addDocumentedRoutes(options.routes ?? [], { roleIds, principalType: options.principalType ?? "USER" }, paths, schemas);
  const workflowSpec = buildWorkflowPaths(options.workflows ?? []);
  Object.assign(paths, workflowSpec.paths);
  Object.assign(schemas, workflowSpec.schemas);

  ensureUniqueOperationIds(paths);
  const common = commonDocumentParts(options);
  return {
    openapi: "3.1.0",
    info: {
      title: "TotalBase Data API",
      version: "1.0.0",
      description:
        "Principal-effective spec (Specification_Data_API.md §14): only resources, actions, and fields the " +
        "requesting caller is currently authorized for are listed. Never manually edited.",
    },
    servers: common.servers,
    security: common.security,
    paths,
    components: { ...common.components, schemas: { ...common.components.schemas, ...schemas } },
  };
}
