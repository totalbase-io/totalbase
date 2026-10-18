import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView } from './helpers.js'

/**
 * Covers the grid's "Import" sidebar (see the chat: its own button next
 * to New, not folded into Export - Import needs write access, Export
 * doesn't) - pick a CSV, auto-match columns by header name, preview,
 * and bulk-create rows (?bulk=true, chunked client-side).
 */
const NAME = 'Import Test'

// The DataView this run created, deleted by its id once the test ends.
let created: { token: string, id: string } | undefined
test.afterEach(async ({ page }) => {
  if (created) await apiRequest(page, created.token, 'DELETE', `/admin/api/dataviews/${created.id}`)
  created = undefined
})

test('importing a CSV auto-matches columns and creates rows', async ({ page }) => {
  const token = await login(page)

  const existingDataviews = await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of existingDataviews.filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DELETE FROM totalbase.resources WHERE schema = 'public' AND name = 'import_test_items';
      DROP TABLE IF EXISTS public.import_test_items CASCADE;
      CREATE TABLE public.import_test_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        code text NOT NULL,
        qty integer
      );
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', '/api/totalbase/table/resources?fields=id,name,schema,status&where[type][_eq]=TABLE&limit=500'
  )
  const itemsResource = resources.find(r => r.schema === 'public' && r.name === 'import_test_items' && r.status === 'ACTIVE')
  expect(itemsResource).toBeTruthy()
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${itemsResource!.id}`, { data: { exposedMethods: ['GET', 'POST'] } })

  const dataview = await apiRequest<{ id: string, slug: string }>(
    page, token, 'POST', '/admin/api/dataviews',
    { data: { name: NAME, sourceResourceId: itemsResource!.id, viewType: 'TABLE' } }
  )
  created = { token, id: dataview.id }

  await publishDataView(page, token, dataview.id)
  await page.goto(`/admin/app/dataviews/${dataview.slug}`)

  await page.locator('main').getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Import/ }).click()
  const importDialog = page.getByRole('dialog').filter({ hasText: 'Import rows from a CSV file' })

  const csv = 'code,qty\nCSV-1,10\nCSV-2,20\nCSV-3,30\n'
  const [fileChooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    importDialog.getByRole('button', { name: /Choose a CSV file/ }).click()
  ])
  await fileChooser.setFiles({ name: 'items.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) })

  // Both CSV headers auto-match real columns by name - preview shows
  // the mapped values, not raw CSV text.
  await expect(importDialog.getByText('CSV-1')).toBeVisible()
  await expect(importDialog.getByText('3 row(s) total')).toBeVisible()

  await importDialog.getByRole('button', { name: 'Import' }).click()
  await expect(importDialog.getByText('3 row(s) imported', { exact: true })).toBeVisible()
  await importDialog.getByRole('button', { name: 'Close' }).last().click()

  await expect(page.getByRole('cell', { name: 'CSV-1', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'CSV-2', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'CSV-3', exact: true })).toBeVisible()
})
