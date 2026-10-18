import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { whereParams, type AdminClient } from "./admin-client.js";
import { columnInputWidgets, columnValueKind, looksLikeSettingsTable, suggestSettingsLayout, widgetDefinition, type WidgetName } from "@totalbase/tb-catalog";
import { ADDITIVE, defined, DESTRUCTIVE, filterForStorage, findResource, deleteEach, deleteTargets, IDEMPOTENT, NAME_RULE, READ_ONLY, result, roleId, schemaName } from "./tool-helpers.js";

/**
 * DataViews (Specification_DataViews.md, Specification_Administration.md
 * §11.3): created over a table or view in one call - the creation wizard's
 * own endpoint, fields from the source's columns - read back with the roles
 * that open it and what those roles may do on its source, changed (settings,
 * view_config, fields), published for the roles that may open them, deleted.
 * A DataView never grants data: its users still need the source's
 * permissions (grant_permission).
 */

interface DataView {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  icon?: string | null;
  viewType: string;
  scope?: string;
  sourceResource?: string | null;
  sourceResourceSchema: string | null;
  sourceResourceName: string | null;
  viewConfig?: Record<string, unknown>;
  liveVersion: number | null;
  hasUnpublishedChanges?: boolean;
}
interface DataViewField { id: string; kind: "COLUMN" | "RELATED" | "WIDGET"; parent?: string | null; columnName: string | null; label: string | null; widget: string | null; visible: boolean; config: Record<string, unknown>; dataType?: string; inherited?: { label?: string; shortLabel?: string } }
interface ActionDecision { decision: string }
interface EffectivePermissions { resource: string; actions: Record<string, ActionDecision | undefined> }

const VIEW_TYPES = ["TABLE", "CARDS", "KANBAN", "CALENDAR", "GANTT", "TREE", "MAP", "FORM", "MASTER_DETAIL", "EXTERNALFRAME", "CUSTOM", "SETTINGS"] as const;
const COLORS = ["red", "orange", "amber", "yellow", "lime", "green", "emerald", "teal", "cyan", "sky", "blue", "indigo", "violet", "purple", "fuchsia", "pink", "rose"] as const;

/** A view_config with its base_where stored as the grammar takes it. */
const storedViewConfig = (config: Record<string, unknown>) => (config["base_where"] ? { ...config, base_where: filterForStorage(config["base_where"]) } : config);

const summary = (v: DataView) => ({
  id: v.id,
  name: v.name,
  slug: v.slug,
  viewType: v.viewType,
  source: v.sourceResourceSchema && v.sourceResourceName ? `${v.sourceResourceSchema}.${v.sourceResourceName}` : null,
  liveVersion: v.liveVersion,
  ...(v.hasUnpublishedChanges !== undefined && { hasUnpublishedChanges: v.hasUnpublishedChanges }),
});

/**
 * Each field as get_dataview shows it, a column's with its record form's input (M26): the input the form edits it
 * with and whether it follows its column's (`fromColumn` - set_column_presentation widget) or is the form's own.
 */
function withFormInputs(fields: DataViewField[]) {
  const inputOf = new Map<string, { widget: string; follows: boolean }>();
  for (const formField of fields) {
    const column = (formField.config["props"] as { column?: unknown } | undefined)?.column;
    if (formField.kind !== "WIDGET" || formField.widget !== "UFormField" || typeof column !== "string") continue;
    const input = fields.find((f) => f.parent === formField.id && f.config["slot"] === "default");
    if (input?.widget) inputOf.set(column, { widget: input.widget, follows: input.config["fromColumn"] === true });
  }
  return fields.map((f) => {
    if (f.kind === "WIDGET" || !f.columnName) return fieldSummary(f);
    // A column's widget is its grid cell's - named so (M28), beside the input its form edits it with.
    const { widget, ...rest } = fieldSummary(f);
    const form = inputOf.get(f.columnName);
    return { ...rest, ...(widget && { gridWidget: widget }), ...(form && { formInput: form.widget, formInputFollowsColumn: form.follows }) };
  });
}

