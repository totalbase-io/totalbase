import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DASHBOARD_WIDGET_CATALOG, DASHBOARD_WIDGET_TYPES, dashboardValueKind, isPresentationWidget, type DashboardWidgetType } from "@totalbase/tb-catalog";
import { AdminApiError, type AdminClient } from "./admin-client.js";
import { ADDITIVE, DESTRUCTIVE, deleteEach, deleteTargets, IDEMPOTENT, NAME_RULE, READ_ONLY, result, roleId } from "./tool-helpers.js";
import { dashboardWidgetSection } from "./guides-text.js";
import { FULL_POLICY, refuseDestructive, type McpPolicy } from "./policy.js";

/**
 * Dashboards (Dashboards.md, Administration.md
 * §11.3): a draft built from SQL widgets, tried with preview_query, saved with
 * save_widget - which runs what it saved, so a widget whose query fails says
 * so - and published for the roles that may view it. The SQL is the
 * administrator's (the token's), run read-only by TotalBase; the
 * totalbase://guide/dashboards resource says what each widget type expects.
 */

interface Dashboard {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  scope: string;
  refreshIntervalSeconds: number | null;
  variables: unknown[];
  tabs?: { value: string; label: string; icon?: string }[];
  embeddingEnabled?: boolean;
  hasUnpublishedChanges?: boolean;
  liveVersion?: number | null;
}
interface Widget { id: string; type: DashboardWidgetType; label: string | null; gridX: number; gridY: number; gridW: number; gridH: number; query: string | null; config: Record<string, unknown>; tab?: string | null }
interface QueryColumn { name: string; dataType: string; fileReference?: boolean; lossy?: boolean; origin?: { schema: string; table: string; column: string } }
interface QueryResult { columns: QueryColumn[]; rows: Record<string, unknown>[]; truncated: boolean; totals?: Record<string, unknown> | null; marks?: Record<string, unknown> | null; roles?: Record<string, unknown> }

const widgetSummary = (w: Widget) => ({
  id: w.id,
  type: w.type,
  label: w.label,
  grid: { x: w.gridX, y: w.gridY, w: w.gridW, h: w.gridH },
  ...(w.tab && { tab: w.tab }),
  ...(w.query !== null && { query: w.query }),
  ...(Object.keys(w.config ?? {}).length > 0 && { config: w.config }),
});

/**
 * A result's columns as an agent plans a widget with them (DM8): its type, the kind a role takes (number, time,
 * category, point, file - a file is a uuid pointing at files), whether it's lossy (a number too long for a
 * double: its exact text) and the table column it is.
 */
const columnInfo = (c: QueryColumn) => ({
  name: c.name,
  type: c.dataType,
  kind: dashboardValueKind(c),
  ...(c.lossy && { lossy: true }),
  ...(c.origin && { origin: `${c.origin.schema}.${c.origin.table}.${c.origin.column}` }),
});

const sample = (data: QueryResult, rows: number) => ({
  columns: data.columns.map(columnInfo),
  rows: data.rows.slice(0, rows),
  rowCount: data.rows.length,
  ...(data.truncated && { truncated: true }),
  ...(data.totals && { totals: data.totals }),
  ...(data.marks && { marks: data.marks }),
  // Each role's columns and why (DM3): chosen in config, or a default by its rule.
  ...(data.roles && { roles: data.roles }),
});

const tabSchema = strict({
  value: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).describe("Its address: ?tab=<value>, a widget's tab"),
  label: z.string().max(32),
  icon: z.string().optional().describe("A Lucide icon, e.g. i-lucide-list"),
});

/** A nested object that refuses a key it doesn't know, naming the ones it takes (DB20) - at its path. */
function strict<T extends z.ZodRawShape>(shape: T) {
  return z.strictObject(shape, { error: (issue) => (issue.code === "unrecognized_keys" ? `has no ${issue.keys.map((k) => `"${k}"`).join(", ")} - it takes: ${Object.keys(shape).join(", ")}` : undefined) });
}

