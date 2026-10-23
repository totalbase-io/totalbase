import type { Page } from '@playwright/test'
import { addDashboardWidget, addWidget, adminSession, api, createDashboard, createDataView, deleteDashboardsNamed, deleteDataViewsNamed, expect, publish, publishDashboard, test, type DashboardRef } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * A report as it's read: a TABLE widget's SQL conventions (Dashboards.md §6
 * - `_` columns never shown, `_color` tinting a row, `_<column>_color`
 * as badges, a totals row, sorting, a column's own title and format); the
 * layout re-flowed for a tablet and a phone (0.2.1); versions published and
 * an earlier one restored; and a dashboard shown inside a CUSTOM page, its
 * variables set from the page.
 */
const REPORT = 'V1 Dash Reporte'
const EMBEDDED = 'V1 Dash Embebido'
const PAGE = 'V1 Dash Pagina'
let report: DashboardRef
let embedded: DashboardRef

const ORDERS_SQL = `SELECT * FROM (VALUES
  (1001, 'Ana', 100.5, 'PAID', 'emerald', NULL),
  (1002, 'Luis', 200, 'CANCELLED', 'red', 'red'),
  (1003, 'Marta', 50.25, 'PAID', 'emerald', NULL)
) AS t(numero, cliente, total, estado, _estado_color, _color)`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [PAGE])
  await deleteDashboardsNamed(page, token, [REPORT, EMBEDDED])
  report = await createDashboard(page, token, REPORT)
  for (const [i, label] of ['Uno', 'Dos', 'Tres', 'Cuatro'].entries()) {
    await addDashboardWidget(page, token, report.id, { type: 'KPI', label, x: i * 3, y: 0, w: 3, h: 2, query: `SELECT ${i + 1} AS n` })
  }
  await addDashboardWidget(page, token, report.id, {
    type: 'TABLE', label: 'Pedidos', x: 0, y: 2, w: 12, h: 5, query: ORDERS_SQL,
    config: { columnSettings: { total: { label: 'Importe', displayFormat: '#,##0.00', total: 'sum' } } }
  })
  await publishDashboard(page, token, report.id)

  embedded = await createDashboard(page, token, EMBEDDED, [
    { name: 'estado', label: 'Estado', type: 'SELECT', options: { source: 'STATIC', values: ['PAID', 'CANCELLED'] } }
  ])
  await addDashboardWidget(page, token, embedded.id, { type: 'TABLE', label: 'Filtrados', x: 0, y: 0, w: 12, h: 4, query: `SELECT numero, cliente FROM (${ORDERS_SQL}) o WHERE ($VAR.estado IS NULL OR estado = $VAR.estado)` })
  await publishDashboard(page, token, embedded.id)
  const custom = await createDataView(page, token, { name: PAGE, viewType: 'CUSTOM' })
  await addWidget(page, token, custom.id, 'TDashboard', { props: { dashboard: embedded.id, variables: { estado: '"CANCELLED"' } } })
  await publish(page, token, custom.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [PAGE])
  await deleteDashboardsNamed(page, token, [REPORT, EMBEDDED])
  await context.close()
})

const card = (page: Page, title: string) => page.locator('main div.rounded-lg.border').filter({ has: page.getByText(title, { exact: true }) }).last()

test('a TABLE widget: its _ columns never shown, a row tinted, a column as badges, totals, sorting, a column\'s title and format', async ({ page, token: _ }) => {
  await page.goto(`/app/dashboards/${report.slug}`)
  const table = card(page, 'Pedidos')
  await expect(table.locator('tbody tr')).toHaveCount(3)
  const headers = await table.locator('thead').getByRole('columnheader').allTextContents()
  expect(headers.map(h => h.trim())).toEqual(['numero', 'cliente', 'Importe', 'estado'])
  // _color: the cancelled order's row tinted; the others not.
  const luis = table.locator('tbody tr').filter({ hasText: 'Luis' })
  expect(await luis.getAttribute('style')).toContain('color-mix')
  expect((await table.locator('tbody tr').filter({ hasText: 'Ana' }).getAttribute('style')) ?? '').not.toContain('color-mix')
  // _estado_color: estado as a colored badge.
  await expect(luis.locator('span[style*="background"]', { hasText: 'CANCELLED' })).toHaveCount(1)
  // Its Format, and the totals row summing it.
  await expect(luis).toContainText(/200[.,]00/)
  await expect(table.locator('tfoot')).toContainText(/350[.,]75/)
  // A header click sorts the loaded rows.
  await table.getByRole('button', { name: 'Importe' }).click()
  await expect(table.locator('tbody tr').first()).toContainText('Marta')
  await table.getByRole('button', { name: 'Importe' }).click()
  await expect(table.locator('tbody tr').first()).toContainText('Luis')
})