const fieldSummary = (f: DataViewField) => ({
  id: f.id,
  kind: f.kind,
  ...(f.columnName && { column: f.columnName }),
  ...(f.label !== null && { label: f.label }),
  // A column's title and short label are its table column's (set_column_presentation).
  ...(f.inherited?.label && { title: f.inherited.label }),
  ...(f.inherited?.shortLabel && { shortLabel: f.inherited.shortLabel }),
  ...(f.widget && { widget: f.widget }),
  visible: f.visible,
  ...(Object.keys(f.config ?? {}).length > 0 && { config: f.config }),
});

const viewConfigDescription =
  "The layout's settings (totalbase://guide/dataviews has every key): e.g. {\"kanban_layout\":{\"groupColumn\":\"stage\"}}, {\"base_where\":{\"archived\":{\"_eq\":\"false\"}}}, {\"auto_refresh\":\"1m\"}, {\"edit_presentation\":\"MODAL\"}, {\"features\":{\"import\":false}}, a CUSTOM page alone on screen {\"kiosk\":true}";

/** related-access's paths some role lacks - null when every role has them all. */
function missingPaths(related: Record<string, string[]>): Record<string, string[]> | null {
  const missing = Object.fromEntries(Object.entries(related).filter(([, roles]) => roles.length > 0));
  return Object.keys(missing).length > 0 ? missing : null;
}

