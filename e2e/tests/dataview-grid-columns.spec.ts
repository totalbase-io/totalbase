import { expect, test, type Page } from '@playwright/test'
import { apiRequest, login, publishDataView, watchApiFailures } from './helpers.js'

/**
 * A grid's columns handled like a spreadsheet's (DataViews.md §4.2, §4.3, §5.2, §5.9): a header's menu (sort,
 * align), its width and its place dragged with the mouse - each kept in the viewer's preferences -, a type's
 * alignment, a column the table gains reaching the list and the record form by itself, and a card's description
 * cut to its lines.
 */
// One viewer's preferences, read and written by every test here: one after the other.
test.describe.configure({ mode: 'serial' })

const TABLE = 'grid_columns_items'
const NAME = 'Grid Columns Test'
const CARDS = 'Grid Columns Cards'

let token = ''
let dataview: { id: string, slug: string }

async function sql(page: Page, statements: string) {
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: statements } })
}
async function resourceId(page: Page): Promise<string> {
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', '/api/totalbase/table/resources?fields=id,name,schema,status&where[type][_eq]=TABLE&limit=500'
  )
  return resources.find(r => r.schema === 'public' && r.name === TABLE && r.status === 'ACTIVE')!.id
}
async function removeOurs(page: Page) {
  const existing = await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of existing.filter(d => d.name === NAME || d.name === CARDS)) await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
}
type Prefs = { columnPrefs?: Record<string, { order: number, visible?: boolean, width?: number, align?: string }>, sort?: string }
const prefs = async (page: Page) => (await apiRequest<{ config: Prefs } | null>(page, token, 'GET', `/app/api/dataviews/${dataview.id}/user-prefs`))?.config
const headerBox = (page: Page, column: string) => page.locator(`[data-col-box="${column}"]`)
const headerTitles = async (page: Page) => (await page.locator('[data-col-box]').evaluateAll(els => els.map(el => el.getAttribute('data-col-box'))))

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  token = await login(page)
  await removeOurs(page)
  await sql(page, `
    DELETE FROM totalbase.resources WHERE schema = 'public' AND name = '${TABLE}';
    DROP TABLE IF EXISTS public.${TABLE} CASCADE;
    CREATE TABLE public.${TABLE} (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      code varchar(12) NOT NULL,
      name text NOT NULL,
      amount numeric(12,2),
      due date,
      notes text
    );
    INSERT INTO public.${TABLE} (code, name, amount, due, notes) VALUES
      ('A-1', 'Alpha', 10.5, '2026-01-10', 'A short note.'),
      ('B-2', 'Beta', 2500, '2026-02-20', repeat('A long description that goes on and on. ', 40)),
      ('C-3', 'Gamma', 300, '2026-03-30', NULL);
  `)
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const id = await resourceId(page)
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  // No columns picked, no New table columns said: every column shown, a new one added shown (§4.2).
  dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', { data: { name: NAME, sourceResourceId: id, viewType: 'TABLE' } })
  await publishDataView(page, token, dataview.id)
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  token = await login(page)
  await removeOurs(page)
  await sql(page, `DELETE FROM totalbase.resources WHERE schema = 'public' AND name = '${TABLE}'; DROP TABLE IF EXISTS public.${TABLE} CASCADE;`)
  await page.close()
})

async function openGrid(page: Page) {
  token = await login(page)
  // A fresh viewer's state: their preferences cleared.
  await apiRequest(page, token, 'PUT', `/app/api/dataviews/${dataview.id}/user-prefs`, { data: { config: {} } })
  await page.goto(`/app/dataviews/${dataview.slug}`)
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible()
}

test('a header\'s menu sorts and aligns - a number and a date right by their type, a text left', async ({ page }) => {
  const failures = watchApiFailures(page)
  await openGrid(page)
  // By its type: a number and a date right, a text left - its header too.
  await expect(page.getByRole('cell', { name: '2,500.00' })).toHaveClass(/text-right/)
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toHaveClass(/text-left/)

  // A click opens the menu, and it stays open.
  await page.getByRole('button', { name: 'Amount: sort, filter, hide, align' }).click()
  const menu = page.getByRole('menu')
  await expect(menu).toBeVisible()
  await page.waitForTimeout(400)
  await expect(menu).toBeVisible()
  await menu.getByRole('menuitemcheckbox', { name: 'Sort descending' }).click()
  await expect(page.locator('tbody tr').first()).toContainText('Beta')
  await expect.poll(async () => (await prefs(page))?.sort).toBe('-amount')

  // The viewer's own alignment, kept.
  await page.getByRole('button', { name: 'Name: sort, filter, hide, align' }).click()
  await page.getByRole('menu').getByRole('menuitemcheckbox', { name: 'Align center' }).click()
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toHaveClass(/text-center/)
  await expect.poll(async () => (await prefs(page))?.columnPrefs?.name?.align).toBe('center')
  expect(failures).toEqual([])
})

