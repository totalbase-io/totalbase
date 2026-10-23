import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView, watchApiFailures } from './helpers.js'

/**
 * A TREE DataView (DataViews.md §5.14): rows under their parent, as a tree and as an org chart; a
 * drag moves a row under another (its parent column, its siblings' order); the cycle guard refuses a loop.
 */
const NAME = 'Tree Smoke Test'
const TABLE = 'tree_smoke_accounts'
const ROOT = '11111111-1111-1111-1111-111111111111'
const ASSETS = '22222222-2222-2222-2222-222222222222'
const CASH = '33333333-3333-3333-3333-333333333333'
const BANK = '44444444-4444-4444-4444-444444444444'
const LIABILITIES = '55555555-5555-5555-5555-555555555555'

test('a TREE DataView shows a hierarchy, moves a row by dragging and is guarded against cycles', async ({ page }) => {
  test.setTimeout(90_000)
  const failures = watchApiFailures(page)
  const token = await login(page)

  for (const dv of (await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')).filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DROP TABLE IF EXISTS public.${TABLE} CASCADE;
      CREATE TABLE public.${TABLE} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        parent uuid REFERENCES public.${TABLE}(id),
        position int
      );
      INSERT INTO public.${TABLE} (id, name, parent, position) VALUES
        ('${ROOT}', 'Chart', NULL, 1),
        ('${ASSETS}', 'Assets', '${ROOT}', 1),
        ('${LIABILITIES}', 'Liabilities', '${ROOT}', 2),
        ('${CASH}', 'Cash', '${ASSETS}', 1),
        ('${BANK}', 'Bank', '${ASSETS}', 2);
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', `/api/totalbase/table/resources?fields=id,name,schema,status&where[name][_eq]=${TABLE}`
  )
  const resource = resources.find(r => r.schema === 'public' && r.status === 'ACTIVE')
  expect(resource).toBeTruthy()
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${resource!.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  await apiRequest(page, token, 'POST', `/admin/api/schema/public/tables/${TABLE}/cycle-guard`, { data: { parentColumn: 'parent' } })

  const dataview = await apiRequest<{ id: string, slug: string, viewConfig: { tree_layout: Record<string, unknown> } }>(page, token, 'POST', '/admin/api/dataviews', {
    data: { name: NAME, sourceResourceId: resource!.id, viewType: 'TREE', viewConfig: { tree_layout: { titleFormula: '{{name}}', orderColumn: 'position', expandLevel: 3 } } }
  })
  expect(dataview.viewConfig.tree_layout.parentColumn).toBe('parent')
  try {
    await publishDataView(page, token, dataview.id)
    await page.goto(`/app/dataviews/${dataview.slug}`)

    const tree = page.getByRole('tree', { name: 'Tree' })
    const item = (name: string) => tree.getByRole('treeitem', { name: new RegExp(`^${name}\\b`) })
    await expect(item('Cash')).toBeVisible()
    await expect(item('Cash')).toHaveAttribute('aria-level', '3')
    await expect(item('Liabilities')).toHaveAttribute('aria-level', '2')

    // "+" opens a new record under the node - its parent set; nothing PostgreSQL fills (the key) to type.
    await item('Cash').hover()
    await page.getByRole('button', { name: 'Add under Cash' }).click()
    await expect(page.getByLabel('Name')).toBeVisible()
    await expect(page.getByLabel('Id', { exact: true })).toHaveCount(0)
    await page.getByRole('button', { name: 'Close' }).click()

    // Letting go on its own descendant moves nothing, and says why.
    // By hand: Playwright's dragTo waits for a drop the row never accepts.
    const from = (await item('Assets').boundingBox())!
    const to = (await item('Cash').boundingBox())!
    await page.mouse.move(from.x + 40, from.y + from.height / 2)
    await page.mouse.down()
    await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 })
    await page.mouse.up()
    await expect(page.getByText(/can't go under/).first()).toBeVisible()
    await expect(item('Cash')).toHaveAttribute('aria-level', '3')

    // Bank into Liabilities: its parent changes; Liabilities' children are numbered again.
    const box = await item('Liabilities').boundingBox()
    await item('Bank').dragTo(item('Liabilities'), { targetPosition: { x: 40, y: box!.height / 2 } })
    await expect.poll(async () => (await apiRequest<{ parent: string }>(page, token, 'GET', `/api/public/table/${TABLE}/${BANK}`)).parent).toBe(LIABILITIES)
    await expect(item('Bank')).toHaveAttribute('aria-level', '3')
    if (process.env.TREE_SHOTS) await page.screenshot({ path: `${process.env.TREE_SHOTS}/tree.png` })

    // The org chart: the same rows, boxes under their parent.
    await page.getByRole('button', { name: 'Org chart' }).click()
    await expect(page.getByRole('tree', { name: 'Tree' }).getByRole('button', { name: 'Cash', exact: true })).toBeVisible()
    // Zoom: − / + step it, Fit to width frames it; the canvas scrolls rather than cutting a branch off.
    const percent = page.getByRole('button', { name: 'Actual size' })
    const before = await percent.textContent()
    await page.getByRole('button', { name: 'Zoom out' }).click()
    await expect(percent).not.toHaveText(before!)
    await page.getByRole('button', { name: 'Fit to width' }).click()
    await percent.click()
    await expect(percent).toHaveText('100%')
    if (process.env.TREE_SHOTS) await page.screenshot({ path: `${process.env.TREE_SHOTS}/org.png` })

    // The guard: a row under its own descendant is refused by PostgreSQL, whoever writes.
    await expect(apiRequest(page, token, 'PATCH', `/api/public/table/${TABLE}/${ROOT}`, { data: { parent: CASH } })).rejects.toThrow(/CHECK_VIOLATION|under itself/)
  } finally {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
    await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: `DROP TABLE IF EXISTS public.${TABLE} CASCADE` } })
    await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  }
  expect(failures.filter(f => !f.includes(`/api/public/table/${TABLE}/${ROOT}`))).toEqual([])
})
