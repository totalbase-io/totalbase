import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { adminSession, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * A grid's toolbar as daily work uses it: filter, choose columns (kept for
 * the viewer across reloads), save a view, export what's shown to CSV,
 * import rows from a CSV - all of them or none - and read a row's history.
 */
const NAME = 'V1 Toolbar'
let dataview: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  dataview = await createDataView(page, token, {
    name: NAME,
    viewType: 'TABLE',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'),
    selectedColumns: ['nombre', 'email', 'categoria', 'activo', 'limite_credito']
  })
  await publish(page, token, dataview.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

async function openGrid(page: Page) {
  await page.goto(`/admin/app/dataviews/${dataview.slug}`)
  const main = page.locator('main')
  await expect(main.locator('tbody tr').first()).toBeVisible()
  return main
}
const rows = (page: Page) => page.locator('main tbody tr')

test('a filter written as the Data API\'s own where narrows the rows', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('button', { name: /^Filter/ }).click()
  const panel = page.getByRole('dialog', { name: 'Filter' })
  await panel.getByRole('button', { name: 'Advanced' }).click()
  await panel.getByRole('textbox').last().fill('{ "activo": { "_eq": "false" } }')
  await panel.getByRole('textbox').last().blur()
  await panel.getByRole('button', { name: 'Close' }).last().click()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Gamma Coop')
})

test('a hidden column stays hidden for this viewer after a reload', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Columns' }).click()
  await page.getByRole('dialog', { name: 'Columns' }).getByRole('checkbox', { name: 'Email' }).click()
  await page.keyboard.press('Escape')
  await expect(main.getByRole('columnheader', { name: 'Email' })).toHaveCount(0)
  await page.waitForTimeout(1000)
  await page.reload()
  await expect(rows(page).first()).toBeVisible()
  await expect(main.getByRole('columnheader', { name: 'Email' })).toHaveCount(0)
  // Back for the next tests.
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Columns' }).click()
  await page.getByRole('dialog', { name: 'Columns' }).getByRole('checkbox', { name: 'Email' }).click()
  await page.keyboard.press('Escape')
  await expect(main.getByRole('columnheader', { name: 'Email' })).toBeVisible()
  // Kept a moment after the change - before this page closes.
  await page.waitForTimeout(1000)
})

test('a filter saved as a view comes back in one click', async ({ page, token }) => {
  const main = await openGrid(page)
  // A view keeps the filter, columns, sort and density - not the search box.
  await main.getByRole('button', { name: /^Filter/ }).click()
  const filter = page.getByRole('dialog', { name: 'Filter' })
  await filter.getByRole('button', { name: 'Advanced' }).click()
  await filter.getByRole('textbox').last().fill('{ "categoria": { "_eq": "3" } }')
  await filter.getByRole('textbox').last().blur()
  await filter.getByRole('button', { name: 'Close' }).last().click()
  await expect(rows(page)).toHaveCount(1)
  // The view selector ("View: Default"): Save current view…
  const selector = main.getByRole('button', { name: /^View: / }).first()
  await selector.click()
  // The popover's Save current view… turns it into the save form, by name.
  await page.getByRole('button', { name: 'Save current view…' }).click()
  const viewName = page.getByRole('dialog').getByLabel('Name')
  await viewName.fill('Solo Gobierno')
  await page.getByRole('dialog').getByRole('button', { name: 'Save', exact: true }).click()
  await expect(viewName).toBeHidden()

  // Cleared, then the view brings the filter back.
  await main.getByRole('button', { name: /^Filter/ }).click()
  await page.getByRole('dialog', { name: 'Filter' }).getByRole('button', { name: 'Clear' }).click()
  await page.keyboard.press('Escape')
  await expect(rows(page)).not.toHaveCount(1)
  await selector.click()
  await page.getByRole('dialog').getByRole('button', { name: /^Solo Gobierno/ }).click()
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Gamma Coop')
  // Gone for the next tests: the open view is remembered for the viewer, and reopens with its filter.
  const headers = { authorization: `Bearer ${token}` }
  const { data: views } = await (await page.request.get(`/app/api/dataviews/${dataview.id}/saved-views`, { headers })).json() as { data: { id: string }[] }
  for (const view of views) await page.request.delete(`/app/api/dataviews/${dataview.id}/saved-views/${view.id}`, { headers })
})

test('export: a CSV of what the grid shows, formatted as it shows it', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('acme')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText('Acme SA')
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Export/ }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export', exact: true }).click()
  const file = await (await download).path()
  const csv = readFileSync(file!, 'utf8')
  expect(csv.split(/\r?\n/)[0]).toContain('Nombre')
  expect(csv).toContain('Acme SA')
  expect(csv).toContain('compras@acme.test')
  expect(csv).not.toContain('Beta SRL')
})

test('import: every row of a CSV created together - or, one failing, none', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  const importCsv = async (content: string) => {
    const path = join(tmpdir(), `v1-import-${Date.now()}.csv`)
    writeFileSync(path, content)
    await main.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Import/ }).click()
    const panel = page.getByRole('dialog', { name: 'Import' })
    const chooser = page.waitForEvent('filechooser')
    await panel.getByRole('button', { name: 'Choose a CSV file…' }).click()
    await (await chooser).setFiles(path)
    await panel.getByRole('button', { name: 'Import', exact: true }).click()
    return panel
  }
  // One row repeats an existing email (UNIQUE): nothing is created.
  const failing = await importCsv('nombre,email\nImport Uno,imp1@e2e.test\nImport Dos,compras@acme.test\n')
  await expect(failing).toContainText(/duplicate|unique|failed|error/i)
  await failing.getByRole('button', { name: 'Close' }).last().click()
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('import')
  await expect(rows(page).filter({ hasText: 'Import Uno' })).toHaveCount(0)

  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('')
  const done = await importCsv('nombre,email\nImport Uno,imp1@e2e.test\nImport Dos,imp2@e2e.test\n')
  await expect(done).toContainText('2 row(s) imported')
  await done.getByRole('button', { name: 'Close' }).last().click()
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('import')
  await expect(rows(page)).toHaveCount(2)
})

test('a row\'s Activity shows the change just saved', async ({ page, token: _ }) => {
  await openGrid(page)
  await rows(page).filter({ hasText: 'Beta SRL' }).click()
  const form = page.getByRole('dialog')
  await form.getByRole('textbox', { name: 'Email' }).fill('historial@beta.test')
  // What's typed stays: the row is read once, before the field opens - never again over it.
  await expect(form.getByRole('textbox', { name: 'Email' })).toHaveValue('historial@beta.test')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toBeHidden()
  await rows(page).filter({ hasText: 'Beta SRL' }).getByRole('button', { name: 'Record actions' }).click()
  await page.getByRole('menuitem', { name: /Activity/ }).click()
  const activity = page.getByRole('dialog').last()
  await expect(activity).toContainText('Updated')
  // The entry opens in the same sidebar, as a diff - and back returns to the list.
  await activity.getByRole('button').filter({ hasText: 'Updated' }).first().click()
  await expect(activity.getByText('historial@beta.test').first()).toBeVisible()
  await activity.getByRole('button', { name: 'Back to the activity' }).click()
  await expect(activity.getByRole('button').filter({ hasText: 'Updated' }).first()).toBeVisible()
})