test.describe('on a tablet and on a phone', () => {
  const widthOf = async (page: Page, title: string) => (await card(page, title).boundingBox())!.width
  const topOf = async (page: Page, title: string) => (await card(page, title).boundingBox())!.y

  test('a tablet (a 6-column grid): the quarter-wide KPIs two to a row', async ({ browser, token: _ }) => {
    // The viewer re-flows by its grid's own width (641-800px: 6 columns) - a tablet held upright, the App compact.
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 820, height: 1180 }, hasTouch: true })
    const page = await context.newPage()
    const { login } = await import('../helpers.js')
    await login(page)
    await page.goto(`/app/dashboards/${report.slug}`)
    await expect(card(page, 'Cuatro')).toContainText('4')
    const grid = (await page.locator('main .grid-stack').first().boundingBox())!.width
    expect(grid).toBeGreaterThan(640)
    expect(grid).toBeLessThanOrEqual(800)
    await expect.poll(async () => Math.abs(await topOf(page, 'Uno') - await topOf(page, 'Dos'))).toBeLessThan(4)
    expect(await topOf(page, 'Tres')).toBeGreaterThan(await topOf(page, 'Uno') + 20)
    await context.close()
  })

  test('a phone: KPIs two to a row, every other widget the screen\'s width', async ({ browser, token: _ }) => {
    const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
    const page = await context.newPage()
    const { login } = await import('../helpers.js')
    await login(page)
    await page.goto(`/app/dashboards/${report.slug}`)
    await expect(card(page, 'Cuatro')).toContainText('4')
    // Dashboards.md §7.2: a phone has 2 columns - Uno and Dos share a row, Pedidos takes it whole.
    await expect.poll(async () => Math.abs(await topOf(page, 'Uno') - await topOf(page, 'Dos'))).toBeLessThan(4)
    expect(await widthOf(page, 'Uno')).toBeLessThan((await widthOf(page, 'Pedidos')) * 0.6)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
    await context.close()
  })
})

test('versions: a change published as v2, then v1 restored and published again', async ({ page, token }) => {
  const kpis = await api<{ id: string, label: string }[]>(page, token, 'GET', `/admin/api/dashboards/${report.id}/widgets`)
  const uno = kpis.find(w => w.label === 'Uno')!
  await api(page, token, 'PATCH', `/admin/api/dashboards/${report.id}/widgets/${uno.id}`, { data: { query: 'SELECT 100 AS n' } })
  await publishDashboard(page, token, report.id)
  await page.goto(`/app/dashboards/${report.slug}`)
  await expect(card(page, 'Uno')).toContainText('100')

  const versions = await api<{ version: number }[]>(page, token, 'GET', `/admin/api/dashboards/${report.id}/versions`)
  expect(versions.map(v => v.version).sort()).toEqual([1, 2])
  await api(page, token, 'POST', `/admin/api/dashboards/${report.id}/versions/1/restore`)
  // Restored into the draft: the App still shows v2 until it's published.
  await page.reload()
  await expect(card(page, 'Uno')).toContainText('100')
  await publishDashboard(page, token, report.id)
  await page.reload()
  await expect(card(page, 'Uno').locator('p').nth(1)).toHaveText('1')
})

test('a dashboard inside a CUSTOM page: its variable set by the page, hidden from its bar', async ({ page, token: _ }) => {
  await page.goto(`/app/dataviews/v1-dash-pagina`)
  const table = card(page, 'Filtrados')
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await expect(table).toContainText('Luis')
  await expect(page.locator('main').getByRole('button', { name: 'Estado' })).toHaveCount(0)
  await expect(page.locator('main').getByRole('combobox', { name: 'Estado' })).toHaveCount(0)
})
