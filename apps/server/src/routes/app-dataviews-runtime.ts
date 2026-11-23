import { parseFilter } from "@totalbase/query-engine";
import type { FastifyInstance } from "fastify";
import { UUID_PATTERN } from "@totalbase/shared";
import { callerRoleIds, callerRoles } from "../caller-roles.js";
import { checkConstraintValues } from "@totalbase/tb-catalog";
import { TotalBaseError } from "@totalbase/errors";
import { readableCatalog, recordCatalog, sourceDetail } from "../record-catalog.js";
import type { AppContext } from "../context.js";
import { requireAppAccess } from "../auth-guards.js";
import { openableDataView } from "./app-dataviews.js";
import { requestData, type DataBody, optionalData } from "../request-body.js";
import { columnReference } from "@totalbase/dataviews";

interface CreateStateBody { name: string; config: Record<string, unknown> }
interface UpdateStateBody { name?: string; config?: Record<string, unknown> }
interface AddShareBody { userId?: string; roleId?: string }
interface SetCurrentBody { config: Record<string, unknown> }
interface AuditEventBody { resource: string; action: string; rowCount?: number; format?: string; search?: string; where?: Record<string, unknown> }

type BulkAuditAction = "IMPORT" | "EXPORT" | "PRINT";
const BULK_AUDIT_ACTIONS: BulkAuditAction[] = ["IMPORT", "EXPORT", "PRINT"];

/** A saved state's `config` - an object, opaque to the server (400 otherwise). */
function stateConfig(config: unknown): Record<string, unknown> {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new TotalBaseError("INVALID_QUERY", "config must be an object.");
  return config as Record<string, unknown>;
}


/**
 * What a published DataView needs at runtime, for every portal user (the
 * App - Security.md §8): the viewer's own current grid
 * state and saved views (owner-scoped), its source's column catalog
 * narrowed to what they may read, and the bulk IMPORT/EXPORT/PRINT audit
 * summary. Every route first checks the caller may open the DataView.
 * Sharing a saved view picks other users, so it stays on the Admin API.
 */
export function registerAppDataViewsRuntimeRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAppAccess(context);

  // `:slug` is the DataView's slug or its id (openableDataView), as on /app/api/dataviews/:slug.
  app.get<{ Params: { slug: string } }>("/app/api/dataviews/:slug/user-prefs", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await context.dataviewsStates.getCurrent(view.id, request.admin!.id) };
  });

  app.put<{ Params: { slug: string }; Body: DataBody<SetCurrentBody> }>("/app/api/dataviews/:slug/user-prefs", { preHandler }, async (request) => {
    const config = stateConfig(requestData(request.body).config);
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await context.dataviewsStates.setCurrent(view.id, request.admin!.id, config) };
  });

  app.get<{ Params: { slug: string } }>("/app/api/dataviews/:slug/saved-views", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    const roleIds = (await callerRoles(context, request)).roleIds;
    return { data: await context.dataviewsStates.listNamed(view.id, request.admin!.id, roleIds) };
  });

  app.post<{ Params: { slug: string }; Body: DataBody<CreateStateBody> }>("/app/api/dataviews/:slug/saved-views", { preHandler }, async (request, reply) => {
    const body = requestData(request.body);
    const config = stateConfig(body.config);
    const view = await openableDataView(context, request, request.params.slug);
    const state = await context.dataviewsStates.createNamed(view.id, request.admin!.id, { name: body.name, config });
    reply.code(201);
    return { data: state };
  });

  // Its owner renames it or saves the current state over it; a view shared with them is 404 to anyone else.
  app.patch<{ Params: { slug: string; viewId: string }; Body: DataBody<UpdateStateBody> }>("/app/api/dataviews/:slug/saved-views/:viewId", { preHandler }, async (request) => {
    const body = requestData(request.body);
    const view = await openableDataView(context, request, request.params.slug);
    return {
      data: await context.dataviewsStates.updateNamed(view.id, request.admin!.id, request.params.viewId, {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.config !== undefined && { config: stateConfig(body.config) })
      })
    };
  });

  // Sharing: the view's owner, with users and roles - read-only for them. One who isn't an administrator shares only
  // with their own roles and the people holding one of them (callerRoles: null for an administrator).
  app.get<{ Params: { slug: string }; Querystring: { q?: string } }>("/app/api/dataviews/:slug/saved-views/share-candidates", { preHandler }, async (request) => {
    await openableDataView(context, request, request.params.slug);
    const scope = await callerRoleIds(context, request);
    return { data: await context.dataviewsStates.shareCandidates(request.admin!.id, scope, typeof request.query.q === "string" ? request.query.q : "") };
  });

  app.get<{ Params: { slug: string; viewId: string } }>("/app/api/dataviews/:slug/saved-views/:viewId/shares", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await context.dataviewsStates.listShares(view.id, request.admin!.id, request.params.viewId) };
  });

  app.post<{ Params: { slug: string; viewId: string }; Body: DataBody<AddShareBody> }>("/app/api/dataviews/:slug/saved-views/:viewId/shares", { preHandler }, async (request, reply) => {
    const { userId, roleId } = requestData(request.body);
    if ((typeof userId === "string") === (typeof roleId === "string")) throw new TotalBaseError("INVALID_QUERY", "Share with one userId or one roleId.");
    const view = await openableDataView(context, request, request.params.slug);
    const target = typeof userId === "string" ? { userId } : { roleId: roleId! };
    const share = await context.dataviewsStates.addShare(view.id, request.admin!.id, request.params.viewId, target, await callerRoleIds(context, request));
    reply.code(201);
    return { data: share };
  });

  app.delete<{ Params: { slug: string; viewId: string; recipientId: string } }>("/app/api/dataviews/:slug/saved-views/:viewId/shares/:recipientId", { preHandler }, async (request, reply) => {
    const view = await openableDataView(context, request, request.params.slug);
    await context.dataviewsStates.removeShare(view.id, request.admin!.id, request.params.viewId, request.params.recipientId);
    reply.code(204);
  });

  app.delete<{ Params: { slug: string; viewId: string } }>("/app/api/dataviews/:slug/saved-views/:viewId", { preHandler }, async (request, reply) => {
    const view = await openableDataView(context, request, request.params.slug);
    await context.dataviewsStates.deleteNamed(view.id, request.admin!.id, request.params.viewId);
    reply.code(204);
  });

  // "Copy link": the link is the credential for the view itself, but only
  // for someone who may open the DataView at all. An unknown view is 404.
  app.get<{ Params: { slug: string; viewId: string } }>("/app/api/dataviews/:slug/saved-views/:viewId/link", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    return { data: await context.dataviewsStates.getForLink(view.id, request.params.viewId) };
  });

  app.get<{ Params: { slug: string } }>("/app/api/dataviews/:slug/catalog", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    if (view.sourceResource === null) throw new TotalBaseError("RESOURCE_NOT_FOUND", "This DataView has no source.");
    const roleIds = await callerRoleIds(context, request);
    const [detail, permission] = await Promise.all([
      sourceDetail(context, view.sourceResource),
      roleIds === null ? null : context.effectivePermissions.resolve(roleIds, view.sourceResource, "READ"),
    ]);
    // The READ grant read once: the catalog's columns and the related ones below both answer to it.
    const catalog = await readableCatalog(context, roleIds, view.sourceResource, { detail, ...(permission && { read: permission }) });
    // The values of its readable columns' CHECK lists (`estado IN ('A', 'B')`) - a Kanban's lanes; never the expressions.
    const expressions = detail.checkConstraints.map((check) => check.expression);
    const checkValues = Object.fromEntries(catalog.columns.map((column) => [column.name, checkConstraintValues(column.name, expressions)] as const).filter(([, values]) => values !== null));
    // Its related columns' types (`producto.codigo` → text) - what the grid's Filter offers them with; only the ones this viewer may read.
    const types = view.sourceResourceOid === null ? {} : await context.dataviewsAdmin.relatedColumnTypes(await context.dataviewsAdmin.listPublishedFields(view.id), view.sourceResourceOid);
    const relatedColumns = Object.fromEntries(Object.entries(types).filter(([path]) => permission === null || permission.fieldDecision(path) === "ALLOW"));
    return { data: { ...catalog, relatedColumns, checkValues } };
  });

  /**
   * What a link filter's chip names a foreign key's value by (DB26): the table the column points at - a view's
   * column through the table column it is (`view_column_origins`) - its key, and the column (or template)
   * its rows show by. Metadata only: the label itself is read through the Data API, under the viewer's grants. 404
   * when the viewer may not read the column; `data: null` when it points at nothing - a plain column is no error (DB40).
   */
  app.get<{ Params: { slug: string; column: string } }>("/app/api/dataviews/:slug/columns/:column/reference", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    const notFound = new TotalBaseError("RESOURCE_NOT_FOUND", "No reference for this column.");
    if (view.sourceResource === null) throw notFound;
    const roleIds = await callerRoleIds(context, request);
    const catalog = await readableCatalog(context, roleIds, view.sourceResource);
    const column = catalog.columns.find((c) => c.name === request.params.column);
    if (!column) throw notFound;
    return { data: await columnReference(context.database, view.sourceResourceOid, catalog.relations, column.name) };
  });

  /**
   * A form field's Junction table as this viewer may use it (DataViews.md §8.5): how it links the record's table to
   * the other one, read live from PostgreSQL's catalog, and whether they may read, add and remove its rows - the
   * Permission Resolver's READ/CREATE/DELETE on an exposed method. Not a junction of the record's table any more, or
   * not readable by them: 404, as a missing one.
   */
  app.get<{ Params: { slug: string; resource: string } }>("/app/api/dataviews/:slug/junctions/:resource", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    const junction = view.sourceResource && UUID_PATTERN.test(request.params.resource) ? await context.dataviewsAdmin.getJunction(view.sourceResource, request.params.resource) : null;
    if (!junction) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Junction table not found.");
    const exposed = new Set<string>((await context.resourcesAdmin.get(junction.resourceId).catch(() => null))?.exposedMethods ?? []);
    const roleIds = await callerRoleIds(context, request);
    const decisions = roleIds === null ? null : (await context.effectivePermissions.resolveBulk(roleIds, [junction.resourceId])).get(junction.resourceId);
    const allowed = (action: "READ" | "CREATE" | "DELETE", method: string) => exposed.has(method) && (decisions === null || decisions?.[action].decision === "ALLOW");
    const actions = { read: allowed("READ", "GET"), create: allowed("CREATE", "POST"), delete: allowed("DELETE", "DELETE") };
    if (!actions.read) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Junction table not found.");
    return { data: { ...junction, actions } };
  });

  app.get<{ Params: { slug: string } }>("/app/api/dataviews/:slug/record", { preHandler }, async (request) => {
    const view = await openableDataView(context, request, request.params.slug);
    if (view.sourceResource === null) throw new TotalBaseError("RESOURCE_NOT_FOUND", "This DataView has no record table.");
    return { data: await recordCatalog(context, await callerRoleIds(context, request), view.sourceResource) };
  });

  /**
   * One summary row per bulk Import/Export/Print click from the grid
   * (DataViewGrid.vue's own toolbar), for a resource the caller may read - deliberately NOT one row per
   * affected record (a decided product rule: the action is logged, the
   * records it touched aren't). `rowCount`/
   * `format`/`search`/`where` are metadata about the OPERATION, never the
   * data it touched - no `payload` at all, unlike CREATE/UPDATE/DELETE's
   * own `auditAndEnqueue` (mutation-service.ts). `where` lands in the
   * same `where_clause` column CREATE/UPDATE/DELETE would use for their
   * own filter, if they had one to record.
   */
  app.post<{ Body: { data?: AuditEventBody } | undefined }>("/app/api/audit/events", { preHandler }, async (request, reply) => {
    const { resource, action, rowCount, format, search, where } = optionalData(request.body);
    if (!BULK_AUDIT_ACTIONS.includes(action as BulkAuditAction)) {
      throw new TotalBaseError("INVALID_QUERY", `Unsupported audit event action: ${action}`);
    }
    if (!resource) throw new TotalBaseError("INVALID_QUERY", "resource is required.");
    // What the entry records is the caller's word: held to the shape the App sends, never free text of any size.
    if (rowCount !== undefined && (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 0)) {
      throw new TotalBaseError("INVALID_QUERY", "rowCount must be a whole number.");
    }
    if (format !== undefined && (typeof format !== "string" || !/^[a-z]{1,16}$/.test(format))) {
      throw new TotalBaseError("INVALID_QUERY", "format must be a short lowercase name (csv, xlsx, pdf).");
    }
    if (search !== undefined && search !== null && (typeof search !== "string" || search.length > 500)) {
      throw new TotalBaseError("INVALID_QUERY", "search must be text of at most 500 characters.");
    }
    if (where !== undefined && where !== null) {
      const [maxFilterDepth, maxRelationDepth] = await Promise.all([context.settings.get("api.max_filter_depth"), context.settings.get("api.max_relation_depth")]);
      parseFilter(where, { maxFilterDepth, maxRelationDepth }, 0);
      if (JSON.stringify(where).length > 10_000) throw new TotalBaseError("INVALID_QUERY", "where is too large to record.");
    }
    const roleIds = await callerRoleIds(context, request);
    if (roleIds !== null && (await context.effectivePermissions.resolve(roleIds, resource, "READ")).action !== "ALLOW") {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "Resource not found.");
    }
    const now = new Date();
    const id = await context.audit.record(context.database, {
      requestId: request.id,
      principal: { type: roleIds === null ? "ADMIN" : "USER", id: request.admin!.id },
      resourceId: resource,
      action: action as BulkAuditAction,
      status: "EXECUTED",
      source: "app",
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      whereClause: where,
      metadata: { rowCount, format, search },
      startedAt: now,
      finishedAt: now,
    });
    // The entry's id - null when the audit log is disabled (audit.enabled) and nothing was written.
    reply.code(201);
    return { data: { id } };
  });
}
