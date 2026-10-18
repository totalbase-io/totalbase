import type { FastifyInstance } from "fastify";
import type { DataApiMethod } from "@totalbase/resources";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { ADMIN_SCHEMAS, adminDoc, arrayOf, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";

/**
 * Resource management (Specification_Administration.md §1: "Resources"). The
 * registry itself is read through the Data API (resources,
 * Specification_Security.md §10); changing a resource stays here.
 */
const COLUMN_PRESENTATION_SCHEMA = object({
  label: { type: "string" },
  shortLabel: { type: "string", description: "A list's header and a card's field name, where room is short - the label everywhere else." },
  description: { type: "string" },
  help: { type: "string" },
  placeholder: { type: "string" },
  icon: { type: "string", description: "An Iconify name, e.g. i-lucide-mail." },
  iconPosition: { type: "string", enum: ["leading", "trailing"] },
  displayFormat: { type: "string" },
  emptyText: { type: "string" },
  booleanLabels: object({ true: { type: "string" }, false: { type: "string" } }),
  linkType: { type: "string", enum: ["url", "email", "tel"] },
  align: { type: "string", enum: ["left", "center", "right"] },
  fontSize: { type: "string", enum: ["xs", "sm", "base", "lg"] },
  bold: { type: "boolean" },
  italic: { type: "boolean" },
  mono: { type: "boolean" },
  color: { type: "string", description: "A palette hue (red, emerald, blue...) for its cells' text." },
  options: {
    type: "object",
    description: "How each value of the column's CHECK list shows.",
    additionalProperties: object({ label: { type: "string" }, color: { type: "string", enum: ["primary", "secondary", "success", "info", "warning", "error", "neutral"] }, icon: { type: "string" } }),
  },
  input: { type: "string", description: "Its control - a column input catalog entry (number-field, email, relation-select...) that edits its type; password only at creation, never changed. Unset: Automatic, by its type and constraints." },
});

/** What Automatic edits a column with: the rule's control, its props and why (Specification_DataViews.md §15.2). */
const AUTOMATIC_INPUT_SCHEMA = object({
  input: { type: "string", description: "The catalog entry." },
  widget: { type: "string" },
  props: { type: "object", additionalProperties: true, description: "What makes the widget that control - an Input's type." },
  reason: { type: "string", enum: ["chosen", "file", "relation", "check-list", "small-range", "number", "link-type", "pattern", "default"] },
});

export function registerAdminResourcesRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  /** Each column's presentation (totalbase.resources_columns) - its control among it - and what Automatic gives it. */
  app.get<{ Params: { id: string } }>(
    "/admin/api/resources/:id/columns",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Each column's presentation",
        description: "A view's column that is a table's column also carries `inherited`: that column's presentation, which it shows under its own. `automatic`: what the rule edits it with - shown for Automatic.",
        pathParameters: { id: UUID_PARAM },
        response: ok(arrayOf(object({ columnName: { type: "string" }, presentation: COLUMN_PRESENTATION_SCHEMA, inherited: COLUMN_PRESENTATION_SCHEMA, automatic: AUTOMATIC_INPUT_SCHEMA, inputs: { type: "array", items: { type: "string" }, description: "The catalog entries that edit it - what its Control offers." } }))),
      }),
    },
    async (request) => {
      await context.resourcesAdmin.get(request.params.id);
      return { data: await context.resourcesAdmin.listColumns(request.params.id) };
    },
  );

  /**
   * The published DataViews whose draft now inherits differently from this
   * resource's columns than their live version - what a presentation change
   * reached (Specification_DataViews.md §15), each to publish
   * or leave as an unpublished change.
   */
  app.get<{ Params: { id: string } }>(
    "/admin/api/resources/:id/affected-dataviews",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "DataViews a column presentation change reaches",
        description: "Published DataViews whose draft inherits differently from this resource's columns than their live version. `otherChanges`: publishing it would publish other unpublished changes too.",
        pathParameters: { id: UUID_PARAM },
        response: ok(arrayOf(object({
          id: { type: "string", format: "uuid" },
          name: { type: "string" },
          slug: { type: "string" },
          liveVersion: { type: "integer" },
          otherChanges: { type: "boolean" },
        }))),
      }),
    },
    async (request) => {
      await context.resourcesAdmin.get(request.params.id);
      return { data: await context.dataviewsAdmin.affectedByColumnPresentation(request.params.id) };
    },
  );

  /** The DataViews that show a column - what a change to its presentation reaches (Specification_DataViews.md §15). */
  app.get<{ Params: { id: string; column: string } }>(
    "/admin/api/resources/:id/columns/:column/dataviews",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "DataViews that show a column",
        description: "Every DataView, published or not, with a grid column, a form field or a related column on this column - or on a view's column that is it.",
        pathParameters: { id: UUID_PARAM, column: { schema: { type: "string" } } },
        response: ok(arrayOf(object({ id: { type: "string", format: "uuid" }, name: { type: "string" } }))),
      }),
    },
    async (request) => {
      await context.resourcesAdmin.get(request.params.id);
      return { data: await context.dataviewsAdmin.dataviewsShowingColumn(request.params.id, request.params.column) };
    },
  );

  /**
   * Replaces a column's presentation (Specification_DataViews.md §15)
   * - the body is all of it, an option left out is unset.
   */
  app.put<{ Params: { id: string; column: string }; Body: { data?: { presentation?: unknown } } }>(
    "/admin/api/resources/:id/columns/:column/presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Set a column's presentation",
        description: "Label, description, help, placeholder, icon, format, empty text, true/false labels, link, how each CHECK value shows and how its cells look in a table - inherited by every view that shows the column. What values are valid stays PostgreSQL's (NOT NULL, CHECK).",
        pathParameters: { id: UUID_PARAM, column: { schema: { type: "string" } } },
        requestBody: { schema: dataEnvelope(object({ presentation: COLUMN_PRESENTATION_SCHEMA })) },
        response: ok(object({ columnName: { type: "string" }, presentation: COLUMN_PRESENTATION_SCHEMA })),
      }),
    },
    async (request) => ({
      data: await context.resourcesAdmin.updateColumnPresentation(request.params.id, request.params.column, request.body?.data?.presentation ?? {}),
    }),
  );

  /** Several columns' presentations at once, each replaced as the PUT above does - all or none (M17). */
  app.put<{ Params: { id: string }; Body: { data?: { columns?: unknown } } }>(
    "/admin/api/resources/:id/columns/presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Set several columns' presentations",
        description: "`columns` maps each column's name to its whole presentation, as the single-column PUT takes it (an option left out is unset; a column left out is untouched). Every one is checked before any is written, in one transaction.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ columns: { type: "object", additionalProperties: COLUMN_PRESENTATION_SCHEMA } }, ["columns"])) },
        response: ok(arrayOf(object({ columnName: { type: "string" }, presentation: COLUMN_PRESENTATION_SCHEMA }))),
      }),
    },
    async (request) => {
      const columns = request.body?.data?.columns;
      if (typeof columns !== "object" || columns === null || Array.isArray(columns)) {
        throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", "The request body must be { \"data\": { \"columns\": { \"<column>\": { ... } } } }.");
      }
      return { data: await context.resourcesAdmin.updateColumnPresentations(request.params.id, columns as Record<string, unknown>) };
    },
  );

  /**
   * Suggest presentation (Specification_DataViews.md §15.6, T69): what each column's type and constraints suggest -
   * never by its name - every difference with its own presentation listed (a fill, or a change). The POST applies
   * what the reviewer accepted.
   */
  const REVIEW_SCHEMA = object({
    resourceId: UUID,
    columns: arrayOf(object({
      columnName: { type: "string" },
      dataType: { type: "string" },
      presentation: COLUMN_PRESENTATION_SCHEMA,
      suggestions: arrayOf(object({
        key: { type: "string" },
        value: { description: "The suggested value, of the key's type." },
        reason: { type: "string", enum: ["unique-integer", "nullable", "check-pattern", "check-pattern-code", "email-pattern", "url-pattern", "check-list", "comment"] },
        replaces: { type: "boolean", description: "The column has its own value for this key - a change, offered unticked." },
        detail: { type: "string", description: "What the reason read on the column: its type (numeric(12,2)), its CHECK range (CHECK 1..12)." },
      })),
    })),
    row: { anyOf: [object({ displayField: { type: "string" }, reason: { type: "string", enum: ["unique-text"] } }), { type: "null" }] },
  });
  app.get<{ Params: { id: string } }>(
    "/admin/api/resources/:id/columns/suggested-presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Suggest each column's presentation",
        description: "What each column's type and constraints suggest beyond TotalBase's defaults - a unique whole number monospaced, a nullable column's empty text, a CHECK pattern's example, an email or URL pattern's link, a CHECK list's labels, COMMENT ON COLUMN as its description - and, when the table has none, its row presentation. Never by a column's name. Every difference with the column's own presentation is listed; `replaces` marks a change of a value it has. A view's column that is a table's gets nothing (it inherits).",
        pathParameters: { id: UUID_PARAM },
        response: ok(REVIEW_SCHEMA),
      }),
    },
    async (request) => ({ data: await context.resourcesAdmin.suggestColumnPresentations(request.params.id) }),
  );
  app.post<{ Params: { id: string }; Body: { data?: { columns?: unknown; row?: unknown } } | undefined }>(
    "/admin/api/resources/:id/columns/suggested-presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Apply the accepted suggestions",
        description: "`columns` maps a column to the keys the reviewer accepted, with their values (edited or not; `null` unsets one) - merged into its own presentation, all checked first, one transaction. `row` sets the row presentation. Returns the columns written.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(object({ columns: { type: "object", additionalProperties: { type: "object", additionalProperties: true } }, row: { type: "object", additionalProperties: true } })) },
        response: ok(arrayOf(object({ columnName: { type: "string" }, presentation: COLUMN_PRESENTATION_SCHEMA }))),
      }),
    },
    async (request) => {
      const { columns, row } = request.body?.data ?? {};
      const isMap = (value: unknown) => typeof value === "object" && value !== null && !Array.isArray(value);
      if ((columns !== undefined && !isMap(columns)) || (row !== undefined && !isMap(row))) {
        throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", "columns must map each column to its keys; row must be an object.");
      }
      return {
        data: await context.resourcesAdmin.applyPresentationReview(request.params.id, {
          ...(columns !== undefined && { columns: columns as Record<string, Record<string, unknown>> }),
          ...(row !== undefined && { row: row as Record<string, string> }),
        }),
      };
    },
  );
  /** Every application table and view at once - for whoever installs TotalBase over an existing database. */
  app.get(
    "/admin/api/resources/suggested-presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Suggest presentation for every table and view",
        description: "One line per application table and view: how many values Suggest presentation would fill, how many it would change, whether it would set a row presentation.",
        response: ok(arrayOf(object({ resourceId: UUID, schema: { type: "string" }, name: { type: "string" }, type: { type: "string", enum: ["TABLE", "VIEW"] }, fills: { type: "integer" }, changes: { type: "integer" }, row: { type: "boolean" } }))),
      }),
    },
    async () => ({ data: await context.resourcesAdmin.suggestPresentationEverywhere() }),
  );
  app.post<{ Body: { data?: { resourceIds?: unknown } } | undefined }>(
    "/admin/api/resources/suggested-presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Fill the suggested presentation where it's missing",
        description: "Fills, on the given tables and views (`resourceIds`; left out, every one), what their columns lack - never changing a value of their own - and a row presentation where there is none. Changes are a table's review. Returns how many columns got something.",
        requestBody: { required: false, schema: dataEnvelope(object({ resourceIds: arrayOf(UUID) })) },
        response: ok(object({ presentedColumns: { type: "integer" } })),
      }),
    },
    async (request) => {
      const ids = request.body?.data?.resourceIds;
      if (ids !== undefined && !(Array.isArray(ids) && ids.every(id => typeof id === "string"))) {
        throw new TotalBaseError("INVALID_QUERY", "resourceIds must be a list of resource ids.");
      }
      return { data: { presentedColumns: await context.resourcesAdmin.applyPresentationFills(ids as string[] | undefined) } };
    },
  );

  /**
   * Replaces a table's or a view's row presentation (Specification_DataViews.md
   * §15.5) - the body is all of it, `{}` clears it.
   */
  app.put<{ Params: { id: string }; Body: { data?: unknown } }>(
    "/admin/api/resources/:id/row-presentation",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Set a table's row presentation",
        description: "How a row of this table or view shows wherever a foreign key points at it - a shown column or a template over its columns - inherited by every foreign-key column of every DataView that sets none of its own (drafts at once, published DataViews when republished). 422 INVALID_ROW_PRESENTATION names a column the table doesn't have.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(ADMIN_SCHEMAS.Resource!.properties!.rowPresentation!) },
        response: ok(ADMIN_SCHEMAS.Resource!.properties!.rowPresentation!),
      }),
    },
    async (request) => ({
      data: await context.resourcesAdmin.updateRowPresentation(request.params.id, (request.body as { data?: unknown } | undefined)?.data ?? {}),
    }),
  );

  /** Replaces a table's or a view's default order (Specification.md §11.7) - the body is all of it, `[]` clears it. */
  app.put<{ Params: { id: string }; Body: { data?: unknown } }>(
    "/admin/api/resources/:id/default-sort",
    {
      preHandler,
      ...adminDoc("resources", {
        summary: "Set a table's default order",
        description: "The order its rows come in when nobody asks for one: the Data API without `order_by` (then the primary key as the tiebreaker, Specification_Data_API.md §3.6) and what a new DataView starts from. `[]` clears it. 400 INVALID_QUERY names a column the resource doesn't have.",
        pathParameters: { id: UUID_PARAM },
        requestBody: { schema: dataEnvelope(ADMIN_SCHEMAS.Resource!.properties!.defaultSort!) },
        response: ok(ADMIN_SCHEMAS.Resource!.properties!.defaultSort!),
      }),
    },
    async (request) => ({
      data: await context.resourcesAdmin.updateDefaultSort(request.params.id, (request.body as { data?: unknown } | undefined)?.data ?? []),
    }),
  );

  app.patch<{
    Params: { id: string };
    Body: {
      data?: {
        exposedMethods?: DataApiMethod[];
        description?: string | null;
        functionClass?: "UNCLASSIFIED" | "QUERY" | "ACTION";
        auditRead?: boolean;
        requireIdempotencyKey?: boolean;
      };
    };
  }>("/admin/api/resources/:id", {
    preHandler,
    ...adminDoc("resources", {
      summary: "Update a resource's exposure and metadata",
      description: "`exposedMethods` is the HTTP ceiling below role permissions: a method not listed answers 404 for everyone.",
      pathParameters: { id: UUID_PARAM },
      requestBody: {
        schema: dataEnvelope(object({
          exposedMethods: arrayOf({ type: "string", enum: ["GET", "POST", "PATCH", "DELETE"] }),
          description: { type: ["string", "null"] },
          functionClass: { type: "string", enum: ["UNCLASSIFIED", "QUERY", "ACTION"] },
          auditRead: { type: "boolean" },
          requireIdempotencyKey: { type: "boolean", description: "TABLE and FUNCTION only." },
        })),
      },
      response: ok(ref("Resource")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request) => {
    const body = request.body?.data ?? {};
    return {
      data: await context.resourcesAdmin.update(request.params.id, {
        exposedMethods: body.exposedMethods,
        description: body.description,
        functionClass: body.functionClass,
        auditRead: body.auditRead,
        requireIdempotencyKey: body.requireIdempotencyKey,
      }),
    };
  });
}
