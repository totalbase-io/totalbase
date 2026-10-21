import { expect as baseExpect, test, type Page } from '@playwright/test'
import { apiRequest as sharedApiRequest, login as loginAsAdmin, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Every write action of the Dashboards and Workflows editors, driven through
 * the UI (the v1/dashboards-*.spec.ts suite already covers creating a
 * dashboard, configuring/duplicating/deleting a widget, publishing and the
 * App's variable bar against API-built fixtures - this adds what it doesn't:
 * details and roles, a variable edited and removed, a widget moved and
 * resized, a version restored and duplicated, the dashboard deleted from its
 * menu; and the whole Workflows editor).
 *
 * Fixtures are created per run with a random suffix and deleted by id.
 */
// The dev server compiles a page on its first visit - give a navigation room.
const expect = baseExpect.configure({ timeout: 15_000 })

/**
 * The Admin API for fixtures and assertions - waiting out a 429: other specs
 * share the server (and its per-client rate limit) while this one runs.
 */
async function apiRequest<T>(page: Page, token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await sharedApiRequest<T>(page, token, method, path, body)
    } catch (error) {
      if (attempt >= 5 || !/-> 429/.test(String(error))) throw error
      await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)))
    }
  }
}

/** Polls an assertion's value without hammering the shared server. */
const POLL = { intervals: [500, 1000, 2000] }

const RUN = Math.random().toString(36).slice(2, 8)
const DASHBOARD = `UI Dash ${RUN}`
const MANUAL = `UI Flow ${RUN}`
const WEBHOOK = `UI Hook ${RUN}`
const ROLE = `UI DashFlow ${RUN}`

const ADMIN_EMAIL = `ui-dashflow-${RUN}@e2e.test`
const ADMIN_PASSWORD = `ui-dashflow-${RUN}-password`

const cleanup = { dashboards: [] as string[], workflows: [] as string[], roles: [] as string[], users: [] as string[] }
let roleId = ''

/**
 * Signs in as this file's own administrator - a fixture user, so another
 * spec signing the shared admin out (its sessions revoked) never ends ours.
 */
async function login(page: Page) {
  await page.goto('/admin/login')
  await page.getByLabel('Email').fill(ADMIN_EMAIL)
  await page.getByLabel('Password').fill(ADMIN_PASSWORD)
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/auth/login') && r.request().method() === 'POST'),
    page.getByRole('button', { name: 'Sign in' }).click()
  ])
  if (!response.ok()) throw new Error(`Sign in failed: ${response.status()} ${await response.text()}`)
  await page.waitForURL(/\/admin\/(status|app)?\/?$/, { waitUntil: 'commit' })
  const token = await page.evaluate(() => localStorage.getItem('totalbase_admin_token'))
  if (!token) throw new Error('Login did not produce a bearer token')
  return token
}


