import type { Page } from '@playwright/test'
import { addDashboardWidget, adminSession, createDashboard, deleteDashboardsNamed, expect, publishDashboard, resetSchema, test, type DashboardRef } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * A dashboard's variables bar, as a report's filters are used
 * (Dashboards.md §3): a date range from
 * its presets, a list from static values or from a query, several picked at
 * once, free text, a number - each bound into the widgets' SQL, the values
 * mirrored in the URL (a shared link shows the same), and only the widgets
 * using a variable run again when it changes.
 *
 * The seed: 22 orders - 11 CONFIRMADO, 6 BORRADOR, 5 ANULADO; 8 of them Beta SRL's.
 */
const NAME = 'V1 Dash Vars'
let dashboard: DashboardRef

const RANGE = '($VAR.rango.from IS NULL OR fecha >= $VAR.rango.from) AND ($VAR.rango.to IS NULL OR fecha < $VAR.rango.to)'
const ORDERS = 'SELECT count(*) AS n FROM public.e2e_v1_pedidos'
const KPIS: Record<string, string> = {
  'Por rango': `${ORDERS} WHERE ${RANGE}`,
  'Por estado': `${ORDERS} WHERE ($VAR.estado IS NULL OR estado = $VAR.estado)`,
  'Por cliente': `${ORDERS} WHERE ($VAR.cliente IS NULL OR cliente::text = $VAR.cliente)`,
  'Por estados': `${ORDERS} WHERE ($VAR.estados IS NULL OR estado = ANY($VAR.estados))`,
  'Por texto': "SELECT count(*) AS n FROM public.e2e_v1_clientes WHERE nombre ILIKE '%' || coalesce($VAR.texto, '') || '%'",
  'Por minimo': 'SELECT count(*) AS n FROM public.e2e_v1_clientes WHERE ($VAR.minimo IS NULL OR limite_credito >= $VAR.minimo)',
  'Fijo': 'SELECT 7 AS n'
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await resetSchema(page, token)
  dashboard = await createDashboard(page, token, NAME, [
    { name: 'rango', label: 'Rango', type: 'DATE_RANGE', default: { source: 'constant', value: 'last_30_days' } },
    { name: 'estado', label: 'Estado', type: 'SELECT', options: { source: 'STATIC', values: ['CONFIRMADO', 'BORRADOR', 'ANULADO'] } },
    { name: 'cliente', label: 'Cliente', type: 'SELECT', options: { source: 'QUERY', query: 'SELECT id::text, nombre FROM public.e2e_v1_clientes WHERE id IN (1, 2, 4) ORDER BY nombre' } },
    { name: 'estados', label: 'Estados', type: 'SELECT', multiple: true, options: { source: 'STATIC', values: ['CONFIRMADO', 'BORRADOR', 'ANULADO'] } },
    { name: 'texto', label: 'Texto', type: 'TEXT' },
    { name: 'minimo', label: 'Minimo', type: 'NUMBER' }
  ])
  let x = 0
  for (const [label, query] of Object.entries(KPIS)) {
    await addDashboardWidget(page, token, dashboard.id, { type: 'KPI', label, x: x % 12, y: Math.floor(x / 12) * 2, w: 3, h: 2, query })
    x += 3
  }
  await publishDashboard(page, token, dashboard.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await context.close()
})

const kpi = (page: Page, label: string) => page.locator('main div.rounded-lg.border').filter({ has: page.getByText(label, { exact: true }) }).last()
const value = (page: Page, label: string) => kpi(page, label).locator('p').nth(1)

async function pick(page: Page, variable: string, option: string) {
  await page.locator('main').getByRole('button', { name: variable }).or(page.locator('main').getByRole('combobox', { name: variable })).first().click()
  await page.getByRole('option', { name: option, exact: true }).click()
  // A multiple select stays open after a pick: closed before anything else is typed (its focus trap would take it).
  for (let i = 0; i < 3 && await page.getByRole('listbox').count(); i++) await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

test('each variable filters the widgets that use it, and the defaults apply on open', async ({ page, token: _ }) => {
  await page.goto(`/app/dashboards/${dashboard.slug}`)
  // No value set: every order, every customer.
  await expect(value(page, 'Por estado')).toHaveText('22')
  await expect(value(page, 'Por texto')).toHaveText('30')
  await expect(value(page, 'Fijo')).toHaveText('7')
  // The range's default (last 30 days): fewer than all, more than none.
  const recent = Number(await value(page, 'Por rango').textContent())
  expect(recent).toBeGreaterThan(0)
  expect(recent).toBeLessThan(22)

  // A date range preset.
  await pick(page, 'Rango', 'All time')
  await expect(value(page, 'Por rango')).toHaveText('22')
  // A static list.
  await pick(page, 'Estado', 'CONFIRMADO')
  await expect(value(page, 'Por estado')).toHaveText('11')
  // A list from a query: its labels, its values bound.
  await pick(page, 'Cliente', 'Beta SRL')
  await expect(value(page, 'Por cliente')).toHaveText('8')
  // Several at once.
  await pick(page, 'Estados', 'BORRADOR')
  await pick(page, 'Estados', 'ANULADO')
  await expect(value(page, 'Por estados')).toHaveText('11')
  // Free text, a number.
  await page.locator('main').getByRole('textbox', { name: 'Texto' }).fill('delta')
  await page.locator('main').getByRole('textbox', { name: 'Texto' }).press('Enter')
  await expect(value(page, 'Por texto')).toHaveText('1')
  await page.locator('main').getByRole('spinbutton', { name: 'Minimo' }).fill('100000')
  await page.locator('main').getByRole('spinbutton', { name: 'Minimo' }).press('Enter')
  await expect(value(page, 'Por minimo')).toHaveText('2')
})

test('the values live in the URL - a shared link shows the same', async ({ page, browser, token: _ }) => {
  await page.goto(`/app/dashboards/${dashboard.slug}`)
  await pick(page, 'Estado', 'ANULADO')
  await expect(value(page, 'Por estado')).toHaveText('5')
  await expect(page).toHaveURL(/estado=ANULADO/)
  const shared = page.url()

  const other = await browser.newContext({ baseURL: BASE_URL, storageState: await page.context().storageState() })
  const second = await other.newPage()
  await second.goto(shared)
  // A fresh browser context loads the dev server's modules cold.
  await expect(value(second, 'Por estado')).toHaveText('5', { timeout: 20_000 })
  await other.close()
})

test('changing a variable runs again only the widgets that use it', async ({ page, token: _ }) => {
  await page.goto(`/app/dashboards/${dashboard.slug}`)
  await expect(value(page, 'Fijo')).toHaveText('7')
  const runs: string[] = []
  page.on('request', (request) => {
    if (/\/widgets\/[0-9a-f-]+\/data$/.test(request.url())) runs.push(request.url())
  })
  await pick(page, 'Estado', 'BORRADOR')
  await expect(value(page, 'Por estado')).toHaveText('6')
  await page.waitForTimeout(500)
  expect(runs).toHaveLength(1)
})
