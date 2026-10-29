import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView } from './helpers.js'

/**
 * Covers the 5 follow-up display niceties added after the display-
 * format feature itself (see the chat): Excel-style negative/zero
 * number sections, ISO-currency numbers, a per-field empty-value text,
 * custom boolean labels, and a long text cut to its column (one line,
 * or several when the column says wrap) with its whole value on hover - all
 * grid-only (build-dataview-columns.ts), none of them touch the FORM's
 * live widget.
 */
test.use({ locale: 'es-AR' })

const NAME = 'Display Extras Test'

// The DataView this run created, deleted by its id once the test ends.
let created: { token: string, id: string } | undefined
test.afterEach(async ({ page }) => {
  if (created) await apiRequest(page, created.token, 'DELETE', `/admin/api/dataviews/${created.id}`)
  created = undefined
})

test('accounting negative/zero, currency, emptyText, booleanLabels, and a long text cut to its column all render correctly in the grid', async ({ page }) => {
  const token = await login(page)

  const existingDataviews = await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of existingDataviews.filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DELETE FROM totalbase.resources WHERE schema = 'public' AND name = 'display_extras_items';
      DROP TABLE IF EXISTS public.display_extras_items CASCADE;
      CREATE TABLE public.display_extras_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        balance numeric(12,2),
        price_usd numeric(12,2),
        assigned_to text,
        active boolean NOT NULL,
        notes text
      );
      INSERT INTO public.display_extras_items (balance, price_usd, assigned_to, active, notes) VALUES
        (-1234.5, 1234.5, NULL, true, 'This is a deliberately long note that should be truncated in the grid cell with an ellipsis and a tooltip showing the full text on hover.'),
        (0, 30, 'Someone', false, 'short');
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', '/api/totalbase/table/resources?fields=id,name,schema,status&where[type][_eq]=TABLE&limit=500'
  )
  const itemsResource = resources.find(r => r.schema === 'public' && r.name === 'display_extras_items' && r.status === 'ACTIVE')
  expect(itemsResource).toBeTruthy()
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${itemsResource!.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })

  const dataview = await apiRequest<{ id: string, slug: string }>(
    page, token, 'POST', '/admin/api/dataviews',
    { data: { name: NAME, sourceResourceId: itemsResource!.id, viewType: 'TABLE', viewConfig: { edit_presentation: 'PAGE' } } }
  )
  created = { token, id: dataview.id }
  const fields = await apiRequest<{ id: string, columnName: string | null }[]>(
    page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`
  )
  const byName = (name: string) => fields.find(f => f.columnName === name)!

  // How each reads is its table column's (DataViews.md §15) - set once, there, for all at once.
  await apiRequest(page, token, 'PUT', `/admin/api/resources/${itemsResource!.id}/columns/presentation`, {
    data: {
      columns: {
        balance: { displayFormat: '#,##0.00;(#,##0.00);"-"' },
        price_usd: { displayFormat: 'CURRENCY:USD' },
        assigned_to: { emptyText: 'Unassigned' },
        active: { booleanLabels: { true: 'Active', false: 'Inactive' } }
      }
    }
  })
  // Its cell's format (DataViews.md §4.3): several lines, at most 2.
  await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}/fields/${byName('notes').id}`, {
    data: { config: { textWrap: 'wrap', maxLines: 2 } }
  })

  await publishDataView(page, token, dataview.id)
  await page.goto(`/app/dataviews/${dataview.slug}`)

  // Accounting: negative wrapped in parens, zero shows the literal "-".
  await expect(page.getByRole('cell', { name: '(1.234,50)' })).toBeVisible()
  await expect(page.getByRole('cell', { name: '-', exact: true })).toBeVisible()

  // ISO currency - symbol/position come from Intl, not a hardcoded prefix.
  await expect(page.getByRole('cell', { name: /US\$\s*1\.234,50/ })).toBeVisible()

  // Per-field empty text instead of the plain "—".
  await expect(page.getByRole('cell', { name: 'Unassigned' })).toBeVisible()

  // Custom boolean labels instead of the check/x icon.
  await expect(page.getByRole('cell', { name: 'Active', exact: true })).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Inactive', exact: true })).toBeVisible()

  // A long text is cut to its column - every cell is bounded (320 px unset), the whole value kept in its text and
  // on hover (its box's title): never silently dropped. `notes` wraps on at most 2 lines; any other cell is one line.
  const notesCell = page.getByRole('cell', { name: /This is a deliberately long note/ })
  const notesBox = notesCell.locator('div[title]').first()
  await expect(notesBox).toHaveAttribute('title', /showing the full text on hover\.$/)
  await expect(notesBox).toHaveClass(/whitespace-normal/)
  expect(await notesBox.evaluate(el => (el as HTMLElement).style.webkitLineClamp)).toBe('2')
  expect((await notesBox.boundingBox())!.width).toBeLessThanOrEqual(320)
  await expect(page.getByRole('cell', { name: 'Unassigned' }).locator('div.truncate')).toHaveCount(1)
})
