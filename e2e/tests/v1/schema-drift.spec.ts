import { adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, sql, test, type DataViewRef } from './fixtures.js'

/**
 * The table changes under a DataView, as a schema does over a system's life
 * (AGENTS.md sections 9 and 23): a column renamed in PostgreSQL keeps its
 * field - same table, same attnum, same identity - and the grid follows the
 * new name; a column added appears once Settings syncs the columns.
 */
const NAME = 'V1 Esquema'
let dataview: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  dataview = await createDataView(page, token, { name: NAME, viewType: 'TABLE', sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'), selectedColumns: ['nombre', 'email', 'telefono'] })
  await publish(page, token, dataview.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

test('a column renamed in PostgreSQL keeps its field; one added appears once synced', async ({ page, token }) => {
  const fieldOf = async (column: string) => (await api<{ id: string, columnName: string | null }[]>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`)).find(f => f.columnName === column)
  const before = (await fieldOf('telefono'))!

  await sql(page, token, 'ALTER TABLE public.e2e_v1_clientes RENAME COLUMN telefono TO celular; ALTER TABLE public.e2e_v1_clientes ADD COLUMN whatsapp text')
  await api(page, token, 'POST', '/admin/api/catalog/refresh')

  await page.goto(`/admin/dataviews/${dataview.id}/settings?section=data`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Sync columns' }).click()
  // The renamed column: the same field, its new name.
  await expect.poll(async () => (await fieldOf('celular'))?.id).toBe(before.id)
  // The added one: listed in Columns now.
  await expect(main.getByRole('checkbox', { name: 'Show whatsapp' })).toBeVisible()

  await main.getByRole('button', { name: 'Publish', exact: true }).first().click()
  // The App serves the live version: wait for the new one before opening it.
  const published = page.waitForResponse(r => r.url().includes(`/admin/api/dataviews/${dataview.id}/publish`) && r.request().method() === 'POST')
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).last().click()
  expect((await published).status()).toBe(201)
  await page.goto(`/admin/app/dataviews/${dataview.slug}`)
  const acme = page.locator('main tbody tr').filter({ hasText: 'Acme SA' })
  await expect(acme).toContainText('011 4000-1000')
  await expect(page.locator('main').getByRole('columnheader', { name: 'Celular' })).toBeVisible()
})
