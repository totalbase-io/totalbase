import { adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * The Frame widget (DataViews.md §9.7): a FORM's record page
 * frames another site with the record's own value in the URL, encoded; the
 * site itself can never come from data.
 */
const NAME = 'V1 Frame Clientes'
let form: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  const clientes = await resourceId(page, token, 'e2e_v1_clientes')
  form = await createDataView(page, token, { name: NAME, viewType: 'FORM', sourceResourceId: clientes, selectedColumns: ['nombre', 'email'] })
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

const addFrame = (page: import('@playwright/test').Page, token: string, url: string) =>
  api<{ id: string }>(page, token, 'POST', `/admin/api/dataviews/${form.id}/widgets`, {
    data: { widget: 'TFrame', config: { props: { url, title: 'Customer site', openInNewTab: true }, bindings: {}, emits: {} } }
  })

test('the site is never data: a token before the site\'s / is refused', async ({ page, token }) => {
  await expect(addFrame(page, token, 'https://{{vars.record.data.email}}/')).rejects.toThrow(/site must be written out/)
  await expect(addFrame(page, token, 'http://example.com/{{vars.record.data.id}}')).rejects.toThrow(/https/)
})

test('a record page frames the URL with the record\'s value, encoded', async ({ page, token }) => {
  await addFrame(page, token, 'https://example.com/customers/{{vars.record.data.nombre}}?from=totalbase')
  await publish(page, token, form.id)
  const [row] = await api<{ id: number, nombre: string }[]>(page, token, 'GET', '/api/public/table/e2e_v1_clientes?fields=id,nombre&order_by=id&limit=1')

  await page.goto(`/admin/app/dataviews/${form.slug}/${row!.id}/edit`)
  const frame = page.locator('main iframe[title="Customer site"]')
  await expect(frame).toHaveAttribute('src', `https://example.com/customers/${encodeURIComponent(row!.nombre)}?from=totalbase`)
  await expect(frame).toHaveAttribute('sandbox', /allow-scripts/)
  await expect(page.locator('main').getByRole('button', { name: 'Open in new tab' })).toBeVisible()
})

test('the Design canvas shows the template instead of loading it', async ({ page, token: _ }) => {
  await page.goto(`/admin/dataviews/${form.id}/design`)
  await expect(page.locator('main').getByText('https://example.com/customers/{{vars.record.data.nombre}}?from=totalbase')).toBeVisible()
  await expect(page.locator('main iframe[title="Customer site"]')).toHaveCount(0)
})