test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  const token = await loginAsAdmin(page)
  const admins = await apiRequest<{ id: string }[]>(page, token, 'GET', '/api/totalbase/table/roles?fields=id&where[name][_eq]=Administrators&limit=1')
  const user = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/users', { data: { email: ADMIN_EMAIL, name: 'UI DashFlow E2E', password: ADMIN_PASSWORD, roleIds: [admins[0]!.id] } })
  cleanup.users.push(user.id)
  const role = await apiRequest<{ id: string }>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: ROLE, app_access: true } })
  roleId = role.id
  cleanup.roles.push(role.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  const token = await loginAsAdmin(page)
  for (const id of cleanup.dashboards) await apiRequest(page, token, 'DELETE', `/admin/api/dashboards/${id}`).catch(() => undefined)
  for (const id of cleanup.workflows) await apiRequest(page, token, 'DELETE', `/admin/api/workflows/${id}`).catch(() => undefined)
  for (const id of cleanup.roles) await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${id}`).catch(() => undefined)
  for (const id of cleanup.users) await apiRequest(page, token, 'DELETE', `/admin/api/users/${id}`).catch(() => undefined)
  await context.close()
})

/** The status of a GET - for asserting a deleted object is gone. */
async function statusOf(page: Page, token: string, path: string) {
  const response = await page.request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  return response.status()
}

/** A multi-select menu stays open after a pick - closed without closing the modal under it. */
async function closeListbox(page: Page) {
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
}

// --- Dashboards ----------------------------------------------------------------------

const card = (page: Page, title: string) => page.locator('main .grid-stack div.rounded-lg.border').filter({ has: page.getByText(title, { exact: true }) })
const gridItem = (page: Page, title: string) => page.locator('main .grid-stack-item').filter({ has: page.getByText(title, { exact: true }) })

async function typeSql(page: Page, sql: string) {
  await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Run' }) }).locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(sql)
}

interface DashboardWidget { id: string, label: string | null, type: string, query: string | null, gridX: number, gridY: number, gridW: number, gridH: number }
interface DashboardVariable { name: string, label: string, type: string, default?: unknown, options?: { source: string, values?: string[] } }

async function publishFromHeader(page: Page) {
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Publish', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).last().click()
}

async function openVersion(page: Page, version: number) {
  await page.locator('main').getByRole('button', { name: /Active: v\d/ }).click()
  await page.getByRole('menuitemcheckbox', { name: new RegExp(`^v${version}\\b`) }).click()
  await expect(page.locator('main')).toContainText(`Viewing v${version}`)
}

/** The preview banner's Restore - asks first only when the draft has unpublished changes to lose. */
async function restoreVersion(page: Page, unpublishedChanges: boolean) {
  await page.locator('main').getByRole('button', { name: 'Restore' }).click()
  if (unpublishedChanges) await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).last().click()
}

test('a dashboard: details and roles, variables, a widget configured, moved, resized and deleted, versions restored and duplicated, viewed in the App, deleted', async ({ page }) => {
  test.setTimeout(180_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const main = page.locator('main')

  // --- Created ---
  await page.goto('/admin/dashboards')
  await page.getByRole('button', { name: 'New Dashboard' }).click()
  await page.getByRole('menuitem', { name: /^Blank/ }).click()
  const create = page.getByRole('dialog')
  await create.getByLabel('Name').fill(DASHBOARD)
  await create.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/admin\/dashboards\/[0-9a-f-]+$/)
  const id = page.url().split('/').pop()!
  cleanup.dashboards.push(id)

  // --- Its settings page (D26): General, at once; Security, at once ---
  await main.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForURL(new RegExp(`/admin/dashboards/${id}/settings`))
  await main.getByLabel('Name').fill(`${DASHBOARD} Renamed`)
  await main.getByLabel('Description').fill('Edited through the UI')
  await expect.poll(async () => (await apiRequest<{ name: string, description: string }>(page, token, 'GET', `/admin/api/dashboards/${id}`))).toMatchObject({ name: `${DASHBOARD} Renamed`, description: 'Edited through the UI' })
  const saved = await apiRequest<{ slug: string }>(page, token, 'GET', `/admin/api/dashboards/${id}`)
  await main.getByRole('link', { name: 'Security' }).click()
  await main.getByRole('switch', { name: `${ROLE} sees it` }).click()
  await expect.poll(async () => (await apiRequest<{ role: string }[]>(page, token, 'GET', `/api/totalbase/table/dashboards_roles?fields=role&where[dashboard][_eq]=${id}`)).map(g => g.role)).toEqual([roleId])

  // --- Variables: one added, another added then removed, the first edited ---
  await main.getByRole('link', { name: 'Variables' }).click()
  await main.getByRole('button', { name: 'Add variable' }).click()
  await main.getByRole('textbox', { name: 'Name', exact: true }).fill('estado')
  await main.getByRole('textbox', { name: 'Label', exact: true }).fill('Estado')
  // Its options, one row each (Add option).
  for (const [i, value] of ['ALTA', 'BAJA'].entries()) {
    await main.getByRole('button', { name: 'Add option' }).click()
    await main.getByRole('textbox', { name: `Option ${i + 1}: value` }).fill(value)
  }
  await main.getByRole('button', { name: 'Add variable' }).click()
  await main.getByRole('textbox', { name: 'Name', exact: true }).fill('temporal')
  await main.getByRole('textbox', { name: 'Label', exact: true }).fill('Temporal')
  await main.getByRole('button', { name: 'Add option' }).click()
  await main.getByRole('textbox', { name: 'Option 1: value' }).fill('X')
  await main.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await apiRequest<{ variables: DashboardVariable[] }>(page, token, 'GET', `/admin/api/dashboards/${id}`)).variables.map(v => v.name)).toEqual(['estado', 'temporal'])

  await main.getByRole('button', { name: /Temporal/ }).click()
  await main.getByRole('button', { name: 'Remove', exact: true }).click()
  await main.getByRole('button', { name: /Estado/ }).click()
  await main.getByRole('textbox', { name: 'Label', exact: true }).fill('Estado del alta')
  await main.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await apiRequest<{ variables: DashboardVariable[] }>(page, token, 'GET', `/admin/api/dashboards/${id}`)).variables).toHaveLength(1)
  const dashboard = await apiRequest<{ variables: DashboardVariable[] }>(page, token, 'GET', `/admin/api/dashboards/${id}`)
  expect(dashboard.variables[0]).toMatchObject({ name: 'estado', label: 'Estado del alta', type: 'SELECT' })

  // --- Back to the canvas ---
  await main.getByRole('button', { name: 'Dashboard design' }).click()
  await expect(main.getByRole('heading', { name: `${DASHBOARD} Renamed` })).toBeVisible()

  // --- A KPI added from the palette, its SQL typed and run ---
  await main.getByRole('button', { name: 'KPI', exact: true }).click()
  await card(page, 'KPI').getByRole('button', { name: 'Configure' }).click()
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Run' }) })
  await typeSql(page, 'SELECT CASE WHEN $VAR.estado = \'BAJA\' THEN 22 ELSE 11 END AS n')
  await drawer.getByRole('button', { name: 'Run' }).click()
  await expect(drawer).toContainText('11')
  await drawer.getByRole('textbox', { name: 'Title' }).fill('Valor')
  await drawer.getByRole('button', { name: 'Save' }).click()
  await expect(drawer).toBeHidden()
  await expect(card(page, 'Valor')).toContainText('11')
  let widgets = await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`)
  expect(widgets).toHaveLength(1)
  expect(widgets[0]).toMatchObject({ type: 'KPI', label: 'Valor' })
  expect(widgets[0]!.query).toContain('$VAR.estado')
  const before = widgets[0]!

  // --- Moved (dragged by its header) and resized (its corner handle) ---
  const header = card(page, 'Valor').locator('.dashboard-widget-drag-handle')
  const box = (await header.boundingBox())!
  const canvas = (await page.locator('main .grid-stack').boundingBox())!
  const column = canvas.width / 12
  await page.mouse.move(box.x + 20, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + 20 + column * 2, box.y + box.height / 2 + 10, { steps: 12 })
  await page.mouse.move(box.x + 20 + column * 4, box.y + box.height / 2 + 10, { steps: 12 })
  await page.mouse.up()
  await expect.poll(async () => (await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`))[0]!.gridX, POLL).toBeGreaterThan(before.gridX)
  const moved = (await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`))[0]!

  await gridItem(page, 'Valor').hover()
  const handle = gridItem(page, 'Valor').locator('.ui-resizable-se')
  const handleBox = (await handle.boundingBox())!
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(handleBox.x + column, handleBox.y + 40, { steps: 10 })
  await page.mouse.move(handleBox.x + column * 2, handleBox.y + 80, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => (await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`))[0]!.gridW, POLL).toBeGreaterThan(moved.gridW)

  // --- A second widget added, then deleted from its menu ---
  await main.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(card(page, 'Text')).toHaveCount(1)
  await card(page, 'Text').getByRole('button', { name: 'Widget actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await page.getByRole('dialog', { name: 'Delete this widget?' }).getByRole('checkbox', { name: 'Confirm' }).check()
  await page.getByRole('dialog', { name: 'Delete this widget?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(card(page, 'Text')).toHaveCount(0)
  widgets = await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`)
  expect(widgets.map(w => w.label)).toEqual(['Valor'])

  // --- Published as v1, viewed in the App with a SELECT variable changed ---
  await publishFromHeader(page)
  await expect(main.getByRole('button', { name: /Active: v1/ })).toBeVisible()
  await page.goto(`/admin/app/dashboards/${saved.slug}`)
  await expect(card(page, 'Valor')).toContainText('11')
  await main.getByRole('button', { name: 'Estado del alta' }).or(main.getByRole('combobox', { name: 'Estado del alta' })).first().click()
  await page.getByRole('option', { name: 'BAJA', exact: true }).click()
  await expect(card(page, 'Valor')).toContainText('22')
  await expect(page).toHaveURL(/estado=BAJA/)

  // --- Changed and published as v2, then v1 restored into the draft ---
  await page.goto(`/admin/dashboards/${id}`)
  await card(page, 'Valor').getByRole('button', { name: 'Widget actions' }).click()
  await page.getByRole('menuitem', { name: /^Edit/ }).click()
  await drawer.getByRole('textbox', { name: 'Title' }).fill('Valor v2')
  await drawer.getByRole('button', { name: 'Save' }).click()
  await expect(card(page, 'Valor v2')).toHaveCount(1)
  await publishFromHeader(page)
  await expect(main.getByRole('button', { name: /Active: v2/ })).toBeVisible()

  await openVersion(page, 1)
  await expect(card(page, 'Valor')).toHaveCount(1)
  await restoreVersion(page, false)
  await expect(page.getByText('Restored v1 into the draft', { exact: true })).toBeVisible()
  await expect(card(page, 'Valor')).toHaveCount(1)
  widgets = await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${id}/widgets`)
  expect(widgets.map(w => w.label)).toEqual(['Valor'])

  // --- v2 duplicated as a new dashboard (Save as…) ---
  await openVersion(page, 2)
  await main.getByRole('button', { name: 'Save as…' }).click()
  const saveAs = page.getByRole('dialog', { name: 'Save as a new copy' })
  await saveAs.getByLabel('Name').fill(`${DASHBOARD} Copy`)
  await saveAs.getByRole('button', { name: 'Create copy' }).click()
  await page.waitForURL(url => /\/admin\/dashboards\/[0-9a-f-]+$/.test(url.pathname) && !url.pathname.endsWith(id))
  const copyId = page.url().split('/').pop()!
  cleanup.dashboards.push(copyId)
  const copyWidgets = await apiRequest<DashboardWidget[]>(page, token, 'GET', `/admin/api/dashboards/${copyId}/widgets`)
  expect(copyWidgets.map(w => w.label)).toEqual(['Valor v2'])
  const copy = await apiRequest<{ name: string, variables: DashboardVariable[] }>(page, token, 'GET', `/admin/api/dashboards/${copyId}`)
  expect(copy.name).toBe(`${DASHBOARD} Copy`)
  expect(copy.variables.map(v => v.name)).toEqual(['estado'])

  // --- The original deleted from its menu ---
  await page.goto(`/admin/dashboards/${id}`)
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this Dashboard?' })
  await confirm.getByRole('checkbox', { name: 'Confirm' }).check()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => statusOf(page, token, `/admin/api/dashboards/${id}`), POLL).toBe(404)

  expect(failures).toEqual([])
})

test('a widget\'s SQL: Optional filter writes the standard pattern for a variable at the cursor', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const main = page.locator('main')
  const dashboard = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/dashboards', { data: { name: `${DASHBOARD} Filter`, slug: `ui-dash-filter-${RUN}` } })
  cleanup.dashboards.push(dashboard.id)
  await apiRequest(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}`, { data: { variables: [{ name: 'tags', label: 'Tags', type: 'SELECT', multiple: true, options: { source: 'STATIC', values: ['a', 'b'] } }] } })
  const widget = await apiRequest<{ id: string }>(page, token, 'POST', `/admin/api/dashboards/${dashboard.id}/widgets`, { data: { type: 'KPI', label: 'Count', gridX: 0, gridY: 0, gridW: 3, gridH: 2 } })

  await page.goto(`/admin/dashboards/${dashboard.id}`)
  await card(page, 'Count').getByRole('button', { name: 'Configure' }).click()
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Run' }) })
  await typeSql(page, 'SELECT count(*) AS n FROM (VALUES (\'a\'), (\'b\')) t(tag) WHERE ')
  await drawer.getByRole('button', { name: 'Optional filter' }).click()
  const popover = page.locator('[role=dialog]').filter({ hasText: 'A condition that applies only while' })
  await popover.getByLabel('Variable').click()
  await page.getByRole('option', { name: /Tags/ }).click()
  await popover.getByLabel('Column').click()
  await page.keyboard.type('tag')
  await expect(popover.getByText('($VAR.tags IS NULL OR tag::text = ANY($VAR.tags))')).toBeVisible()
  await popover.getByRole('button', { name: 'Insert', exact: true }).click()
  // Unset, the filter keeps every row.
  await drawer.getByRole('button', { name: 'Run' }).click()
  await expect(drawer).toContainText('2')
  await drawer.getByRole('button', { name: 'Save' }).click()
  await expect(drawer).toBeHidden()
  const saved = await apiRequest<Array<{ id: string, query: string | null }>>(page, token, 'GET', `/admin/api/dashboards/${dashboard.id}/widgets`)
  expect(saved.find(w => w.id === widget.id)?.query).toContain('($VAR.tags IS NULL OR tag::text = ANY($VAR.tags))')
  expect(failures).toEqual([])
  void main
})