export function registerDataViewTools(server: McpServer, client: AdminClient): void {
  server.registerTool(
    "list_dataviews",
    {
      title: "List DataViews",
      description: "Every DataView: id, name, slug, type, source table, live version (null: never published) and whether the draft has unpublished changes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => result((await client.get<DataView[]>("/dataviews")).map(summary)),
  );

  server.registerTool(
    "get_dataview",
    {
      title: "Get DataView",
      description:
        "A DataView's draft: its settings, view_config, fields (id, column, a column's title and shortLabel - its table column's, set_column_presentation -, a widget's label and widget, visible, a column's gridWidget (its grid cell's) and formInput: the input its record form edits it with, formInputFollowsColumn true when it follows its column's (set_column_presentation widget), false when it is the form's own - update_dataview changes visible and widget by column), the roles that may open it and, for each of those roles, what it may do on the source (READ / CREATE / UPDATE / DELETE) - a role granted the DataView without READ on its source can't open it; the paths a role may not read - related columns, and the columns a reference shows its row by (it would see the key) - are listed too (rolesMissingRelatedColumns). By default its columns only, without their config; detail=true adds its whole field tree (the generated form's widgets, each field's config and bindings).",
      inputSchema: {
        id: z.string().describe("The DataView's id (list_dataviews)"),
        detail: z.boolean().optional().describe("Every field - the form's widgets too - with its config"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, detail }) => {
      const [dataview, fields, roles, related] = await Promise.all([
        client.get<DataView>(`/dataviews/${id}`),
        client.get<DataViewField[]>(`/dataviews/${id}/fields`),
        client.data<{ role: string }[]>("GET", "/totalbase/table/dataviews_roles", { query: { fields: "role", ...whereParams({ dataview: { _eq: id } }) } }),
        client.get<Record<string, string[]>>(`/dataviews/${id}/related-access`).catch(() => ({})),
      ]);
      const access = dataview.sourceResource
        ? await Promise.all(
            roles.map(async ({ role }) => {
              const decisions = (await client.get<EffectivePermissions[]>(`/roles/${role}/effective-permissions`)).find((d) => d.resource === dataview.sourceResource);
              const on = (action: string) => decisions?.actions[action]?.decision ?? "UNDEFINED";
              return { role, read: on("READ"), create: on("CREATE"), update: on("UPDATE"), delete: on("DELETE") };
            }),
          )
        : roles.map(({ role }) => ({ role }));
      return result({
        ...summary(dataview),
        description: dataview.description ?? null,
        icon: dataview.icon ?? null,
        scope: dataview.scope,
        viewConfig: dataview.viewConfig ?? {},
        // Most questions - which columns, can role X read it - need the columns, not the generated form's widget tree
        // with its bindings (5k tokens for a 9-column KANBAN).
        fields: detail ? withFormInputs(fields) : withFormInputs(fields).filter((f) => "column" in f && f.kind !== "WIDGET").map(({ config: _config, ...f }) => f),
        roles: access,
        ...(missingPaths(related) && { rolesMissingRelatedColumns: missingPaths(related) }),
      });
    },
  );

  server.registerTool(
    "create_dataview",
    {
      title: "Create DataView",
      description:
        "Create a DataView - the screen users work with in the App - over a table or view, as an unpublished draft (totalbase://guide/dataviews: which type for which data). Its fields come from the source's columns (columns picks some), with the columns' presentation (set_column_presentation) and foreign keys shown by their row presentation (set_row_presentation); over a table a TABLE (or any list type) also gets its record form. The other layouts need their columns in view_config: KANBAN {\"kanban_layout\":{\"groupColumn\": a FOREIGN KEY column - one lane per row of its target - or a column with a CHECK list - one lane per value}}, CALENDAR {\"calendar_layout\":{\"dateColumn\"}}, GANTT {\"gantt_layout\":{\"startDateColumn\",\"endDateColumn\"}}, MAP {\"map_layout\":{\"pointColumn\"}} (a point column) or latitudeColumn/longitudeColumn, EXTERNALFRAME {\"frame_url\": an https URL} and no table. MASTER_DETAIL takes detail: the lines table and its foreign key to the master table. A FORM shows one record at a time: browsing and editing existing rows by default (view_config form_view_mode READ or UPDATE), or only creating new ones (form_view_mode CREATE - a data-entry screen: always a blank record, a save starts the next), or a table's one row (form_view_mode SINGLE - a company's settings: opened to edit, created on the first save, no New, search, browsing or delete). Over a view, any type is read-only - no New, edit or delete. CUSTOM is a blank page you build (totalbase://guide/pages): table, optional, is its record's table (a TABLE) - then set_page_variables, add_page_widgets, save_page_code. SETTINGS is a parameter table (a key, a value, a title, a description per row - totalbase://guide/modeling) edited in place: view_config {\"settings_layout\":{\"keyColumn\",\"valueColumn\",\"titleColumn\",\"descriptionColumn\",\"groupColumn\"?,\"orderColumn\"?}}. A list type may offer several views of the same rows, switched from the toolbar: view_config {\"layouts\":[\"TABLE\",\"MAP\",\"CARDS\"]} - view_type among them, the one it opens with - plus each one's own *_layout. Then publish_dataview with the roles that open it.",
      inputSchema: {
        name: z.string().max(32).describe(`Shown in the App menu, e.g. 'Customers' - ${NAME_RULE}`),
        view_type: z.enum(VIEW_TYPES),
        schema: schemaName(),
        table: z.string().optional().describe("The source table or view - every type but EXTERNALFRAME; for CUSTOM, optional: the table its record is a row of"),
        columns: z.array(z.string()).optional().describe("The source columns to show, in order; all of them when omitted. A related column by path: 'customer.city'"),
        slug: z.string().max(32).optional().describe("URL-safe; proposed from the name when omitted. Fixed once published - links point at it"),
        icon: z.string().optional().describe("A Lucide icon, e.g. 'i-lucide-users'"),
        menu_label: z.string().max(32).nullable().optional().describe("What the App menu shows, when it should read differently from its name (e.g. a short one) - applies at once, no publish; empty or null: its name"),
        view_config: z.record(z.string(), z.unknown()).optional().describe(viewConfigDescription),
        detail: z
          .object({
            table: z.string().describe("The lines table, in the same schema"),
            fk_column: z.string().describe("Its foreign key column pointing at the master table"),
            columns: z.array(z.string()).optional().describe("The lines' columns to show; all of them when omitted"),
          })
          .optional()
          .describe("MASTER_DETAIL only"),
      },
      annotations: ADDITIVE,
    },
    async ({ name, view_type, schema, table, columns, slug, icon, menu_label, view_config, detail }) => {
      if (view_type !== "EXTERNALFRAME" && view_type !== "CUSTOM" && !table) throw new Error(`${view_type} needs a source table.`);
      if (view_type === "MASTER_DETAIL" && !detail) throw new Error("MASTER_DETAIL needs detail: the lines table and its foreign key column.");
      const source = table ? await findResource(client, schema, table, view_type === "CUSTOM" ? "TABLE" : undefined) : undefined;
      const detailSource = detail ? await findResource(client, schema, detail.table, "TABLE") : undefined;
      const created = await client.post<DataView>("/dataviews", {
        data: {
          name,
          viewType: view_type,
          ...(source && { sourceResourceId: source.id }),
          ...(detail && detailSource && {
            detail: { resourceId: detailSource.id, fkColumn: detail.fk_column, ...(detail.columns && { selectedColumns: detail.columns }) },
          }),
          ...(columns && { selectedColumns: columns }),
          ...(slug && { slug }),
          ...(icon && { icon }),
          ...(view_config && { viewConfig: storedViewConfig(view_config) }),
        },
      });
      // Not a create field: the label is live identity, set like a rename.
      if (menu_label) await client.patch(`/dataviews/${created.id}`, { data: { menuLabel: menu_label } });
      // A parameter table made into another type: say SETTINGS edits it in place.
      let settingsHint: string | undefined;
      if (view_type !== "SETTINGS" && view_type !== "CUSTOM" && table) {
        const fields = await client.get<{ columnName: string | null }[]>(`/dataviews/${created.id}/fields`);
        const names = fields.map((f) => f.columnName).filter((n): n is string => Boolean(n));
        if (looksLikeSettingsTable(names)) {
          settingsHint = `${table} looks like a parameter table (a key and a value): a SETTINGS DataView edits it like TotalBase's Settings - settings_layout ${JSON.stringify(suggestSettingsLayout(names))}.`;
        }
      }
      return result({
        ...summary(created),
        ...(settingsHint && { hint: settingsHint }),
        next: view_type === "CUSTOM" ? "set_page_variables, add_page_widgets, save_page_code, then publish_dataview" : "publish_dataview with the roles that open it - they also need grant_permission on the source",
      });
    },
  );

  server.registerTool(
    "update_dataview",
    {
      title: "Update DataView",
      description:
        "Change a DataView's draft: name, slug, description, icon, color, scope (LISTED in the App menu, or EMBEDDED_ONLY - out of it), view_config (shallow merge: each top-level key sent replaces that key, the rest stay - null resets one), auto_refresh, its columns (add_columns from the source - a column or 'fk.column' -, remove_columns, column_order and default_sort for the grid), toolbar_mode (full or compact) and its fields by column (visible, widget) - a column's title, format and look are its table column's: set_column_presentation. role_ids replaces who may open it at once, without publishing - [] leaves only administrators: the way to take a DataView out of the App without deleting it. Everything else reaches the App at the next publish_dataview.",
      inputSchema: {
        id: z.string().describe("The DataView's id"),
        name: z.string().max(32).optional().describe(NAME_RULE),
        slug: z.string().max(32).optional(),
        description: z.string().max(128).nullable().optional().describe("Also the App menu's tooltip"),
        menu_label: z.string().max(32).nullable().optional().describe("What the App menu shows, when it should read differently from its name (e.g. a short one) - applies at once, no publish; empty or null: its name"),
        icon: z.string().nullable().optional(),
        color: z.enum(COLORS).nullable().optional(),
        scope: z.enum(["LISTED", "EMBEDDED_ONLY"]).optional(),
        view_config: z.record(z.string(), z.unknown()).optional().describe(viewConfigDescription),
        auto_refresh: z.string().nullable().optional().describe("Re-read its rows this often: '10s', '30s', '1m', '5m', '15m'; null turns it off"),
        role_ids: z.array(roleId()).optional().describe("Replaces the roles that may open it, now - no publish needed"),
        add_columns: z.array(z.string()).optional().describe("Source columns to add, or a related column as 'fk.column'"),
        remove_columns: z.array(z.string()).optional().describe("Columns to take out (never the primary key - hide it with fields visible false)"),
        column_order: z.array(z.string()).optional().describe("The grid's default column order, by column - those not listed follow"),
        default_sort: z.string().optional().describe("The grid's default order, as order_by: 'name,-created_at'"),
        toolbar_mode: z
          .enum(["full", "compact"])
          .nullable()
          .optional()
          .describe("List types: the toolbar a viewer who hasn't chosen opens with - compact puts Search and the ⋮ menu in the page header; null leaves it to the instance's default (Settings > DataViews > Toolbar). A phone or tablet is always compact"),
        fields: z
          .array(
            z.object({
              column: z.string().describe("The field's column, or a related path ('customer.city')"),
              visible: z.boolean().optional(),
              widget: z
                .string()
                .nullable()
                .optional()
                .describe("Its input - in the grid and in the record form, an input of this form's own: one compatible with the column's type, e.g. 'UInput', 'UTextarea', 'USelectMenu', 'URadioGroup', 'USwitch'. null: the form follows its column's input again (set_column_presentation widget)"),
            }),
          )
          .optional(),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, name, slug, description, menu_label, icon, color, scope, view_config, auto_refresh, role_ids, add_columns, remove_columns, column_order, default_sort, toolbar_mode, fields }) => {
      if (role_ids) await client.put(`/dataviews/${id}/roles`, { data: { roleIds: role_ids } });
      if (add_columns?.length) await client.post(`/dataviews/${id}/columns`, { data: add_columns });
      if (remove_columns?.length) {
        const existing = await client.get<DataViewField[]>(`/dataviews/${id}/fields`);
        for (const column of remove_columns) {
          const field = existing.find((f) => f.kind !== "WIDGET" && f.columnName === column);
          if (!field) throw new Error(`No column "${column}" in this DataView (get_dataview lists them).`);
          await client.delete(`/dataviews/${id}/fields/${field.id}`);
        }
      }
      let viewConfig = view_config ? storedViewConfig({ ...view_config }) : undefined;
      if (auto_refresh !== undefined) viewConfig = { ...viewConfig, auto_refresh };
      if (column_order || default_sort !== undefined || toolbar_mode !== undefined) {
        // default_state is one key: merged here so the grid's other defaults (density, page size) stay.
        const current = (await client.get<DataView>(`/dataviews/${id}`)).viewConfig?.["default_state"] as Record<string, unknown> | null | undefined;
        const prefs = { ...((current?.["columnPrefs"] as Record<string, Record<string, unknown>> | undefined) ?? {}) };
        column_order?.forEach((column, order) => (prefs[column] = { ...prefs[column], order }));
        const state: Record<string, unknown> = { ...current, ...(column_order && { columnPrefs: prefs }), ...(default_sort !== undefined && { sort: default_sort }) };
        if (toolbar_mode === null) delete state["toolbarMode"];
        else if (toolbar_mode !== undefined) state["toolbarMode"] = toolbar_mode;
        viewConfig = { ...viewConfig, default_state: state };
      }
      const patch = defined({ name, slug, description, menuLabel: menu_label, icon, color, scope, viewConfig });
      let dataview = Object.keys(patch).length > 0 ? await client.patch<DataView>(`/dataviews/${id}`, { data: patch }) : await client.get<DataView>(`/dataviews/${id}`);
      const changed: ReturnType<typeof fieldSummary>[] = [];
      if (fields?.length) {
        const existing = await client.get<DataViewField[]>(`/dataviews/${id}/fields`);
        for (const change of fields) {
          const field = existing.find((f) => f.kind !== "WIDGET" && f.columnName === change.column);
          // The record form's field bound to the column, and its input (M23).
          const formField = existing.find((f) => f.kind === "WIDGET" && f.widget === "UFormField" && (f.config["props"] as { column?: unknown } | undefined)?.column === change.column);
          const input = formField && existing.find((f) => f.kind === "WIDGET" && f.parent === formField.id && f.config["slot"] === "default");
          if (!field && !input) throw new Error(`No field for column "${change.column}" in this DataView (get_dataview lists them).`);
          if (typeof change.widget === "string" && field?.dataType) {
            const kind = field.widget === "USelectMenu" || field.config["display_field_target"] ? "relation" : columnValueKind(field.dataType, null);
            const valid = columnInputWidgets(kind);
            if (!(valid as string[]).includes(change.widget)) throw new Error(`Widget "${change.widget}" doesn't edit "${change.column}" (${field.dataType}) - one of: ${valid.join(", ")}.`);
          }
          if (field) {
            const body = defined({ visible: change.visible, widget: change.widget ?? undefined });
            if (Object.keys(body).length > 0) changed.push(fieldSummary(await client.patch<DataViewField>(`/dataviews/${id}/fields/${field.id}`, { data: body })));
          }
          if (input && change.widget === null) {
            changed.push(fieldSummary(await client.patch<DataViewField>(`/dataviews/${id}/fields/${input.id}`, { data: { config: { ...input.config, fromColumn: true } } })));
          } else if (input && typeof change.widget === "string") {
            const takes = widgetDefinition(change.widget as WidgetName).props;
            const keep = (values: unknown) => Object.fromEntries(Object.entries((values ?? {}) as Record<string, unknown>).filter(([key]) => key === "modelValue" || key in takes));
            // Switched in place, keeping what it's bound to where the new input takes it - its own from now on.
            changed.push(fieldSummary(await client.patch<DataViewField>(`/dataviews/${id}/fields/${input.id}`, {
              data: { widget: change.widget, config: { slot: "default", props: keep(input.config["props"]), bindings: keep(input.config["bindings"]), emits: {} } },
            })));
          }
        }
        dataview = await client.get<DataView>(`/dataviews/${id}`);
      }
      return result({ ...summary(dataview), viewConfig: dataview.viewConfig ?? {}, ...(changed.length > 0 && { fields: changed }), ...(role_ids && { roleIds: role_ids }) });
    },
  );

  server.registerTool(
    "publish_dataview",
    {
      title: "Publish DataView",
      description:
        "Publish a DataView's draft as its next version - what users see in the App. role_ids replaces the roles that may open it (list_roles); without any, only administrators do. Those roles also need the source table's permissions (grant_permission) to read or write its rows - get_dataview shows what each role may do. A published, LISTED DataView joins the App menu.",
      inputSchema: { id: z.string().describe("The DataView's id"), role_ids: z.array(roleId()).optional().describe("Every role that may open it - replaces the current set"), note: z.string().max(128).optional().describe("What this version changes - shown in its Versions") },
      annotations: ADDITIVE,
    },
    async ({ id, role_ids, note }) => {
      if (role_ids) await client.put(`/dataviews/${id}/roles`, { data: { roleIds: role_ids } });
      const { data: version, meta } = await client.postWithMeta<{ version: number }>(`/dataviews/${id}/publish`, note ? { data: { note } } : {});
      // A role opening it without a path its columns show - a related column, a reference's name (B44, M19).
      const missing = missingPaths(await client.get<Record<string, string[]>>(`/dataviews/${id}/related-access`).catch(() => ({})));
      const warnings = [
        ...(Array.isArray(meta?.["warnings"]) ? (meta["warnings"] as unknown[]) : meta?.["warnings"] !== undefined ? [meta["warnings"]] : []),
        ...(missing ? [`Roles that open it but can't read these paths of the source see a key or nothing there - grant them on its READ (grant_permission fields): ${JSON.stringify(missing)}`] : []),
      ];
      return result({ id, version: version?.version, ...(role_ids && { roleIds: role_ids }), ...(warnings.length > 0 && { warnings }) });
    },
  );

  server.registerTool(
    "delete_dataview",
    {
      title: "Delete DataView",
      description: "Delete a DataView with its versions (and the detail DataViews it owns) - it leaves the App menu. The table and its rows stay. Refused while another page embeds it. Requires confirm=true.",
      inputSchema: { ...deleteTargets(), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ id, ids }) => result(await deleteEach(client, "/dataviews", { id, ids })),
  );
}