test('a header\'s edge drags its width, kept after a reload; a double click goes back', async ({ page }) => {
  await openGrid(page)
  const before = (await headerBox(page, 'name').boundingBox())!.width
  const edge = (await page.locator('[data-col-resize="name"]').boundingBox())!
  await page.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2)
  await page.mouse.down()
  await page.mouse.move(edge.x + edge.width / 2 + 120, edge.y + edge.height / 2, { steps: 8 })
  await page.mouse.up()
  // Dragging never opened a menu.
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(async () => (await prefs(page))?.columnPrefs?.name?.width ?? 0).toBeGreaterThan(before + 100)

  await page.reload()
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible()
  expect((await headerBox(page, 'name').boundingBox())!.width).toBeGreaterThan(before + 100)

  await page.locator('[data-col-resize="name"]').dblclick()
  await expect.poll(async () => (await prefs(page))?.columnPrefs?.name?.width).toBeUndefined()
})

test('a header dragged moves its column, kept after a reload - and opens no menu', async ({ page }) => {
  await openGrid(page)
  const order = await headerTitles(page)
  expect(order.indexOf('amount')).toBeGreaterThan(order.indexOf('code'))

  const from = (await headerBox(page, 'amount').boundingBox())!
  const to = (await headerBox(page, 'code').boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await expect.poll(async () => {
    const now = await headerTitles(page)
    return now.indexOf('amount') < now.indexOf('code')
  }).toBe(true)
  // Kept with the viewer's preferences (saved a moment after the change).
  await expect.poll(async () => {
    const columns = (await prefs(page))?.columnPrefs ?? {}
    return (columns.amount?.order ?? 99) < (columns.code?.order ?? -1)
  }).toBe(true)

  await page.reload()
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible()
  const kept = await headerTitles(page)
  expect(kept.indexOf('amount')).toBeLessThan(kept.indexOf('code'))
})

test('a column the table gains reaches the DataView by itself - shown, and at the end of its record form', async ({ page }) => {
  token = await login(page)
  await sql(page, `ALTER TABLE public.${TABLE} ADD COLUMN extra text`)
  // The catalog sync - what the watch runs within seconds - brings it.
  const synced = await apiRequest<{ dataviewsSynced: number }>(page, token, 'POST', '/admin/api/catalog/refresh')
  expect(synced.dataviewsSynced).toBeGreaterThanOrEqual(1)
  const fields = await apiRequest<{ kind: string, widget: string | null, columnName: string | null, visible: boolean, gridY: number, config: { props?: { column?: string } } }[]>(
    page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`
  )
  expect(fields.find(f => f.kind === 'COLUMN' && f.columnName === 'extra')).toMatchObject({ visible: true })
  const form = fields.filter(f => f.kind === 'WIDGET' && f.widget === 'UFormField').sort((a, b) => a.gridY - b.gridY).map(f => f.config.props?.column)
  expect(form.at(-1)).toBe('extra')
})

// DataViews.md §4.1: a column the DataView hides is read but not shown, and the viewer shows it from the Columns panel.
test('a column the DataView hides is shown from the Columns panel - with a header, and kept after a reload', async ({ page }) => {
  token = await login(page)
  const fields = await apiRequest<{ id: string, kind: string, columnName: string | null }[]>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`)
  const notes = fields.find(f => f.kind === 'COLUMN' && f.columnName === 'notes')!
  await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}/fields/${notes.id}`, { data: { visible: false } })
  await publishDataView(page, token, dataview.id)

  // A fresh viewer's state (openGrid's, already signed in here).
  await apiRequest(page, token, 'PUT', `/app/api/dataviews/${dataview.id}/user-prefs`, { data: { config: {} } })
  await page.goto(`/app/dataviews/${dataview.slug}`)
  await expect(headerBox(page, 'code')).toBeVisible()
  await expect(headerBox(page, 'notes')).toHaveCount(0)

  // The toolbar's "⋮" (compact, the instance's default), then the Columns panel.
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Columns/ }).click()
  const columns = page.getByRole('dialog', { name: 'Columns' })
  await columns.getByRole('checkbox', { name: 'Notes' }).click()
  await columns.getByRole('button', { name: 'Close' }).last().click()
  await expect(headerBox(page, 'notes')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'A short note.' })).toBeVisible()
  await expect.poll(async () => (await prefs(page))?.columnPrefs?.notes?.visible).toBe(true)

  await page.reload()
  await expect(page.getByRole('cell', { name: 'Alpha', exact: true })).toBeVisible()
  await expect(headerBox(page, 'notes')).toBeVisible()
})

test('a card\'s description takes at most 3 lines, its whole text on hover', async ({ page }) => {
  token = await login(page)
  const cards = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', {
    data: { name: CARDS, sourceResourceId: await resourceId(page), viewType: 'CARDS', viewConfig: { card_layout: { titleFormula: '{{name}}', descriptionFormula: '{{notes}}' } } }
  })
  await publishDataView(page, token, cards.id)
  await page.goto(`/app/dataviews/${cards.slug}`)
  const description = page.locator('p', { hasText: 'A long description that goes on' }).first()
  await expect(description).toBeVisible()
  expect(await description.evaluate(el => getComputedStyle(el).webkitLineClamp)).toBe('3')
  const lineHeight = await description.evaluate(el => Number.parseFloat(getComputedStyle(el).lineHeight))
  expect((await description.boundingBox())!.height).toBeLessThanOrEqual(lineHeight * 3 + 1)
})