test('dependent variables: picking a country narrows the cities offered, dropping a city it no longer offers', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const dashboard = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/dashboards', { data: { name: `${DASHBOARD} Cities`, slug: `ui-dash-cities-${RUN}` } })
  cleanup.dashboards.push(dashboard.id)
  await apiRequest(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}`, { data: { variables: [
    { name: 'country', label: 'Country', type: 'SELECT', options: { source: 'STATIC', values: ['AR', 'UY'] } },
    { name: 'city', label: 'City', type: 'SELECT', options: { source: 'QUERY', query: 'SELECT c FROM (VALUES (\'AR\', \'Rosario\'), (\'UY\', \'Salto\')) t(k, c) WHERE ($VAR.country IS NULL OR k = $VAR.country) ORDER BY 1' } }
  ] } })

  await page.goto(`/admin/dashboards/${dashboard.id}`)
  const main = page.locator('main')
  const control = (name: string) => main.getByRole('button', { name }).or(main.getByRole('combobox', { name })).first()
  await control('City').click()
  await expect(page.getByRole('option', { name: 'Rosario' })).toBeVisible()
  await page.getByRole('option', { name: 'Rosario' }).click()
  await control('Country').click()
  await page.getByRole('option', { name: 'UY' }).click()
  // Rosario isn't a UY city: dropped, and only Salto is offered.
  await expect(control('City')).toContainText('All')
  await control('City').click()
  await expect(page.getByRole('option', { name: 'Salto' })).toBeVisible()
  await expect(page.getByRole('option', { name: 'Rosario' })).toHaveCount(0)
  await page.keyboard.press('Escape')
  expect(failures).toEqual([])
})

test('versions: Delete old versions keeps the chosen one and newer, after a Confirm', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const dashboard = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/dashboards', { data: { name: `${DASHBOARD} Versions`, slug: `ui-dash-versions-${RUN}` } })
  cleanup.dashboards.push(dashboard.id)
  for (let i = 1; i <= 3; i++) {
    await apiRequest(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}`, { data: { variables: [{ name: 'n', label: `N${i}`, type: 'NUMBER' }] } })
    await apiRequest(page, token, 'POST', `/admin/api/dashboards/${dashboard.id}/publish`)
  }

  await page.goto(`/admin/dashboards/${dashboard.id}`)
  await page.locator('main').getByRole('button', { name: /Draft/ }).click()
  await page.getByRole('menuitem', { name: 'Delete old versions…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete old versions' })
  await expect(dialog).toContainText('Deletes v1.')
  await expect(dialog.getByRole('button', { name: 'Delete' })).toBeDisabled()
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(dialog).toBeHidden()
  const versions = await apiRequest<Array<{ version: number }>>(page, token, 'GET', `/admin/api/dashboards/${dashboard.id}/versions`)
  expect(versions.map(v => v.version)).toEqual([3, 2])
  expect(failures).toEqual([])
})

