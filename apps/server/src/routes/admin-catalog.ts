import type { FastifyInstance } from "fastify";
import {
  buildCatalogSnapshot,
  getFunctionDdl,
  getFunctionDetail,
  listFunctionArguments,
  getFunctionOwnership,
  getRelationDetail,
  getRelationOwnership,
  getRelationIndexes,
  getViewDdl,
  listRelationColumns,
  listSchemas,
  previewRelationRows,
  type ResourceType,
} from "@totalbase/pg-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { isProtectedField } from "@totalbase/mutations";
import type { AppContext } from "../context.js";
import { recordCatalog } from "../record-catalog.js";
import { brokenReferences, syncCatalog } from "../catalog-refresh.js";
import { dataApiTimeout } from "@totalbase/mutations";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, object, ok, ref } from "../openapi-admin-docs.js";
import { CATALOG_SCHEMAS, RESOURCE_ID_PARAM } from "../openapi-admin-docs-database.js";
import { resourceByPathId } from "../resource-by-path-id.js";

const doc = (openapi: Parameters<typeof adminDoc>[1]) => adminDoc("catalog", { schemas: CATALOG_SCHEMAS, ...openapi });
const BY_ID = { id: RESOURCE_ID_PARAM };
const NOT_A = (type: string) => `400 INVALID_QUERY when the resource is not a ${type}; 404 when it doesn't exist.`;

async function resolveResource(context: AppContext, id: string, type: ResourceType) {
  const resource = await resourceByPathId(context, id);
  if (resource.type !== type) {
    throw new TotalBaseError("INVALID_QUERY", `Resource ${id} is not a ${type}.`);
  }
  return resource;
}

async function resolveResourceOid(context: AppContext, id: string, type: ResourceType): Promise<number> {
  return (await resolveResource(context, id, type)).postgresOid;
}

/**
 * A relation's detail with `protected` on each column: the columns the Data API never reads or writes whatever a
 * grant says (@totalbase/mutations' guardrails) - the field-grant checklist shows them disabled, from this flag,
 * never from a list of its own.
 */
async function relationDetailWithOwnership(context: AppContext, id: string, type: ResourceType) {
  const resource = await resolveResource(context, id, type);
  const [detail, ownership] = await Promise.all([getRelationDetail(context.database, resource.postgresOid), getRelationOwnership(context.database, resource.postgresOid)]);
  return {
    ...detail,
    columns: detail.columns.map((column) => ({ ...column, protected: isProtectedField(resource.schema, resource.name, column.name) })),
    ...ownership,
  };
}

/**
 * Raw PostgreSQL catalog browsing (Administration.md §1:
 * "Catalog"). Independent of exposure state - see admin-resources.ts for
 * managing what's actually exposed through the Data API. `{resource}`
 * is the PostgreSQL oid (Foundations.md §11: identity follows
 * OID), not a resource name, since names collide across schemas.
 * `{id}` is the TotalBase resource id, or the object's PostgreSQL OID
 * (resourceByPathId - the same rules as DROP VIEW/FUNCTION).
 */
