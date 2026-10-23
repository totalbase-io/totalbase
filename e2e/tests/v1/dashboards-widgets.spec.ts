import type { Locator, Page } from '@playwright/test'
import { DASHBOARD_WIDGET_CATALOG, DASHBOARD_WIDGET_TYPES } from '../../../packages/tb-catalog/dist/index.js'
import { addDashboardWidget, adminSession, createDashboard, deleteDashboardsNamed, expect, publishDashboard, test, type DashboardRef } from './fixtures.js'

/**
 * Every dashboard widget type (DASHBOARD_WIDGET_TYPES, read from
 * @totalbase/tb-catalog) on one dashboard, each running its catalog's own
 * Example SQL - published, drawn in the App and in the editor, with no
 * console error. A type added to the catalog is on this dashboard by itself.
 */
const NAME = 'V1 Dash Widgets'
let dashboard: DashboardRef

type Catalog = Record<string, { label: string, size: { w: number, h: number }, query: boolean, page?: string, example?: string }>
const CATALOG = DASHBOARD_WIDGET_CATALOG as unknown as Catalog
const title = (type: string) => `W ${type}`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  dashboard = await createDashboard(page, token, NAME)
  let y = 0
  for (const type of DASHBOARD_WIDGET_TYPES) {
    const entry = CATALOG[type]!
    await addDashboardWidget(page, token, dashboard.id, {
      type, label: title(type), x: 0, y, w: entry.size.w, h: entry.size.h,
      ...(entry.example ? { query: entry.example } : {}),
      // A presentation widget's formula reads its query's first row (D3).
      // A pivot's aggregate is chosen, never guessed (D17).
      ...(type === 'PIVOT' ? { config: { aggregates: { total: 'sum' } } } : {}),
      ...(type === 'TText' ? { config: { props: { label: 'x' }, bindings: { label: { kind: 'formula', formula: '"Revenue: " + {{row.revenue}}' } } } } : {})
    })
    y += entry.size.h
  }
  await publishDashboard(page, token, dashboard.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await context.close()
})

/** A widget's card - the bordered box holding its title. */
function card(page: Page, type: string): Locator {
  return page.locator('main div.rounded-lg.border').filter({ has: page.getByText(title(type), { exact: true }) }).last()
}

/** What each type draws, from its Example's rows. */
async function expectDrawn(page: Page, type: string) {
  const box = card(page, type)
  await box.scrollIntoViewIfNeeded()
  switch (type) {
    // Compact by default (Dashboards.md §5.10): 1250 reads 1.3K.
    case 'KPI': return expect(box).toContainText(/1[.,]3K/)
    case 'GAUGE': return expect(box.locator('canvas').first()).toBeVisible()
    // Nuxt UI's UProgress, no chart (§5.15).
    case 'PROGRESS': return expect(box.getByRole('progressbar')).toBeVisible()
    // One row as label / value pairs.
    case 'DETAIL': return expect(box).toContainText('Ana Pérez')
    case 'LEADERBOARD': return expect(box).toContainText('Ana')
    case 'TABLE':
      await expect(box.locator('tbody tr')).toHaveCount(3)
      // _status_color is never a column: it colors status as badges.
      return expect(box.getByRole('columnheader', { name: '_status_color' })).toHaveCount(0)
    // Charts and the map load on demand (their libraries are chunks of their own): a busy dev server takes its time.
    case 'MAP': return expect(box.locator('.leaflet-container')).toBeVisible({ timeout: 15_000 })
    case 'TText': return expect(box).toContainText('Revenue: 1250')
    default:
      if (CATALOG[type]!.page) return expect(box).toBeVisible()
      // A chart's canvas, or the table a pivot draws.
      return expect(box.locator('canvas, table').first(), `${type} draws`).toBeVisible({ timeout: 15_000 })
  }
}

test('every widget type of the catalog is on this dashboard', () => {
  expect(DASHBOARD_WIDGET_TYPES.length).toBeGreaterThanOrEqual(20)
})

test('every widget type runs its Example in the App, with no console error', async ({ page, token: _ }) => {
  test.setTimeout(90_000)
  await page.goto(`/app/dashboards/${dashboard.slug}`)
  await expect(page.locator('main').getByRole('heading', { name: NAME })).toBeVisible()
  for (const type of DASHBOARD_WIDGET_TYPES) await expectDrawn(page, type)
})

test('every widget type is drawn in the editor too', async ({ page, token: _ }) => {
  test.setTimeout(90_000)
  await page.goto(`/dashboards/${dashboard.id}`)
  await expect(page.locator('main').getByRole('button', { name: 'Settings', exact: true })).toBeVisible()
  for (const type of DASHBOARD_WIDGET_TYPES) await expectDrawn(page, type)
})
