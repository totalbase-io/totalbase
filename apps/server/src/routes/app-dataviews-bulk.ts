import type { FastifyInstance, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { executeTransaction } from "@totalbase/mutations";
import { resolveTableResource } from "@totalbase/resources";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { openableDataView } from "./app-dataviews.js";
import { requestData, type DataBody } from "../request-body.js";

interface BulkUpdateBody {
  /** The values every row gets. */
  set: Record<string, unknown>;
  /** The rows the viewer chose, by their primary key - the only way to name them. */
  keys: unknown[];
}

/**
 * Bulk edit (DataViews.md §5.15): the chosen fields set on the rows the viewer chose - by their keys,
 * never a set resolved by a filter or a search (a `query` is refused). At most `dataviews.bulk_edit_max_rows`; then
 * one transaction, an update by key per row as the viewer (the DataView's save, §6.6): a key that isn't there or is
 * outside their row filter, or a row PostgreSQL refuses (a CHECK), and none changes. Audited row by row.
 */
export function registerAppDataViewBulkRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  app.post<{ Params: { slug: string }; Body: DataBody<BulkUpdateBody> }>("/app/api/dataviews/:slug/bulk-update", { preHandler }, async (request: FastifyRequest<{ Params: { slug: string }; Body: DataBody<BulkUpdateBody> }>) => {
    const view = await openableDataView(context, request, request.params.slug);
    const body = requestData(request.body);
    // Editing, many at once: only where the DataView lets its viewers edit - each write still needs their UPDATE.
    const allow = view.viewConfig.allow;
    if (Array.isArray(allow) && !allow.includes("update")) {
      throw new TotalBaseError("ACTION_DENIED", "This DataView doesn't let its viewers edit.");
    }
    if (view.sourceResourceType !== "TABLE" || !view.sourceResourceSchema || !view.sourceResourceName) {
      throw new TotalBaseError("ACTION_DENIED", "Only a table's rows are edited in bulk.");
    }
    if (!body || typeof body.set !== "object" || body.set === null || Array.isArray(body.set) || Object.keys(body.set).length === 0) {
      throw new TotalBaseError("INVALID_QUERY", "set names at least one field.");
    }
    if ("query" in body || !Array.isArray(body.keys) || body.keys.length === 0) {
      throw new TotalBaseError("INVALID_QUERY", "Bulk edit takes the chosen rows' keys - never a filter or a search.");
    }

    const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), request.headers["x-totalbase-timezone"], request);
    const [maxRows, maxFilterDepth, maxRelationDepth] = await Promise.all([
      context.settings.get("dataviews.bulk_edit_max_rows"),
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
    ]);
    const keys = [...new Set(body.keys)];
    if (keys.length > maxRows) {
      throw new TotalBaseError("BULK_EDIT_TOO_MANY", `More than ${maxRows} rows: edit them in parts.`);
    }
    const resource = await resolveTableResource(context, view.sourceResourceSchema, view.sourceResourceName, "PATCH");

    const operations = keys.map((id, index) => ({ key: `row${index + 1}`, operation: "update" as const, schema: resource.schema, table: resource.name, id, data: body.set }));
    await executeTransaction(
      {
        context,
        dataPrincipal,
        limits: { maxFilterDepth, maxRelationDepth },
        audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
      },
      { operations },
      { recordSave: { maxOperations: maxRows } },
    );
    return { data: { updated: keys.length } };
  });
}
