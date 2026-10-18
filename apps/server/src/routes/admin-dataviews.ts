import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AddWidgetTreeInput, DataViewScope, DataViewType, WidgetFieldConfig } from "@totalbase/dataviews";
import { resourceQueryColumns, type VariableDefinition } from "@totalbase/tb-catalog";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { adminDoc, arrayOf, created, NO_CONTENT, object, ok, ref, UUID } from "../openapi-admin-docs.js";
import { ADD_WIDGET_BODY, ADD_WIDGETS_TREE_BODY, CREATE_DATAVIEW_BODY, DATAVIEW_SCHEMAS, MOVE_WIDGET_BODY, UPDATE_DATAVIEW_BODY, UPDATE_FIELD_BODY } from "../openapi-admin-docs-dataviews.js";
import { type DataBody, publishNote, requestData, versionParam } from "../request-body.js";
import { registerDeleteVersionsRoute } from "./delete-versions.js";

interface CreateDataViewBody {
  name: string;
  slug?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  /** Omitted for EXTERNALFRAME, the one layout with no source. */
  sourceResourceId?: string;
  viewType: DataViewType;
  selectedColumns?: string[];
  viewConfig?: Record<string, unknown>;
  /** `searchable` - FORM DataViews only (the wizard's Columns step only shows the checkbox for that type) - stored straight into that column's own `config.searchable`. */
  fieldOverrides?: Record<string, { widget?: string; help?: string; searchable?: boolean }>;
  /** MASTER_DETAIL only - the detail table and its FK column pointing at the master. */
  detail?: {
    resourceId: string;
    fkColumn: string;
    /** The detail rows' columns - its grid and each row's form; every column when omitted. */
    selectedColumns?: string[];
    fieldOverrides?: Record<string, { widget?: string; help?: string }>;
  };
}

interface UpdateDataViewBody {
  name?: string;
  slug?: string;
  description?: string | null;
  menuLabel?: string | null;
  icon?: string | null;
  color?: string | null;
  /** Shallow-merged into the stored view_config - see DataViewsAdminService.update()'s own doc comment on why not a full replace. */
  viewConfig?: Record<string, unknown>;
  /** The "Show in the App menu" switch - LISTED or EMBEDDED_ONLY. */
  scope?: DataViewScope;
  /** A CUSTOM page's record table, while it has none. */
  sourceResourceId?: string;
  /** A list DataView's main view - another of its views (`layouts`), the one it opens with. */
  viewType?: DataViewType;
}

interface UpdateFieldBody {
  label?: string | null;
  widget?: string;
  visible?: boolean;
  config?: Record<string, unknown>;
  gridX?: number;
  gridY?: number;
  gridW?: number;
  gridH?: number;
  /** WIDGET rows: the parent widget (null for the canvas) - `config.slot` names its slot. */
  parent?: string | null;
}


interface AddWidgetBody {
  widget: string;
  label?: string | null;
  config?: WidgetFieldConfig;
  /** The parent widget's field id - `config.slot` names its slot. */
  parent?: string | null;
}






function pruneUndefined<T extends Record<string, unknown>>(input: T): Partial<T> {
  const result: Partial<T> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) (result as Record<string, unknown>)[key] = value;
  }
  return result;
}

/**
 * DataView management: the creation wizard's steps 1-2 (identity,
 * source) - see Specification_DataViews.md. Admin-only
 * (Specification_DataViews.md §1.5), same as every other admin-plane route (requireAdmin);
 * *using* an already-built DataView goes through the public REST Data
 * API instead, gated by the viewer's actual permission on the
 * underlying resource, never through this surface.
 */
