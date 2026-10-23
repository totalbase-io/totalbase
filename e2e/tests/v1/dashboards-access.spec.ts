import type { Browser, Page } from '@playwright/test'
import { addDashboardWidget, adminSession, api, createDashboard, deleteDashboardsNamed, expect, publishDashboard, resetSchema, sql, test, type DashboardRef } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * Who sees a dashboard, and what reaches them (Dashboards.md §2.4, §2.6;
 * AGENTS.md section 7): a role sees the published dashboards granted to
 * it and no other; a viewer gets the layout, never the SQL - not a widget's,
 * not an options query's; a widget runs by id from the published snapshot,
 * whatever the request carries; $USER.* is the viewer's own row; a draft
 * change reaches nobody until published.
 */
const GRANTED = 'V1 Dash Gerencia'
const HIDDEN = 'V1 Dash Directorio'
const ROLE = 'V1 Gerencia'
const EMAIL = 'v1-gerencia@e2e.test'
const PASSWORD = 'v1-gerencia-password'
let granted: DashboardRef
let hidden: DashboardRef
const ids: Record<string, string> = {}

async function cleanUp(page: Page, token: string) {
  await deleteDashboardsNamed(page, token, [GRANTED, HIDDEN])
  for (const user of (await api<{ id: string, email: string }[]>(page, token, 'GET', '/admin/api/users')).filter(u => u.email === EMAIL)) {
    await api(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  }
  for (const role of await api<{ id: string }[]>(page, token, 'GET', `/api/totalbase/table/roles?fields=id&where[name][_eq]=${encodeURIComponent(ROLE)}`)) {
    await api(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await cleanUp(page, token)
  await resetSchema(page, token)
  const role = await api<{ id: string }>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: ROLE, app_access: true } })
  await api(page, token, 'POST', '/admin/api/users', { data: { email: EMAIL, name: 'Gerencia E2E', password: PASSWORD, roleIds: [role.id] } })

  granted = await createDashboard(page, token, GRANTED, [
    { name: 'cliente', label: 'Cliente', type: 'SELECT', options: { source: 'QUERY', query: 'SELECT id::text, nombre FROM public.e2e_v1_clientes ORDER BY nombre' } }
  ])
  ids.ventas = (await addDashboardWidget(page, token, granted.id, { type: 'KPI', label: 'Pedidos', x: 0, y: 0, w: 3, h: 2, query: 'SELECT count(*) AS n FROM public.e2e_v1_pedidos' })).id
  ids.yo = (await addDashboardWidget(page, token, granted.id, { type: 'TABLE', label: 'Quien soy', x: 3, y: 0, w: 6, h: 3, query: 'SELECT $USER.email AS email' })).id
  await api(page, token, 'PUT', `/admin/api/dashboards/${granted.id}/roles`, { data: { roleIds: [role.id] } })
  await publishDashboard(page, token, granted.id)

  hidden = await createDashboard(page, token, HIDDEN)
  ids.oculto = (await addDashboardWidget(page, token, hidden.id, { type: 'KPI', label: 'Secreto', query: 'SELECT 42 AS n' })).id
  await publishDashboard(page, token, hidden.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await cleanUp(page, token)
  await context.close()
})

async function asManager(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/app/)
  const token = (await page.evaluate(() => localStorage.getItem('totalbase_admin_token')))!
  const call = (method: string, path: string, data?: unknown) => page.request.fetch(`${BASE_URL}${path}`, { method, data, headers: { Authorization: `Bearer ${token}` } })
  return { context, page, call }
}

