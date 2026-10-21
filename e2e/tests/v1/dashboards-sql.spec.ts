import type { Page } from '@playwright/test'
import { adminSession, api, createDashboard, deleteDashboardsNamed, expect, resetSchema, sql, test, type DashboardRef } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * A dashboard widget runs SQL - the one exception to "no SQL from clients"
 * (AGENTS.md section 7, "Dashboard widget SQL"), so its fences are tried
 * here, against the editor's own Run (POST /admin/api/dashboards/:id/query):
 * PostgreSQL refuses every write (a READ ONLY transaction), stacked
 * statements never run, a slow query stops at its timeout, a large one at
 * its row cap, variables are bound - never interpolated - and a hand-written
 * parameter or the password hash is refused. After every attempt, the data
 * is as it was.
 */
const NAME = 'V1 Dash SQL'
let dashboard: DashboardRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await resetSchema(page, token)
  dashboard = await createDashboard(page, token, NAME, [{ name: 'texto', label: 'Texto', type: 'TEXT' }])
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await context.close()
})

interface QueryResult { columns: { name: string }[], rows: Record<string, unknown>[], truncated?: boolean }

/** The editor's Run: status and body, success or not. */
async function run(page: Page, token: string, query: string, variables: Record<string, unknown> = {}) {
  const response = await page.request.fetch(`${BASE_URL}/admin/api/dashboards/${dashboard.id}/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, data: { data: { query, variables } }
  })
  const body = await response.json()
  return { status: response.status(), data: body.data as QueryResult | undefined, error: body.errors?.[0] as { code: string, message: string } | undefined }
}
const customers = async (page: Page, token: string) => Number((await sql(page, token, 'SELECT count(*)::int AS n FROM public.e2e_v1_clientes')).rows[0]!.n)

test('a SELECT runs and returns its columns and rows', async ({ page, token }) => {
  const result = await run(page, token, 'SELECT nombre, limite_credito FROM public.e2e_v1_clientes WHERE id = 1')
  expect(result.status).toBe(200)
  expect(result.data!.columns.map(c => c.name)).toEqual(['nombre', 'limite_credito'])
  expect(result.data!.rows[0]).toMatchObject({ nombre: 'Acme SA' })
})

test('every write is refused by PostgreSQL - the data stays as it was', async ({ page, token }) => {
  const before = await customers(page, token)
  for (const write of [
    "INSERT INTO public.e2e_v1_clientes (nombre) VALUES ('Intruso')",
    'UPDATE public.e2e_v1_clientes SET limite_credito = 0',
    'DELETE FROM public.e2e_v1_clientes',
    'CREATE TABLE public.e2e_v1_intruso (id int)',
    'DROP TABLE public.e2e_v1_tareas',
    "WITH x AS (DELETE FROM public.e2e_v1_clientes RETURNING id) SELECT count(*) FROM x",
    "SELECT nextval(pg_get_serial_sequence('public.e2e_v1_clientes', 'id'))"
  ]) {
    const result = await run(page, token, write)
    expect(result.status, write).toBeGreaterThanOrEqual(400)
  }
  expect(await customers(page, token)).toBe(before)
  expect((await sql(page, token, "SELECT to_regclass('public.e2e_v1_intruso') IS NULL AS gone")).rows[0]!.gone).toBe(true)
  expect((await sql(page, token, "SELECT to_regclass('public.e2e_v1_tareas') IS NOT NULL AS kept")).rows[0]!.kept).toBe(true)
})

test('a session setting a query changes never outlives it - no other request inherits it from the pool', async ({ page, token }) => {
  const changed = await run(page, token, "SELECT set_config('TimeZone', 'Pacific/Kiritimati', false) AS tz")
  expect(changed.status).toBe(200)
  // Every connection the pool serves next: its own time zone, never that one.
  for (let i = 0; i < 30; i++) {
    const zone = await run(page, token, "SELECT current_setting('TimeZone') AS tz")
    expect(zone.data!.rows[0]!.tz).not.toBe('Pacific/Kiritimati')
  }
})

test('stacked statements never run - only one statement is ever accepted', async ({ page, token }) => {
  const before = await customers(page, token)
  for (const stacked of ['SELECT 1; DELETE FROM public.e2e_v1_clientes', 'SELECT 1; COMMIT; DELETE FROM public.e2e_v1_clientes']) {
    expect((await run(page, token, stacked)).status, stacked).toBeGreaterThanOrEqual(400)
  }
  expect(await customers(page, token)).toBe(before)
})

test('a slow query stops at the timeout, a large one at the row cap', async ({ page, token }) => {
  const settings = await api<Record<string, unknown>>(page, token, 'GET', '/admin/api/settings/dashboards')
  // GET answers full keys ("dashboards.query_timeout_ms"); PATCH takes either.
  const previous = { query_timeout_ms: settings['dashboards.query_timeout_ms'], query_max_rows: settings['dashboards.query_max_rows'] }
  try {
    await api(page, token, 'PATCH', '/admin/api/settings/dashboards', { data: { query_timeout_ms: 1000, query_max_rows: 50 } })
    const started = Date.now()
    const slow = await run(page, token, 'SELECT pg_sleep(10)')
    expect(slow.status).toBeGreaterThanOrEqual(400)
    expect(Date.now() - started).toBeLessThan(8000)

    const large = await run(page, token, 'SELECT n FROM generate_series(1, 1000) n')
    expect(large.status).toBe(200)
    expect(large.data!.rows).toHaveLength(50)
  } finally {
    await api(page, token, 'PATCH', '/admin/api/settings/dashboards', { data: previous })
  }
})

test('variables are bound as parameters, never interpolated', async ({ page, token }) => {
  const before = await customers(page, token)
  // A value made of SQL stays a value.
  const injected = await run(page, token, 'SELECT count(*)::int AS n FROM public.e2e_v1_clientes WHERE nombre = $VAR.texto', { texto: "x' OR '1'='1" })
  expect(injected.status).toBe(200)
  expect(injected.data!.rows[0]).toEqual({ n: 0 })
  const exact = await run(page, token, 'SELECT count(*)::int AS n FROM public.e2e_v1_clientes WHERE nombre = $VAR.texto', { texto: 'Acme SA' })
  expect(exact.data!.rows[0]).toEqual({ n: 1 })
  // Inside a string literal or a comment, a reference is just text.
  const literal = await run(page, token, "SELECT '$VAR.texto' AS t -- $USER.email")
  expect(literal.data!.rows[0]).toEqual({ t: '$VAR.texto' })
  // $USER.* reads the signed-in user's own row.
  const me = await run(page, token, 'SELECT $USER.email AS email')
  expect(me.data!.rows[0]!.email).toBe(process.env.TOTALBASE_ADMIN_EMAIL ?? 'admin@totalbase.local')
  expect(await customers(page, token)).toBe(before)
})

test('a hand-written parameter, an undefined variable and the password hash are refused', async ({ page, token }) => {
  for (const [query, code] of [
    ['SELECT $1', 'DASHBOARD_QUERY_INVALID'],
    ['SELECT $VAR.nada', 'DASHBOARD_QUERY_INVALID'],
    ['SELECT $USER.password_hash', 'DASHBOARD_QUERY_INVALID'],
    ['SELECT $USER.no_such_column', 'DASHBOARD_QUERY_INVALID'],
    ['', 'DASHBOARD_QUERY_INVALID']
  ] as const) {
    const result = await run(page, token, query)
    expect(result.status, query).toBeGreaterThanOrEqual(400)
    expect(result.error?.code, query).toBe(code)
  }
})

test('a viewer\'s Data API token can\'t run draft SQL - the Admin API is administrators\' only', async ({ page }) => {
  const response = await page.request.fetch(`${BASE_URL}/admin/api/dashboards/${dashboard.id}/query`, { method: 'POST', data: { data: { query: 'SELECT 1' } } })
  expect(response.status()).toBe(401)
})
