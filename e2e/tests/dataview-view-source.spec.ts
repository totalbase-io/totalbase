import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView, watchApiFailures } from './helpers'

/**
 * A DataView over a VIEW reads its rows at the view's own route
 * (/api/{schema}/view/{name}) - it once asked /table/ and showed nothing.
 */
const VIEW = 'e2e_view_source_v'
const NAME = 'E2E view source'

test('a DataView over a view shows the view\'s rows', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  // One a run that stopped half-way left behind, by its id.
  for (const left of (await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')).filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${left.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: { sql: `DROP VIEW IF EXISTS public.${VIEW}; CREATE VIEW public.${VIEW} AS SELECT g AS id, 'Row ' || g AS label FROM generate_series(1, 3) g` }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const [resource] = await apiRequest<Array<{ id: string }>>(page, token, 'GET', `/api/totalbase/table/resources?where[schema][_eq]=public&where[name][_eq]=${VIEW}&where[status][_eq]=ACTIVE&fields=id`)
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${resource!.id}`, { data: { exposedMethods: ['GET'] } })
  const dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', {
    data: { name: NAME, viewType: 'TABLE', sourceResourceId: resource!.id }
  })
  try {
    await publishDataView(page, token, dataview.id)
    await page.goto(`/app/dataviews/${dataview.slug}`)
    for (const label of ['Row 1', 'Row 2', 'Row 3']) await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 30_000 })
    expect(failures).toEqual([])
  } finally {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
    await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: `DROP VIEW IF EXISTS public.${VIEW}` } })
    await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  }
})