test('the menu lists the dashboard granted to the role, and no other; the other\'s URL shows nothing', async ({ browser, token: _ }) => {
  const { context, page, call } = await asManager(browser)
  try {
    await page.goto('/app')
    await expect(page.getByRole('link', { name: GRANTED })).toBeVisible()
    await expect(page.getByRole('link', { name: HIDDEN })).toHaveCount(0)
    expect((await call('GET', `/app/api/dashboards/${hidden.slug}`)).status()).toBe(404)
    // Its widget, asked for by id through either dashboard: nothing.
    expect((await call('POST', `/app/api/dashboards/${hidden.slug}/widgets/${ids.oculto}/data`, { data: {} })).status()).toBe(404)
    expect((await call('POST', `/app/api/dashboards/${granted.slug}/widgets/${ids.oculto}/data`, { data: {} })).status()).toBeGreaterThanOrEqual(400)
  } finally {
    await context.close()
  }
})

test('a viewer gets the layout, never the SQL - and a widget runs its published query whatever the request carries', async ({ browser, token }) => {
  const { context, page, call } = await asManager(browser)
  try {
    const widgets = await (await call('GET', `/app/api/dashboards/${granted.slug}/widgets`)).json()
    expect(widgets.data.length).toBe(2)
    for (const widget of widgets.data) expect(widget).not.toHaveProperty('query')
    expect(JSON.stringify(widgets)).not.toContain('e2e_v1_pedidos')
    const variables = await (await call('GET', `/app/api/dashboards/${granted.slug}/variables`)).json()
    expect(JSON.stringify(variables)).not.toContain('e2e_v1_clientes')
    // The options themselves, yes - run on the server.
    const options = await (await call('POST', `/app/api/dashboards/${granted.slug}/variables/cliente/options`, { data: { variables: {} } })).json()
    expect(JSON.stringify(options)).toContain('Acme SA')

    const before = (await sql(page, token, 'SELECT count(*)::int AS n FROM public.e2e_v1_clientes')).rows[0]!.n
    const run = await call('POST', `/app/api/dashboards/${granted.slug}/widgets/${ids.ventas}/data`, { data: { query: 'DELETE FROM public.e2e_v1_clientes', variables: {} } })
    expect(run.status()).toBe(200)
    expect((await run.json()).data.rows[0]).toEqual({ n: 22 })
    expect((await sql(page, token, 'SELECT count(*)::int AS n FROM public.e2e_v1_clientes')).rows[0]!.n).toBe(before)
    // The Admin API is administrators' only.
    expect((await call('GET', '/admin/api/dashboards')).status()).toBeGreaterThanOrEqual(401)
    expect((await call('POST', `/admin/api/dashboards/${granted.id}/query`, { data: { query: 'SELECT 1' } })).status()).toBeGreaterThanOrEqual(401)
  } finally {
    await context.close()
  }
})

test('$USER.* is the viewer\'s own row', async ({ browser, token: _ }) => {
  const { context, page } = await asManager(browser)
  try {
    await page.goto(`/app/dashboards/${granted.slug}`)
    await expect(page.locator('main').getByRole('cell', { name: EMAIL })).toBeVisible()
  } finally {
    await context.close()
  }
})

test('a draft change reaches no viewer until published; an unconfigured widget never shows', async ({ browser, page, token }) => {
  await api(page, token, 'PATCH', `/admin/api/dashboards/${granted.id}/widgets/${ids.ventas}`, { data: { query: 'SELECT 999 AS n' } })
  await addDashboardWidget(page, token, granted.id, { type: 'BAR', label: 'Sin configurar', x: 0, y: 3, w: 6, h: 4 })
  const { context, page: viewer } = await asManager(browser)
  try {
    const card = (label: string) => viewer.locator('main div.rounded-lg.border').filter({ has: viewer.getByText(label, { exact: true }) }).last()
    await viewer.goto(`/app/dashboards/${granted.slug}`)
    await expect(card('Pedidos')).toContainText('22')

    await publishDashboard(page, token, granted.id)
    await viewer.reload()
    await expect(card('Pedidos')).toContainText('999')
    await expect(viewer.getByText('Sin configurar', { exact: true })).toHaveCount(0)
  } finally {
    await context.close()
  }
})