test('a dashboard\'s auto-refresh: set in Settings › Data, the App re-runs its widgets on the interval, paused while the tab is hidden', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const main = page.locator('main')

  // A published dashboard with one widget, built through the API.
  const slug = `ui-dash-refresh-${RUN}`
  const dashboard = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/dashboards', { data: { name: `${DASHBOARD} Refresh`, slug } })
  cleanup.dashboards.push(dashboard.id)
  const widget = await apiRequest<{ id: string }>(page, token, 'POST', `/admin/api/dashboards/${dashboard.id}/widgets`, { data: { type: 'KPI', label: 'Ticks', gridX: 0, gridY: 0, gridW: 3, gridH: 2 } })
  await apiRequest(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}/widgets/${widget.id}`, { data: { query: 'SELECT 42 AS n' } })
  await apiRequest(page, token, 'POST', `/admin/api/dashboards/${dashboard.id}/publish`)

  // --- Set in Settings › Data: live at once, nothing to publish ---
  await page.goto(`/admin/dashboards/${dashboard.id}/settings?section=data`)
  await main.getByRole('combobox', { name: 'Auto-refresh' }).click()
  await page.getByRole('option', { name: 'Every 30 seconds' }).click()
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect.poll(async () => (await apiRequest<{ refreshIntervalSeconds: number | null }>(page, token, 'GET', `/admin/api/dashboards/${dashboard.id}`)).refreshIntervalSeconds).toBe(30)
  const saved = await apiRequest<{ refreshIntervalSeconds: number | null, hasUnpublishedChanges: boolean }>(page, token, 'GET', `/admin/api/dashboards/${dashboard.id}`)
  expect(saved.refreshIntervalSeconds).toBe(30)
  expect(saved.hasUnpublishedChanges).toBe(false)

  // --- The App re-runs the widget every 30 seconds - the clock fast-forwarded, not waited out ---
  // Counted once answered: the next interval starts when a run ends, so the clock is moved only after.
  let runs = 0
  page.on('requestfinished', (request) => {
    if (request.method() === 'POST' && request.url().includes(`/app/api/dashboards/${slug}/widgets/${widget.id}/data`)) runs++
  })
  await page.clock.install()
  await page.goto(`/admin/app/dashboards/${slug}`)
  await expect(main.getByText('42', { exact: true })).toBeVisible()
  await expect(page.getByText('Auto-refresh: every 30 seconds')).toBeVisible()
  await expect.poll(() => runs, POLL).toBe(1)
  await page.clock.fastForward(29_000)
  await page.waitForTimeout(500)
  expect(runs).toBe(1)
  await page.clock.fastForward(1_000)
  await expect.poll(() => runs, POLL).toBe(2)
  await page.clock.fastForward(30_000)
  await expect.poll(() => runs, POLL).toBe(3)

  // --- Hidden tab: paused; back: one catch-up run at once, not one per missed interval ---
  const setVisibility = (state: 'hidden' | 'visible') => page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', { value, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  }, state)
  await setVisibility('hidden')
  await page.clock.fastForward(120_000)
  await page.waitForTimeout(500)
  expect(runs).toBe(3)
  await setVisibility('visible')
  await expect.poll(() => runs, POLL).toBe(4)
  await page.waitForTimeout(500)
  expect(runs).toBe(4)

  // --- Off again: no more runs ---
  await apiRequest(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}`, { data: { refreshIntervalSeconds: null } })
  await page.reload()
  await expect(main.getByText('42', { exact: true })).toBeVisible()
  await expect.poll(() => runs, POLL).toBe(5)
  await page.clock.fastForward(120_000)
  await page.waitForTimeout(500)
  expect(runs).toBe(5)

  expect(failures).toEqual([])
})

