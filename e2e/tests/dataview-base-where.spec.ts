import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView } from './helpers.js'

/**
 * Covers `view_config.base_where` (types/dataview.ts's own doc comment
 * - the chat's own example: "solo mostrar los productos que están
 * activos") - a permanent filter set from the DataView's settings page
 * (`/dataviews/:id/settings?section=data`, its Scope), merged
 * into every query this DataView makes (DataViewGrid.vue's own
 * `forcedWhere` prop, the SAME mechanism an EMBED panel's own FK scoping
 * already used). Confirms the settings page's Filter field (WhereField)
 * loads and displays it, and that the published grid only ever shows
 * the scoped rows, even though the row that got filtered out is still a
 * real row in the table.
 */
const NAME = 'Base Where Test'

// The DataView this run created, deleted by its id once the test ends.
let created: { token: string, id: string } | undefined
test.afterEach(async ({ page }) => {
  if (created) await apiRequest(page, created.token, 'DELETE', `/admin/api/dataviews/${created.id}`)
  created = undefined
})

test('a Filter set from the DataView settings permanently scopes the grid, even for a row the API would otherwise return', async ({ page }) => {
  const token = await login(page)

  const existingDataviews = await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of existingDataviews.filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DELETE FROM totalbase.resources WHERE schema = 'public' AND name = 'base_where_items';
      DROP TABLE IF EXISTS public.base_where_items CASCADE;
      CREATE TABLE public.base_where_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        active boolean NOT NULL
      );
      INSERT INTO public.base_where_items (name, active) VALUES ('Active Widget', true), ('Retired Widget', false);
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', '/api/totalbase/table/resources?fields=id,name,schema,status&where[type][_eq]=TABLE&limit=500'
  )
  const itemsResource = resources.find(r => r.schema === 'public' && r.name === 'base_where_items' && r.status === 'ACTIVE')
  expect(itemsResource).toBeTruthy()
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${itemsResource!.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })

  const dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', {
    data: { name: NAME, description: 'Base where e2e fixture', sourceResourceId: itemsResource!.id, viewType: 'TABLE' }
  })
  created = { token, id: dataview.id }

  // No filter yet - both rows show.
  await publishDataView(page, token, dataview.id)
  await page.goto(`/app/dataviews/${dataview.slug}`)
  await expect(page.getByRole('cell', { name: 'Active Widget' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Retired Widget' })).toBeVisible()

  // Set the Filter - via the API (WhereField's own editor is Monaco,
  // not a plain input Playwright can `.fill()` reliably), then confirm
  // the settings page both LOADS and DISPLAYS it correctly (a parsed
  // condition chip, same as WhereField renders for the grid's own
  // ad-hoc filter).
  // Leaf values in this grammar are always strings (coerced to the
  // column's real type server-side, query-engine's own
  // `coerceLiteral`) - same convention WhereField's own Builder
  // produces by hand, `true` as JSON boolean is NOT one of the two
  // shapes `parseConditions` recognizes.
  await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}`, {
    data: { viewConfig: { base_where: { active: { _eq: 'true' } } } }
  })
  await page.goto(`/dataviews/${dataview.id}/settings?section=data`)
  await expect(page.locator('main').getByText('active equals true', { exact: true })).toBeVisible()

  // The filter was a draft edit - publish it, then only the active row
  // shows - permanently, not just because someone typed into the
  // grid's own ad-hoc filter box.
  await publishDataView(page, token, dataview.id)
  await page.goto(`/app/dataviews/${dataview.slug}`)
  await expect(page.getByRole('cell', { name: 'Active Widget' })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Retired Widget' })).toHaveCount(0)

  // The filtered-out row is still a real row - the API itself (no
  // DataView in the way) still returns both, proving this is
  // presentation-only, never access control.
  const rawRows = await apiRequest<{ name: string }[]>(page, token, 'GET', `/api/public/table/${itemsResource!.name}`)
  expect(rawRows.map(r => r.name).sort()).toEqual(['Active Widget', 'Retired Widget'])
})
