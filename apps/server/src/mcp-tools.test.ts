import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Database } from "@totalbase/database";
import { AdminClient, createTotalBaseMcpServer } from "@totalbase/mcp-server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp } from "./test-support.js";

/**
 * The MCP server against a real TotalBase (Administration.md
 * §11): an agent's whole build - a schema, related tables, a change of
 * structure, records, a dashboard tried, saved and published, a DataView -
 * through the tools over HTTP, with an administrator's plane="ADMIN" token.
 */
describe("MCP tools (an agent building on a real instance)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let mcp: Client;
  let ownerId: string;
  let roleId: string;
  let agentToken: string;
  let tokenAccess: { overridden: boolean; value: boolean };
  let rateLimit: { overridden: boolean; value: number };
  const SUFFIX = randomBytes(3).toString("hex");
  const SCHEMA = `mcp_test_${SUFFIX}`;
  const created = { dashboards: [] as string[], dataviews: [] as string[], workflows: [] as string[], users: [] as string[], templates: [] as string[] };
  const PASSWORD = "Correct-Horse-9-Battery";

  /** A tool's answer, parsed - or its error as a thrown Error. */
  async function call<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const answer = await mcp.callTool({ name, arguments: args });
    const text = (answer.content as { type: string; text: string }[])[0]?.text ?? "";
    if (answer.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await app.listen({ host: "127.0.0.1", port: 0 });
    const baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const owner = await context.auth.users.create({ email: `mcp-test-${SUFFIX}@example.com`, name: "MCP agent" });
    ownerId = owner.id;
    await context.roleAssignments.assignRoleToUser(owner.id, await context.roles.getAdministratorsRoleId());
    const { plainKey } = await context.usersApis.create({ userId: owner.id, name: `mcp-test-${SUFFIX}`, plane: "ADMIN" });
    agentToken = plainKey;
    tokenAccess = { overridden: await context.settings.isOverridden("sql_console.token_access"), value: await context.settings.get("sql_console.token_access") };
    // Every tool call is one or more HTTP requests from 127.0.0.1: the whole suite runs past the per-IP minute limit,
    // and the client would wait it out (admin-client.ts) - longer than a test may take.
    rateLimit = { overridden: await context.settings.isOverridden("security.rate_limit_per_minute"), value: await context.settings.get("security.rate_limit_per_minute") };
    await context.settings.set("security.rate_limit_per_minute", 100_000);
    roleId = (await context.roles.create(`mcp-test-${SUFFIX}`, { appAccess: true })).id;

    const server = createTotalBaseMcpServer(new AdminClient({ baseUrl, token: plainKey }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    mcp = new Client({ name: "mcp-tools-test", version: "1.0.0" });
    await mcp.connect(clientTransport);
  });

  afterAll(async () => {
    await mcp?.close();
    // Shared with local development: leave it as it was.
    if (tokenAccess.overridden) await context.settings.set("sql_console.token_access", tokenAccess.value);
    else await context.settings.reset("sql_console.token_access");
    if (rateLimit.overridden) await context.settings.set("security.rate_limit_per_minute", rateLimit.value);
    else await context.settings.reset("security.rate_limit_per_minute");
    for (const id of created.dashboards) await context.dashboardsAdmin.delete(id).catch(() => undefined);
    for (const id of created.dataviews) await context.dataviewsAdmin.delete(id).catch(() => undefined);
    for (const id of created.workflows) await context.workflowsAdmin.remove(id).catch(() => undefined);
    for (const id of created.users) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    for (const id of created.templates) await database.query(`DELETE FROM totalbase.templates WHERE id = $1`, [id]);
    await database.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
    await database.query(`DELETE FROM totalbase.resources WHERE "schema" = $1`, [SCHEMA]);
    await database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [roleId]);
    await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [ownerId]);
    await app.close();
  });

  it("orients the agent: instructions and thirteen guides, two of them read from the instance", async () => {
    expect(mcp.getInstructions()).toMatch(/draft/i);
    expect(mcp.getInstructions()).toMatch(/never bytea/);
    const { resources } = await mcp.listResources();
    expect(resources.map((r) => r.uri).sort()).toEqual(
      ["build", "dashboards", "data-api", "dataviews", "errors", "files", "modeling", "pages", "pdf-templates", "permissions", "totalbase-tables", "widgets", "workflows"].map((g) => `totalbase://guide/${g}`),
    );
    const read = async (guide: string) => ((await mcp.readResource({ uri: `totalbase://guide/${guide}` })).contents[0] as { text: string }).text;
    const dashboards = await read("dashboards");
    // Every type listed; each one's contract read on its own.
    for (const type of ["KPI", "BAR", "TABLE", "TText", "TFrame"]) expect(dashboards).toContain(`${type} (`);
    const contracts = ((await mcp.callTool({ name: "describe_dashboard_widgets", arguments: { types: ["KPI", "TText"] } })).content as { text: string }[])[0]!.text;
    expect(contracts).toMatch(/^### KPI - /);
    // The page catalog's display widgets (D3): their page props, and the formulas' context.
    expect(contracts).toContain("### TText - ");
    expect(contracts).toContain("A presentation widget");
    expect(dashboards).toMatch(/\{\{row\.<column>\}\} the query's first row/);
    // Generated from the catalog (DM1): each role with its kinds and default, each prop with what unset means.
    expect(contracts).toContain("- roles.value (number · 1 · default: the first matching column)");
    expect(contracts).toContain("- displayFormat (format, unset by default)");
    expect(dashboards).toContain("**% never multiplies**");
    expect(dashboards).toMatch(/^- Indicators: /im);
    expect(await read("totalbase-tables")).toMatch(/\| users \| GET, POST, PATCH, DELETE \|/);
    expect(await read("workflows")).toMatch(/Publishable operation types on this instance: .*totalbase\.read-records/);
    expect(await read("dataviews")).toContain("| KANBAN |");
    expect(await read("widgets")).toContain("## UFormField");
    expect(await read("pages")).toContain("### RESOURCE");
  });

  it("annotates its tools: read-only ones as such, destructive ones as such", async () => {
    const { tools } = await mcp.listTools();
    const byName = new Map(tools.map((t) => [t.name, t.annotations]));
    expect(byName.get("query_records")?.readOnlyHint).toBe(true);
    expect(byName.get("get_openapi")?.readOnlyHint).toBe(true);
    expect(byName.get("suggest_dashboard")?.readOnlyHint).toBe(true);
    expect(byName.get("delete_table")?.destructiveHint).toBe(true);
    expect(byName.get("grant_permission")?.idempotentHint).toBe(true);
  });

  it("creates a schema and related tables, then describes one", async () => {
    await call("create_schema", { name: SCHEMA });
    await call("create_table", {
      schema: SCHEMA,
      name: "customers",
      columns: [
        { name: "id", data_type: "uuid", primary_key: true, default: "gen_random_uuid()" },
        { name: "name", data_type: "text", nullable: false, unique: true },
      ],
      expose_methods: ["GET", "POST", "PATCH", "DELETE"],
    });
    await call("create_table", {
      schema: SCHEMA,
      name: "deals",
      columns: [
        { name: "id", data_type: "uuid", primary_key: true, default: "gen_random_uuid()" },
        { name: "customer", data_type: "uuid", nullable: false, foreign_key: { references_schema: SCHEMA, references_table: "customers" } },
        { name: "stage", data_type: "text", nullable: false },
        { name: "amount", data_type: "numeric(12,2)", nullable: false, check: "amount >= 0" },
      ],
      expose_methods: ["GET", "POST", "PATCH", "DELETE"],
    });
    const deals = await call<{ columns: { name: string }[]; foreignKeys: { column: string; references: string }[]; checks: unknown[]; exposedMethods: string[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(deals.columns.map((c) => c.name)).toEqual(["id", "customer", "stage", "amount"]);
    expect(deals.foreignKeys).toEqual([expect.objectContaining({ column: "customer", references: `${SCHEMA}.customers.id` })]);
    expect(deals.checks).toHaveLength(1);
    expect(deals.exposedMethods).toEqual(["GET", "POST", "PATCH", "DELETE"]);
  });

  // describe_table dropped what a constraint says and a partial index's WHERE.
  it("describes each constraint's message and a partial index's condition", async () => {
    const { unique } = await call<{ unique: { name: string }[] }>("describe_table", { schema: SCHEMA, name: "customers" });
    const { foreignKeys } = await call<{ foreignKeys: { name: string }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    await call("alter_table", { schema: SCHEMA, name: "customers", operations: [{ kind: "set_constraint_message", name: unique[0]!.name, message: "That customer exists" }] });
    await call("alter_table", {
      schema: SCHEMA, name: "deals",
      operations: [
        { kind: "set_constraint_message", name: foreignKeys[0]!.name, message: "Pick a customer" },
        { kind: "create_index", name: "deals_one_won", columns: ["customer"], unique: true, where: "stage = 'WON'" },
      ],
    });
    const customers = await call<{ unique: { message: string | null }[] }>("describe_table", { schema: SCHEMA, name: "customers" });
    expect(customers.unique[0]!.message).toBe("That customer exists");
    const deals = await call<{ foreignKeys: { message: string | null }[]; indexes: { name: string; where?: string }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(deals.foreignKeys[0]!.message).toBe("Pick a customer");
    expect(deals.indexes.find((i) => i.name === "deals_one_won")?.where).toBe("(stage = 'WON'::text)");
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [{ kind: "drop_index", name: "deals_one_won" }], confirm: true });
  });

  it("alters a table in one batch, previews a drop, and refuses one without confirm", async () => {
    // What it applied and the names - not every column's input and widget again.
    const after = await call<{ applied: string[]; columns: string[]; indexes: string[] }>("alter_table", {
      schema: SCHEMA,
      name: "deals",
      operations: [
        { kind: "add_column", column: { name: "closed_at", data_type: "timestamptz" } },
        { kind: "create_index", columns: ["stage"] },
      ],
    });
    expect(after.applied).toEqual(["add_column", "create_index"]);
    expect(after.columns).toContain("closed_at");
    expect(after.indexes.some((i) => i.includes("stage"))).toBe(true);

    const drop = { schema: SCHEMA, name: "deals", operations: [{ kind: "drop_column", column: "closed_at" }] };
    expect(JSON.stringify(await call("alter_table", { ...drop, preview: true }))).toMatch(/DROP COLUMN/i);
    await expect(call("alter_table", drop)).rejects.toThrow(/confirm=true/);
    const kept = await call<{ columns: { name: string }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(kept.columns.map((c) => c.name)).toContain("closed_at");

    // T50: a CHECK's message - with it, or set later on one that exists; describe_table lists it.
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [{ kind: "add_check", name: "deals_amount_positive", expression: "amount >= 0", message: "An amount can't be negative." }] });
    let checks = (await call<{ checks: { name: string; message: string | null }[] }>("describe_table", { schema: SCHEMA, name: "deals" })).checks;
    expect(checks.find((c) => c.name === "deals_amount_positive")?.message).toBe("An amount can't be negative.");
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [{ kind: "set_constraint_message", name: "deals_amount_positive", message: null }] });
    checks = (await call<{ checks: { name: string; message: string | null }[] }>("describe_table", { schema: SCHEMA, name: "deals" })).checks;
    expect(checks.find((c) => c.name === "deals_amount_positive")?.message).toBeNull();
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [{ kind: "drop_constraint", name: "deals_amount_positive" }], confirm: true });
  });

  it("writes records and counts them - PostgreSQL's CHECK still decides", async () => {
    const customers = await call<{ id: string; name: string }[]>("write_records", { schema: SCHEMA, name: "customers", operation: "create", data: [{ name: "Acme" }, { name: "Globex" }] });
    const acme = customers.find((c) => c.name === "Acme")!;
    await call("write_records", {
      schema: SCHEMA,
      name: "deals",
      operation: "create",
      data: [
        { customer: acme.id, stage: "LEAD", amount: 1000 },
        { customer: acme.id, stage: "WON", amount: 2500 },
        { customer: customers[1]!.id, stage: "WON", amount: 500 },
      ],
    });
    await expect(call("write_records", { schema: SCHEMA, name: "deals", operation: "create", data: { customer: acme.id, stage: "LEAD", amount: -1 } })).rejects.toThrow(/CHECK_VIOLATION/);
    const won = await call<{ rows: unknown[]; count: number }>("query_records", { schema: SCHEMA, name: "deals", where: { stage: { _eq: "WON" } }, fields: "amount,customer.name", count: true });
    expect(won.count).toBe(2);
    expect(won.rows).toHaveLength(2);
  });

  it("builds a dashboard: a query tried, widgets saved and run, variables, published for a role", async () => {
    const dashboard = await call<{ id: string; slug: string }>("create_dashboard", { name: `Ventas ${SUFFIX}`, description: "Pipeline" });
    created.dashboards.push(dashboard.id);

    // No ::float: numeric aggregates come back as numbers.
    const sql = `SELECT stage, sum(amount) AS total FROM "${SCHEMA}".deals GROUP BY stage ORDER BY stage`;
    const preview = await call<{ columns: string[]; rows: { stage: string; total: number }[] }>("preview_query", { dashboard_id: dashboard.id, query: sql });
    // The dashboard assistant (D27) reads the table and proposes, applying nothing.
    const suggestion = await call<{ analysis: { column: string; role: string }[]; spec: { widgets: unknown[] } }>("suggest_dashboard", { schema: SCHEMA, name: "deals" });
    expect(suggestion.analysis.find((a) => a.column === "customer")?.role).toBe("dimension");
    expect(suggestion.spec.widgets.length).toBeGreaterThan(0);
    expect(preview.rows).toEqual([{ stage: "LEAD", total: 1000 }, { stage: "WON", total: 3000 }]);

    const bar = await call<{ widget: { id: string; grid: { y: number; w: number } }; run: { rows: unknown[] } }>("save_widget", { dashboard_id: dashboard.id, type: "BAR", label: "By stage", query: sql });
    expect(bar.widget.grid).toMatchObject({ y: 0, w: 6 });
    expect(bar.run.rows).toHaveLength(2);

    // Saved, but its query fails: the answer says so instead of a widget that silently draws nothing.
    const broken = await call<{ widget: { id: string; grid: { y: number } }; run: { error: string } }>("save_widget", { dashboard_id: dashboard.id, type: "KPI", label: "Broken", query: `SELECT nope FROM "${SCHEMA}".deals` });
    expect(broken.widget.grid.y).toBe(4);
    expect(broken.run.error).toMatch(/nope/);
    const fixed = await call<{ run: { rows: { total: number }[] } }>("save_widget", { dashboard_id: dashboard.id, widget_id: broken.widget.id, query: `SELECT sum(amount) AS total FROM "${SCHEMA}".deals`, config: { roles: { value: "total" }, displayFormat: "$ #,##0" } });
    expect(fixed.run.rows).toEqual([{ total: 4000 }]);
    // A role given a column the query doesn't return: refused, naming the role and what the query returns (D1).
    await expect(call("save_widget", { dashboard_id: dashboard.id, widget_id: broken.widget.id, config: { roles: { value: "no_existe" } } }))
      .rejects.toThrow(/KPI's Value: the query returns no column "no_existe" - it returns total \(numeric\)/);
    // Created all or nothing (DB7): a refused config leaves no widget behind - a retrying agent piles up none.
    const before = (await call<{ spec: { widgets: unknown[] } }>("get_dashboard", { id: dashboard.id })).spec.widgets.length;
    await expect(call("save_widget", { dashboard_id: dashboard.id, type: "KPI", query: "SELECT 1 AS a", config: { roles: { value: "no_existe" } } })).rejects.toThrow(/no_existe/);
    // Smaller than its type allows (DB11).
    await expect(call("save_widget", { dashboard_id: dashboard.id, type: "KPI", query: "SELECT 1 AS a", grid: { x: 0, y: 20, w: 1, h: 1 } })).rejects.toThrow(/KPI is at least 2x2 on the canvas - got 1x1/);
    expect((await call<{ spec: { widgets: unknown[] } }>("get_dashboard", { id: dashboard.id })).spec.widgets).toHaveLength(before);
    // An argument a tool doesn't take is refused, naming it (DM5).
    await expect(call("save_widget", { dashboard_id: dashboard.id, widget_id: broken.widget.id, tabs: "x" })).rejects.toThrow(/save_widget has no argument tabs; it takes: dashboard_id, widget_id/);
    // A nested key it doesn't take, with its path (DB20); prefix is gone (D4).
    await expect(call("save_widget", { dashboard_id: dashboard.id, widget_id: bar.widget.id, config: { series: { total: { colour: "blue" } } } }))
      .rejects.toThrow(/Bar chart's series.total has no "colour" - it takes: label, color, type, axis, displayFormat/);
    await expect(call("save_widget", { dashboard_id: dashboard.id, widget_id: broken.widget.id, config: { prefix: "$" } })).rejects.toThrow(/KPI has no prop "prefix"/);
    // Tabs (D7): a widget on one, a tab with widgets kept.
    await call("update_dashboard", { id: dashboard.id, tabs: [{ value: "general", label: "General" }, { value: "detalle", label: "Detalle" }] });
    const onTab = await call<{ widget: { tab: string; grid: { y: number } } }>("save_widget", { dashboard_id: dashboard.id, type: "TText", tab: "detalle" });
    expect(onTab.widget).toMatchObject({ tab: "detalle", grid: { y: 0 } });
    await expect(call("update_dashboard", { id: dashboard.id, tabs: [{ value: "general", label: "General" }] })).rejects.toThrow(/DASHBOARD_TAB_NOT_EMPTY/);
    await call("delete_widget", { dashboard_id: dashboard.id, widget_id: (onTab.widget as unknown as { id: string }).id, confirm: true });
    await call("update_dashboard", { id: dashboard.id, tabs: [] });

    await call("update_dashboard", { id: dashboard.id, variables: [{ name: "stage", label: "Stage", type: "SELECT", options: { source: "STATIC", values: ["LEAD", "WON"] } }] });
    const filtered = await call<{ rows: unknown[] }>("preview_query", { dashboard_id: dashboard.id, query: `SELECT * FROM "${SCHEMA}".deals WHERE ($VAR.stage IS NULL OR stage = $VAR.stage)`, variables: { stage: "LEAD" } });
    expect(filtered.rows).toHaveLength(1);

    await expect(call("delete_widget", { dashboard_id: dashboard.id, widget_id: bar.widget.id })).rejects.toThrow();
    const full = await call<{ spec: { widgets: unknown[]; variables: unknown[] }; hasUnpublishedChanges: boolean }>("get_dashboard", { id: dashboard.id });
    expect(full.spec.widgets).toHaveLength(2);
    expect(full.spec.variables).toHaveLength(1);

    const published = await call<{ version: number }>("publish_dashboard", { id: dashboard.id, role_ids: [roleId] });
    expect(published.version).toBe(1);
    const listed = (await call<{ id: string; liveVersion: number | null; hasUnpublishedChanges: boolean }[]>("list_dashboards")).find((d) => d.id === dashboard.id);
    expect(listed).toMatchObject({ liveVersion: 1, hasUnpublishedChanges: false });
    expect(await context.dashboardsAdmin.listRoles(dashboard.id)).toEqual([roleId]);

    // Embeds by MCP (DM7): created, changed, listed, revoked - the same checks as Share.
    await call("update_dashboard", { id: dashboard.id, embedding_enabled: true });
    await expect(call("create_embed", { dashboard_id: dashboard.id, name: "Web", type: "LINK", variables: { stage: { mode: "LOCKED" } } })).rejects.toThrow(/DASHBOARD_EMBED_INVALID/);
    const embed = await call<{ id: string; link: string }>("create_embed", { dashboard_id: dashboard.id, name: "Web", type: "LINK", variables: { stage: { mode: "LOCKED", value: "WON" } } });
    expect(embed.link).toMatch(/^tbe_/);
    const changed = await call<{ display: { allowExport?: boolean } }>("update_embed", { dashboard_id: dashboard.id, embed_id: embed.id, display: { allowExport: true } });
    expect(changed.display.allowExport).toBe(true);
    expect((await call<{ id: string }[]>("list_embeds", { dashboard_id: dashboard.id })).map((e) => e.id)).toEqual([embed.id]);
    await call("revoke_embed", { dashboard_id: dashboard.id, embed_id: embed.id, confirm: true });
    expect((await call<{ revokedAt: string | null }[]>("list_embeds", { dashboard_id: dashboard.id }))[0]!.revokedAt).not.toBeNull();
  });

  it("creates a DataView over a table and publishes it for a role", async () => {
    const dataview = await call<{ id: string; viewType: string; source: string; liveVersion: number | null }>("create_dataview", { name: `Deals ${SUFFIX}`, view_type: "TABLE", schema: SCHEMA, table: "deals", columns: ["stage", "amount", "customer"] });
    created.dataviews.push(dataview.id);
    expect(dataview).toMatchObject({ viewType: "TABLE", source: `${SCHEMA}.deals`, liveVersion: null });
    const published = await call<{ version: number }>("publish_dataview", { id: dataview.id, role_ids: [roleId] });
    expect(published.version).toBe(1);
    expect((await call<{ id: string; liveVersion: number }[]>("list_dataviews")).find((v) => v.id === dataview.id)?.liveVersion).toBe(1);

    // A customer with its deals entered together.
    await expect(call("create_dataview", { name: `Customer ${SUFFIX}`, view_type: "MASTER_DETAIL", schema: SCHEMA, table: "customers" })).rejects.toThrow(/detail/);
    const master = await call<{ id: string; viewType: string }>("create_dataview", {
      name: `Customer ${SUFFIX}`, view_type: "MASTER_DETAIL", schema: SCHEMA, table: "customers", detail: { table: "deals", fk_column: "customer" },
    });
    created.dataviews.push(master.id);
    expect(master.viewType).toBe("MASTER_DETAIL");
  });

  it("finds a re-created table by its live resource, not the dropped one of the same name", async () => {
    const scratch = { schema: SCHEMA, name: "scratch", columns: [{ name: "id", data_type: "uuid", primary_key: true, default: "gen_random_uuid()" }] };
    await call("create_table", scratch);
    await call("delete_table", { schema: SCHEMA, name: "scratch", confirm: true });
    await call("create_table", scratch);
    const exposed = await call<{ exposedMethods: string[] }>("expose_resource", { schema: SCHEMA, name: "scratch", expose_methods: ["GET"] });
    expect(exposed.exposedMethods).toEqual(["GET"]);
  });

  // "Resource not found" for a table create_table had just answered sent an agent after a typo.
  it("says a write's method isn't exposed, and that files are written by id", async () => {
    await expect(call("write_records", { schema: SCHEMA, name: "scratch", operation: "create", data: {} })).rejects.toThrow(
      `METHOD_NOT_EXPOSED: ${SCHEMA}.scratch exists but is exposed for GET only - expose POST with expose_resource`,
    );
    await expect(call("write_records", { schema: SCHEMA, name: "no_such_table", operation: "create", data: {} })).rejects.toThrow(/RESOURCE_NOT_FOUND/);
    await expect(call("write_records", { schema: "totalbase", name: "files", operation: "delete", where: { id: { _nnull: true } }, confirm: true })).rejects.toThrow(
      /Files are deleted one at a time, by id/,
    );
  });

  it("presents a table: column labels and value colors, a row by its name", async () => {
    await call("set_row_presentation", { schema: SCHEMA, name: "customers", display_field: "name" });
    await call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "stage", presentation: { label: "Stage", options: { WON: { label: "Won", color: "success" } } } });
    const deals = await call<{ columns: { name: string; presentation?: { label?: string } }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(deals.columns.find((c) => c.name === "stage")?.presentation?.label).toBe("Stage");
    const customers = await call<{ rowPresentation?: { displayField?: string } }>("describe_table", { schema: SCHEMA, name: "customers" });
    expect(customers.rowPresentation?.displayField).toBe("name");
    // Every column of a table in one call (M17).
    const many = await call<{ columns: string[] }>("set_column_presentations", { schema: SCHEMA, name: "deals", columns: { amount: { label: "Amount", displayFormat: "#,##0.00" }, closed_at: { label: "Closed" } } });
    // The columns written, not 24 tables' presentations echoed back.
    expect(many.columns).toEqual(["amount", "closed_at"]);
    // A short label, merged (M21): kept, and described.
    const short = await call<{ presentation: Record<string, unknown> }>("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { shortLabel: "Amt." }, merge: true });
    expect(short.presentation).toEqual({ label: "Amount", displayFormat: "#,##0.00", shortLabel: "Amt." });
    const described = await call<{ columns: { name: string; presentation?: { shortLabel?: string } }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(described.columns.find((c) => c.name === "amount")?.presentation?.shortLabel).toBe("Amt.");
    // A key it doesn't know is refused, naming the valid ones - never dropped in silence.
    await expect(call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { short_label: "x" }, merge: true }))
      .rejects.toThrow(/Unknown option "short_label" - one of: label, shortLabel,/);
    await expect(call("set_column_presentations", { schema: SCHEMA, name: "deals", columns: { amount: { shortLabel: "x".repeat(33) } } })).rejects.toThrow();
    // Several columns merged (M22): only the keys given change - a null unsets one.
    const merged = await call<{ columns: { column: string; presentation: Record<string, unknown> }[] }>("set_column_presentations", {
      schema: SCHEMA, name: "deals", columns: { amount: { shortLabel: "Amt.", displayFormat: null }, closed_at: { shortLabel: "Cl." } }, merge: true,
    });
    expect(merged.columns.find((c) => c.column === "amount")?.presentation).toEqual({ label: "Amount", shortLabel: "Amt." });
    expect(merged.columns.find((c) => c.column === "closed_at")?.presentation).toEqual({ label: "Closed", shortLabel: "Cl." });
    await expect(call("set_column_presentations", { schema: SCHEMA, name: "deals", columns: {}, merged: true }))
      .rejects.toThrow(/set_column_presentations has no argument merged; it takes: schema, name, columns, merge/);
    // A condition's filter takes a JSON number like every stored filter.
    const conditioned = await call<{ presentation: { conditions: { where: unknown }[] } }>("set_column_presentation", {
      schema: SCHEMA, name: "deals", column: "amount", presentation: { conditions: [{ name: "Big", where: { amount: { _gt: 1000 } }, style: { bold: true } }] }, merge: true,
    });
    expect(conditioned.presentation.conditions[0]!.where).toEqual({ amount: { _gt: "1000" } });
  });

  it("edits a column with its column's input in every form, until a form picks its own (M24, M23)", async () => {
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [
      { kind: "add_column", column: { name: "month", data_type: "integer" } },
      { kind: "add_check", name: "deals_month_range", expression: "month >= 1 AND month <= 12" },
    ] });
    const form = await call<{ id: string }>("create_dataview", { name: `Deal form ${SUFFIX}`, view_type: "FORM", schema: SCHEMA, table: "deals" });
    created.dataviews.push(form.id);
    type Field = { id: string; kind: string; widget?: string; config?: { props?: { column?: string }; fromColumn?: boolean; slot?: string } };
    const inputOf = async (column: string) => {
      const { fields } = await call<{ fields: Field[] }>("get_dataview", { id: form.id, detail: true });
      const field = fields.find((f) => f.widget === "UFormField" && f.config?.props?.column === column)!;
      const raw = await context.dataviewsAdmin.listFields(form.id);
      const input = raw.find((f) => f.parent === field.id)!;
      return { widget: input.widget, fromColumn: input.config.fromColumn === true };
    };
    // By type and CHECKs: an amount a plain number input, a month (1..12) − and +.
    expect(await inputOf("amount")).toEqual({ widget: "UInput", fromColumn: true });
    expect(await inputOf("month")).toEqual({ widget: "UInputNumber", fromColumn: true });
    // describe_table and get_dataview say so (M26).
    const described = await call<{ columns: { name: string; input: string; widget: string; inputReason: string }[] }>("describe_table", { schema: SCHEMA, name: "deals" });
    expect(described.columns.find((c) => c.name === "amount")).toMatchObject({ input: "number-field", widget: "UInput", inputReason: "number" });
    expect(described.columns.find((c) => c.name === "month")).toMatchObject({ input: "number-stepper", widget: "UInputNumber", inputReason: "small-range" });
    const shown = await call<{ fields: { column?: string; formInput?: string; formInputFollowsColumn?: boolean }[] }>("get_dataview", { id: form.id });
    expect(shown.fields.find((f) => f.column === "amount")).toMatchObject({ formInput: "UInput", formInputFollowsColumn: true });
    const suggested = await call<{ columns: { columnName: string; suggestions: { key: string; value: unknown; reason: string; detail?: string }[] }[] }>("suggest_presentation", { schema: SCHEMA, name: "deals" });
    // No input is suggested: Automatic already gives the rule's (§15.2).
    expect(suggested.columns.flatMap((c) => c.suggestions).filter((s) => s.key === "input")).toEqual([]);
    // describe_table says which control an Input is.
    expect(described.columns.find((c) => c.name === "amount")).toMatchObject({ widgetProps: { type: "text" } });

    // Set on the column: every form that follows it changes.
    await call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { input: "slider" }, merge: true });
    expect(await inputOf("amount")).toEqual({ widget: "USlider", fromColumn: true });
    await expect(call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { input: "switch" }, merge: true }))
      .rejects.toThrow(/Input "switch" doesn't edit a number column - one of: number-field, number-stepper/);

    // A form's own input (M23): the form changes too, and stops following the column - until null.
    await call("update_dataview", { id: form.id, fields: [{ column: "amount", widget: "UInputNumber" }] });
    expect(await inputOf("amount")).toEqual({ widget: "UInputNumber", fromColumn: false });
    await call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { input: null }, merge: true });
    expect((await inputOf("amount")).widget).toBe("UInputNumber");
    await call("update_dataview", { id: form.id, fields: [{ column: "amount", widget: null }] });
    expect(await inputOf("amount")).toEqual({ widget: "UInput", fromColumn: true });
    await expect(call("update_dataview", { id: form.id, fields: [{ column: "amount", widget: "USwitch" }] })).rejects.toThrow(/doesn't edit "amount"/);
    await call("alter_table", { schema: SCHEMA, name: "deals", operations: [{ kind: "drop_column", column: "month" }], confirm: true });
  });

  it("aggregates, nests a child row and upserts - through the Data API", async () => {
    const totals = await call<{ stage: string; total: number }[]>("query_records", {
      schema: SCHEMA, name: "deals", aggregates: [{ fn: "sum", field: "amount", alias: "total" }], group_by: "stage", order_by: "stage",
    });
    expect(totals.map((t) => [t.stage, Number(t.total)])).toEqual([["LEAD", 1000], ["WON", 3000]]);

    const nested = await call<{ id: string; $deals: { id: string; customer: string }[] }>("write_records", {
      schema: SCHEMA, name: "customers", operation: "create", data: { name: "Initech", $deals: [{ stage: "LEAD", amount: 10 }] },
    });
    expect(nested.$deals[0]!.customer).toBe(nested.id);

    const upserted = await call<{ id: string }>("write_records", {
      schema: SCHEMA, name: "customers", operation: "create", data: { name: "Initech" }, on_conflict: { target: ["name"], action: "UPDATE", data: { name: "$INSERT.name" } },
    });
    expect(upserted.id).toBe(nested.id);
    // A delete answers what went, not every column of every row.
    const dealsGone = await call<{ deleted: number; ids: string[] }>("write_records", { schema: SCHEMA, name: "deals", operation: "delete", where: { customer: { _eq: nested.id } }, confirm: true });
    expect(dealsGone).toEqual({ deleted: 1, ids: [nested.$deals[0]!.id] });
    expect(await call("write_records", { schema: SCHEMA, name: "customers", operation: "delete", id: nested.id, confirm: true })).toEqual({ deleted: 1, ids: [nested.id] });
  });

  it("fills an owner column from the writer, as the modeling guide says", async () => {
    await call("create_table", {
      schema: SCHEMA,
      name: "notes",
      columns: [
        { name: "id", data_type: "uuid", primary_key: true, default: "gen_random_uuid()" },
        { name: "body", data_type: "text", nullable: false },
        { name: "owner", data_type: "uuid", default: "NULLIF(current_setting('totalbase.actor_user_id', true), '')::uuid", foreign_key: { references_schema: "totalbase", references_table: "users", on_delete: "SET NULL" } },
      ],
      expose_methods: ["GET", "POST", "PATCH", "DELETE"],
    });
    const note = await call<{ owner: string }>("write_records", { schema: SCHEMA, name: "notes", operation: "create", data: { body: "hello" } });
    expect(note.owner).toBe(ownerId);
  });

  // A role granted "CRUD" wrote its own key or reassigned its rows to someone else.
  it("leaves what the database fills out of a write grant's every field, and says so", async () => {
    const create = await call<{ fields: string[]; warnings?: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "notes", action: "CREATE" });
    expect(create.fields).toEqual(["body"]);
    expect(create.warnings?.[0]).toContain("id, owner");
    const update = await call<{ fields: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "notes", action: "UPDATE", fields: "all" });
    expect(update.fields).toEqual(["body"]);
    const named = await call<{ fields: string[]; warnings?: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "notes", action: "UPDATE", fields: ["body", "owner"] });
    expect(named.fields.sort()).toEqual(["body", "owner"]);
    expect(named).not.toHaveProperty("warnings");
    expect((await call<{ fields: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "notes", action: "READ" })).fields).toContain("owner");
    for (const action of ["CREATE", "UPDATE", "READ"]) await call("revoke_permission", { role_id: roleId, schema: SCHEMA, name: "notes", action, confirm: true });
  });

  it("grants with every column by default, a row filter and denied fields - and a user of the role reads exactly that", async () => {
    // A grant without fields used to allow no column at all: there is no wildcard (Security.md §6.4).
    const granted = await call<{ fields: string[]; where: unknown }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "deals", action: "READ", where: { stage: { _eq: "WON" } } });
    // READ "every field" names the path its reference column shows a customer by too (B44, Security.md §6.10).
    expect(granted.fields.sort()).toEqual(["amount", "closed_at", "customer", "customer.name", "id", "stage"]);
    expect(granted).not.toHaveProperty("warnings");
    expect(granted.where).toEqual({ stage: { _eq: "WON" } });

    const user = await call<{ id: string; status: string; roles: string[] }>("create_user", { email: `mcp-reader-${SUFFIX}@example.com`, name: "Reader", password: PASSWORD, role_ids: [roleId] });
    created.users.push(user.id);
    expect(user).toMatchObject({ status: "ACTIVE", roles: [roleId] });
    const { token } = await context.auth.login({ email: `mcp-reader-${SUFFIX}@example.com`, password: PASSWORD });
    const read = async () => app.inject({ method: "GET", url: `/api/${SCHEMA}/table/deals`, headers: { authorization: `Bearer ${token}` } });
    const rows = (await read()).json().data as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r["stage"] === "WON" && "amount" in r)).toBe(true);

    const narrowed = await call<{ fields: string[]; deniedFields: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "deals", action: "READ", where: { stage: { _eq: "WON" } }, deny_fields: ["amount"] });
    expect(narrowed.deniedFields).toEqual(["amount"]);
    expect(narrowed.fields).toContain("stage");
    expect(((await read()).json().data as Record<string, unknown>[]).some((r) => "amount" in r)).toBe(false);

    const permissions = await call<{ resource: string; actions: { READ?: { decision: string; fields: string[]; rowFilters: unknown[] } } }[]>("get_permissions", { role_id: roleId, schema: SCHEMA });
    const deals = permissions.find((p) => p.resource === `${SCHEMA}.deals`)!;
    expect(deals.actions.READ).toMatchObject({ decision: "ALLOW", rowFilters: [expect.objectContaining({ where: { stage: { _eq: "WON" } } })] });
    expect(deals.actions.READ!.fields).not.toContain("amount");

    // M19: a READ naming its fields without the reference's path says the App would show the key.
    const keysOnly = await call<{ warnings?: string[] }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "deals", action: "READ", fields: ["id", "stage", "customer"] });
    expect(keysOnly.warnings?.[0]).toContain("customer.name");

    await call("revoke_permission", { role_id: roleId, schema: SCHEMA, name: "deals", action: "READ", confirm: true });
    expect((await call<{ resource: string }[]>("get_permissions", { role_id: roleId, schema: SCHEMA })).map((p) => p.resource)).not.toContain(`${SCHEMA}.deals`);
    expect((await read()).statusCode).toBe(403);
  });

  it("invites a user without a password and replaces their roles", async () => {
    const invited = await call<{ id: string; status: string; invitation: { delivered: boolean; actionUrl: string } }>("create_user", { email: `mcp-invited-${SUFFIX}@example.com`, invite: "link" });
    created.users.push(invited.id);
    expect(invited.status).toBe("INVITED");
    expect(invited.invitation).toMatchObject({ delivered: false, actionUrl: expect.stringMatching(/^https?:\/\//) });
    await call("set_user_roles", { user_id: invited.id, role_ids: [roleId] });
    expect((await call<{ id: string; roles: string[] }[]>("list_users", { role_id: roleId })).map((u) => u.id)).toContain(invited.id);
  });

  it("reads, changes and deletes a DataView - and says which of its roles can't read the source", async () => {
    const id = created.dataviews[0]!;
    const before = await call<{ roles: { role: string; read: string }[]; fields: { column?: string; kind: string; config?: unknown }[] }>("get_dataview", { id });
    // Its columns, not the generated form's widget tree with its bindings.
    expect(before.fields.every((f) => f.column && f.kind !== "WIDGET" && f.config === undefined)).toBe(true);
    expect((await call<{ fields: { kind: string }[] }>("get_dataview", { id, detail: true })).fields.some((f) => f.kind === "WIDGET")).toBe(true);
    expect(before.roles).toEqual([expect.objectContaining({ role: roleId, read: "UNDEFINED" })]);
    const updated = await call<{ viewConfig: Record<string, unknown>; fields: { column: string; label: string; visible: boolean }[] }>("update_dataview", {
      id, view_config: { auto_refresh: "1m" }, fields: [{ column: "amount", visible: false }],
    });
    expect(updated.viewConfig["auto_refresh"]).toBe("1m");
    // Its title and short label: its table column's (M21).
    expect(updated.fields).toEqual([expect.objectContaining({ column: "amount", visible: false, title: "Amount", shortLabel: "Amt." })]);
    expect((await call<{ hasUnpublishedChanges: boolean }>("get_dataview", { id })).hasUnpublishedChanges).toBe(true);

    // Its grid cell (DataViews.md §4.3): set, shown by get_dataview, unset with null, refused out of range.
    await call("update_dataview", { id, fields: [{ column: "amount", textWrap: "wrap", maxLines: 2, verticalAlign: "top", width: 140 }] });
    const cellOf = async () => (await call<{ fields: { column?: string; cell?: Record<string, unknown> }[] }>("get_dataview", { id })).fields.find((f) => f.column === "amount")?.cell;
    expect(await cellOf()).toEqual({ textWrap: "wrap", maxLines: 2, verticalAlign: "top", width: 140 });
    await call("update_dataview", { id, fields: [{ column: "amount", textWrap: null, maxLines: null, width: null }] });
    expect(await cellOf()).toEqual({ verticalAlign: "top" });
    await expect(call("update_dataview", { id, fields: [{ column: "amount", minWidth: 300, maxWidth: 200 }] })).rejects.toThrow(/minWidth/);

    const scratch = await call<{ id: string }>("create_dataview", { name: `Scratch ${SUFFIX}`, view_type: "FORM", schema: SCHEMA, table: "customers" });
    await call("delete_dataview", { id: scratch.id, confirm: true });
    expect((await call<{ id: string }[]>("list_dataviews")).map((v) => v.id)).not.toContain(scratch.id);
  });

  it("deletes a dashboard", async () => {
    const dashboard = await call<{ id: string }>("create_dashboard", { name: `Scratch ${SUFFIX}` });
    created.dashboards.push(dashboard.id);
    await call("delete_dashboard", { id: dashboard.id, confirm: true });
    expect((await call<{ id: string }[]>("list_dashboards")).map((d) => d.id)).not.toContain(dashboard.id);

    // Several in one call - clearing an instance took one call each.
    const two = [await call<{ id: string }>("create_dashboard", { name: `Scratch A ${SUFFIX}` }), await call<{ id: string }>("create_dashboard", { name: `Scratch B ${SUFFIX}` })].map((d) => d.id);
    created.dashboards.push(...two);
    expect(await call("delete_dashboard", { ids: two, confirm: true })).toEqual({ deleted: two });
    expect((await call<{ id: string }[]>("list_dashboards")).map((d) => d.id)).not.toEqual(expect.arrayContaining([two[0]]));
    await expect(call("delete_dashboard", { ids: [two[0]], confirm: true })).rejects.toThrow();
  });

  it("builds a workflow by step keys: saved, test-run, published enabled for a role, run in production", async () => {
    const deals = (await call<{ id: string; name: string }[]>("list_resources", { schema: SCHEMA, type: "TABLE" })).find((r) => r.name === "deals")!;
    const workflow = await call<{ id: string; revision: string; definition: { operations: { id: string; key: string }[] } }>("create_workflow", { name: `Won ${SUFFIX}` });
    created.workflows.push(workflow.id);
    const start = workflow.definition.operations.find((op) => op.key === "start")!;
    const saved = await call<{ revision: string; definition: { operations: unknown[]; connections: { source: string }[] } }>("save_workflow", {
      id: workflow.id,
      revision: workflow.revision,
      operations: [
        { id: start.id, type: "totalbase.start", key: "start", configuration: { trigger: "MANUAL" } },
        { type: "totalbase.read-records", key: "won", configuration: { resource: deals.id, query: { where: { stage: { _eq: "WON" } } } } },
        { type: "totalbase.finish-result", key: "done", configuration: { result: "{{won.data}}" } },
      ],
      connections: [{ source: "start", output: "next", target: "won" }, { source: "won", output: "next", target: "done" }],
    });
    expect(saved.definition.operations).toHaveLength(3);
    expect(saved.definition.connections[0]!.source).toBe(start.id);
    await expect(call("save_workflow", { id: workflow.id, revision: workflow.revision, operations: [{ id: start.id, type: "totalbase.start", key: "start" }] })).rejects.toThrow(/WORKFLOW_REVISION_CONFLICT/);

    const test = await call<{ status: string; steps: { step: string; status: string }[] }>("run_workflow", { id: workflow.id, mode: "test" });
    expect(test.status).toBe("SUCCEEDED");
    expect(test.steps.map((s) => s.step)).toEqual(["start", "won", "done"]);

    const published = await call<{ enabled: boolean; liveVersion: number; roleIds: string[] }>("publish_workflow", { id: workflow.id, revision: saved.revision, enabled: true, role_ids: [roleId] });
    expect(published).toMatchObject({ enabled: true, liveVersion: 1, roleIds: [roleId] });
    const production = await call<{ run: string; status: string; mode: string }>("run_workflow", { id: workflow.id, mode: "production" });
    expect(production).toMatchObject({ status: "SUCCEEDED", mode: "PRODUCTION" });
    expect((await call<{ run: string }[]>("get_workflow_runs", { id: workflow.id })).map((r) => r.run)).toContain(production.run);
    expect((await call<{ steps: unknown[] }>("get_workflow_runs", { run_id: production.run })).steps).toHaveLength(3);
  });

  // A test run answered a PDF's whole base64 and every row of every step.
  it("answers a run's long texts by their size and long lists by their first rows, unless full", async () => {
    const workflow = await call<{ id: string; revision: string; definition: { operations: { id: string; key: string }[] } }>("create_workflow", { name: `Big ${SUFFIX}` });
    created.workflows.push(workflow.id);
    const start = workflow.definition.operations.find((op) => op.key === "start")!;
    await call("save_workflow", {
      id: workflow.id,
      revision: workflow.revision,
      operations: [
        { id: start.id, type: "totalbase.start", key: "start", configuration: { trigger: "MANUAL" } },
        { type: "totalbase.execute-javascript", key: "big", configuration: { code: "return { pdf: 'QUJD'.repeat(500), rows: Array.from({ length: 15 }, (_, i) => i) };" } },
      ],
      connections: [{ source: "start", output: "next", target: "big" }],
    });
    type Run = { steps: { step: string; result?: { data: { pdf: string; rows: unknown[] } } }[] };
    const big = (run: Run) => run.steps.find((s) => s.step === "big")!.result!.data;
    const compacted = big(await call<Run>("run_workflow", { id: workflow.id, mode: "test" }));
    expect(compacted.pdf).toBe("<base64, 2,000 characters - full: true for all of it>");
    expect(compacted.rows).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, "<5 more - full: true for all of them>"]);
    const whole = big(await call<Run>("run_workflow", { id: workflow.id, mode: "test", full: true }));
    expect(whole.pdf).toHaveLength(2000);
    expect(whole.rows).toHaveLength(15);
  });

  it("answers the OpenAPI documents: an index, a filtered operation with its schemas, a role's view", async () => {
    const admin = await call<{ operations: number; index: string[] }>("get_openapi", { api: "admin" });
    expect(admin.index.some((l) => l.startsWith("GET /admin/api/dataviews "))).toBe(true);
    const put = await call<{ paths: { method: string; path: string }[]; schemas: Record<string, unknown> }>("get_openapi", { api: "admin", path: "/admin/api/roles/{role}/resources/{resource}/permissions/{action}", method: "PUT" });
    expect(put.paths).toEqual([expect.objectContaining({ method: "PUT" })]);
    expect(Object.keys(put.schemas)).toContain("Permission");

    const data = await call<{ index: string[] }>("get_openapi", { api: "data" });
    expect(data.index.some((l) => l.includes(`/api/${SCHEMA}/table/deals`))).toBe(true);
    // The role holds nothing on deals any more: its document leaves it out.
    const asRole = await call<{ index: string[] }>("get_openapi", { api: "data", role_id: roleId });
    expect(asRole.index.some((l) => l.includes(`/api/${SCHEMA}/table/deals`))).toBe(false);
  });

  it("reads settings and who it is", async () => {
    const api = await call<Record<string, unknown>>("get_settings", { group: "api" });
    expect(api).toHaveProperty("api.max_filter_depth");
    expect(await call<{ id: string }>("whoami")).toMatchObject({ id: ownerId });
  });

  it("runs SQL only once an administrator allowed API tokens - and the token can't allow itself", async () => {
    await context.settings.reset("sql_console.token_access");
    const view = `CREATE VIEW "${SCHEMA}".won_deals AS SELECT * FROM "${SCHEMA}".deals WHERE stage = 'WON'`;
    await expect(call("execute_sql", { sql: view })).rejects.toThrow(/SQL_CONSOLE_DISABLED/);

    // Neither through the settings route nor as a settings row.
    const asToken = (method: "PATCH" | "DELETE", url: string, payload?: Record<string, unknown>) =>
      app.inject({ method, url, ...(payload && { payload }), headers: { authorization: `Bearer ${agentToken}` } });
    for (const response of [
      await asToken("PATCH", "/admin/api/settings/sql_console", { data: { token_access: true } }),
      await asToken("PATCH", "/admin/api/settings/sql_console", { data: { "sql_console.token_access": true } }),
      await asToken("DELETE", "/admin/api/settings/sql_console/token_access"),
    ]) expect([response.statusCode, response.json().errors[0].code]).toEqual([403, "PERMISSION_DENIED"]);
    const settingsResource = (await database.query<{ id: string; exposed_methods: string[] }>(
      `SELECT id, exposed_methods FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = 'settings' AND status = 'ACTIVE'`,
    )).rows[0]!;
    await database.query(`UPDATE totalbase.resources SET exposed_methods = '{GET,POST,PATCH,DELETE}' WHERE id = $1`, [settingsResource.id]);
    try {
      await expect(call("write_records", { schema: "totalbase", name: "settings", operation: "create", data: { key: "sql_console.token_access", value: true } })).rejects.toThrow(/Admin API/);
    } finally {
      await database.query(`UPDATE totalbase.resources SET exposed_methods = $2 WHERE id = $1`, [settingsResource.id, settingsResource.exposed_methods]);
    }
    expect(await context.settings.get("sql_console.token_access")).toBe(false);
    // The token may still change other settings.
    expect((await asToken("PATCH", "/admin/api/settings/sql_console", { data: { max_rows: 1000 } })).statusCode).toBe(200);

    await context.settings.set("sql_console.token_access", true);
    const executed = await call<{ status: string }>("execute_sql", { sql: view });
    expect(executed.status).toBe("EXECUTED");
    const resources = await call<{ name: string; type: string }[]>("list_resources", { schema: SCHEMA, type: "VIEW" });
    expect(resources.map((r) => r.name)).toContain("won_deals");
    const { rows } = await database.query(`SELECT 1 FROM totalbase.logs WHERE action = 'SQL_EXECUTE' AND sql_text = $1`, [view]);
    expect(rows).toHaveLength(1);

    const plan = await call<{ plan: unknown[] }>("explain_sql", { sql: `SELECT * FROM "${SCHEMA}".won_deals` });
    expect(plan.plan.length).toBeGreaterThan(0);
    await call("execute_sql", { sql: `CREATE FUNCTION "${SCHEMA}".double_it(n integer) RETURNS integer LANGUAGE sql AS 'SELECT n * 2'` });
    await expect(call("call_function", { schema: SCHEMA, name: "double_it", arguments: { n: 21 } })).rejects.toThrow(/RESOURCE_NOT_FOUND/);
    await call("expose_resource", { schema: SCHEMA, name: "double_it", expose_methods: ["POST"] });
    expect(await call("call_function", { schema: SCHEMA, name: "double_it", arguments: { n: 21 } })).toBe(42);

    await expect(call("execute_sql", { sql: `DROP VIEW "${SCHEMA}".won_deals` })).rejects.toThrow(/confirm=true/);
    expect((await call<{ status: string }>("execute_sql", { sql: `DROP VIEW "${SCHEMA}".won_deals`, confirm: true })).status).toBe("EXECUTED");
  });

  it("builds a CUSTOM registration page: a scanned code checked by a function, form fields over the record, code, published", async () => {
    // Runs after the SQL test: sql_console.token_access is on.
    await call("create_table", {
      schema: SCHEMA,
      name: "people",
      columns: [
        { name: "id", data_type: "uuid", primary_key: true, default: "gen_random_uuid()" },
        { name: "document", data_type: "text", nullable: false, unique: true },
        { name: "last_name", data_type: "text", nullable: false },
        { name: "first_name", data_type: "text", nullable: false },
        { name: "photo", data_type: "uuid", foreign_key: { references_schema: "totalbase", references_table: "files", on_delete: "SET NULL" } },
      ],
      expose_methods: ["GET", "POST", "PATCH", "DELETE"],
    });
    await call("execute_sql", {
      sql: `CREATE FUNCTION "${SCHEMA}".preview_document(code text) RETURNS jsonb LANGUAGE sql STABLE AS $$
        SELECT jsonb_build_object(
          'exists', EXISTS (SELECT 1 FROM "${SCHEMA}".people WHERE document = split_part(code, '@', 3)),
          'fields', jsonb_build_object('last_name', split_part(code, '@', 1), 'first_name', split_part(code, '@', 2), 'document', split_part(code, '@', 3)))
      $$`,
    });
    await call("expose_resource", { schema: SCHEMA, name: "preview_document", expose_methods: ["POST"] });
    expect(await call("call_function", { schema: SCHEMA, name: "preview_document", arguments: { code: "PEREZ@ANA@30111222" } })).toMatchObject({ exists: false, fields: { document: "30111222" } });

    const page = await call<{ id: string; viewType: string; source: string }>("create_dataview", { name: `Alta ${SUFFIX}`, view_type: "CUSTOM", schema: SCHEMA, table: "people" });
    created.dataviews.push(page.id);
    expect(page).toMatchObject({ viewType: "CUSTOM", source: `${SCHEMA}.people` });

    const variables = await call<{ variables: { name: string; resource?: string; target?: { resource: string } }[] }>("set_page_variables", {
      id: page.id,
      variables: [
        { name: "code", kind: "VALUE", type: "text" },
        { name: "preview", kind: "CALL", target: { type: "FUNCTION", resource: `${SCHEMA}.preview_document` } },
        { name: "recent", kind: "RESOURCE", resource: `${SCHEMA}.people`, query: { fields: "id,last_name,first_name", order_by: "last_name", limit: 20 } },
      ],
    });
    expect(variables.variables.map((v) => v.name)).toEqual(["code", "preview", "recent"]);
    expect(variables.variables[1]!.target!.resource).toMatch(/^[0-9a-f-]{36}$/);
    await expect(call("set_page_variables", { id: page.id, variables: [{ name: "broken", kind: "VALUE", type: "nope" }] })).rejects.toThrow(/DATAVIEW_VARIABLES_INVALID/);

    type Node = { id: string; widget: string; name?: string; slot?: string; width?: number; props?: Record<string, unknown>; bindings?: Record<string, unknown>; emits?: Record<string, string>; children?: Node[] };
    const built = await call<{ widgets: Node[] }>("add_page_widgets", {
      id: page.id,
      widgets: [
        { widget: "UButton", name: "save", slot: "header", props: { label: "Save", color: "primary" }, emits: { click: "onSaveClick" } },
        { widget: "TScanner", name: "scanner", props: { listen: "page", continuous: false }, bindings: { modelValue: { variable: "code" } }, emits: { scan: "onScan" } },
        { widget: "UAlert", name: "previewAlert", bindings: { title: { formula: "{{vars.preview.data.fields.last_name}}" }, visible: { formula: "!ISBLANK({{vars.preview.data}})" } } },
        {
          widget: "UForm",
          name: "form",
          children: [
            { widget: "UFormField", props: { column: "document" }, width: 4, children: [{ widget: "UInput" }] },
            { widget: "UFormField", props: { column: "last_name" }, width: 4, children: [{ widget: "UInput" }] },
            { widget: "UFormField", props: { column: "first_name" }, width: 4, children: [{ widget: "UInput" }] },
            { widget: "UFormField", props: { column: "photo" }, children: [{ widget: "TCamera", props: { aspect: "3:4", maxSize: 1200 } }] },
          ],
        },
        { widget: "UTable", name: "recentTable", bindings: { data: { variable: "recent" } }, height: 6 },
      ],
    });
    const byName = (name: string) => built.widgets.find((w) => w.name === name)!;
    expect(byName("save").slot).toBe("header");
    expect(byName("form").children!.map((f) => [f.props!["column"], f.width ?? 12, f.children![0]!.widget, f.children![0]!.slot])).toEqual([
      ["document", 4, "UInput", "default"], ["last_name", 4, "UInput", "default"], ["first_name", 4, "UInput", "default"], ["photo", 12, "TCamera", "default"],
    ]);
    // A form field bound to a column keeps no label of its own - it follows the column's.
    expect(byName("form").children![0]!.props!["label"]).toBeUndefined();

    // A failure leaves nothing half-built: a form field holds one input only.
    const count = (nodes: Node[]): number => nodes.reduce((n, w) => n + 1 + count(w.children ?? []), 0);
    await expect(call("add_page_widgets", { id: page.id, widgets: [{ widget: "UFormField", children: [{ widget: "UInput" }, { widget: "UInput" }] }] })).rejects.toThrow();
    await expect(call("add_page_widgets", { id: page.id, widgets: [{ widget: "UInput", props: { nope: 1 } }] })).rejects.toThrow(/no prop "nope"/);
    expect(count((await call<{ widgets: Node[] }>("get_page", { id: page.id })).widgets)).toBe(count(built.widgets));

    const updated = await call<{ widgets: Node[] }>("update_page_widget", { id: page.id, widget: "scanner", width: 6, props: { formats: "pdf417" } });
    const scanner = updated.widgets.find((w) => w.name === "scanner")!;
    expect(scanner).toMatchObject({ width: 6, props: { listen: "page", formats: "pdf417" }, bindings: { modelValue: { variable: "code" } }, emits: { scan: "onScan" } });
    // The catalog decides: a Scanner's listen is field or page.
    await expect(call("update_page_widget", { id: page.id, widget: "scanner", props: { listen: "everywhere" } })).rejects.toThrow(/DATAVIEW_WIDGET_INVALID|invalid value/);

    const partial = await call<{ warning?: string; missing?: { fn: string }[] }>("save_page_code", { id: page.id, code: "async function onScan(dataview, event) {}" });
    expect(partial.missing?.map((m) => m.fn)).toEqual(["onSaveClick"]);
    const code = `async function onScan(dataview, event) {
  const data = await dataview.vars.preview.execute({ data: { code: event.value } })
  if (data.exists) return dataview.notify('Already registered', 'warning')
  for (const [column, value] of Object.entries(data.fields)) dataview.vars.record.set(column, value)
}
async function onSaveClick(dataview) {
  if (await dataview.vars.record.save()) dataview.vars.record.new()
}
function onRecordSaved(dataview) { dataview.vars.recent.refresh() }`;
    const saved = await call<{ missing?: unknown[]; functions: string[] }>("save_page_code", { id: page.id, code, record_emits: { save: "onRecordSaved" } });
    expect(saved.missing).toBeUndefined();
    expect(saved.functions).toEqual(["onScan", "onSaveClick", "onRecordSaved"]);

    await call("delete_page_widget", { id: page.id, widget: "previewAlert", confirm: true });
    const final = await call<{ record: string; code: string; recordEmits: Record<string, string>; widgets: Node[] }>("get_page", { id: page.id });
    expect(final).toMatchObject({ record: `${SCHEMA}.people`, code, recordEmits: { save: "onRecordSaved" } });
    expect(final.widgets.map((w) => w.name)).not.toContain("previewAlert");

    // The server validates the whole page again on publish.
    expect((await call<{ version: number }>("publish_dataview", { id: page.id, role_ids: [roleId] })).version).toBe(1);
  });

  it("keeps a trigger's DELETE and a function body's DROP from asking for confirm; marks a type without an input as plain text - a range has its own (T2)", async () => {
    // Runs after the SQL test: sql_console.token_access is on.
    const sql = `CREATE FUNCTION "${SCHEMA}".touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW; END $$;
      CREATE TRIGGER notes_touch BEFORE INSERT OR UPDATE OR DELETE ON "${SCHEMA}".notes FOR EACH ROW EXECUTE FUNCTION "${SCHEMA}".touch();
      -- DROP TABLE notes;`;
    expect((await call<{ status: string }>("execute_sql", { sql })).status).toBe("EXECUTED");
    const notes = await call<{ columns: { name: string; editedAs?: string; widget?: string }[] }>("alter_table", { schema: SCHEMA, name: "notes", verbose: true, operations: [
      { kind: "add_column", column: { name: "valid", data_type: "tstzrange" } },
      { kind: "add_column", column: { name: "origin", data_type: "inet" } },
    ] });
    expect(notes.columns.find((c) => c.name === "valid")).toMatchObject({ widget: "TRangeInput" });
    expect(notes.columns.find((c) => c.name === "valid")?.editedAs).toBeUndefined();
    expect(notes.columns.find((c) => c.name === "origin")?.editedAs).toMatch(/plain text/);
    expect(notes.columns.find((c) => c.name === "body")?.editedAs).toBeUndefined();
  });

  it("grants many at once, lists a table's grants, and configures a resource", async () => {
    const batch = await call<{ applied: number }>("grant_permissions", {
      role_ids: [roleId],
      grants: [
        { schema: SCHEMA, name: "customers", actions: ["READ", "CREATE"] },
        { schema: SCHEMA, name: "notes", actions: ["READ", "UPDATE"], where: { owner: { _eq: "$USER.id" } } },
      ],
    });
    expect(batch.applied).toBe(4);
    const onNotes = await call<{ grants: { roleName: string; action: string; where?: unknown; fields: string[] }[] }>("get_permissions", { schema: SCHEMA, name: "notes" });
    expect(onNotes.grants.map((g) => g.action).sort()).toEqual(["READ", "UPDATE"]);
    expect(onNotes.grants[0]).toMatchObject({ roleName: `mcp-test-${SUFFIX}`, where: { owner: { _eq: "$USER.id" } } });
    expect(onNotes.grants[0]!.fields).toContain("valid");

    const configured = await call<{ requireIdempotencyKey: boolean; description: string; exposedMethods: string[] }>("expose_resource", { schema: SCHEMA, name: "notes", description: "A user's notes", require_idempotency_key: true });
    expect(configured).toMatchObject({ requireIdempotencyKey: true, description: "A user's notes", exposedMethods: ["GET", "POST", "PATCH", "DELETE"] });
    await expect(call("write_records", { schema: SCHEMA, name: "notes", operation: "create", data: { body: "no key" } })).rejects.toThrow(/IDEMPOTENCY_KEY_REQUIRED/);
    await call("expose_resource", { schema: SCHEMA, name: "notes", require_idempotency_key: false });
  });

  it("changes a DataView's columns, order, refresh and roles without publishing; a dashboard's roles too", async () => {
    const id = created.dataviews[0]!;
    const updated = await call<{ viewConfig: Record<string, unknown>; roleIds: string[] }>("update_dataview", {
      id, remove_columns: ["customer"], add_columns: ["customer.name"], column_order: ["amount", "stage"], default_sort: "-amount", auto_refresh: "30s", role_ids: [],
    });
    expect(updated.roleIds).toEqual([]);
    expect(updated.viewConfig).toMatchObject({ auto_refresh: "30s", default_state: { sort: "-amount", columnPrefs: { amount: { order: 0 }, stage: { order: 1 } } } });
    const view = await call<{ fields: { column?: string }[]; roles: unknown[] }>("get_dataview", { id });
    expect(view.fields.map((f) => f.column)).toContain("customer.name");
    expect(view.fields.map((f) => f.column)).not.toContain("customer");
    expect(view.roles).toEqual([]);

    const dashboard = created.dashboards[0]!;
    await call("update_dashboard", { id: dashboard, role_ids: [] });
    expect(await context.dashboardsAdmin.listRoles(dashboard)).toEqual([]);
  });

  it("arranges the App menu in groups by slug", async () => {
    const deals = (await call<{ id: string; slug: string }[]>("list_dataviews")).find((v) => v.id === created.dataviews[0])!;
    const menu = await call<{ nodes: { group?: string; children?: { dataview?: string }[] }[] }>("set_app_menu", { nodes: [{ group: `Sales ${SUFFIX}`, children: [{ dataview: deals.slug }] }] });
    const group = menu.nodes.find((n) => n.group === `Sales ${SUFFIX}`)!;
    expect(group.children).toEqual([expect.objectContaining({ dataview: deals.slug })]);

    // A group kept by id keeps its icon when a rearrangement leaves it out; null clears it.
    const iconed = await call<{ nodes: { group?: string; id?: string; icon?: string }[] }>("set_app_menu", { nodes: [{ group: `Sales ${SUFFIX}`, icon: "i-lucide-shield-ban", icon_open: "i-lucide-shield", children: [{ dataview: deals.slug }] }] });
    const id = iconed.nodes.find((n) => n.group === `Sales ${SUFFIX}`)!.id!;
    const kept = await call<{ nodes: { id?: string; icon?: string; icon_open?: string }[] }>("set_app_menu", { nodes: [{ group: `Sales ${SUFFIX}`, id, children: [{ dataview: deals.slug }] }] });
    expect(kept.nodes.find((n) => n.id === id)?.icon).toBe("i-lucide-shield-ban");
    expect(kept.nodes.find((n) => n.id === id)?.icon_open).toBe("i-lucide-shield");
    const cleared = await call<{ nodes: { id?: string; icon?: string }[] }>("set_app_menu", { nodes: [{ group: `Sales ${SUFFIX}`, id, icon: null, children: [{ dataview: deals.slug }] }] });
    expect(cleared.nodes.find((n) => n.id === id)?.icon).toBeUndefined();

    // An item's label and description are its DataView's own - set at once, read back by get_app_menu.
    await call("set_app_menu", { nodes: [{ group: `Sales ${SUFFIX}`, id, children: [{ dataview: deals.slug, label: "Open deals", description: "Deals still in play" }] }] });
    const read = await call<{ nodes: { id?: string; children?: { dataview?: string; label?: string; description?: string }[] }[] }>("get_app_menu", {});
    expect(read.nodes.find((n) => n.id === id)?.children?.[0]).toMatchObject({ dataview: deals.slug, label: "Open deals", description: "Deals still in play" });
    await call("set_app_menu", { nodes: [] });
  });

  it("saves an email template and says which placeholders sample data leaves empty", async () => {
    const template = await call<{ id: string; placeholders: string[] }>("save_template", {
      name: `Welcome ${SUFFIX}`, kind: "MAILING", subject: "Hi {{name}}", message: "<p>Your order {{order.number}} is in.</p>",
    });
    created.templates.push(template.id);
    expect(template.placeholders).toEqual(["name", "order.number"]);
    expect(await call("test_template", { id: template.id, data: { name: "Ana" } })).toMatchObject({ missing: ["order.number"] });
    expect(await call("test_template", { id: template.id, data: { name: "Ana", order: { number: 7 } } })).toMatchObject({ complete: true });
    const changed = await call<{ placeholders: string[] }>("save_template", { id: template.id, subject: "Welcome, {{name}}" });
    expect(changed.placeholders).toEqual(["name", "order.number"]);
  });

  it("turns a workflow off and on without publishing", async () => {
    const workflow = created.workflows[0]!;
    expect((await call<{ enabled: boolean }>("set_workflow_enabled", { id: workflow, enabled: false })).enabled).toBe(false);
    expect((await call<{ enabled: boolean }>("set_workflow_enabled", { id: workflow, enabled: true })).enabled).toBe(true);
  });

  it("keeps a grant the role had when applying the defaults, and lists a CHECK list's values", async () => {
    await call("grant_permission", { role_id: roleId, schema: "totalbase", name: "users", action: "READ" });
    // The role's own READ on every user stays: a default never replaces a grant it already has.
    const defaults = await call<{ kept: { table: string; action: string }[] }>("apply_default_permissions", { role_id: roleId });
    expect(defaults.kept).toContainEqual({ table: "users", action: "READ" });
    expect((await call<{ grants: { roleName: string; action: string; where?: unknown }[] }>("get_permissions", { schema: "totalbase", name: "users" })).grants.find((g) => g.roleName === `mcp-test-${SUFFIX}` && g.action === "READ")?.where).toBeUndefined();

    const deals = await call<{ columns: { name: string; values?: string[] }[] }>("alter_table", {
      schema: SCHEMA, name: "deals", verbose: true, operations: [{ kind: "add_check", name: "deals_stage_list", expression: "stage IN ('LEAD', 'WON', 'LOST')" }],
    });
    expect(deals.columns.find((c) => c.name === "stage")?.values).toEqual(["LEAD", "WON", "LOST"]);
    expect(deals.columns.find((c) => c.name === "amount")?.values).toBeUndefined();
  });

  it("lets a generated form field inherit its column's label, and a select's options follow another field", async () => {
    // The column's title set before the DataView exists: the form field follows it instead of a humanized name of its own.
    await call("set_column_presentation", { schema: SCHEMA, name: "deals", column: "amount", presentation: { label: "Importe total" } });
    const view = await call<{ id: string }>("create_dataview", { name: `Labels ${SUFFIX}`, view_type: "TABLE", schema: SCHEMA, table: "deals" });
    created.dataviews.push(view.id);
    type Node = { widget: string; props?: Record<string, unknown>; children?: Node[] };
    const page = await call<{ widgets: Node[]; variables: { name: string; kind: string; query?: Record<string, unknown> }[] }>("get_page", { id: view.id });
    const fields: Node[] = [];
    const walk = (nodes: Node[]) => nodes.forEach((n) => { if (n.widget === "UFormField") fields.push(n); walk(n.children ?? []); });
    walk(page.widgets);
    const amount = fields.find((f) => f.props?.["column"] === "amount")!;
    expect(amount.props?.["label"]).toBeUndefined();

    // A foreign key's select is fed by a Resource of its table: a where on the record's own values narrows it, no new feature.
    const options = page.variables.find((v) => v.kind === "RESOURCE")!;
    const narrowed = await call<{ variables: { name: string; query: { where?: unknown } }[] }>("set_page_variables", {
      id: view.id,
      variables: [{ ...options, query: { ...options.query, where: { name: { _ilike: "{{vars.record.data.stage}}" } } } }],
    });
    expect(narrowed.variables.find((v) => v.name === options.name)?.query.where).toEqual({ name: { _ilike: "{{vars.record.data.stage}}" } });
  });

  it("stores a filter with a JSON true or number as the grammar takes it - text", async () => {
    await call("alter_table", { schema: SCHEMA, name: "customers", operations: [{ kind: "add_column", column: { name: "active", data_type: "boolean", nullable: false, default: "true" } }] });
    const view = created.dataviews.at(-1)!;
    const stored = await call<{ variables: { name: string; query: { where?: unknown } }[] }>("set_page_variables", {
      id: view,
      variables: [{ name: "activeCustomers", kind: "RESOURCE", resource: `${SCHEMA}.customers`, query: { fields: "id,name", where: { active: { _eq: true }, _or: [{ name: { _in: ["Acme", "Globex"] } }] } } }],
    });
    expect(stored.variables.find((v) => v.name === "activeCustomers")?.query.where).toEqual({ active: { _eq: "true" }, _or: [{ name: { _in: "Acme,Globex" } }] });
    const grant = await call<{ where: unknown }>("grant_permission", { role_id: roleId, schema: SCHEMA, name: "deals", action: "READ", where: { amount: { _gte: 100 } } });
    expect(grant.where).toEqual({ amount: { _gte: "100" } });
  });

  it("uploads a file from its content - public, read without credentials - and updates it as files", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>';
    const file = await call<{ id: string; name: string; visibility: string; mime_type: string }>("upload_file", { name: `dni-${SUFFIX}.svg`, mime_type: "image/svg+xml", text: svg, visibility: "PUBLIC" });
    try {
      expect([file.name, file.visibility, file.mime_type]).toEqual([`dni-${SUFFIX}.svg`, "PUBLIC", "image/svg+xml"]);
      const anonymous = await app.inject({ method: "GET", url: `/api/totalbase/table/files/${file.id}` });
      expect([anonymous.statusCode, anonymous.body]).toEqual([200, svg]);
      const png = await call<{ id: string; size_bytes: number }>("upload_file", { name: `dot-${SUFFIX}.png`, mime_type: "image/png", content_base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" });
      await database.query(`DELETE FROM totalbase.files WHERE id = $1`, [png.id]);
      // The guide's name finds it: files is written at /totalbase/table/files.
      await call("write_records", { schema: "totalbase", name: "files", operation: "update", id: file.id, data: { description: "DNI front" } });
      const { rows } = await database.query<{ description: string }>(`SELECT description FROM totalbase.files WHERE id = $1`, [file.id]);
      expect(rows[0]?.description).toBe("DNI front");
      await expect(call("write_records", { schema: "totalbase", name: "files", operation: "create", data: { name: "x" } })).rejects.toThrow(/upload_file/);
    } finally {
      await database.query(`DELETE FROM totalbase.files WHERE id = $1`, [file.id]);
    }
  });

  it("moves a page widget into a card and to the top of the page, keeping its props", async () => {
    const page = await context.dataviewsAdmin.create({ name: `Move ${SUFFIX}`, slug: `mcp-move-${SUFFIX}`, viewType: "CUSTOM" });
    created.dataviews.push(page.id);
    await call("add_page_widgets", { id: page.id, widgets: [
      { widget: "UButton", name: "scan", props: { label: "Scan" } },
      { widget: "UCard", name: "box", children: [{ widget: "TText", name: "hint", slot: "default", props: { label: "Hint" } }] },
      { widget: "UAlert", name: "alerta", props: { title: "Careful" } },
    ] });
    type Node = { name?: string; slot?: string; props?: Record<string, unknown>; children?: Node[] };
    const intoBox = await call<{ widgets: Node[] }>("move_page_widget", { id: page.id, widget: "alerta", parent: "box", position: 0 });
    expect(intoBox.widgets.map((w) => w.name)).toEqual(["scan", "box"]);
    const box = intoBox.widgets.find((w) => w.name === "box")!;
    expect(box.children?.map((c) => [c.name, c.slot])).toEqual([["alerta", "default"], ["hint", "default"]]);
    expect(box.children?.[0]?.props).toEqual({ title: "Careful" });
    const top = await call<{ widgets: Node[] }>("move_page_widget", { id: page.id, widget: "alerta", parent: null, position: 0 });
    expect(top.widgets.map((w) => w.name)).toEqual(["alerta", "scan", "box"]);
    await expect(call("move_page_widget", { id: page.id, widget: "box", parent: "box" })).rejects.toThrow();
  });
});