// --- Workflows -----------------------------------------------------------------------

interface WorkflowDraft { workflow: { id: string, slug?: string, enabled: boolean, historyLevel: string, liveVersion: number | null, revision: string }, definition: { operations: { id: string, type: string, key: string }[] } }

/** The New workflow wizard: name, a trigger card, its configuration, access, auditing. */
async function createWorkflow(page: Page, name: string, trigger: 'Manual' | 'Webhook', configure: (dialog: ReturnType<Page['getByRole']>) => Promise<void>, roles: string[] = []) {
  await page.goto('/admin/workflows')
  await page.getByRole('button', { name: 'New workflow' }).click()
  const wizard = page.getByRole('dialog', { name: 'New workflow' })
  await wizard.getByLabel('Name').fill(name)
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: new RegExp(`^${trigger} Run`) }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await configure(wizard)
  await wizard.getByRole('button', { name: 'Next' }).click()
  // Access: a switch per role.
  for (const role of roles) await wizard.getByRole('switch', { name: `${role} sees it` }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/admin\/workflows\/[0-9a-f-]+$/)
  const id = page.url().split('/').pop()!
  cleanup.workflows.push(id)
  return id
}

/** Replaces a dialog's (only) Monaco editor content. */
async function typeJson(page: Page, dialog: ReturnType<Page['getByRole']>, json: string) {
  await dialog.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(json)
}

/** "Add step" from the Start card's "⋮" - a Finish with result (`result`, or its default), saved from its modal. */
async function addFinishStep(page: Page, result?: string) {
  await page.locator('main').getByRole('button', { name: 'Step actions' }).first().click()
  await page.getByRole('menuitem', { name: 'Add step' }).click()
  await page.getByRole('menuitem', { name: 'Finish with result' }).click()
  const modal = page.getByRole('dialog', { name: 'Finish with result' })
  if (result) await typeJson(page, modal, result)
  await modal.getByRole('button', { name: 'Save' }).click()
  await expect(modal).toBeHidden()
}

async function workflowDraft(page: Page, token: string, id: string) {
  return apiRequest<WorkflowDraft>(page, token, 'GET', `/admin/api/workflows/${id}/draft`)
}

async function publishWorkflow(page: Page, version: number) {
  await publishFromHeader(page)
  await expect(page.locator('main').getByRole('button', { name: new RegExp(`Active: v${version}`) })).toBeVisible()
}

/** The settings page (Workflows.md §16) from the canvas' header, at one of its sections. */
async function openWorkflowSettings(page: Page, section?: 'General' | 'Trigger' | 'Security' | 'Runs' | 'Versions') {
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.waitForURL(/\/settings/)
  if (section) await main.getByRole('navigation', { name: 'Workflow settings' }).getByRole('link', { name: section, exact: true }).click()
  return main
}

/** Back to the canvas from the settings page. */
async function backToDesign(page: Page) {
  await page.locator('main').getByRole('button', { name: 'Workflow design' }).click()
  await page.waitForURL(/\/admin\/workflows\/[0-9a-f-]+$/)
}

