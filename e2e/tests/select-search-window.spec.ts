import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView, watchApiFailures } from './helpers.js'

/**
 * A Select menu's search window (DataViews.md §9.8, `searchWindow`): a 🔍 beside the select opens
 * its Resource as a searchable, paged table - a sidebar by default - and a row picked there is the select's value.
 */
const NAME = 'Search Window Test'
const CATEGORIES = 'search_window_categories'
const PRODUCTS = 'search_window_products'

test('a select menu\'s search window finds a row by another column and picks it', async ({ page }) => {
  test.setTimeout(90_000)
  const failures = watchApiFailures(page)
  const token = await login(page)

  for (const dv of (await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')).filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DROP TABLE IF EXISTS public.${PRODUCTS}, public.${CATEGORIES} CASCADE;
      CREATE TABLE public.${CATEGORIES} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, code text NOT NULL);
      CREATE TABLE public.${PRODUCTS} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), title text NOT NULL, category uuid REFERENCES public.${CATEGORIES}(id));
      INSERT INTO public.${CATEGORIES} (name, code) SELECT 'Category ' || n, 'C-' || lpad(n::text, 3, '0') FROM generate_series(1, 60) n;
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', `/api/totalbase/table/resources?fields=id,name,schema,status&where[schema][_eq]=public&limit=500`
  )
  const products = resources.find(r => r.name === PRODUCTS && r.status === 'ACTIVE')!
  const categories = resources.find(r => r.name === CATEGORIES && r.status === 'ACTIVE')!
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${products.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${categories.id}`, { data: { exposedMethods: ['GET'] } })

  const dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', {
    data: { name: NAME, sourceResourceId: products.id, viewType: 'TABLE' }
  })
  try {
    // The generated form's category select: its search window on (a sidebar, the default).
    const fields = await apiRequest<{ id: string, widget: string, config: { props?: Record<string, unknown> } }[]>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`)
    const select = fields.find(f => f.widget === 'USelectMenu')!
    expect(select).toBeTruthy()
    await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}/fields/${select.id}`, {
      data: { config: { ...select.config, props: { ...select.config.props, searchWindow: true } } }
    })
    // Its columns are its Resource's fields: the generated one reads the key and the label - widened to the code.
    const current = await apiRequest<{ viewConfig: { variables: { resource?: string, query?: Record<string, unknown> }[] } }>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}`)
    const variables = current.viewConfig.variables.map(v => (v.resource === categories.id ? { ...v, query: { ...v.query, fields: 'id,name,code' } } : v))
    await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}`, { data: { viewConfig: { variables } } })
    await publishDataView(page, token, dataview.id)

    await page.goto(`/app/dataviews/${dataview.slug}`)
    await expect(page.getByText('No rows found')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'New' }).first().click()
    await expect(page.getByLabel('Title')).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Search Category' }).click()

    // A sidebar with the Resource's fields as columns - the uuid key left out - searched on the server.
    const window = page.getByRole('dialog', { name: 'Category' })
    await expect(window).toBeVisible()
    await expect(window.getByRole('columnheader', { name: 'Code' })).toBeVisible()
    await expect(window.getByRole('columnheader', { name: 'Id' })).toHaveCount(0)
    await window.getByRole('textbox', { name: 'Search' }).fill('C-047')
    await expect(window.getByRole('cell', { name: 'Category 47' })).toBeVisible()
    await expect(window.getByRole('row')).toHaveCount(2)
    await window.getByRole('textbox', { name: 'Search' }).press('Enter')

    // Picked: the window closes and the select shows the row.
    await expect(window).toBeHidden()
    await expect(page.getByRole('button', { name: 'Category', exact: true })).toContainText('Category 47')
  } finally {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
    await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: `DROP TABLE IF EXISTS public.${PRODUCTS}, public.${CATEGORIES} CASCADE` } })
    await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  }
  expect(failures).toEqual([])
})
