import { TotalBaseError } from "@totalbase/errors";
import type { WorkflowEngineContext } from "./context.js";

export interface WorkflowResource {
  id: string;
  postgresOid: number;
  schema: string;
  name: string;
  /** The resource's default order (Specification.md §11.7) - a Read records without an order uses it. */
  defaultSort: { column: string; direction: "asc" | "desc" }[];
}

/**
 * Resolves a Workflow operation's `configuration.resource` field - a
 * totalbase.resources.id (uuid), the same id the admin's resource
 * picker persists (ReadRecordsModal.vue etc. store `resource.id`
 * directly, not a schema/name slug) - into what mutation-service.ts /
 * @totalbase/query-engine actually need. Distinct from
 * apps/server/src/resource-resolver.ts's resolveTableResource(), which
 * takes (schema, name, method) for the HTTP Data API's own :schema/:name
 * route params; a workflow operation has no such route, just the one id
 * string, so it resolves directly by primary key instead.
 */
export async function resolveWorkflowResource(
  context: WorkflowEngineContext,
  resourceId: string | undefined,
  /** Accepted resource types - Read records also reads a VIEW (Specification_Workflows.md §5.2); writes and functions take exactly one. */
  types: ReadonlyArray<"TABLE" | "VIEW" | "FUNCTION"> = ["TABLE"],
): Promise<WorkflowResource> {
  if (!resourceId) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "This step has no resource configured.");
  const { rows } = await context.database.query<{ id: string; postgres_oid: number; schema: string; name: string; status: string; type: string; default_sort: { column: string; direction: "asc" | "desc" }[] }>(
    `SELECT id, postgres_oid, schema, name, status, type, default_sort FROM totalbase.resources WHERE id = $1`,
    [resourceId],
  );
  const row = rows[0];
  if (!row || row.status !== "ACTIVE" || !types.includes(row.type as "TABLE" | "VIEW" | "FUNCTION")) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", "The resource configured for this step no longer exists.");
  }
  return { id: row.id, postgresOid: row.postgres_oid, schema: row.schema, name: row.name, defaultSort: row.default_sort ?? [] };
}
