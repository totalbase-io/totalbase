import { adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, sql, test, type DataViewRef } from './fixtures.js'

/**
 * Create from search (Specification_DataViews.md §9.8): a FORM's foreign-key
 * select, with Create from search on, creates the category it lacks - a row of
 * the related table, as the viewer - and picks it.
 */
const NAME = 'V1 Create From Search'
const CATEGORY = `Cat ${Math.random().toString(36).slice(2, 8)}`
let form: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  form = await createDataView(page, token, {
    name: NAME,
    viewType: 'FORM',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'),
    selectedColumns: ['nombre', 'categoria']
  })
  // The generated select of `categoria`: Create from search turned on.
  const fields = await api<Array<{ id: string, widget: string, parent: string | null, config: { props?: Record<string, unknown> } }>>(page, token, 'GET', `/admin/api/dataviews/${form.id}/fields`)
  const select = fields.find(f => f.widget === 'USelectMenu')!
  await api(page, token, 'PATCH', `/admin/api/dataviews/${form.id}/fields/${select.id}`, { data: { config: { ...select.config, props: { ...select.config.props, createItem: true } } } })
  await publish(page, token, form.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await sql(page, token, `DELETE FROM public.e2e_v1_clientes WHERE nombre = 'Cliente con categoría nueva'`)
  await sql(page, token, `DELETE FROM public.e2e_v1_categorias WHERE nombre = '${CATEGORY}'`)
  await context.close()
})

test('a category the select lacks is created from what was typed, picked and saved with the record', async ({ page, token }) => {
  await page.goto(`/admin/app/dataviews/${form.slug}`)
  const main = page.locator('main')
  // A FORM opens on its first record, read-only: New starts the record to create.
  await main.getByRole('button', { name: 'New', exact: true }).click()
  await main.getByLabel('Nombre').fill('Cliente con categoría nueva')
  // The select's trigger is named by its field's label; the label points at it.
  const forId = await main.locator('label', { hasText: /^Categoria$/ }).getAttribute('for')
  const categoria = main.locator(`[id="${forId}"]`)
  await categoria.click()
  await page.keyboard.type(CATEGORY)
  await page.getByRole('option', { name: new RegExp(`Create.*${CATEGORY}`) }).click()
  await expect(categoria).toContainText(CATEGORY)
  await main.getByRole('button', { name: 'Save', exact: true }).click()

  await expect.poll(async () => (await sql(page, token, `SELECT c.nombre FROM public.e2e_v1_clientes cl JOIN public.e2e_v1_categorias c ON c.id = cl.categoria WHERE cl.nombre = 'Cliente con categoría nueva'`)).rows[0]?.nombre).toBe(CATEGORY)
})
