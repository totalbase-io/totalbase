import { expect, test } from '@playwright/test'
import { apiRequest, login, publishDataView, watchApiFailures } from './helpers.js'

/**
 * A DataView's own actions (DataViews.md §3.7, T72): one set up in Settings › Actions - a function on
 * a row, shown only where its condition holds, asked first - and one on a selection; both run from the App.
 */
const NAME = 'Custom Actions Test'
const TABLE = 'e2e_ca_invoices'

test('custom actions: set up in Settings, shown where their condition holds, run on a row and on a selection', async ({ page }) => {
  test.setTimeout(120_000)
  const failures = watchApiFailures(page)
  const token = await login(page)
  for (const dv of (await apiRequest<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')).filter(d => d.name === NAME)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: {
      sql: `
      DROP TABLE IF EXISTS public.${TABLE} CASCADE;
      DROP FUNCTION IF EXISTS public.e2e_ca_issue(uuid);
      DROP FUNCTION IF EXISTS public.e2e_ca_archive(uuid[]);
      CREATE TABLE public.${TABLE} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), numero int NOT NULL, estado text NOT NULL DEFAULT 'BORRADOR');
      INSERT INTO public.${TABLE} (numero, estado) VALUES (1, 'BORRADOR'), (2, 'EMITIDA');
      CREATE FUNCTION public.e2e_ca_issue(factura uuid) RETURNS void LANGUAGE sql AS $$ UPDATE public.${TABLE} SET estado = 'EMITIDA' WHERE id = factura $$;
      CREATE FUNCTION public.e2e_ca_archive(ids uuid[]) RETURNS void LANGUAGE sql AS $$ UPDATE public.${TABLE} SET estado = 'ARCHIVADA' WHERE id = ANY(ids) $$;
      `
    }
  })
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await apiRequest<{ id: string, name: string, schema: string, status: string }[]>(
    page, token, 'GET', `/api/totalbase/table/resources?fields=id,name,schema,status&where[name][_in]=${TABLE},e2e_ca_issue,e2e_ca_archive&where[status][_eq]=ACTIVE`
  )
  const id = (name: string) => resources.find(r => r.name === name)!.id
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${id(TABLE)}`, { data: { exposedMethods: ['GET', 'PATCH'] } })
  for (const fn of ['e2e_ca_issue', 'e2e_ca_archive']) await apiRequest(page, token, 'PATCH', `/admin/api/resources/${id(fn)}`, { data: { exposedMethods: ['POST'] } })
  const dataview = await apiRequest<{ id: string, slug: string }>(page, token, 'POST', '/admin/api/dataviews', { data: { name: NAME, sourceResourceId: id(TABLE), viewType: 'TABLE' } })
  const actionsOf = async () => ((await apiRequest<{ viewConfig: { custom_actions?: { id: string }[] } }>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}`)).viewConfig.custom_actions ?? [])

  try {
    // --- Settings › Actions: Issue, a function on a row, only on drafts, asked first ---
    await page.goto(`/dataviews/${dataview.id}/settings?section=actions`)
    const main = page.locator('main')
    await main.getByRole('button', { name: 'New action' }).click()
    const panel = page.getByRole('dialog', { name: 'New action' })
    await panel.getByLabel('Label').fill('Issue')
    await panel.getByRole('button', { name: 'Function' }).click()
    await page.getByRole('option', { name: 'public.e2e_ca_issue' }).click()
    // The function's first parameter takes the row's key.
    await expect(panel.getByLabel('factura')).toHaveValue('{{id}}')
    await panel.getByRole('button', { name: 'Advanced' }).click()
    await panel.locator('.monaco-editor .view-lines').click()
    await page.keyboard.insertText('{ "estado": { "_eq": "BORRADOR" } }')
    await panel.getByRole('switch', { name: 'Ask first' }).click()
    await panel.getByLabel('Question').fill('Issue invoice {{numero}}?')
    await panel.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(main.getByText('Issue', { exact: true })).toBeVisible()
    await expect.poll(async () => (await actionsOf()).map(a => a.id)).toEqual(['issue'])
    // A selection's action, written as the API takes it.
    const actions = await actionsOf()
    await apiRequest(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}`, {
      data: { viewConfig: { custom_actions: [...actions, { id: 'archive', label: 'Archive', icon: 'i-lucide-archive', target: { kind: 'FUNCTION', resource: id('e2e_ca_archive') }, args: { ids: '{{ids}}' }, places: ['selection'] }] } }
    })
    await publishDataView(page, token, dataview.id)

    // --- The App: Issue on the draft only, asked, run ---
    await page.goto(`/app/dataviews/${dataview.slug}`)
    const row = (numero: number) => main.locator('tbody tr').filter({ has: page.getByRole('cell', { name: String(numero), exact: true }) })
    await expect(row(1)).toBeVisible()
    await row(2).getByRole('button', { name: 'Record actions' }).click()
    await expect(page.getByRole('menuitem', { name: 'Issue' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await row(1).getByRole('button', { name: 'Record actions' }).click()
    await page.getByRole('menuitem', { name: 'Issue' }).click()
    const confirm = page.getByRole('dialog', { name: 'Issue' })
    await expect(confirm).toContainText('Issue invoice 1?')
    const issued: string[] = []
    page.on('request', r => { if (r.url().includes('/function/e2e_ca_issue')) issued.push(r.url()) })
    await confirm.getByRole('button', { name: 'Issue' }).click()
    // A toast's title shows (and is announced) - the call ran once.
    await expect(page.getByText('Issue: done').first()).toBeVisible()
    expect(issued).toHaveLength(1)
    await expect(row(1)).toContainText('EMITIDA')

    // --- A selection: both archived in one call ---
    await row(1).getByRole('checkbox', { name: 'Select row' }).check()
    await row(2).getByRole('checkbox', { name: 'Select row' }).check()
    const calls: string[] = []
    page.on('request', r => { if (r.url().includes('/function/e2e_ca_archive')) calls.push(r.url()) })
    await page.getByRole('button', { name: 'Archive' }).click()
    await expect(page.getByText('Archive: done').first()).toBeVisible()
    // One call for the whole selection.
    expect(calls).toHaveLength(1)
    await expect(row(1)).toContainText('ARCHIVADA')
    await expect(row(2)).toContainText('ARCHIVADA')
    expect(failures).toEqual([])
  } finally {
    await apiRequest(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
    await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: `DROP TABLE IF EXISTS public.${TABLE} CASCADE; DROP FUNCTION IF EXISTS public.e2e_ca_issue(uuid); DROP FUNCTION IF EXISTS public.e2e_ca_archive(uuid[]);` } })
    await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  }
})
