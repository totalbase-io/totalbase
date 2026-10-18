import type { FastifyInstance } from "fastify";
import { dashboardWidgetDefinition, isDashboardDecisionCode, validateDashboardWidgetConfig, type DashboardWidgetType } from "@totalbase/tb-catalog";
import { suggestDashboard, type DashboardSpec, type DashboardSpecWidget, type DashboardSuggestion } from "@totalbase/dashboards";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reconcileCatalog } from "../catalog-refresh.js";
import type { AppContext } from "../context.js";
import { loadServerEnv } from "../env.js";
import { setupTestApp } from "../test-support.js";

const RUN = Date.now().toString(36);
const BRANCHES = `sg_branches_${RUN}`;
const EXCLUSIONS = `sg_exclusions_${RUN}`;
const READINGS = `sg_readings_${RUN}`;
const COPY = `sg_copy_${RUN}`;
const ACCOUNTS = `sg_accounts_${RUN}`;
const VISITS = `sg_visits_${RUN}`;
const VIEW = `sg_v_readings_${RUN}`;
const USER_BRANCH = `sg_branch_${RUN}`;

/** The readings table, with its columns named by `n` - the same table renamed gives the same analysis. */
function readingsDdl(table: string, n: (column: string) => string): string {
  return `CREATE TABLE public.${table} (
    ${n("id")} bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ${n("taken_at")} timestamptz NOT NULL DEFAULT now(),
    ${n("received_at")} timestamptz NOT NULL DEFAULT now(),
    ${n("branch")} uuid NOT NULL REFERENCES public.${BRANCHES}(id),
    ${n("format")} text NOT NULL CHECK (${n("format")} IN ('DNI', 'PASSPORT', 'OTHER')),
    ${n("is_dni")} boolean NOT NULL DEFAULT true,
    ${n("minor")} boolean NOT NULL DEFAULT false,
    ${n("hour")} smallint NOT NULL CHECK (${n("hour")} BETWEEN 0 AND 23),
    ${n("weekday")} smallint NOT NULL CHECK (${n("weekday")} BETWEEN 1 AND 7),
    ${n("age")} integer,
    ${n("device")} uuid,
    ${n("sex")} text,
    ${n("exclusion")} uuid REFERENCES public.${EXCLUSIONS}(id),
    ${n("age_range")} text GENERATED ALWAYS AS (CASE WHEN ${n("age")} < 30 THEN 'young' ELSE 'adult' END) STORED,
    ${n("shift")} integer
  )`;
}

/**
 * The dashboard assistant (Specification_Dashboards.md §10.7, D27) against real PostgreSQL: each column's role from
 * the catalog and pg_stats (the lab's readings, accounts and visits, a view, a renamed copy), the same codes in every
 * language, no scan of the table, and a proposal that saves, publishes and runs widget by widget.
 */
