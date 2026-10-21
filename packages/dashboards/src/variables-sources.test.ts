import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DashboardsAdminService } from "./dashboards-admin-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));
const COUNTRIES = "dashboards_d22_countries";
const CITIES = "dashboards_d22_cities";
const LIMITS = { timeoutMs: 5_000, maxRows: 100 };

/**
 * Variables, more complete (Dashboards.md §3, D22): the previous period, short presets, a default from
 * the viewer's user row, a fixed list with labels, a list from a table - its key and row presentation, chained.
 */
describe("dashboard variables (D22, integration)", () => {
  let database: Database;
  let dashboards: DashboardsAdminService;
  let dashboardId: string;
  let countriesId: string;
  let citiesId: string;
  let userId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    dashboards = new DashboardsAdminService(database);
    await database.query(`DROP TABLE IF EXISTS public.${CITIES}, public.${COUNTRIES} CASCADE`);
    await database.query(`CREATE TABLE public.${COUNTRIES} (code text PRIMARY KEY, name text NOT NULL)`);
    await database.query(`CREATE TABLE public.${CITIES} (id serial PRIMARY KEY, name text NOT NULL, country text REFERENCES public.${COUNTRIES} (code))`);
    await database.query(`INSERT INTO public.${COUNTRIES} VALUES ('AR', 'Argentina'), ('UY', 'Uruguay')`);
    await database.query(`INSERT INTO public.${CITIES} (name, country) VALUES ('Rosario', 'AR'), ('Córdoba', 'AR'), ('Salto', 'UY')`);
    const register = async (name: string) => (await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status) VALUES ($1::regclass::oid, 'public', $2, 'TABLE', 'ACTIVE') RETURNING id`,
      [`public.${name}`, name],
    )).rows[0]!.id;
    countriesId = await register(COUNTRIES);
    citiesId = await register(CITIES);
    await database.query(`UPDATE totalbase.resources SET row_presentation = '{"displayTemplate": "{{name}} ({{code}})"}' WHERE id = $1`, [countriesId]);
    dashboardId = (await dashboards.create({ name: "dashboards d22 test", slug: "dashboards-d22-test" })).id;
    userId = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users ORDER BY created_at LIMIT 1`)).rows[0]!.id;
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [dashboardId]);
    await database.query(`DELETE FROM totalbase.resources WHERE id = ANY($1::uuid[])`, [[countriesId, citiesId]]);
    await database.query(`DROP TABLE IF EXISTS public.${CITIES}, public.${COUNTRIES} CASCADE`);
    await database.close();
  });

  it("gives a period its previous one - as long and just before; a calendar preset's previous unit", async () => {
    const variables = [{ name: "p", label: "P", type: "DATE_RANGE" }];
    const run = async (value: unknown) => (await dashboards.executeQuery(
      "SELECT ($VAR.p.to - $VAR.p.from) AS length, ($VAR.p.prev_to - $VAR.p.prev_from) AS prev_length, ($VAR.p.prev_to = $VAR.p.from) AS adjacent, date_trunc('month', $VAR.p.prev_from) = date_trunc('month', $VAR.p.from) - interval '1 month' AS last_month",
      LIMITS,
      { userId: null, variables: variables as never, values: { p: value } },
    )).rows[0]!;
    expect(await run("last_7_days")).toMatchObject({ adjacent: true });
    const custom = await run({ from: "2026-03-01", to: "2026-03-10" });
    expect(custom).toMatchObject({ adjacent: true });
    expect(String(custom.length)).toBe(String(custom.prev_length));
    expect(await run("this_month")).toMatchObject({ adjacent: true, last_month: true });
    expect(await run("last_hour")).toMatchObject({ adjacent: true });
    expect(await run("today")).toMatchObject({ adjacent: true });
  });

  it("takes a default from the viewer's own user row, and refuses a raw value that isn't a default's shape", async () => {
    await expect(dashboards.update(dashboardId, { variables: [{ name: "who", label: "Who", type: "TEXT", default: "$USER.email" }] })).rejects.toMatchObject({ code: "DASHBOARD_VARIABLE_INVALID" });
    await expect(dashboards.update(dashboardId, { variables: [{ name: "who", label: "Who", type: "TEXT", default: { source: "user", field: "no_such_column" } }] })).rejects.toMatchObject({ code: "DASHBOARD_VARIABLE_INVALID" });
    await expect(dashboards.update(dashboardId, { variables: [{ name: "who", label: "Who", type: "TEXT", default: { source: "user", field: "password_hash" } }] })).rejects.toMatchObject({ code: "DASHBOARD_VARIABLE_INVALID" });
    const saved = await dashboards.update(dashboardId, { variables: [{ name: "who", label: "Who", type: "TEXT", default: { source: "user", field: "email" } }] });
    const email = (await database.query<{ email: string }>(`SELECT email FROM totalbase.users WHERE id = $1`, [userId])).rows[0]!.email;
    const result = await dashboards.executeQuery("SELECT $VAR.who AS who", LIMITS, { userId, variables: saved.variables, values: {} });
    expect(result.rows[0]).toEqual({ who: email });
    expect((await dashboards.withDefaultValues(saved.variables, userId))[0]!.defaultValue).toBe(email);
    expect((await dashboards.withDefaultValues(saved.variables, null))[0]!.defaultValue).toBeNull();
  });

  it("offers a fixed list's labels - Yes / No, unset is All", async () => {
    await dashboards.update(dashboardId, { variables: [{ name: "paid", label: "Paid", type: "SELECT", options: { source: "STATIC", values: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] } }] });
    expect(await dashboards.variableOptions(dashboardId, "paid", "DRAFT", LIMITS, { userId: null })).toEqual([{ value: "true", label: "Yes" }, { value: "false", label: "No" }]);
  });

  it("lists a table's rows - its key the value, its row presentation the label - chained by another variable", async () => {
    await expect(dashboards.update(dashboardId, { variables: [{ name: "city", label: "City", type: "SELECT", options: { source: "TABLE", resource: citiesId, filters: [{ column: "nope", variable: "city" }] } }] })).rejects.toMatchObject({ code: "DASHBOARD_VARIABLE_INVALID" });
    await dashboards.update(dashboardId, {
      variables: [
        { name: "country", label: "Country", type: "SELECT", options: { source: "TABLE", resource: countriesId } },
        { name: "city", label: "City", type: "SELECT", multiple: true, options: { source: "TABLE", resource: citiesId, filters: [{ column: "country", variable: "country" }] } },
      ],
    });
    expect(await dashboards.variableOptions(dashboardId, "country", "DRAFT", LIMITS, { userId: null })).toEqual([{ value: "AR", label: "Argentina (AR)" }, { value: "UY", label: "Uruguay (UY)" }]);
    const cities = async (country?: string) => (await dashboards.variableOptions(dashboardId, "city", "DRAFT", LIMITS, { userId: null }, country ? { country } : {})).map((o) => o.label);
    expect(await cities()).toEqual(["Córdoba", "Rosario", "Salto"]);
    expect(await cities("AR")).toEqual(["Córdoba", "Rosario"]);
    expect((await dashboards.get(dashboardId)).variables[1]!.dependsOn).toEqual(["country"]);
  });

  it("reuses a published widget's result - per values, zone and (when it reads them) user; Refresh runs it again (D24)", async () => {
    await dashboards.update(dashboardId, { variables: [{ name: "n", label: "N", type: "NUMBER" }] });
    const plain = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 0, gridY: 0, gridW: 3, gridH: 2, query: "SELECT extract(epoch FROM clock_timestamp()) AS t, $VAR.n AS n", config: { roles: { value: "t" } } });
    const personal = await dashboards.addWidget(dashboardId, { type: "KPI", gridX: 3, gridY: 0, gridW: 3, gridH: 2, query: "SELECT extract(epoch FROM clock_timestamp()) AS t, $USER.id AS u", config: { roles: { value: "t" } } });
    await dashboards.publish(dashboardId, null);
    const limits = { ...LIMITS, cacheSeconds: 60 };
    const run = (widgetId: string, viewer: { userId: string | null; timezone?: string }, values: Record<string, unknown> = {}, extra = {}) =>
      dashboards.executePublishedWidget(dashboardId, widgetId, { ...limits, ...extra }, viewer, values);
    const first = await run(plain.id, { userId: null }, { n: 1 });
    expect(first.cached).toBe(false);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(await run(plain.id, { userId }, { n: 1 })).toMatchObject({ cached: true, rows: first.rows });
    expect((await run(plain.id, { userId: null }, { n: 2 })).cached).toBe(false);
    expect((await run(plain.id, { userId: null, timezone: "Asia/Tokyo" }, { n: 1 })).cached).toBe(false);
    const refreshed = await run(plain.id, { userId: null }, { n: 1 }, { fresh: true });
    expect(refreshed.cached).toBe(false);
    expect((await run(plain.id, { userId: null }, { n: 1 })).rows).toEqual(refreshed.rows);
    expect((await dashboards.executePublishedWidget(dashboardId, plain.id, { ...LIMITS, cacheSeconds: 0 }, { userId: null }, { n: 1 })).cached).toBe(false);
    const mine = await run(personal.id, { userId });
    expect((await run(personal.id, { userId })).cached).toBe(true);
    const other = (await database.query<{ id: string }>(`SELECT id FROM totalbase.users WHERE id <> $1 LIMIT 1`, [userId])).rows[0];
    if (other) expect((await run(personal.id, { userId: other.id })).rows[0]!.u).not.toBe(mine.rows[0]!.u);
  });
});