export function registerAdminDataViewsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get("/admin/api/dataviews", {
    preHandler,
    ...adminDoc("dataviews", {
      summary: "List DataViews",
      description: "Every DataView, LISTED or EMBEDDED_ONLY, by name, with whether its draft differs from its live version.",
      response: ok(arrayOf(ref("DataViewListItem"))),
      schemas: DATAVIEW_SCHEMAS,
    }),
  }, async () => ({ data: await context.dataviewsAdmin.list() }));

  app.get<{ Params: { id: string } }>(
    "/admin/api/dataviews/:id",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Get a DataView (draft)",
        description: "The draft as the Design form edits it, with whether it differs from the live version.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok(ref("DataViewWithStatus")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.getWithStatus(request.params.id) }),
  );

  app.get<{ Params: { slug: string } }>(
    "/admin/api/dataviews/by-slug/:slug",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Get a DataView (draft) by slug",
        pathParameters: { slug: { description: "The DataView's slug." } },
        response: ok(ref("DataView")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.getBySlug(request.params.slug) }),
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/dataviews/:id/fields",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "List a DataView's fields (draft)",
        description: "Its grid columns (COLUMN, RELATED) and its page's widgets (WIDGET), in display order.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok(arrayOf(ref("DataViewField"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.listFields(request.params.id) }),
  );

  // Published counterparts of the two routes above - the admin's own
  // read of what's live. A viewer (APP access) reads the same through
  // /app/api/dataviews (app-dataviews.ts), filtered by their permissions;
  // see DataViewsAdminService.getPublishedBySlug's own doc comment.
  app.get<{ Params: { slug: string } }>(
    "/admin/api/dataviews/by-slug/:slug/published",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Get a DataView's live version by slug",
        description: "The DataView with the latest published version's `viewConfig`, `code` and `columnPresentation` - what viewers see. 404 DATAVIEW_NOT_FOUND when never published.",
        pathParameters: { slug: { description: "The DataView's slug." } },
        response: ok(ref("DataView")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.getPublishedBySlug(request.params.slug) }),
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/dataviews/:id/fields/published",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "List a DataView's live fields",
        description: "The latest published version's fields. 404 DATAVIEW_NOT_FOUND when never published.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok(arrayOf(ref("DataViewField"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.listPublishedFields(request.params.id) }),
  );

  app.post<{ Params: { id: string }; Body: DataBody<{ code: string }> }>(
    "/admin/api/dataviews/:id/code",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Save a page's Code (draft)",
        description: "Replaces the draft's client-side controller code; viewers get it only after the next publish.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(object({ code: { type: "string" } }, ["code"])) },
        response: NO_CONTENT,
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const { code } = requestData(request.body);
      if (typeof code !== "string") throw new TotalBaseError("INVALID_QUERY", "code must be a string.");
      await context.dataviewsAdmin.updateCode(request.params.id, code);
      reply.code(204);
    },
  );

  // Versioning - Specification.md §13.6, same shape as Dashboards and Workflows.
  app.post<{ Params: { id: string }; Body: DataBody<{ note?: string }> }>(
    "/admin/api/dataviews/:id/publish",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Publish the draft as a new version",
        description:
          "Snapshots the draft (view_config, fields, code and the inherited column presentation) as the next version, and " +
          "publishes the detail DataViews it owns with it. A no-op returning the latest version when the draft equals it. " +
          "A page publishes only whole: invalid variables or widget configs are refused (422). `meta.warnings` says what it " +
          "published anyway but should be looked at - a single-record FORM over a table with more than one row.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(object({ note: { type: "string", maxLength: 128, description: "What this version changes - the publisher's note, shown in the object's Versions." } })), required: false },
        response: created(ref("DataViewVersion")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const version = await context.dataviewsAdmin.publish(request.params.id, request.admin?.id ?? null, publishNote(request.body));
      const warnings = await context.dataviewsAdmin.publishWarnings(request.params.id);
      reply.code(201);
      return { data: version, ...(warnings.length > 0 && { meta: { warnings } }) };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/admin/api/dataviews/:id/versions",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "List a DataView's versions",
        description: "Newest first, summaries only.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok(arrayOf(ref("DataViewVersion"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.listVersions(request.params.id) }),
  );

  app.get<{ Params: { id: string; version: string } }>(
    "/admin/api/dataviews/:id/versions/:version",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Get one version's content",
        description: "Shaped like the published read (DataView + fields) - for a read-only preview of that version. 400 for a version that isn't a number; 404 DATAVIEW_VERSION_NOT_FOUND.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, version: { description: "A version number.", schema: { type: "integer", minimum: 1 } } },
        response: ok(ref("DataViewVersionContent")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.getVersion(request.params.id, versionParam(request.params.version)) }),
  );

  registerDeleteVersionsRoute(app, context, preHandler, "dataviews", (id, before) => context.dataviewsAdmin.deleteVersionsBefore(id, before));

  app.post<{ Params: { id: string; version: string } }>(
    "/admin/api/dataviews/:id/versions/:version/restore",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Restore a version into the draft",
        description:
          "That version's view_config, code and fields replace the draft (fields keep their ids). Publishes nothing - " +
          "the next publish records `restoredFromVersion` if the draft is still that content. No body.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, version: { description: "A version number.", schema: { type: "integer", minimum: 1 } } },
        response: ok(ref("DataView")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.restore(request.params.id, versionParam(request.params.version)) }),
  );

  app.post<{ Params: { id: string; version: string }; Body: DataBody<{ name: string; slug?: string }> }>(
    "/admin/api/dataviews/:id/versions/:version/duplicate",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Save a version as a new DataView",
        description:
          "A new, unpublished DataView (same source, layout, scope, icon, color, description) whose draft is that version's " +
          "content, with new field ids. 409 DATAVIEW_NAME_DUPLICATE / DATAVIEW_SLUG_DUPLICATE.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, version: { description: "A version number.", schema: { type: "integer", minimum: 1 } } },
        requestBody: {
          schema: dataEnvelope(object(
            { name: { type: "string", maxLength: 32 }, slug: { type: "string", maxLength: 32, description: "Proposed from `name` when omitted." } },
            ["name"],
          )),
        },
        response: created(ref("DataView")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const version = versionParam(request.params.version);
      const body = requestData(request.body);
      const dataview = await context.dataviewsAdmin.duplicateVersion(request.params.id, version, {
        name: body.name ?? "",
        slug: body.slug,
      });
      reply.code(201);
      return { data: dataview };
    },
  );

  // The Design form's schema-drift fix - reconciles
  // `dataviews_fields` against the source table's REAL current columns.
  // Called automatically whenever the Design form opens, and also
  // reachable as its own explicit action - see
  // DataViewsAdminService.syncFields()'s own doc comment for what it
  // actually does (new/renamed/orphaned columns).
  app.post<{ Params: { id: string } }>(
    "/admin/api/dataviews/:id/sync-fields",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Reconcile fields with the source's current columns",
        description:
          "Matches by attnum: new columns are added (per `viewConfig.column_sync`), renamed ones corrected in place, " +
          "dropped ones returned as `orphaned` - never deleted automatically. No body.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok(ref("DataViewSyncFieldsResult")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.syncFields(request.params.id) }),
  );

  // "Add columns…" - source columns not in the DataView yet, by name
  // (Specification_DataViews.md §4). A column leaves it
  // through DELETE .../fields/:fieldId.
  app.post<{ Params: { id: string }; Body: { data?: unknown } }>(
    "/admin/api/dataviews/:id/columns",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Add source columns to a DataView",
        description:
          "Source columns not in the DataView yet, by name, or a related column as `fk.column` (one hop, the target table " +
          "exposed for GET) - added shown, after the last one, returned as a field read returns them. A column already in it " +
          "is 409 DATAVIEW_FIELD_DUPLICATE; one not in the table, or a DataView with no source table, 422 DATAVIEW_COLUMN_INVALID. " +
          "A column leaves it through DELETE .../fields/{fieldId}.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: object({ data: { ...arrayOf({ type: "string" }), minItems: 1 } }, ["data"]) },
        response: created(arrayOf(ref("DataViewField"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const names = request.body?.data;
      if (!Array.isArray(names) || names.length === 0 || !names.every((n) => typeof n === "string")) {
        throw new TotalBaseError("INVALID_QUERY", "data must be a non-empty list of column names.");
      }
      const fields = await context.dataviewsAdmin.addColumns(request.params.id, names);
      reply.code(201);
      return { data: fields };
    },
  );

  // The wizard's Detail step (MASTER_DETAIL) - tables whose FK points at the chosen master.
  app.get<{ Querystring: { master: string } }>(
    "/admin/api/dataviews/detail-candidates",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Possible details of a MASTER_DETAIL",
        description: "TABLE resources whose single-column foreign key points at `master` (a self-reference excluded) - the wizard's Detail step.",
        parameters: [{ name: "master", in: "query", required: true, description: "The master table's resource id.", schema: UUID }],
        response: ok(arrayOf(ref("DataViewDetailCandidate"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => ({ data: await context.dataviewsAdmin.listDetailCandidates(request.query.master) }),
  );

  app.post<{ Body: DataBody<CreateDataViewBody> }>("/admin/api/dataviews", {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Create a DataView",
        description:
          "The creation wizard in one call. Its fields are populated from the source's columns, and over a table a grid " +
          "type's (or a FORM's) record form is generated as a page. Created as an unpublished draft. 409 " +
          "DATAVIEW_NAME_DUPLICATE / DATAVIEW_SLUG_DUPLICATE; 422 for an invalid type, source or detail.",
        requestBody: { schema: dataEnvelope(CREATE_DATAVIEW_BODY) },
        response: created(ref("DataView")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    }, async (request, reply) => {
    const body = requestData(request.body);
    const dataview = await context.dataviewsAdmin.create({
      name: body.name,
      slug: body.slug,
      description: body.description,
      icon: body.icon,
      color: body.color,
      sourceResourceId: body.sourceResourceId,
      viewType: body.viewType,
      selectedColumns: body.selectedColumns,
      viewConfig: body.viewConfig,
      fieldOverrides: body.fieldOverrides,
      detail: body.detail
        ? {
            resourceId: body.detail.resourceId,
            fkColumn: body.detail.fkColumn,
            selectedColumns: body.detail.selectedColumns,
            fieldOverrides: body.detail.fieldOverrides,
          }
        : undefined,
    });
    reply.code(201);
    return { data: dataview };
  });

  app.patch<{ Params: { id: string }; Body: DataBody<UpdateDataViewBody> }>(
    "/admin/api/dataviews/:id",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Update a DataView (draft)",
        description: "Only the keys sent change; `viewConfig` is shallow-merged. Answers as GET does, with whether the draft now differs from the live version.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(UPDATE_DATAVIEW_BODY) },
        response: ok(ref("DataViewWithStatus")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => {
      const body = requestData(request.body);
      const dataview = await context.dataviewsAdmin.update(
        request.params.id,
        pruneUndefined({
          name: body.name,
          slug: body.slug,
          description: body.description,
          menuLabel: body.menuLabel,
          icon: body.icon,
          color: body.color,
          viewConfig: body.viewConfig,
          scope: body.scope,
          sourceResourceId: body.sourceResourceId,
          viewType: body.viewType,
        }),
      );
      // The status with the saved draft (as GET answers), so an editor that autosaves needn't read it again after every save.
      return { data: { ...dataview, hasUnpublishedChanges: await context.dataviewsAdmin.hasUnpublishedChanges(dataview.id) } };
    },
  );

  // The Design form's save action (Specification_DataViews.md §12) - one field's
  // position/size/visibility/label/widget/config, and a widget's parent.
  app.patch<{ Params: { id: string; fieldId: string }; Body: DataBody<UpdateFieldBody> }>(
    "/admin/api/dataviews/:id/fields/:fieldId",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Update one field (draft)",
        description: "The Design form's save: position, size, visibility, label, widget, config, and a widget's parent. Only the keys sent change; `kind` and the column identity never do.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, fieldId: { description: "The field's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(UPDATE_FIELD_BODY) },
        response: ok(ref("DataViewField")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => {
      const body = requestData(request.body);
      const field = await context.dataviewsAdmin.updateField(request.params.id, request.params.fieldId, {
        label: body.label,
        widget: body.widget,
        visible: body.visible,
        config: body.config,
        gridX: body.gridX,
        gridY: body.gridY,
        gridW: body.gridW,
        gridH: body.gridH,
        parent: body.parent,
      });
      return { data: field };
    },
  );

  // Places one widget of the widget catalog on a CUSTOM DataView - on the
  // canvas, or in a slot of another widget (Specification_DataViews.md).
  app.post<{ Params: { id: string }; Body: DataBody<AddWidgetBody> }>(
    "/admin/api/dataviews/:id/widgets",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Place a widget on a page (draft)",
        description: "One widget of the widget catalog, on the canvas or in a slot of another widget, appended after its siblings. Not on an EXTERNALFRAME.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(ADD_WIDGET_BODY) },
        response: created(ref("DataViewField")),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const body = requestData(request.body);
      const field = await context.dataviewsAdmin.addWidget(request.params.id, {
        widget: body.widget,
        label: body.label,
        config: body.config,
        parent: body.parent,
      });
      reply.code(201);
      return { data: field };
    },
  );

  // Several widgets, each with what it holds, in one transaction - an agent
  // building a form (add_page_widgets); nothing is left behind when one is refused.
  app.post<{ Params: { id: string }; Body: DataBody<{ widgets?: AddWidgetTreeInput[] }> }>(
    "/admin/api/dataviews/:id/widgets/tree",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Place several widgets, each with what it holds (draft)",
        description:
          "Every widget of `widgets` and, inside it, its `children` (each in the slot its `config.slot` names), appended " +
          "after their siblings in the order given - all placed in one transaction, or none when one is refused. Answers " +
          "every placed field, a parent before its children.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(ADD_WIDGETS_TREE_BODY) },
        response: created(arrayOf(ref("DataViewField"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const body = requestData(request.body);
      if (!Array.isArray(body.widgets) || body.widgets.length === 0) throw new TotalBaseError("INVALID_QUERY", "widgets must be a non-empty list.");
      const fields = await context.dataviewsAdmin.addWidgets(request.params.id, body.widgets);
      reply.code(201);
      return { data: fields };
    },
  );

  // A placed widget moved - another container or slot, another position in
  // its area - with its siblings renumbered in the same transaction.
  app.post<{ Params: { id: string; fieldId: string }; Body: DataBody<{ parent?: string | null; slot?: string; position?: number }> | undefined }>(
    "/admin/api/dataviews/:id/widgets/:fieldId/move",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Move a placed widget (draft)",
        description:
          "Moves the widget, with everything its slots hold, to `parent`/`slot` (omitted: where it is) at `position` " +
          "among its new siblings (omitted: last), renumbering that area in one transaction. Refused like a field patch " +
          "when the place doesn't take it. Answers the DataView's fields as they are after the move.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, fieldId: { description: "The widget's field id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(MOVE_WIDGET_BODY), required: false },
        response: ok(arrayOf(ref("DataViewField"))),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => {
      const body = request.body?.data ?? {};
      if (body.position !== undefined && (!Number.isInteger(body.position) || body.position < 0)) throw new TotalBaseError("INVALID_QUERY", "position must be a non-negative integer.");
      const fields = await context.dataviewsAdmin.moveWidget(request.params.id, request.params.fieldId, { parent: body.parent, slot: body.slot, position: body.position });
      return { data: fields };
    },
  );

  // A placed widget is deletable (with what its slots hold) - a COLUMN
  // field is hidden instead, see DataViewsAdminService.deleteField.
  app.delete<{ Params: { id: string; fieldId: string } }>(
    "/admin/api/dataviews/:id/fields/:fieldId",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Remove a field (draft)",
        description:
          "A WIDGET goes with what its slots hold (and a detail DataView it owns, once nothing else shows it). A COLUMN/RELATED " +
          "leaves the DataView - never the primary key (422 DATAVIEW_FIELD_NOT_DELETABLE: hide it instead).",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID }, fieldId: { description: "The field's id.", schema: UUID } },
        response: NO_CONTENT,
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request, reply) => {
      await context.dataviewsAdmin.deleteField(request.params.id, request.params.fieldId);
      reply.code(204);
    },
  );

  // Settings › Columns' warning: for each related column (`brand.country`), the roles that open this
  // DataView but whose READ grant on its table lacks that path - they won't see it (app-dataviews.ts).
  // Decided by the Permission Resolver, as the Data API decides it; never grants anything.
  app.get<{ Params: { id: string } }>("/admin/api/dataviews/:id/related-access", {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Roles missing a related column",
        description:
          "For each related column (`brand.country`) and each path a shown reference column displays its row by " +
          "(`brand.name`), the ids of roles that open this DataView but whose READ grant on its source lacks that path - " +
          "they'd see the key instead. Decided by the Permission Resolver. Never grants anything.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok({ type: "object", additionalProperties: arrayOf(UUID), description: "Role ids by related column path." }),
        schemas: DATAVIEW_SCHEMAS,
      }),
    }, async (request) => {
    const view = await context.dataviewsAdmin.get(request.params.id);
    const fields = await context.dataviewsAdmin.listFields(view.id);
    // Related columns, and the paths a reference column shows its row by (`cliente.razon_social`, its Label field or
    // template's columns) - without them a role sees the key (B44, Specification_Security.md §6.10).
    const paths = new Set(fields.filter((f) => f.kind === "RELATED" && f.columnName).map((f) => f.columnName!));
    for (const field of fields) {
      const config = field.config as { display_field?: unknown; display_template?: unknown };
      if (field.kind !== "COLUMN" || !field.columnName || !field.visible) continue;
      const template = typeof config.display_template === "string" ? config.display_template.trim() : "";
      const shown = template ? [...template.matchAll(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g)].map((m) => m[1]!) : typeof config.display_field === "string" && config.display_field ? [config.display_field] : [];
      for (const column of shown) paths.add(`${field.columnName}.${column}`);
    }
    const missing: Record<string, string[]> = Object.fromEntries([...paths].map((path) => [path, []]));
    if (view.sourceResource === null || paths.size === 0) return { data: missing };
    for (const role of await context.dataviewsAdmin.listRoles(view.id)) {
      const permission = await context.effectivePermissions.resolve([role], view.sourceResource, "READ");
      for (const path of paths) {
        if (permission.fieldDecision(path) !== "ALLOW") missing[path]!.push(role);
      }
    }
    return { data: missing };
  });

  // The Design form's warning (Specification_DataViews.md §8.3, "All or nothing"): for
  // each Resource variable, the roles that open this DataView but may not READ its resource, or a
  // column its query reads - the Data API would refuse the whole query for them. Decided by the
  // Permission Resolver, as the Data API decides it; never grants anything.
  app.get<{ Params: { id: string } }>("/admin/api/dataviews/:id/resource-access", {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Roles a page's Resource variables would fail for",
        description:
          "For each RESOURCE variable, the roles that open this DataView but may not READ its resource (`columns: null`) or " +
          "some column its query reads (those columns) - the Data API would refuse the whole query for them.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: ok({
          type: "object",
          description: "By variable name.",
          additionalProperties: arrayOf(object({ role: UUID, columns: { type: ["array", "null"], items: { type: "string" } } }, ["role", "columns"])),
        }),
        schemas: DATAVIEW_SCHEMAS,
      }),
    }, async (request) => {
    const view = await context.dataviewsAdmin.get(request.params.id);
    const variables = (Array.isArray(view.viewConfig.variables) ? view.viewConfig.variables : []) as VariableDefinition[];
    const roles = await context.dataviewsAdmin.listRoles(view.id);
    const missing: Record<string, { role: string; columns: string[] | null }[]> = {};
    for (const variable of variables) {
      if (variable.kind !== "RESOURCE") continue;
      const columns = resourceQueryColumns(variable.query);
      const lacking: { role: string; columns: string[] | null }[] = [];
      for (const role of roles) {
        const permission = await context.effectivePermissions.resolve([role], variable.resource, "READ");
        if (permission.action !== "ALLOW") lacking.push({ role, columns: null });
        else {
          const denied = columns.filter((column) => permission.fieldDecision(column) !== "ALLOW");
          if (denied.length) lacking.push({ role, columns: denied });
        }
      }
      missing[variable.name] = lacking;
    }
    return { data: missing };
  });

  // An embedded Dashboard's warning (TDashboard): the roles that open this DataView but not that
  // Dashboard - its access is its own, so they'd see it isn't available. Never grants anything.
  app.get<{ Params: { id: string }; Querystring: { dashboard?: string } }>("/admin/api/dataviews/:id/dashboard-access", {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Roles that can't open an embedded Dashboard",
        description: "The ids of roles that open this DataView but not `dashboard` (object access is per object). 400 without `dashboard`.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        parameters: [{ name: "dashboard", in: "query", required: true, description: "The embedded Dashboard's id.", schema: UUID }],
        response: ok(arrayOf(UUID)),
        schemas: DATAVIEW_SCHEMAS,
      }),
    }, async (request) => {
    const view = await context.dataviewsAdmin.get(request.params.id);
    const dashboardId = request.query.dashboard;
    if (!dashboardId) throw new TotalBaseError("INVALID_QUERY", "dashboard is required.");
    const dashboard = await context.dashboardsAdmin.get(dashboardId);
    const allowed = new Set(await context.dashboardsAdmin.listRoles(dashboard.id));
    return { data: (await context.dataviewsAdmin.listRoles(view.id)).filter((role) => !allowed.has(role)) };
  });

  app.put<{ Params: { id: string }; Body: DataBody<{ roleIds: string[] }> }>(
    "/admin/api/dataviews/:id/roles",
    {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Replace the roles that may open a DataView",
        description: "Object access (Specification_Security.md §7.1): who sees and opens it in the App. Never grants data - every read and write still needs the source's permissions. Returns the role ids set.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        requestBody: { schema: dataEnvelope(object({ roleIds: arrayOf(UUID) }, ["roleIds"])) },
        response: ok(arrayOf(UUID)),
        schemas: DATAVIEW_SCHEMAS,
      }),
    },
    async (request) => {
      const { roleIds } = requestData(request.body);
      if (!Array.isArray(roleIds) || !roleIds.every((id) => typeof id === "string")) {
        throw new TotalBaseError("INVALID_QUERY", "roleIds must be a list of role ids.");
      }
      return { data: await context.dataviewsAdmin.setRoles(request.params.id, roleIds) };
    },
  );

  app.delete<{ Params: { id: string } }>("/admin/api/dataviews/:id", {
      preHandler,
      ...adminDoc("dataviews", {
        summary: "Delete a DataView",
        description: "With its versions and the detail DataViews it owns. Refused (409) while another page still embeds it.",
        pathParameters: { id: { description: "The DataView's id.", schema: UUID } },
        response: NO_CONTENT,
        schemas: DATAVIEW_SCHEMAS,
      }),
    }, async (request, reply) => {
    await context.dataviewsAdmin.delete(request.params.id);
    reply.code(204);
  });
}