const variableSchema = strict({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/).describe("Used in widget SQL as $VAR.<name> - a DATE_RANGE as $VAR.<name>.from / .to, its previous period (as long, just before) as .prev_from / .prev_to"),
  label: z.string().describe("Shown above the filter"),
  type: z.enum(["DATE_RANGE", "SELECT", "TEXT", "NUMBER"]),
  multiple: z.boolean().optional().describe("SELECT only: binds text[] instead of text - filter with = ANY($VAR.<name>)"),
  // By its source - an unknown key is named in the branch it belongs to (DB20), not a bare "Invalid input".
  options: z
    .discriminatedUnion("source", [
      strict({ source: z.literal("STATIC"), values: z.array(z.union([z.string(), strict({ value: z.string(), label: z.string().optional() })])) })
        .describe("A fixed list - each a value, or {value, label}: Yes / No / All is [{value:'true',label:'Yes'},{value:'false',label:'No'}], unset being All"),
      strict({ source: z.literal("QUERY"), query: z.string().describe("Read-only SQL: first column = value, optional second = label; may read other variables ($VAR.x) - chained, reloaded when they change") }),
      strict({
        source: z.literal("TABLE"),
        resource: z.string().describe("A table's resource id: its key the value, its row presentation (set_row_presentation) the label - no SQL"),
        filters: z.array(strict({ column: z.string(), variable: z.string() })).optional().describe("Chained: a column of the table equal to another variable's value - the cities of the selected country; no value, no filter"),
      }),
    ])
    .optional()
    .describe("SELECT only"),
  default: z
    .discriminatedUnion("source", [strict({ source: z.literal("constant"), value: z.unknown() }), strict({ source: z.literal("user"), field: z.string() })])
    .optional()
    .describe("Absent = NULL. {source:'constant', value} - a DATE_RANGE preset: last_hour, today, last_7_days, last_30_days, last_90_days, this_month, last_month, this_year, all, or {from, to} - presets and every query run in the viewer's time zone; or {source:'user', field} - the viewer's own user row's column (their branch)"),
});

const REFRESH = [z.literal(30), z.literal(60), z.literal(300), z.literal(900), z.literal(3600)] as const;

const gridSchema = z
  .object({ x: z.number().int().min(0).max(11), y: z.number().int().min(0), w: z.number().int().min(1).max(12), h: z.number().int().min(1) })
  .describe("Position on the 12-column canvas: x 0-11, w 1-12 (6 = half, 4 = a third, 3 = a quarter), y and h in rows");