export function registerAdminCatalogRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  const byType = async (type: ResourceType) => {
    const snapshot = await buildCatalogSnapshot(context.database);
    return snapshot.filter((object) => object.resourceType === type);
  };

  app.get("/admin/api/catalog/schemas", {
    preHandler,
    ...doc({
      summary: "PostgreSQL schemas",
      description: "Every schema except PostgreSQL's own (pg_*, information_schema), empty ones included, with how many tables, views and functions it holds.",
      response: ok(arrayOf(object({ schema: { type: "string" }, objectCount: { type: "integer" } }))),
    }),
  }, async () => {
    const [snapshot, schemaNames] = await Promise.all([buildCatalogSnapshot(context.database), listSchemas(context.database)]);
    const counts = new Map<string, number>();
    for (const object of snapshot) {
      counts.set(object.schema, (counts.get(object.schema) ?? 0) + 1);
    }
    return {
      data: schemaNames
        .map((schema) => ({ schema, objectCount: counts.get(schema) ?? 0 }))
        .sort((a, b) => a.schema.localeCompare(b.schema)),
    };
  });

  app.get("/admin/api/catalog/tables", {
    preHandler,
    ...doc({
      summary: "Ordinary and partitioned tables in the catalog",
      description: "Read straight from pg_catalog, whether exposed through the Data API or not. TotalBase's own tables appear only where they are exposable.",
      response: ok(arrayOf(ref("CatalogObject"))),
    }),
  }, async () => ({ data: await byType("TABLE") }));
  app.get("/admin/api/catalog/views", {
    preHandler,
    ...doc({
      summary: "Views and materialized views in the catalog",
      description: "Read straight from pg_catalog, whether exposed through the Data API or not. TotalBase's own tables appear only where they are exposable.",
      response: ok(arrayOf(ref("CatalogObject"))),
    }),
  }, async () => ({ data: await byType("VIEW") }));
  app.get("/admin/api/catalog/functions", {
    preHandler,
    ...doc({
      summary: "Functions (procedures are not listed) in the catalog",
      description:
        "Read straight from pg_catalog, whether exposed through the Data API or not. Each overload is its own entry (one OID each); " +
        "`arguments` is its identity signature, what tells overloads of one name apart.",
      response: ok(arrayOf(ref("CatalogFunction"))),
    }),
  }, async () => {
    const functions = await byType("FUNCTION");
    const args = await listFunctionArguments(context.database, functions.map((fn) => fn.oid));
    return { data: functions.map((fn) => ({ ...fn, arguments: args.get(fn.oid) ?? "" })) };
  });

  app.get<{ Querystring: { schema?: string } }>("/admin/api/catalog/columns", {
    preHandler,
    ...doc({
      summary: "Column names of every table and view in a schema",
      description:
        "One read for the whole schema (the SQL Console's completion): each table's and view's column names in order, " +
        "straight from pg_catalog. TotalBase's own tables appear only where they are exposable. 400 INVALID_QUERY without `schema`.",
      parameters: [{ name: "schema", in: "query", required: true, schema: { type: "string" } }],
      response: ok(arrayOf(ref("CatalogRelationColumns"))),
    }),
  }, async (request) => {
    const schema = request.query.schema;
    if (!schema) throw new TotalBaseError("INVALID_QUERY", "schema is required.");
    return { data: await listRelationColumns(context.database, schema) };
  });

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/table/:id",
    {
      preHandler,
      ...doc({
        summary: "A table's columns and constraints",
        description:
          "Columns, primary key, single-column foreign keys, UNIQUE and CHECK constraints, from pg_catalog; its `owner`, and `canAlter`: " +
          `whether the configured PostgreSQL role may change its structure (owner or member of the owner role). ${NOT_A("TABLE")}`,
        pathParameters: BY_ID,
        response: ok(ref("CatalogRelationDetail")),
      }),
    },
    async (request) => ({ data: await relationDetailWithOwnership(context, request.params.id, "TABLE") }),
  );

  // The Design form's Preview: the table's record catalog as the App's
  // `/app/api/dataviews/:slug/record` computes it for an administrator -
  // every column writable, the CHECKs' patterns, bounds and lists read
  // server-side, the one computation (record-catalog.ts).
  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/table/:id/record",
    {
      preHandler,
      ...doc({
        summary: "A table as a record form uses it",
        description:
          "The table's columns, key and relations with what a form anticipates of its CHECKs - the regular expressions (`patterns`), " +
          "the ranges (`bounds`), the allowed days (`dateBounds`) and the lists of values (`values`) - every column writable: " +
          `an administrator's view, the same shape the App gives a viewer narrowed to their grants. ${NOT_A("TABLE")}`,
        pathParameters: BY_ID,
        response: ok(ref("CatalogRecord")),
      }),
    },
    async (request) => ({ data: await recordCatalog(context, null, (await resolveResource(context, request.params.id, "TABLE")).id) }),
  );

  // The admin's read-only table preview (Database > table > Data): a page
  // of rows read by OID in a READ ONLY transaction under
  // api.request_timeout_ms - the client never builds SQL for it.
  app.get<{ Params: { id: string }; Querystring: { limit?: string; offset?: string } }>(
    "/admin/api/catalog/table/:id/rows",
    {
      preHandler,
      ...doc({
        summary: "Preview a page of a table's rows",
        description:
          "Every column, unfiltered and unordered (`SELECT *`), in its own READ ONLY transaction under api.request_timeout_ms. " +
          "Ignores Data API exposure and permissions - an administrator's look at the raw table. Not audited.",
        pathParameters: BY_ID,
        parameters: [
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0, default: 0 } },
        ],
        response: ok(ref("CatalogRowsPage")),
      }),
    },
    async (request) => {
      const oid = await resolveResourceOid(context, request.params.id, "TABLE");
      const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      return { data: await previewRelationRows(context.database, oid, { limit, offset }, await dataApiTimeout(context)) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/table/:id/indexes",
    {
      preHandler,
      ...doc({ summary: "A table's indexes", description: NOT_A("TABLE"), pathParameters: BY_ID, response: ok(arrayOf(ref("CatalogIndex"))) }),
    },
    async (request) => {
      const oid = await resolveResourceOid(context, request.params.id, "TABLE");
      return { data: await getRelationIndexes(context.database, oid) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/view/:id",
    {
      preHandler,
      ...doc({
        summary: "A view's columns",
        description: `Same shape as a table's (\`canAlter\`: may the configured role replace or drop it); a view has no constraints of its own, so those lists are empty. ${NOT_A("VIEW")}`,
        pathParameters: BY_ID,
        response: ok(ref("CatalogRelationDetail")),
      }),
    },
    async (request) => ({ data: await relationDetailWithOwnership(context, request.params.id, "VIEW") }),
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/view/:id/ddl",
    {
      preHandler,
      ...doc({
        summary: "A view's definition",
        description:
          "The complete statement, runnable as is: `CREATE OR REPLACE VIEW <schema>.<name> [WITH (options)] AS` and the query as " +
          "PostgreSQL reconstructs it (pg_get_viewdef); a materialized view: `CREATE MATERIALIZED VIEW`, which has no OR REPLACE. " +
          NOT_A("VIEW"),
        pathParameters: BY_ID,
        response: ok(object({ ddl: { type: "string" } })),
      }),
    },
    async (request) => {
      const oid = await resolveResourceOid(context, request.params.id, "VIEW");
      return { data: { ddl: await getViewDdl(context.database, oid) } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/function/:id",
    {
      preHandler,
      ...doc({
        summary: "A function's parameters and return shape",
        description: `IN parameters in order, whether it returns rows, its \`owner\` and \`canAlter\` (may the configured role replace or drop it). ${NOT_A("FUNCTION")}`,
        pathParameters: BY_ID,
        response: ok(ref("CatalogFunctionDetail")),
      }),
    },
    async (request) => {
      const oid = await resolveResourceOid(context, request.params.id, "FUNCTION");
      const [detail, ownership] = await Promise.all([getFunctionDetail(context.database, oid), getFunctionOwnership(context.database, oid)]);
      return { data: { ...detail, ...ownership } };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/catalog/function/:id/ddl",
    {
      preHandler,
      ...doc({
        summary: "A function's source",
        description: `The full CREATE OR REPLACE FUNCTION statement as PostgreSQL reconstructs it (pg_get_functiondef). ${NOT_A("FUNCTION")}`,
        pathParameters: BY_ID,
        response: ok(object({ ddl: { type: "string" } })),
      }),
    },
    async (request) => {
      const oid = await resolveResourceOid(context, request.params.id, "FUNCTION");
      return { data: { ddl: await getFunctionDdl(context.database, oid) } };
    },
  );

  // What still names a column, table or view PostgreSQL lost (DataViews.md §4.8).
  app.get<{ Querystring: { resource?: string } }>("/admin/api/catalog/broken-references", {
    preHandler,
    ...doc({
      summary: "What names a column, table or view that is gone",
      description:
        "Dashboard widgets whose query PostgreSQL refuses (each planned with LIMIT 0, read only, its variables NULL - nothing is read) " +
        "and DataViews whose layouts or Filter name a column their source no longer has - drafts and live versions. `resource`: only " +
        "that table's or view's DataViews, and the widgets whose query names it.",
      parameters: [{ name: "resource", in: "query", required: false, schema: { type: "string", format: "uuid" }, description: "A resource id." }],
      response: ok(ref("BrokenReferences")),
    }),
  }, async request => ({ data: await brokenReferences(context, request.query.resource) }));

  // pg-sync's Pull direction (Foundations.md §11.8)
  // - see catalog-refresh.ts's syncCatalog().
  app.post<{ Body: { data?: { autoPresentation?: unknown } } | undefined }>("/admin/api/catalog/refresh", {
    preHandler,
    ...doc({
      summary: "Sync resources with the PostgreSQL catalog",
      description:
        "Reconciles TotalBase resources with pg_catalog: new tables/views/functions become resources (hidden - nothing exposed), " +
        "dropped ones turn MISSING, renames keep their resource (identity follows the OID). Then pulls column changes, brings each " +
        "DataView the new columns of its source (its New table columns: shown and in its form, hidden, or not at all) and, with " +
        "catalog.track_comments, syncs descriptions with PostgreSQL COMMENTs. TotalBase's own schema routes do this after their DDL; " +
        "call it after DDL run elsewhere (SQL Console, migrations, psql). The body is optional: `autoPresentation` also gives every " +
        "column of the application's tables and views what Suggest presentation fills - by its type and constraints, never its name - where it lacks it.",
      requestBody: { required: false, schema: dataEnvelope(object({ autoPresentation: { type: "boolean" } })) },
      response: ok(ref("CatalogSyncResult")),
    }),
  }, async request => ({ data: await syncCatalog(context, { autoPresentation: request.body?.data?.autoPresentation === true }) }));
}