/** Run, from the header's menu: Test (the draft) or Production (the live version). */
async function openRun(page: Page, mode: 'Test' | 'Production') {
  await page.locator('main').getByRole('button', { name: 'Run', exact: true }).click()
  await page.getByRole('menuitem', { name: new RegExp(`^${mode}`) }).click()
}

test('a MANUAL workflow: created with invoke roles, trigger edited, a step added, published, test-run, enabled and run, logs, versions restored and duplicated, deleted', async ({ page }) => {
  test.setTimeout(180_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const main = page.locator('main')

  // --- Created with an invoke role ---
  const id = await createWorkflow(page, MANUAL, 'Manual', async (wizard) => {
    await expect(wizard).toContainText('No further configuration')
  }, [ROLE])
  expect(await apiRequest(page, token, 'GET', `/admin/api/workflows/${id}/roles`)).toEqual([roleId])
  expect((await workflowDraft(page, token, id)).workflow.historyLevel).toBe('DETAILED')

  // --- Settings › General: history to Summary, saved at once ---
  await openWorkflowSettings(page)
  await expect(async () => {
    await main.getByRole('combobox', { name: 'History level' }).click()
    await page.getByRole('option', { name: 'SUMMARY' }).click({ timeout: 2000 })
  }).toPass()
  await expect(main.getByRole('combobox', { name: 'History level' })).toHaveText('SUMMARY')
  await expect.poll(async () => (await workflowDraft(page, token, id)).workflow.historyLevel, POLL).toBe('SUMMARY')
  expect(await apiRequest(page, token, 'GET', `/admin/api/workflows/${id}/roles`)).toEqual([roleId])
  await backToDesign(page)

  // --- A step added (its result echoes the trigger input), the draft autosaved ---
  await addFinishStep(page, '{"echo": "{{start.data.greeting}}"}')
  await expect.poll(async () => (await workflowDraft(page, token, id)).definition.operations.map(o => o.type), POLL).toContain('totalbase.finish-result')

  // --- Published as v1 ---
  await publishWorkflow(page, 1)

  // --- Production is held until the workflow is enabled; Test runs the draft ---
  await main.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.getByRole('menuitem', { name: /^Production/ })).toBeDisabled()
  await page.getByRole('menuitem', { name: /^Test/ }).click()
  const testRun = page.getByRole('dialog', { name: 'Test run', exact: true })
  await typeJson(page, testRun, '{"greeting": "hello-test"}')
  await testRun.getByRole('button', { name: 'Run test' }).click()
  const testResult = testRun.getByRole('region', { name: 'Run result' })
  await expect(testResult).toContainText('SUCCEEDED', { timeout: 30_000 })
  await expect(testResult).toContainText('MANUAL · TEST')
  // The step, by its label and key, expanded to its result - live values,
  // even under Summary history.
  const testStep = testResult.getByRole('button', { name: /finish_result/ })
  await expect(testStep).toContainText('SUCCEEDED')
  await testStep.click()
  await expect(testResult.getByText('totalbase.finish-result')).toBeVisible()
  // The run's final result and the expanded step's own.
  await expect(testResult.locator('pre').filter({ hasText: '"echo": "hello-test"' })).toHaveCount(2)
  await page.keyboard.press('Escape')
  await expect(testRun).toBeHidden()

  // --- Enabled in Settings › General, then Production (the published version) ---
  await openWorkflowSettings(page)
  await main.getByRole('switch', { name: 'Enabled' }).click()
  await expect.poll(async () => (await workflowDraft(page, token, id)).workflow.enabled, POLL).toBe(true)
  await backToDesign(page)
  await openRun(page, 'Production')
  const run = page.getByRole('dialog', { name: 'Run', exact: true })
  await typeJson(page, run, '{"greeting": "hello-production"}')
  await run.getByRole('button', { name: 'Run', exact: true }).click()
  const runResult = run.getByRole('region', { name: 'Run result' })
  await expect(runResult).toContainText('SUCCEEDED', { timeout: 30_000 })
  await expect(runResult).toContainText('MANUAL · PRODUCTION')
  await runResult.getByRole('button', { name: /finish_result/ }).click()
  await expect(runResult.locator('pre').filter({ hasText: '"echo": "hello-production"' })).toHaveCount(2)

  // --- "Open in Runs" lands on that run, in Settings › Runs ---
  await run.getByRole('button', { name: 'Open in Runs' }).click()
  await page.waitForURL(/section=runs/)
  const detail = page.getByRole('dialog', { name: 'Run', exact: true })
  await expect(detail).toContainText('MANUAL · PRODUCTION')
  // A run reached through Open in Runs, its Close doesn't close it - the list opened anew.
  await page.goto(`/admin/workflows/${id}/settings?section=runs`)
  await expect(detail).toBeHidden()

  // --- Runs: both, the total in meta ---
  await expect(main.getByRole('table')).toContainText('Production')
  await expect(main.getByRole('table')).toContainText('Test')
  const runsResponse = await page.request.get(`${BASE_URL}/admin/api/workflows/${id}/runs`, { headers: { Authorization: `Bearer ${token}` } })
  expect((await runsResponse.json()).meta).toEqual({ total: 2 })
  await backToDesign(page)

  // --- The step's key changed (an unpublished change), then v1 restored ---
  await main.getByText('finish_result', { exact: false }).first().click()
  const step = page.getByRole('dialog', { name: 'Finish with result' })
  const keyInput = step.getByLabel('Step ID')
  const originalKey = await keyInput.inputValue()
  await keyInput.fill('done_renamed')
  await step.getByRole('button', { name: 'Save' }).click()
  await expect.poll(async () => (await workflowDraft(page, token, id)).definition.operations.map(o => o.key), POLL).toContain('done_renamed')
  await openVersion(page, 1)
  await restoreVersion(page, true)
  await expect.poll(async () => (await workflowDraft(page, token, id)).definition.operations.map(o => o.key), POLL).toContain(originalKey)

  // --- v1 duplicated as a new workflow ---
  await openVersion(page, 1)
  await main.getByRole('button', { name: 'Save as…' }).click()
  const saveAs = page.getByRole('dialog', { name: 'Save as a new copy' })
  await saveAs.getByLabel('Name').fill(`${MANUAL} Copy`)
  await saveAs.getByRole('button', { name: 'Create copy' }).click()
  await page.waitForURL(url => /\/admin\/workflows\/[0-9a-f-]+$/.test(url.pathname) && !url.pathname.endsWith(id))
  const copyId = page.url().split('/').pop()!
  cleanup.workflows.push(copyId)
  const copy = await workflowDraft(page, token, copyId)
  expect(copy.definition.operations.map(o => o.type)).toContain('totalbase.finish-result')
  expect(copy.workflow.enabled).toBe(false)

  // --- The original deleted from its menu ---
  await page.goto(`/admin/workflows/${id}`)
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete this workflow?' })
  await confirm.getByRole('checkbox', { name: 'Confirm' }).check()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => statusOf(page, token, `/admin/api/workflows/${id}`), POLL).toBe(404)

  expect(failures).toEqual([])
})