export function registerDashboardTools(server: McpServer, client: AdminClient, policy: McpPolicy = FULL_POLICY): void {
  server.registerTool(
    "describe_dashboard_widgets",
    {
      title: "Describe dashboard widgets",
      description: "Each widget type's contract: what its query must return (its roles, by column kind), its props with their defaults, and an example - read the types a dashboard uses before save_widget. totalbase://guide/dashboards has the rules every widget shares.",
      inputSchema: { types: z.array(z.enum(DASHBOARD_WIDGET_TYPES as unknown as [DashboardWidgetType, ...DashboardWidgetType[]])).min(1) },
      annotations: READ_ONLY,
    },
    async ({ types }) => ({ content: [{ type: "text" as const, text: [...new Set(types)].map(dashboardWidgetSection).join("\n\n") }] }),
  );

  server.registerTool(
    "list_dashboards",
    {
      title: "List dashboards",
      description: "Every dashboard: id, name, slug, its live version (null: never published) and whether its draft has unpublished changes.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const dashboards = await client.get<Dashboard[]>("/dashboards");
      return result(dashboards.map((d) => ({ id: d.id, name: d.name, slug: d.slug, liveVersion: d.liveVersion ?? null, hasUnpublishedChanges: d.hasUnpublishedChanges ?? false })));
    },
  );

  server.registerTool(
    "get_dashboard",
    {
      title: "Get dashboard",
      description:
        "A dashboard's draft as a spec - name, slug, description, icon, menuLabel, scope, refreshIntervalSeconds, variables ($VAR.*), tabs and widgets (id, type, label, tab, grid, query, config) - with draftVersion (pass it to apply_dashboard), liveVersion, hasUnpublishedChanges and access (its roles and embeds, read-only: change them with update_dashboard and the embed tools). The spec goes back to apply_dashboard as is: applied unchanged, nothing changes.",
      inputSchema: { id: z.string().describe("The dashboard's id (list_dashboards)") },
      annotations: READ_ONLY,
    },
    async ({ id }) => result(await client.get(`/dashboards/${id}/spec`)),
  );

  server.registerTool(
    "apply_dashboard",
    {
      title: "Apply dashboard",
      description:
        "Create a dashboard (no id) or replace its whole draft with a spec - get_dashboard's shape - in one transaction: a widget with an id is that widget (kept: clicks and links point at it), one without is new, one left out is DELETED. Widgets without grid are placed in order at their type's size. Every problem comes back at once, each with its path and code (widgets[3].config.roles.value), and nothing is applied. dry_run: only check and get the difference. Pass the draftVersion get_dashboard gave you: if someone changed the draft since, it's refused (DASHBOARD_DRAFT_CHANGED). The answer gives each widget's id, columns (kind, origin) and roles (which column each took and why); rows: n adds each widget's first rows. Then publish_dashboard. For one small change, save_widget. Outside FULL mode, a spec that would delete widgets is refused.",
      inputSchema: {
        id: z.string().optional().describe("The dashboard to replace - omit to create one"),
        draft_version: z.string().optional().describe("From get_dashboard - refused if the draft changed since"),
        spec: z.record(z.string(), z.unknown()).describe("{name, slug?, description?, icon?, menuLabel?, scope?, refreshIntervalSeconds?, variables, tabs, widgets: [{id?, type, label, tab?, grid?, query, config}]} - totalbase://guide/dashboards"),
        dry_run: z.boolean().optional().describe("Check and answer the difference - nothing applied"),
        rows: z.number().int().min(0).max(50).optional().describe("Each widget's first rows in the answer (0, the default: none run)"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ id, draft_version, spec, dry_run, rows }) => {
      let draftVersion = draft_version;
      try {
        // Outside FULL mode a spec that leaves widgets out - deleting them - is refused: checked first, then applied
        // against the draft that check saw (a change in between is DASHBOARD_DRAFT_CHANGED).
        if (id && !dry_run && policy.mode !== "FULL") {
          const check = await client.put<{ draftVersion: string | null; diff: { widgets: { deleted: { label: string | null; type: string }[] } } }>(
            `/dashboards/${id}/spec`,
            { data: { spec, ...(draftVersion && { draftVersion }), dryRun: true } },
          );
          const deleted = check.diff.widgets.deleted;
          if (deleted.length > 0) refuseDestructive(policy, `Deleting widgets (${deleted.map((w) => w.label ?? w.type).join(", ")}) - keep them in the spec`);
          draftVersion = check.draftVersion ?? draftVersion;
        }
        const body = { data: { spec, ...(draftVersion && { draftVersion }), ...(dry_run && { dryRun: true }), ...(rows && { rows }) } };
        return result(id ? await client.put(`/dashboards/${id}/spec`, body) : await client.post(`/dashboards/spec`, body));
      } catch (error) {
        // Every problem at once, each at its path - nothing was applied.
        if (error instanceof AdminApiError && error.errors.length) return { ...result({ applied: false, errors: error.errors.map(({ source: _source, ...e }) => e) }), isError: true };
        throw error;
      }
    },
  );

  server.registerTool(
    "create_dashboard",
    {
      title: "Create dashboard",
      description: "Create an empty dashboard draft. Add filters with update_dashboard (variables), widgets with save_widget, then publish_dashboard - until then only administrators see it.",
      inputSchema: {
        name: z.string().max(32).describe(`Shown in the App menu, e.g. 'Sales' - ${NAME_RULE}`),
        slug: z.string().max(32).optional().describe("URL-safe; proposed from the name when omitted"),
        description: z.string().max(128).optional(),
        icon: z.string().optional().describe("A Lucide icon, e.g. 'i-lucide-chart-pie'"),
        refresh_interval_seconds: z.union(REFRESH).optional().describe("Re-run every widget this often while it is open"),
      },
      annotations: ADDITIVE,
    },
    async ({ name, slug, description, icon, refresh_interval_seconds }) => {
      const created = await client.post<Dashboard>("/dashboards", {
        data: { name, ...(slug && { slug }), ...(icon && { icon }), ...(refresh_interval_seconds && { refreshIntervalSeconds: refresh_interval_seconds }) },
      });
      if (description) await client.patch(`/dashboards/${created.id}`, { data: { description } });
      return result({ id: created.id, name: created.name, slug: created.slug });
    },
  );

  server.registerTool(
    "update_dashboard",
    {
      title: "Update dashboard",
      description: "Change a dashboard's name, description, listing or refresh interval, its tabs, whether its embeds work, or replace its variables (the filters a viewer picks; widget SQL reads them as $VAR.<name> - totalbase://guide/dashboards). role_ids replaces who may view it at once, without publishing - [] leaves only administrators: the way to take it out of the App without deleting it.",
      inputSchema: {
        id: z.string(),
        name: z.string().max(32).optional().describe(NAME_RULE),
        description: z.string().max(128).nullable().optional().describe("Also the App menu's tooltip"),
        menu_label: z.string().max(32).nullable().optional().describe("What the App menu shows, when it should read differently from its name (e.g. a short one) - applies at once, no publish; empty or null: its name"),
        scope: z.enum(["LISTED", "EMBEDDED_ONLY"]).optional().describe("LISTED shows it in the App menu once published"),
        refresh_interval_seconds: z.union([...REFRESH, z.null()]).optional(),
        variables: z.array(variableSchema).optional().describe("Replaces every variable - none named tab (the App's ?tab=)"),
        tabs: z
          .array(tabSchema)
          .optional()
          .describe("Replaces its tabs, in order - each widget's tab (save_widget) is one of their values, unset the first; a tab with widgets can't go (DASHBOARD_TAB_NOT_EMPTY, naming them - move them first); [] joins every widget in one grid. The App opens ?tab=<value>; only the open tab's widgets run"),
        embedding_enabled: z.boolean().optional().describe("Whether its embeds work (create_embed) - off: every embed answers not found"),
        role_ids: z.array(roleId()).optional().describe("Replaces the roles that may view it, now - no publish needed"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, name, description, menu_label, scope, refresh_interval_seconds, variables, tabs, embedding_enabled, role_ids }) => {
      if (role_ids) await client.put(`/dashboards/${id}/roles`, { data: { roleIds: role_ids } });
      const updated = await client.patch<Dashboard>(`/dashboards/${id}`, {
        data: {
          ...(name !== undefined && { name }),
          ...(description !== undefined && { description }),
          ...(menu_label !== undefined && { menuLabel: menu_label }),
          ...(scope !== undefined && { scope }),
          ...(refresh_interval_seconds !== undefined && { refreshIntervalSeconds: refresh_interval_seconds }),
          ...(variables !== undefined && { variables }),
          ...(tabs !== undefined && { tabs }),
          ...(embedding_enabled !== undefined && { embeddingEnabled: embedding_enabled }),
        },
      });
      return result({ id: updated.id, name: updated.name, scope: updated.scope, variables: updated.variables, tabs: updated.tabs ?? [], embeddingEnabled: updated.embeddingEnabled ?? false, ...(role_ids && { roleIds: role_ids }) });
    },
  );

  server.registerTool(
    "preview_query",
    {
      title: "Preview widget query",
      description:
        "Run a widget's SQL without saving it - read-only, against the dashboard draft's variables - and see its columns (with their types) and first rows. Try a query here before save_widget. One SELECT (or WITH ... SELECT); $USER.<column> is your own user row, $VAR.<name> the values given (unset = NULL).",
      inputSchema: {
        dashboard_id: z.string(),
        query: z.string(),
        variables: z.record(z.string(), z.unknown()).optional().describe("$VAR values to bind, e.g. {\"region\": \"North\"}"),
        rows: z.number().int().min(1).max(100).default(10).describe("How many rows to answer"),
      },
      annotations: READ_ONLY,
    },
    async ({ dashboard_id, query, variables, rows }) => {
      const data = await client.post<QueryResult>(`/dashboards/${dashboard_id}/query`, { data: { query, ...(variables && { variables }) } });
      return result(sample(data, rows));
    },
  );

  server.registerTool(
    "save_widget",
    {
      title: "Save widget",
      description:
        `Create (no widget_id) or update a dashboard draft's widget, then run it: the answer includes its first rows, or PostgreSQL's error when its query fails - fix it and save again with the same widget_id. Types: ${DASHBOARD_WIDGET_TYPES.join(", ")} - describe_dashboard_widgets gives each one's data contract (roles), props and their defaults. A new widget is placed below the others at its type's usual size unless grid is given (12 columns wide).`,
      inputSchema: {
        dashboard_id: z.string(),
        widget_id: z.string().optional().describe("Omit to create a widget"),
        type: z.enum(DASHBOARD_WIDGET_TYPES as [DashboardWidgetType, ...DashboardWidgetType[]]).optional().describe("Required to create"),
        label: z.string().nullable().optional().describe("The widget's title"),
        query: z.string().nullable().optional().describe("Read-only SQL - a data widget's data; optional for a presentation widget, whose formulas read its rows as {{row.<column>}} (the first) and {{rows}}"),
        tab: z.string().nullable().optional().describe("The tab it goes on (update_dashboard tabs) - unset or null: the first"),
        config: z.record(z.string(), z.unknown()).optional().describe("Replaces the whole config. A data widget: its roles and props, {\"roles\":{\"value\":\"total\"},\"displayFormat\":\"$ #,##0\"} - every nested key checked, a refusal naming its path; roles assign the query's columns (by name), each checked against what the query returns; a role or prop left out takes its default. A presentation widget (TImage, THeading, TText...): its page props and formulas, {\"props\":{\"level\":\"h2\"},\"bindings\":{\"label\":{\"kind\":\"formula\",\"formula\":\"\\\"Sales of \\\" + {{vars.seller.label}}\"}}}. Any widget: bindings.title, its title as a formula (totalbase://guide/dashboards)"),
        grid: gridSchema.optional(),
      },
      annotations: IDEMPOTENT,
    },
    async ({ dashboard_id, widget_id, type, label, query, config, grid, tab }) => {
      const base = `/dashboards/${dashboard_id}/widgets`;
      let widget: Widget;
      if (widget_id === undefined) {
        if (!type) throw new Error("Creating a widget needs its type.");
        let place = grid;
        if (!place) {
          // Below the others on its tab.
          const existing = (await client.get<Widget[]>(base)).filter((w) => (w.tab ?? null) === (tab ?? null));
          const size = DASHBOARD_WIDGET_CATALOG[type].size;
          place = { x: 0, y: existing.reduce((bottom, w) => Math.max(bottom, w.gridY + w.gridH), 0), w: size.w, h: size.h };
        }
        // One call: created configured or not at all (DB7) - a refused query or config leaves no widget behind.
        widget = await client.post<Widget>(base, {
          data: { type, label: label ?? null, gridX: place.x, gridY: place.y, gridW: place.w, gridH: place.h, ...(query !== undefined && { query }), ...(config !== undefined && { config }), ...(tab !== undefined && { tab }) },
        });
      }
      // An update: what it changes, as one PATCH (all or nothing too).
      const patch = widget_id === undefined ? {} : {
        ...(type !== undefined && { type }),
        ...(label !== undefined && { label }),
        ...(query !== undefined && { query }),
        ...(config !== undefined && { config }),
        ...(tab !== undefined && { tab }),
        ...(grid && { gridX: grid.x, gridY: grid.y, gridW: grid.w, gridH: grid.h }),
      };
      const id = widget_id ?? widget!.id;
      if (Object.keys(patch).length > 0) {
        widget = await client.patch<Widget>(`${base}/${id}`, { data: patch });
      } else if (widget_id !== undefined) {
        // Nothing to change: just run it again.
        const found = (await client.get<Widget[]>(base)).find((w) => w.id === widget_id);
        if (!found) throw new Error(`No widget ${widget_id} in this dashboard's draft (get_dashboard lists them).`);
        widget = found;
      }

      if (!widget!.query) {
        const presentation = isPresentationWidget(widget!.type);
        return result({ widget: widgetSummary(widget!), run: presentation ? "No query - it draws from its props and formulas alone." : "No query yet - set one to see data." });
      }
      try {
        const data = await client.post<QueryResult>(`${base}/${id}/data`, {});
        return result({ widget: widgetSummary(widget!), run: sample(data, 5) });
      } catch (error) {
        return result({ widget: widgetSummary(widget!), run: { error: error instanceof Error ? error.message : String(error) } });
      }
    },
  );

  // --- Embeds (DM7, Dashboards.md §9.5): the same validation as Settings › Share ---

  const embedVariablesSchema = z
    .record(z.string(), strict({ mode: z.enum(["EDITABLE", "HIDDEN", "LOCKED"]), value: z.unknown().optional() }))
    .describe("Per variable: EDITABLE (the visitor changes it, value its start), HIDDEN (fixed, unseen; value), LOCKED (fixed - its value, or on a SIGNED embed the token's). A variable left out is editable from its default");
  const embedDisplaySchema = z
    .strictObject({
      theme: z.enum(["light", "dark", "auto"]).optional(),
      titled: z.boolean().optional().describe("Shows the dashboard's name above it"),
      transparent: z.boolean().optional(),
      refreshSeconds: z.union([...REFRESH, z.null()]).optional().describe("Its own auto-refresh; null: off; unset: the dashboard's"),
      allowExport: z.boolean().optional().describe("Each widget's ⋮ offers CSV, Excel and image downloads (off by default) - only a convenience: the data is in the visitor's browser either way"),
      allowFiles: z.boolean().optional().describe("Files the queries return that aren't PUBLIC (a photo) are shown to its visitors (off by default) - on a public link, to anyone who has it"),
    })
    .describe("How it shows");

  server.registerTool(
    "list_embeds",
    {
      title: "List embeds",
      description: "A dashboard's embeds (Settings › Share): public links and signed embeds, with their variables, display, sites, expiry and whether revoked - a link's URL secret included. What each widget's click does in an embed: only a FILTER on a variable the visitor may change, and a URL marked inEmbeds.",
      inputSchema: { dashboard_id: z.string() },
      annotations: READ_ONLY,
    },
    async ({ dashboard_id }) => result(await client.get(`/dashboards/${dashboard_id}/embeds`)),
  );

  server.registerTool(
    "create_embed",
    {
      title: "Create embed",
      description:
        "Share a published dashboard outside TotalBase: LINK - a public URL (public to whoever has it: for data that may be public), or SIGNED - a portal's backend signs a short-lived token per visit (dashboards.embed_secret_key) and may give LOCKED values in it. Nothing in it is the viewer's: no $USER.*. Its dashboard needs embedding_enabled (update_dashboard). Everything its queries return reaches the browser. With widget, it shows that one published widget alone (a KPI in a portal's header), its URL clicks only.",
      inputSchema: {
        dashboard_id: z.string(),
        name: z.string().max(32).describe("Unique in the dashboard - who it is for (Website, Partner portal)"),
        type: z.enum(["LINK", "SIGNED"]),
        variables: embedVariablesSchema.optional(),
        display: embedDisplaySchema.optional(),
        widget: z.string().nullable().optional().describe("One published widget's id (get_dashboard) to show alone, filling the frame - its title by display.titled; null or omitted: the whole dashboard"),
        origins: z.array(z.string()).optional().describe("The sites that may frame it, among dashboards.embed_allowed_origins - none: all of those"),
        expires_at: z.string().nullable().optional().describe("ISO timestamp it stops working at; null: never"),
      },
      annotations: ADDITIVE,
    },
    async ({ dashboard_id, name, type, variables, display, widget, origins, expires_at }) =>
      result(await client.post(`/dashboards/${dashboard_id}/embeds`, { data: { name, type, ...(variables && { variables }), ...(display && { display }), ...(widget !== undefined && { widget }), ...(origins && { origins }), ...(expires_at !== undefined && { expiresAt: expires_at }) } })),
  );

  server.registerTool(
    "update_embed",
    {
      title: "Update embed",
      description: "Change an embed's name, variables, display (allowExport, theme...), widget (one to show alone, or null for the whole dashboard), sites or expiry - each given replaces that part whole. Its type and a link's URL stay.",
      inputSchema: {
        dashboard_id: z.string(),
        embed_id: z.string(),
        name: z.string().max(32).optional(),
        variables: embedVariablesSchema.optional(),
        display: embedDisplaySchema.optional(),
        widget: z.string().nullable().optional().describe("One published widget's id (get_dashboard) to show alone, filling the frame - its title by display.titled; null or omitted: the whole dashboard"),
        origins: z.array(z.string()).optional(),
        expires_at: z.string().nullable().optional(),
      },
      annotations: IDEMPOTENT,
    },
    async ({ dashboard_id, embed_id, name, variables, display, widget, origins, expires_at }) =>
      result(
        await client.patch(`/dashboards/${dashboard_id}/embeds/${embed_id}`, {
          data: { ...(name !== undefined && { name }), ...(variables && { variables }), ...(display && { display }), ...(widget !== undefined && { widget }), ...(origins && { origins }), ...(expires_at !== undefined && { expiresAt: expires_at }) },
        }),
      ),
  );

  server.registerTool(
    "revoke_embed",
    {
      title: "Revoke embed",
      description: "Stop an embed at once - its link or tokens answer not found from now on; kept, listed as revoked (never reactivated: create another). Requires confirm=true.",
      inputSchema: { dashboard_id: z.string(), embed_id: z.string(), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ dashboard_id, embed_id }) => result(await client.post(`/dashboards/${dashboard_id}/embeds/${embed_id}/revoke`, {})),
  );

  server.registerTool(
    "delete_widget",
    {
      title: "Delete widget",
      description: "Remove a widget from a dashboard's draft (the live version keeps it until the next publish). Requires confirm=true.",
      inputSchema: { dashboard_id: z.string(), widget_id: z.string(), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ dashboard_id, widget_id }) => {
      await client.delete(`/dashboards/${dashboard_id}/widgets/${widget_id}`);
      return result({ deleted: widget_id });
    },
  );

  server.registerTool(
    "publish_dashboard",
    {
      title: "Publish dashboard",
      description:
        "Publish a dashboard's draft as its next version - what viewers see. role_ids replaces the roles that may view it (list_roles); without any, only administrators do. Viewers see every widget's data whatever their own grants (the SQL runs with the dashboard's authority, filtered only by $USER.* in it) - publish only to roles that may see all of it. A published, LISTED dashboard joins the App menu.",
      inputSchema: { id: z.string(), role_ids: z.array(roleId()).optional().describe("Every role that may view it - replaces the current set"), note: z.string().max(128).optional().describe("What this version changes - shown in its Versions") },
      annotations: ADDITIVE,
    },
    async ({ id, role_ids, note }) => {
      if (role_ids) await client.put(`/dashboards/${id}/roles`, { data: { roleIds: role_ids } });
      const version = await client.post<{ version: number }>(`/dashboards/${id}/publish`, note ? { data: { note } } : {});
      return result({ id, version: version?.version, ...(role_ids && { roleIds: role_ids }) });
    },
  );

  server.registerTool(
    "delete_dashboard",
    {
      title: "Delete dashboard",
      description: "Delete a dashboard with its widgets and versions - it leaves the App menu. Requires confirm=true; ask the user first.",
      inputSchema: { ...deleteTargets(), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ id, ids }) => result(await deleteEach(client, "/dashboards", { id, ids })),
  );
}