describe("Dashboards - suggest_dashboard (D27)", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  const dashboardIds: string[] = [];
  const resourceIds: string[] = [];
  let savedLanguage: { overridden: boolean; value: string };

  const call = (method: string, url: string, payload?: unknown, token: string | null = adminToken) =>
    app.inject({ method: method as "POST", url, headers: token ? { authorization: `Bearer ${token}` } : {}, ...(payload !== undefined && { payload: { data: payload } }) });
  const suggest = async (name: string): Promise<DashboardSuggestion> => {
    const res = await call("POST", "/admin/api/dashboards/suggest", { name });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().data;
  };
  const roles = (s: DashboardSuggestion) => Object.fromEntries(s.analysis.map((a) => [a.column, `${a.role}:${a.reason.code}`]));
  const resourceId = async (table: string) => (await database.query<{ id: string }>(`SELECT id FROM totalbase.resources WHERE postgres_oid = to_regclass($1)::oid`, [`public.${table}`])).rows[0]!.id;

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    adminToken = (await context.auth.login({ email: loadServerEnv().adminEmail!, password: loadServerEnv().adminPassword! })).token;
    savedLanguage = { overridden: await context.settings.isOverridden("system.language"), value: await context.settings.get("system.language") };
    await context.settings.set("system.language", "en");

    await database.query(`CREATE TABLE public.${BRANCHES} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE)`);
    await database.query(`INSERT INTO public.${BRANCHES} (name) VALUES ('North'), ('South'), ('East'), ('West')`);
    await database.query(`CREATE TABLE public.${EXCLUSIONS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), document text NOT NULL UNIQUE)`);
    await database.query(`INSERT INTO public.${EXCLUSIONS} (document) VALUES ('20111222'), ('27333444'), ('30555666')`);
    await database.query(readingsDdl(READINGS, (c) => c));
    await database.query(`INSERT INTO public.${READINGS} (taken_at, received_at, branch, format, is_dni, minor, hour, weekday, age, device, sex, shift, exclusion)
      SELECT now() - (i % 60) * interval '1 day' - (i % 24) * interval '1 hour', now() - i * interval '1 minute', (SELECT id FROM public.${BRANCHES} ORDER BY name OFFSET i % 4 LIMIT 1),
             (ARRAY['DNI', 'PASSPORT', 'OTHER'])[1 + i % 3], i % 5 <> 0, i % 7 = 0, i % 24, 1 + i % 7, 18 + i % 67,
             ('00000000-0000-4000-8000-0000000000' || lpad((i % 20)::text, 2, '0'))::uuid, (ARRAY['F', 'M', 'X'])[1 + i % 3], i % 3,
             CASE WHEN i % 10 = 0 THEN (SELECT id FROM public.${EXCLUSIONS} ORDER BY document OFFSET i % 3 LIMIT 1) END
        FROM generate_series(1, 600) i`);
    // The same table, its columns renamed.
    const renamed = (c: string) => `x${c.length}_${c.split("").reverse().join("")}`;
    await database.query(readingsDdl(COPY, renamed));
    const copied = ["taken_at", "received_at", "branch", "format", "is_dni", "minor", "hour", "weekday", "age", "device", "sex", "shift", "exclusion"];
    await database.query(`INSERT INTO public.${COPY} (${copied.map(renamed).join(", ")}) SELECT ${copied.join(", ")} FROM public.${READINGS}`);
    await database.query(`CREATE TABLE public.${ACCOUNTS} (
      id serial PRIMARY KEY, opened_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
      subtotal numeric(12,2), bonus numeric(12,2), discount numeric(12,2), total numeric(12,2), paid numeric(12,2),
      status text NOT NULL CHECK (status IN ('OPEN', 'CLOSED', 'VOID')), anonymized boolean NOT NULL DEFAULT false)`);
    await database.query(`INSERT INTO public.${ACCOUNTS} (opened_at, created_at, subtotal, bonus, discount, total, paid, status)
      SELECT now() - i * interval '5 hours', now() - i * interval '1 minute', i * 10, i, i * 0.5, i * 9.5, i * 9, (ARRAY['OPEN', 'CLOSED', 'VOID'])[1 + i % 3] FROM generate_series(1, 200) i`);
    await database.query(`CREATE TABLE public.${VISITS} (id serial PRIMARY KEY, entered_at timestamp NOT NULL, closing text)`);
    await database.query(`INSERT INTO public.${VISITS} (entered_at) SELECT now() - i * interval '1 hour' FROM generate_series(1, 50) i`);
    await database.query(`CREATE VIEW public.${VIEW} AS SELECT r.taken_at, r.branch, r.format, r.age, r.age * 2 AS double_age, upper(r.sex) AS sex_upper FROM public.${READINGS} r`);
    for (const table of [BRANCHES, EXCLUSIONS, READINGS, COPY, ACCOUNTS, VISITS]) await database.query(`ANALYZE public.${table}`);
    // Added after ANALYZE: no statistics yet, its CHECK is enough.
    await database.query(`ALTER TABLE public.${READINGS} ADD COLUMN direction text CHECK (direction IN ('IN', 'OUT'))`);
    await database.query(`ALTER TABLE public.${COPY} ADD COLUMN zz_noitcerid text CHECK (zz_noitcerid IN ('IN', 'OUT'))`);
    // The lab's users.sucursal: a viewer's branch.
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN ${USER_BRANCH} uuid REFERENCES public.${BRANCHES}(id)`);

    await reconcileCatalog(context);
    for (const table of [BRANCHES, EXCLUSIONS, READINGS, COPY, ACCOUNTS, VISITS, VIEW]) resourceIds.push(await resourceId(table));
    await context.resourcesAdmin.updateRowPresentation(resourceIds[0]!, { displayField: "name" });
    await context.resourcesAdmin.updateColumnPresentation(resourceIds[2]!, "age", { label: "Age", displayFormat: "#,##0.0" });
  });

  afterAll(async () => {
    for (const id of dashboardIds) await database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${USER_BRANCH}`);
    await database.query(`DROP VIEW IF EXISTS public.${VIEW}`);
    for (const table of [READINGS, COPY, ACCOUNTS, VISITS, EXCLUSIONS, BRANCHES]) await database.query(`DROP TABLE IF EXISTS public.${table}`);
    for (const id of resourceIds) await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [id]);
    if (savedLanguage.overridden) await context.settings.set("system.language", savedLanguage.value);
    else await context.settings.reset("system.language");
    await app.close();
  });

  it("reads the readings table as the lab's (D27's acceptance)", async () => {
    const s = await suggest(READINGS);
    expect(s.relation).toMatchObject({ schema: "public", name: READINGS, type: "TABLE", resourceId: resourceIds[2] });
    expect(roles(s)).toEqual({
      id: "identifier:identifier-primary-key",
      taken_at: "moment:moment-several",
      received_at: "discarded:moment-alternative",
      branch: "dimension:dimension-foreign-key",
      format: "category:category-check-list",
      is_dni: "category:category-boolean",
      minor: "category:category-boolean",
      hour: "category:category-check-range",
      weekday: "category:category-check-range",
      age: "measure:measure-integer-many",
      device: "discarded:uuid-without-fk",
      sex: "discarded:text-without-check",
      exclusion: "dimension:dimension-suggested-presentation",
      age_range: "discarded:text-without-check",
      shift: "category:category-few-values",
      direction: "category:category-check-list",
    });
    expect(s.analysis.find((a) => a.column === "taken_at")!.alternatives).toEqual(["received_at"]);
    expect(s.analysis.find((a) => a.column === "age")).toMatchObject({ aggregate: "avg", reason: { detail: "n_distinct 67" } });
    expect(s.missing.map((m) => m.code)).toEqual(expect.arrayContaining(["uuid-without-fk", "text-without-check", "dimension-suggested-presentation"]));
    expect(s.missing.filter((m) => m.code === "text-without-check")).toHaveLength(2);
    // The heatmap of weekday × hour, the branch list from its table, the security options for the viewer's branch.
    expect(s.spec.widgets.map((w) => w.type)).toContain("HEATMAP");
    expect(s.spec.variables).toEqual(expect.arrayContaining([expect.objectContaining({ name: "branch", type: "SELECT", options: { source: "TABLE", resource: resourceIds[0] } })]));
    expect(s.security.notice.code).toBe("security-all-rows");
    expect(s.security.options.map((o) => [o.key, o.column, o.field])).toEqual([["openOnViewers", "branch", USER_BRANCH], ["onlyViewers", "branch", USER_BRANCH]]);
    // The age KPI inherits its column's format; every reason is a listed code.
    expect(s.spec.widgets.find((w) => w.type === "KPI" && w.query!.includes("avg("))!.config).toMatchObject({ displayFormat: "#,##0.0" });
    for (const decision of [...s.analysis.map((a) => a.reason), ...s.reasons.map((r) => r.reason), ...s.missing]) expect(isDashboardDecisionCode(decision.code), decision.code).toBe(true);
    // What the document declares is what comes back.
    const doc = (await call("GET", "/admin/api/openapi")).json();
    const declared = Object.keys(doc.paths["/admin/api/dashboards/suggest"].post.responses["200"].content["application/json"].schema.properties.data.properties);
    expect(Object.keys(s).sort()).toEqual(declared.sort());
  });

  it("reads accounts and visits: 4 KPIs ticked, a donut of the status, a single value left out, a required date as the axis", async () => {
    const accounts = await suggest(ACCOUNTS);
    expect(roles(accounts)).toMatchObject({
      opened_at: "moment:moment-several",
      created_at: "discarded:moment-alternative",
      subtotal: "measure:measure-numeric",
      bonus: "measure:measure-numeric",
      discount: "measure:measure-numeric",
      total: "measure:measure-numeric",
      paid: "measure:measure-numeric",
      status: "category:category-check-list",
      anonymized: "discarded:single-value",
    });
    expect(accounts.spec.widgets.filter((w) => w.type === "KPI")).toHaveLength(4);
    expect(accounts.more.filter((w) => w.type === "KPI")).toHaveLength(2);
    expect(accounts.spec.widgets.find((w) => w.type === "DONUT")!.config!.roles).toMatchObject({ category: "status" });
    const visits = await suggest(VISITS);
    expect(roles(visits)).toMatchObject({ entered_at: "moment:moment-not-null", closing: "discarded:single-value" });
  });

  it("reads a view by its columns' origins - a computed one a measure when it's a number", async () => {
    const view = await suggest(VIEW);
    expect(view.relation.type).toBe("VIEW");
    expect(roles(view)).toEqual({
      taken_at: "moment:moment-default-now",
      branch: "dimension:dimension-foreign-key",
      format: "category:category-check-list",
      age: "measure:measure-integer-many",
      double_age: "measure:view-computed",
      sex_upper: "discarded:view-computed",
    });
    expect(view.analysis[0]!.origin).toBe(`public.${READINGS}.taken_at`);
  });

  it("is the same analysis with the columns renamed, and the same codes and details in Spanish", async () => {
    const original = await suggest(READINGS);
    const copy = await suggest(COPY);
    const shape = (s: DashboardSuggestion) => s.analysis.map((a) => [a.role, a.reason.code]);
    expect(shape(copy)).toEqual(shape(original));
    await context.settings.set("system.language", "es");
    try {
      const es = await suggest(READINGS);
      expect(es.analysis.map((a) => [a.reason.code, a.reason.detail ?? null])).toEqual(original.analysis.map((a) => [a.reason.code, a.reason.detail ?? null]));
      expect(es.analysis.map((a) => a.reason.message)).not.toEqual(original.analysis.map((a) => a.reason.message));
      expect(es.reasons.map((r) => [r.path, r.reason.code, r.reason.detail ?? null])).toEqual(original.reasons.map((r) => [r.path, r.reason.code, r.reason.detail ?? null]));
      expect(es.spec.variables![0]!.label).toBe("Período");
    } finally {
      await context.settings.set("system.language", "en");
    }
  });

  it("answers 404 for an unknown table, and only to an administrator", async () => {
    const missing = await call("POST", "/admin/api/dashboards/suggest", { name: `sg_nothing_${RUN}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().errors[0].code).toBe("RESOURCE_NOT_FOUND");
    expect((await call("POST", "/admin/api/dashboards/suggest", { name: READINGS }, null)).statusCode).toBe(401);
  });

  it("never scans the table: seq_scan and idx_scan stay the same", async () => {
    // One connection, so its pending counters are flushed on demand (pg_stat_force_next_flush, PostgreSQL 15+).
    const probe = new Database({ ...loadDatabaseConfigFromEnv(), poolMax: 1 });
    const scans = async () => {
      await probe.query(`SELECT pg_stat_force_next_flush()`);
      await probe.query(`SELECT 1`);
      const { rows } = await database.query<{ n: string }>(`SELECT (coalesce(seq_scan, 0) + coalesce(idx_scan, 0))::text AS n FROM pg_stat_user_tables WHERE relid = to_regclass($1)`, [`public.${READINGS}`]);
      return Number(rows[0]!.n);
    };
    try {
      const before = await scans();
      // The counters do move with a scan - so an unchanged one means none.
      await probe.query(`SELECT count(*) FROM public.${READINGS}`);
      const scanned = await scans();
      expect(scanned).toBeGreaterThan(before);
      await suggestDashboard(probe, { name: READINGS, language: "en" });
      await suggestDashboard(probe, { name: VIEW, language: "en" });
      expect(await scans()).toBe(scanned);
    } finally {
      await probe.close();
    }
  });

  it("proposes a dashboard that saves, publishes and runs widget by widget - its more and its security options too", async () => {
    const checks: { label: string; spec: DashboardSpec; more: DashboardSpecWidget[] }[] = [];
    for (const table of [READINGS, ACCOUNTS, VISITS, VIEW]) {
      const s = await suggest(table);
      checks.push({ label: table, spec: s.spec, more: s.more });
      if (table === READINGS) for (const option of s.security.options) checks.push({ label: `${table} ${option.key}`, spec: option.spec, more: option.more });
    }
    for (const [i, { label, spec, more }] of checks.entries()) {
      const dashboard = await context.dashboardsAdmin.create({ name: `Suggest ${i} ${RUN}`, slug: `suggest-${i}-${RUN}` });
      dashboardIds.push(dashboard.id);
      await context.dashboardsAdmin.update(dashboard.id, { variables: spec.variables ?? [] });
      let y = 0;
      const ids: string[] = [];
      for (const widget of [...spec.widgets, ...more]) {
        const type = widget.type as DashboardWidgetType;
        expect(validateDashboardWidgetConfig(type, widget.config), `${label} ${widget.label}`).toEqual([]);
        const size = dashboardWidgetDefinition(type).size;
        const saved = await context.dashboardsAdmin.addWidget(dashboard.id, { type, label: widget.label, gridX: 0, gridY: y, gridW: size.w, gridH: size.h, query: widget.query, config: widget.config });
        y += size.h;
        ids.push(saved.id);
      }
      await context.dashboardsAdmin.publish(dashboard.id, null);
      for (const id of ids) {
        const res = await call("POST", `/admin/api/dashboards/${dashboard.id}/widgets/${id}/data`, {});
        expect(res.statusCode, `${label}: ${res.body}`).toBe(200);
        expect(res.json().data.error ?? null, `${label}: ${res.body}`).toBeNull();
      }
      if (label === READINGS) {
        // The period's default (last 30 days) narrows the rows; the KPI compares with the 30 days before.
        const kpi = await call("POST", `/admin/api/dashboards/${dashboard.id}/widgets/${ids[0]}/data`, {});
        const row = kpi.json().data.rows[0] as Record<string, number>;
        const { rows } = await database.query<{ now: string; before: string }>(
          `SELECT count(*) FILTER (WHERE taken_at >= now() - interval '30 days')::text AS now, count(*) FILTER (WHERE taken_at >= now() - interval '60 days' AND taken_at < now() - interval '30 days')::text AS before FROM public.${READINGS}`,
        );
        expect([Number(row.count), Number(row.previous)]).toEqual([Number(rows[0]!.now), Number(rows[0]!.before)]);
      }
    }
  });
});