test('a WEBHOOK workflow: created, published, enabled, called by its URL - the run in the logs', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const main = page.locator('main')

  const id = await createWorkflow(page, WEBHOOK, 'Webhook', async (wizard) => {
    await wizard.getByRole('radio', { name: 'Authenticated' }).check()
  })
  const workflow = await apiRequest<{ slug: string }>(page, token, 'GET', `/admin/api/workflows/${id}`)
  await addFinishStep(page)
  await expect.poll(async () => (await workflowDraft(page, token, id)).definition.operations.length, POLL).toBe(2)
  await publishWorkflow(page, 1)
  await openWorkflowSettings(page)
  await main.getByRole('switch', { name: 'Enabled' }).click()
  await expect.poll(async () => (await workflowDraft(page, token, id)).workflow.enabled, POLL).toBe(true)

  const response = await page.request.post(`${BASE_URL}/api/workflows/${workflow.slug}/webhook?source=ui-e2e`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { hello: 'world' }
  })
  expect(response.status(), await response.text()).toBeLessThan(300)

  // Settings › Runs: the one run, by its webhook.
  await main.getByRole('navigation', { name: 'Workflow settings' }).getByRole('link', { name: 'Runs', exact: true }).click()
  const runs = main.getByRole('table')
  await expect(runs.locator('tbody tr')).toHaveCount(1)
  await expect(runs).toContainText('Webhook')
  await expect(runs).toContainText('Succeeded')

  expect(failures).toEqual([])
})

/** A workflow made through the Admin API, opened in the editor. */
async function apiWorkflow(page: Page, token: string, name: string, startConfiguration?: Record<string, unknown>) {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
  const workflow = await apiRequest<{ id: string }>(page, token, 'POST', '/admin/api/workflows', { data: { name, slug, ...(startConfiguration && { startConfiguration }) } })
  cleanup.workflows.push(workflow.id)
  return workflow.id
}

test('a MANUAL Start\'s input form and confirmation: Run asks for the fields, then confirms', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await apiWorkflow(page, token, `UI Form ${RUN}`, {
    trigger: 'MANUAL',
    input_fields: [{ name: 'qty', label: 'Quantity', type: 'number', required: true }],
    confirm_message: 'This orders the quantity for real.'
  })
  // Start -> Finish echoing the form's value, published and enabled through the API.
  const draft = await workflowDraft(page, token, id)
  const start = draft.definition.operations.find(o => o.type === 'totalbase.start')!
  const finish = { id: crypto.randomUUID(), type: 'totalbase.finish-result', key: 'finish', label: 'Done', configuration_version: 1, configuration: { result: '{{start.data.qty}}' } }
  await apiRequest(page, token, 'PUT', `/admin/api/workflows/${id}/draft`, { data: { revision: draft.workflow.revision, definition: { operations: [start, finish], connections: [{ source: start.id, target: finish.id, output: 'next' }] } } })
  await apiRequest(page, token, 'POST', `/admin/api/workflows/${id}/publish`, { data: { revision: (await workflowDraft(page, token, id)).workflow.revision } })
  await apiRequest(page, token, 'PATCH', `/admin/api/workflows/${id}`, { data: { revision: (await workflowDraft(page, token, id)).workflow.revision, enabled: true } })

  await page.goto(`/admin/workflows/${id}`)
  await openRun(page, 'Production')
  const run = page.getByRole('dialog', { name: 'Run', exact: true })
  const runButton = run.getByRole('button', { name: 'Run', exact: true })
  await expect(runButton).toBeDisabled()
  await run.getByLabel('Quantity').fill('3')
  await run.getByLabel('Quantity').press('Tab')
  await runButton.click()
  await expect(page.getByText('This orders the quantity for real.')).toBeVisible()
  await page.getByRole('button', { name: 'Run it' }).click()
  await expect(run.getByRole('region', { name: 'Run result' })).toContainText('SUCCEEDED', { timeout: 30_000 })
  expect(failures).toEqual([])
})

