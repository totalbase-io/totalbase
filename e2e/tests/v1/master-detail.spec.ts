import type { Page } from '@playwright/test'
import { adminSession, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * Orders and their items, as any sales system has them - the Master-detail
 * the wizard creates over e2e_v1_pedidos → e2e_v1_pedidos_items. PostgreSQL
 * computes each item's amount (a generated column) and the order's total (a
 * trigger); the page shows both as they change, with no code of its own.
 */
const NAME = 'V1 Pedidos'
let dataview: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  dataview = await createDataView(page, token, {
    name: NAME,
    viewType: 'MASTER_DETAIL',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_pedidos'),
    detail: { resourceId: await resourceId(page, token, 'e2e_v1_pedidos_items'), fkColumn: 'pedido' }
  })
  await publish(page, token, dataview.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

/** A number input's own value (a native number field: no grouping). */
const plain = (n: number) => new RegExp(`^${n.toFixed(2).replace(".", "[.,]")}$`)
const money = (n: number) => new RegExp(n.toLocaleString('en-US', { minimumFractionDigits: 2 }).replace(/[.,]/g, '[.,]'))

/** A line's cell, by its column's title and its line's number (DataViewInlineLines.vue). */
const cell = (page: Page, column: string, line: number) => page.locator('main').getByLabel(`${column}, line ${line}`, { exact: true })

test('an order shows its items, each amount computed by PostgreSQL and formatted as money', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${dataview.slug}?pk=2`)
  const main = page.locator('main')
  await expect(cell(page, 'Descripcion', 1)).toHaveValue('Cable 10 m')
  // `importe` is generated (cantidad * precio): a read-only amount, grouped like any number.
  await expect(main.locator('tbody tr').first()).toContainText(money(6600))
  await expect(main.getByRole('spinbutton', { name: 'Total' })).toHaveValue(plain(6600))
})

test('items added in the grid - Tab past the last cell adds a line - saved with the order in one go, its total recomputed', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${dataview.slug}?pk=2`)
  const main = page.locator('main')
  await expect(cell(page, 'Descripcion', 1)).toHaveValue('Cable 10 m')
  await main.getByRole('button', { name: 'Add item' }).click()
  // The new line's first cell has the focus.
  await expect(cell(page, 'Descripcion', 2)).toBeFocused()
  await cell(page, 'Descripcion', 2).fill('Fusible')
  await cell(page, 'Cantidad', 2).fill('2')
  await cell(page, 'Precio', 2).fill('500')
  await cell(page, 'Precio', 2).press('Tab')
  await expect(cell(page, 'Descripcion', 3)).toBeFocused()
  await cell(page, 'Descripcion', 3).fill('Relé')
  await cell(page, 'Precio', 3).fill('300')
  // Nothing written yet: the order's total is still PostgreSQL's last one.
  await expect(main.getByRole('spinbutton', { name: 'Total' })).toHaveValue(plain(6600))
  await main.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(main.getByRole('spinbutton', { name: 'Total' })).toHaveValue(plain(7900))
  await expect(main.locator('tbody tr').filter({ has: page.getByLabel('Descripcion, line 2', { exact: true }) })).toContainText(money(1000))
})

test('a line refused by its CHECK (cantidad > 0) refuses the whole save - nothing changes, Cancel drops it', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${dataview.slug}?pk=2`)
  const main = page.locator('main')
  await expect(cell(page, 'Descripcion', 1)).toHaveValue('Cable 10 m')
  const lines = await main.locator('tbody tr').count()
  await main.getByRole('button', { name: 'Add item' }).click()
  await cell(page, 'Descripcion', lines + 1).fill('Nada')
  await cell(page, 'Cantidad', lines + 1).fill('0')
  await cell(page, 'Descripcion', 1).fill('Cable 20 m')
  await main.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/More than 0|cantidad/i).first()).toBeVisible()
  await main.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(main.locator('tbody tr')).toHaveCount(lines)
  await page.reload()
  await expect(cell(page, 'Descripcion', 1)).toHaveValue('Cable 10 m')
  await expect(main.locator('tbody tr')).toHaveCount(lines)
})

test('a new order: opened blank - its customer is required, nothing refused before it\'s chosen - saved with its items in one go', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${dataview.slug}`)
  const main = page.locator('main')
  // It needs a customer: no save tried on open, no error shown; its items are typed before it exists.
  await expect(main.getByRole('button', { name: 'Add item' })).toBeVisible()
  await expect(main.getByText('Required')).toHaveCount(0)
  await main.locator('button[aria-haspopup="listbox"]').first().click()
  await page.getByRole('option', { name: 'Delta y Asociados' }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await main.getByRole('button', { name: 'Add item' }).click()
  await cell(page, 'Descripcion', 1).fill('Primer ítem')
  await cell(page, 'Precio', 1).fill('1234.5')
  await main.getByRole('button', { name: 'Save', exact: true }).click()
  // Saved: its key and its defaults (estado BORRADOR) come from PostgreSQL, its total from its items' trigger.
  await expect(main.getByRole('spinbutton', { name: 'Id', exact: true }).first()).toHaveValue(/\d+/)
  await expect(main.getByRole('combobox', { name: 'Estado' })).toContainText('BORRADOR')
  await expect(main.getByRole('spinbutton', { name: 'Total' })).toHaveValue(plain(1234.5))
  await expect(cell(page, 'Descripcion', 1)).toHaveValue('Primer ítem')
})
