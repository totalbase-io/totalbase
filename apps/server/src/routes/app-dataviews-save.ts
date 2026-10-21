import type { FastifyInstance, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { executeTransaction, type TransactionRequest } from "@totalbase/mutations";
import type { AdminDataView } from "@totalbase/dataviews";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAppAccess } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { withIdempotency } from "../idempotency-helper.js";
import { openableDataView } from "./app-dataviews.js";
import { requestData, type DataBody } from "../request-body.js";

/** `schema.table` - how an operation names its table. */
const tableKey = (schema: string, name: string) => `${schema}.${name}`;

/**
 * The tables a record of this DataView saves (DataViews.md §6.6): its own source, the sources of
 * the DataViews its page embeds (TDataView - a master-detail's lines) and the junction tables its form
 * fields link through (`junction`, §8.5) - each still one of the source's, read live. Read from what the viewer
 * opens: the published page, or an administrator's draft of one never published.
 */
async function recordTables(context: AppContext, view: AdminDataView): Promise<Set<string>> {
  const tables = new Set<string>();
  if (view.sourceResourceSchema && view.sourceResourceName && view.sourceResourceType === "TABLE") {
    tables.add(tableKey(view.sourceResourceSchema, view.sourceResourceName));
  }
  const fields = view.liveVersion === null ? await context.dataviewsAdmin.listFields(view.id) : await context.dataviewsAdmin.listPublishedFields(view.id);
  const embedded = [...new Set(fields.filter((field) => field.widget === "TDataView" && field.relatedDataview).map((field) => field.relatedDataview!))];
  for (const id of embedded) {
    const detail = await context.dataviewsAdmin.get(id);
    if (detail.sourceResourceSchema && detail.sourceResourceName && detail.sourceResourceType === "TABLE") {
      tables.add(tableKey(detail.sourceResourceSchema, detail.sourceResourceName));
    }
  }
  const junctions = [...new Set(fields.flatMap((field) => {
    const junction = field.widget === "UFormField" ? (field.config as { props?: { junction?: unknown } }).props?.junction : undefined;
    return typeof junction === "string" && junction ? [junction] : [];
  }))];
  for (const id of view.sourceResource ? junctions : []) {
    const junction = await context.dataviewsAdmin.getJunction(view.sourceResource!, id);
    if (junction) tables.add(tableKey(junction.schema, junction.table));
  }
  return tables;
}

/**
 * A record and its lines saved together (DataViews.md §6.6): `POST /app/api/dataviews/:slug/save`
 * runs the transactions engine (Data_API.md §8) for a DataView the caller opens - only on its own
 * tables, each operation authorized like any write, without the public API's TRANSACTIONS capability.
 */
export function registerAppDataViewSaveRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  app.post<{ Params: { slug: string }; Body: DataBody<TransactionRequest> }>("/app/api/dataviews/:slug/save", { preHandler }, async (request: FastifyRequest<{ Params: { slug: string }; Body: DataBody<TransactionRequest> }>, reply) => {
    const view = await openableDataView(context, request, request.params.slug);
    const body = requestData(request.body);
    const tables = await recordTables(context, view);
    const operations = Array.isArray(body?.operations) ? body.operations : [];
    for (const op of operations) {
      if (typeof op?.schema !== "string" || typeof op?.table !== "string" || !tables.has(tableKey(op.schema, op.table))) {
        throw new TotalBaseError("INVALID_TRANSACTION_PAYLOAD", `Operation "${String(op?.key)}" writes a table this DataView doesn't save.`);
      }
    }

    const dataPrincipal = await resolveDataPrincipal(context, extractBearerToken(request), request.headers["x-totalbase-timezone"], request);
    const [maxFilterDepth, maxRelationDepth, maxOperations] = await Promise.all([
      context.settings.get("api.max_filter_depth"),
      context.settings.get("api.max_relation_depth"),
      context.settings.get("dataviews.save_max_operations"),
    ]);
    const response = await withIdempotency(context, request.headers as Record<string, unknown>, dataPrincipal, `dataviews:save:${view.id}`, "POST", request.body, async () => {
      const results = await executeTransaction(
        {
          context,
          dataPrincipal,
          limits: { maxFilterDepth, maxRelationDepth },
          audit: { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"], source: "api" },
        },
        { operations },
        { recordSave: { maxOperations } },
      );
      return { status: 200, body: { data: results } };
    });
    reply.code(response.status);
    return response.body;
  });
}