test('workflow settings: name, description and slug edited, history turned off, a role allowed', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await apiWorkflow(page, token, `UI Settings ${RUN}`)
  await page.goto(`/admin/workflows/${id}`)

  // General, saved at once: the saved slug is never re-proposed from a new name.
  const settings = await openWorkflowSettings(page)
  await expect(settings.getByLabel('Slug')).toHaveValue(`ui-settings-${RUN}`)
  await settings.getByLabel('Name').fill(`UI Renamed ${RUN}`)
  await expect(settings.getByLabel('Slug')).toHaveValue(`ui-settings-${RUN}`)
  await settings.getByLabel('Description').fill('Renamed from the editor')
  await settings.getByLabel('Slug').fill(`ui-renamed-${RUN}`)
  // What a run keeps: history off disables its level.
  await settings.getByRole('switch', { name: /history/i }).click()
  await expect(settings.getByRole('combobox', { name: 'History level' })).toBeDisabled()
  await expect.poll(async () => (await apiRequest<{ name: string }>(page, token, 'GET', `/admin/api/workflows/${id}`)).name, POLL).toBe(`UI Renamed ${RUN}`)
  await expect.poll(async () => apiRequest(page, token, 'GET', `/admin/api/workflows/${id}`), POLL).toMatchObject({ description: 'Renamed from the editor', slug: `ui-renamed-${RUN}`, historyEnabled: false })

  // Security: a role allowed to invoke it.
  await settings.getByRole('navigation', { name: 'Workflow settings' }).getByRole('link', { name: 'Security', exact: true }).click()
  await settings.getByRole('switch', { name: `${ROLE} sees it` }).click()
  await expect.poll(async () => apiRequest(page, token, 'GET', `/admin/api/workflows/${id}/roles`), POLL).toEqual([roleId])
  // The header follows the new name.
  await expect(page.locator('main').getByRole('heading', { name: `UI Renamed ${RUN}` })).toBeVisible()

  // Reopened, General shows what was saved.
  await page.reload()
  await settings.getByRole('navigation', { name: 'Workflow settings' }).getByRole('link', { name: 'General', exact: true }).click()
  await expect(settings.getByLabel('Name')).toHaveValue(`UI Renamed ${RUN}`)

  expect(failures).toEqual([])
})

test('a CRON schedule: the saved expression reopens as Custom, a weekly preset writes weekday names, the last occurrence is shown', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await apiWorkflow(page, token, `UI Cron ${RUN}`, { trigger: 'CRON', cron_expression: '0 9 * JAN-JUN MON', timezone: 'UTC', execute_as: cleanup.users[0] })
  await page.goto(`/admin/workflows/${id}`)

  // Settings › Trigger, saved to the draft as edited.
  const settings = await openWorkflowSettings(page, 'Trigger')
  await expect(settings.getByRole('radio', { name: 'Custom' })).toBeChecked()
  await expect(settings.getByLabel('Cron expression')).toHaveValue('0 9 * JAN-JUN MON')
  await expect(settings.getByText('Last occurrence:')).toContainText('—')
  await expect(settings.getByText('Next runs (UTC):')).toBeVisible()

  // Weekly: Monday (the default) and Friday.
  await settings.getByRole('radio', { name: 'Weekly' }).check()
  await settings.getByRole('button', { name: 'Friday' }).click()
  const cronOf = async () => (await workflowDraft(page, token, id)).definition.operations.find(o => o.type === 'totalbase.start') as unknown as { configuration: { cron_expression: string } }
  await expect.poll(async () => (await cronOf()).configuration.cron_expression, POLL).toBe('0 3 * * MON,FRI')

  // A custom expression with names is accepted as typed.
  await settings.getByRole('radio', { name: 'Custom' }).check()
  await settings.getByLabel('Cron expression').fill('30 6 * MAR-OCT SAT,SUN')
  await expect(settings.getByText('Invalid cron expression.')).toHaveCount(0)
  await expect.poll(async () => (await cronOf()).configuration.cron_expression, POLL).toBe('30 6 * MAR-OCT SAT,SUN')

  expect(failures).toEqual([])
})

test('the step limit: at 100 operations every Add step entry is disabled, saying why', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await apiWorkflow(page, token, `UI Limit ${RUN}`)
  const draft = await workflowDraft(page, token, id)
  const start = draft.definition.operations[0]!
  const steps = Array.from({ length: 99 }, (_, i) => ({ id: crypto.randomUUID(), type: 'totalbase.wait-resume', key: `wait_${i}`, label: `Wait ${i}`, configuration_version: 1, configuration: { waitSeconds: 1 } }))
  const chain = [start, ...steps]
  const revision = (await apiRequest<{ revision: string }>(page, token, 'GET', `/admin/api/workflows/${id}`)).revision
  const saved = await page.request.put(`${BASE_URL}/admin/api/workflows/${id}/draft`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { data: { revision, definition: { operations: chain, connections: steps.map((step, i) => ({ source: chain[i]!.id, output: 'next', target: step.id })) } } }
  })
  expect(saved.status(), await saved.text()).toBe(200)

  await page.goto(`/admin/workflows/${id}`)
  const last = page.locator('main').getByRole('button', { name: 'Step actions' }).last()
  await last.scrollIntoViewIfNeeded()
  await last.click()
  const success = page.getByRole('menuitem', { name: /Success/ })
  await expect(success).toBeDisabled()
  await expect(success).toContainText('A workflow holds at most 100 steps')

  expect(failures).toEqual([])
})
