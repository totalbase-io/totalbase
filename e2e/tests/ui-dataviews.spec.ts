import { expect as baseExpect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, apiRequest, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Every write a DataView's authoring screens make, driven through the UI
 * (the brief: the forms and actions that WRITE, after the body-contract
 * migration): the wizard creating each structural type, Settings (identity,
 * features, roles, columns, fields, publish, restore, Save as), the Design
 * form (a widget added, moved, resized, code, publish), the App menu
 * arrangement, and the runtime writes - saved views and their shares, the
 * viewer's own grid prefs, export/print audit events.
 *
 * Fixtures: a schema `ui_dv_<random>` (created with the SQL Console API and
 * dropped at the end), a role and a user to share with - every row deleted
 * by its id. What v1/*.spec.ts already covers (TABLE wizard + restore, a
 * saved view applied, a hidden column, CSV export, Sync columns after a
 * rename) is not repeated here.
 */

/** A dev server shared by several suites at once answers slowly - a little more patience than the default 5s. */
const expect = baseExpect.configure({ timeout: 15_000 })
/**
 * expect.poll, slower: every suite shares one IP's rate limit
 * (security.rate_limit_per_minute) - a re-read once a second or two, not ten times.
 */
const poll = <T>(fn: () => Promise<T>, options: { timeout?: number } = {}) => expect.poll(fn, { intervals: [1000, 2000, 3000], timeout: 30_000, ...options })

const SUFFIX = Math.random().toString(36).slice(2, 8)
const SCHEMA = `ui_dv_${SUFFIX}`
const PREFIX = `UI DV ${SUFFIX}`
const USER_EMAIL = `ui-dv-${SUFFIX}@e2e.test`
const USER_PASSWORD = `ui-dv-${SUFFIX}-password`

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT'
const api = <T>(page: Page, token: string, method: Method, path: string, body?: unknown) => apiRequest<T>(page, token, method as 'GET', path, body)
const sql = (page: Page, token: string, statement: string) => api<{ rows: Record<string, unknown>[] }>(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: statement } })

interface DataViewRow { id: string, name: string, slug: string, owner?: string | null, viewType: string, liveVersion?: number | null, hasUnpublishedChanges?: boolean, scope?: string, viewConfig: Record<string, unknown>, code?: string | null }
interface FieldRow { id: string, columnName: string | null, label: string | null, widget: string | null, visible: boolean, kind: string, gridW: number, gridX: number, gridY: number, parent: string | null }

const state = {
  resources: {} as Record<string, string>,
  roleId: '',
  userId: '',
  /** Every DataView this file created, by id - deleted in afterAll. */
  dataviews: new Set<string>(),
  created: {} as Record<string, DataViewRow>
}

/**
 * helpers.ts' login, waiting for the token instead of the page's `load`
 * event - a busy dev server (several suites at once) can hold `load` past
 * the timeout while the app is already signed in.
 */
async function login(page: Page, email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
  await page.goto('/admin/login', { waitUntil: 'domcontentloaded' })
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/admin\/(status|app)?\/?$/, { waitUntil: 'commit', timeout: 60_000 })
  await expect.poll(() => page.evaluate(() => localStorage.getItem('totalbase_admin_token')), { timeout: 30_000 }).toBeTruthy()
  return (await page.evaluate(() => localStorage.getItem('totalbase_admin_token')))!
}

async function adminSession(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  const token = await login(page)
  return { context, page, token }
}

const SCHEMA_SQL = `
CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.clientes (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  email text UNIQUE,
  ciudad text,
  activo boolean NOT NULL DEFAULT true,
  limite numeric(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE ${SCHEMA}.pedidos (
  id serial PRIMARY KEY,
  cliente integer NOT NULL REFERENCES ${SCHEMA}.clientes(id),
  fecha date NOT NULL DEFAULT current_date,
  estado text NOT NULL DEFAULT 'BORRADOR'
);
CREATE TABLE ${SCHEMA}.pedidos_items (
  id serial PRIMARY KEY,
  pedido integer NOT NULL REFERENCES ${SCHEMA}.pedidos(id) ON DELETE CASCADE,
  descripcion text NOT NULL,
  cantidad integer NOT NULL DEFAULT 1
);
INSERT INTO ${SCHEMA}.clientes (nombre, email, ciudad, activo, limite) VALUES
  ('Acme', 'acme@ui-dv.test', 'Rosario', true, 1000),
  ('Beta', 'beta@ui-dv.test', 'Cordoba', true, 500),
  ('Gamma', 'gamma@ui-dv.test', 'Salta', false, 0),
  ('Delta', 'delta@ui-dv.test', 'Mendoza', true, 2500);
INSERT INTO ${SCHEMA}.pedidos (cliente, estado) VALUES (1, 'CONFIRMADO'), (2, 'BORRADOR');
INSERT INTO ${SCHEMA}.pedidos_items (pedido, descripcion, cantidad) VALUES (1, 'Tornillos', 2), (2, 'Cable', 3);
`

const TABLES = ['clientes', 'pedidos', 'pedidos_items'] as const

test.describe.configure({ mode: 'serial', timeout: 90_000 })
test.use({ navigationTimeout: 60_000 })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(90_000)
  const { context, page, token } = await adminSession(browser)
  await sql(page, token, SCHEMA_SQL)
  await api(page, token, 'POST', '/admin/api/catalog/refresh')
  const resources = await api<{ id: string, name: string }[]>(page, token, 'GET', `/api/totalbase/table/resources?fields=id,name&where[schema][_eq]=${SCHEMA}&where[status][_eq]=ACTIVE`)
  for (const table of TABLES) {
    const resource = resources.find(r => r.name === table)
    if (!resource) throw new Error(`No resource for ${SCHEMA}.${table}`)
    state.resources[table] = resource.id
    await api(page, token, 'PATCH', `/admin/api/resources/${resource.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  }
  // A viewer to share with: an App role reading clientes, and its user.
  const role = await api<{ id: string }>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: `${PREFIX} Viewer`.slice(0, 32), app_access: true } })
  state.roleId = role.id
  await api(page, token, 'PUT', `/admin/api/roles/${role.id}/resources/${state.resources.clientes}/permissions/READ`, {
    // A field a grant doesn't name is UNDEFINED - denied: every column named.
    data: { effect: 'ALLOW', fields: ['id', 'nombre', 'email', 'ciudad', 'activo', 'limite'].map(field => ({ field, effect: 'ALLOW' })) }
  })
  const user = await api<{ id: string }>(page, token, 'POST', '/admin/api/users', { data: { email: USER_EMAIL, name: `${PREFIX} Viewer`, password: USER_PASSWORD, roleIds: [role.id] } })
  state.userId = user.id
  await context.close()
})

test.afterAll(async ({ browser }) => {
  test.setTimeout(90_000)
  const { context, page, token } = await adminSession(browser)
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined)
  // An owned DataView (a Master-detail's detail) goes with its owner: owners first, then whatever is left.
  const all = await api<DataViewRow[]>(page, token, 'GET', '/admin/api/dataviews')
  const ours = all.filter(d => state.dataviews.has(d.id)).sort((a, b) => Number(Boolean(a.owner)) - Number(Boolean(b.owner)))
  for (const dv of ours) await quiet(api(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`))
  if (state.userId) await quiet(api(page, token, 'DELETE', `/admin/api/users/${state.userId}`))
  if (state.roleId) await quiet(api(page, token, 'DELETE', `/api/totalbase/table/roles/${state.roleId}`))
  await quiet(sql(page, token, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`))
  await quiet(api(page, token, 'POST', '/admin/api/catalog/refresh'))
  const ids = Object.values(state.resources)
  if (ids.length) await quiet(sql(page, token, `DELETE FROM totalbase.resources WHERE id IN (${ids.map(id => `'${id}'`).join(', ')})`))
  await context.close()
})

// --- Helpers -----------------------------------------------------------------------

const getDataView = (page: Page, token: string, id: string) => api<DataViewRow>(page, token, 'GET', `/admin/api/dataviews/${id}`)
const getFields = (page: Page, token: string, id: string) => api<FieldRow[]>(page, token, 'GET', `/admin/api/dataviews/${id}/fields`)

/** The wizard from the DataViews screen, up to its Identity and Source steps; the rest at their defaults until Create. */
async function createWithWizard(page: Page, options: { type: RegExp, name: string, source?: RegExp }) {
  await page.goto('/admin/dataviews')
  await page.getByRole('button', { name: 'New DataView' }).first().click()
  const wizard = page.getByRole('dialog', { name: 'New DataView' })
  await wizard.getByRole('button', { name: options.type }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Name').fill(options.name)
  await wizard.getByRole('button', { name: 'Next' }).click()
  if (options.source) {
    await wizard.getByRole('button', { name: /^(Table or view|Master table|Record table)$/ }).click()
    await page.getByRole('option', { name: options.source }).click()
  }
  // Next until the last step, where Create takes its place (a FORM's Mode has a "Create" of its own - the footer's is the last).
  for (let step = 0; step < 8 && await wizard.getByRole('button', { name: 'Next', exact: true }).isVisible(); step++) {
    await wizard.getByRole('button', { name: 'Next', exact: true }).click()
  }
  await wizard.getByRole('button', { name: 'Create', exact: true }).last().click()
  await expect(page.getByText('DataView created').first()).toBeVisible()
  await page.waitForURL(/\/admin\/dataviews\/[0-9a-f-]{36}/, { waitUntil: 'commit' })
  const id = /\/admin\/dataviews\/([0-9a-f-]{36})/.exec(page.url())![1]!
  state.dataviews.add(id)
  return id
}

/** The header's Publish opens a short confirmation whose own Publish publishes. */
async function publishFromHeader(page: Page) {
  const header = page.locator('main').getByRole('button', { name: 'Publish', exact: true }).first()
  await expect(header).toBeEnabled()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('dialog').filter({ hasNot: page.locator('main') }).getByRole('button', { name: 'Publish', exact: true }).last().click()
  await expect(page.getByText(/Published as v\d+/).first()).toBeVisible()
}

// --- The wizard: one DataView of each structural type ---------------------------------

test('wizard: a TABLE over a table, with its columns and features', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await createWithWizard(page, { type: /^Table A sortable/, name: `${PREFIX} Tabla`, source: new RegExp(`${SCHEMA}\\.clientes$`) })
  const dv = await getDataView(page, token, id)
  expect(dv.viewType).toBe('TABLE')
  expect(dv.name).toBe(`${PREFIX} Tabla`)
  const fields = await getFields(page, token, id)
  expect(fields.filter(f => f.kind === 'COLUMN').map(f => f.columnName)).toEqual(expect.arrayContaining(['nombre', 'email', 'ciudad']))
  state.created.TABLE = dv
  expect(failures).toEqual([])
})

test('wizard: a FORM over a table', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await createWithWizard(page, { type: /^Form One record/, name: `${PREFIX} Form`, source: new RegExp(`${SCHEMA}\\.clientes$`) })
  const dv = await getDataView(page, token, id)
  expect(dv.viewType).toBe('FORM')
  expect(dv.viewConfig.form_view_mode).toBe('READ')
  state.created.FORM = dv
  expect(failures).toEqual([])
})

test('wizard: a MASTER_DETAIL with its detail table picked by its foreign key', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await createWithWizard(page, { type: /^Master-detail/, name: `${PREFIX} Pedidos`, source: new RegExp(`${SCHEMA}\\.pedidos$`) })
  const dv = await getDataView(page, token, id)
  expect(dv.viewType).toBe('MASTER_DETAIL')
  // Its detail is a DataView of its own, owned by the master - deleted with it.
  const owned = (await sql(page, token, `SELECT id FROM totalbase.dataviews WHERE owner = '${id}'`)).rows as { id: string }[]
  expect(owned).toHaveLength(1)
  owned.forEach(d => state.dataviews.add(d.id))
  const detailFields = await getFields(page, token, owned[0]!.id)
  expect(detailFields.map(f => f.columnName)).toEqual(expect.arrayContaining(['descripcion', 'cantidad']))
  expect(failures).toEqual([])
})

test('wizard: a CUSTOM page with no record table', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = await createWithWizard(page, { type: /^Custom A blank page/, name: `${PREFIX} Pagina` })
  const dv = await getDataView(page, token, id)
  expect(dv.viewType).toBe('CUSTOM')
  state.created.CUSTOM = dv
  expect(failures).toEqual([])
})

// --- Settings -----------------------------------------------------------------------

const settingsOf = async (page: Page, id: string) => {
  await page.goto(`/admin/dataviews/${id}/settings`)
  const main = page.locator('main')
  await expect(main.getByRole('textbox', { name: 'Name*' })).toBeVisible()
  return main
}
/** A row of the Columns table, by its column's name. */
const columnRow = (main: Locator, column: string) => main.getByRole('row').filter({ has: main.page().getByRole('button', { name: `Settings of ${column}`, exact: true }) })

test('settings: rename, a feature off, and the roles that open it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.TABLE!.id
  const main = await settingsOf(page, id)

  // Identity: saved at once, not versioned.
  await main.getByRole('textbox', { name: 'Name*' }).fill(`${PREFIX} Clientes`)
  await main.getByRole('textbox', { name: 'Name*' }).blur()
  await poll(async () => (await getDataView(page, token, id)).name).toBe(`${PREFIX} Clientes`)

  // A table feature: Export off, in Actions - a draft change.
  await page.goto(`/admin/dataviews/${id}/settings?section=actions`)
  await main.getByRole('switch', { name: 'Export', exact: true }).click()
  await poll(async () => ((await getDataView(page, token, id)).viewConfig.features as Record<string, boolean> | undefined)?.export).toBe(false)
  await poll(async () => (await getDataView(page, token, id)).hasUnpublishedChanges).toBe(true)

  // Security: the fixture role opens it - applies at once.
  await page.goto(`/admin/dataviews/${id}/settings?section=security`)
  await main.getByRole('switch', { name: `${PREFIX} Viewer sees it` }).click()
  const granted = () => api<{ role: string }[]>(page, token, 'GET', `/api/totalbase/table/dataviews_roles?fields=role&where[dataview][_eq]=${id}`)
  await poll(async () => (await granted()).map(r => r.role)).toEqual([state.roleId])

  // Feature back on, so the runtime tests keep their toolbar.
  await page.goto(`/admin/dataviews/${id}/settings?section=actions`)
  await main.getByRole('switch', { name: 'Export', exact: true }).click()
  await poll(async () => ((await getDataView(page, token, id)).viewConfig.features as Record<string, boolean> | undefined)?.export).toBe(true)
  expect(failures).toEqual([])
})

test('preview: Phone frames the App with the draft - its phone shell', async ({ page }) => {
  await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.TABLE!.id
  await settingsOf(page, id)
  await page.getByRole('button', { name: 'Preview' }).first().click()
  const drawer = page.getByRole('dialog').filter({ hasText: 'Preview' })
  await drawer.getByRole('tab', { name: 'Phone' }).click()
  const frame = drawer.locator('iframe')
  await expect(frame).toHaveAttribute('src', /\?draft=true$/)
  const box = await frame.boundingBox()
  expect(Math.round(box!.width)).toBe(390)
  // Inside, the App at a phone's width: its header and the DataView's name.
  await expect(frame.contentFrame().getByRole('heading', { name: `${PREFIX} Clientes` })).toBeVisible()
  expect(failures).toEqual([])
})

test('settings: columns added, synced, removed; a column\'s panel, hidden, ordered and sorted', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.TABLE!.id
  await sql(page, token, `ALTER TABLE ${SCHEMA}.clientes ADD COLUMN telefono text, ADD COLUMN notas text`)
  await api(page, token, 'POST', '/admin/api/catalog/refresh')
  const main = await settingsOf(page, id)
  await page.goto(`/admin/dataviews/${id}/settings?section=data`)
  const fieldOf = async (column: string) => (await getFields(page, token, id)).find(f => f.columnName === column)

  // Add columns…: telefono, shown at the end.
  await main.getByRole('button', { name: 'Add columns…' }).click()
  await page.getByRole('dialog').getByRole('checkbox', { name: 'telefono' }).check()
  await page.getByRole('dialog').getByRole('button', { name: 'Add 1', exact: true }).click()
  await expect(columnRow(main, 'telefono')).toBeVisible()
  expect((await fieldOf('telefono'))?.visible).toBe(true)

  // Sync columns: notas, the table's other new column, comes in too.
  await main.getByRole('button', { name: 'Sync columns' }).click()
  await expect(page.getByText('Columns synced').first()).toBeVisible()
  await poll(async () => (await fieldOf('notas'))?.columnName).toBe('notas')

  // A column's panel, a sidebar over the page: its list's Properties; its title, format and look From the column, read only.
  const panel = page.getByRole('dialog', { name: 'Ciudad' })
  await columnRow(main, 'ciudad').getByRole('button', { name: 'Settings of ciudad' }).click()
  await expect(panel.getByRole('switch', { name: 'Shown' })).toBeVisible()
  await panel.getByRole('tab', { name: 'From the column' }).click()
  await expect(panel.getByRole('button', { name: 'Edit in the table' })).toBeVisible()
  await expect(panel.getByRole('textbox')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
  await main.getByRole('checkbox', { name: 'Show activo' }).click()
  await poll(async () => (await fieldOf('activo'))?.visible).toBe(false)

  // Default order: email above nombre; default sort: nombre ascending.
  await columnRow(main, 'email').getByRole('button', { name: 'Move up' }).click()
  const defaultState = async () => (await getDataView(page, token, id)).viewConfig.default_state as { columnPrefs?: Record<string, { order: number }>, sort?: string }
  await poll(async () => {
    const prefs = (await defaultState())?.columnPrefs ?? {}
    return (prefs.email?.order ?? 99) < (prefs.nombre?.order ?? -1)
  }).toBe(true)
  await columnRow(main, 'nombre').getByRole('button', { name: 'Not sorted - click to sort ascending' }).click()
  // After whatever sorted it before (its primary key, by default): a sort is a list.
  await poll(async () => (await defaultState())?.sort ?? '').toMatch(/(^|,)nombre$/)

  // Remove from the DataView: telefono is no longer read.
  await columnRow(main, 'telefono').getByRole('button', { name: 'Settings of telefono' }).click()
  await page.getByRole('dialog', { name: 'Telefono' }).getByRole('button', { name: 'Remove from the DataView' }).click()
  await expect(columnRow(main, 'telefono')).toHaveCount(0)
  await poll(async () => await fieldOf('telefono')).toBeUndefined()
  expect(failures).toEqual([])
})

test('settings: published, an earlier version restored, and one saved as a new DataView', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.TABLE!.id
  const main = await settingsOf(page, id)

  // v1: what the earlier tests left in the draft.
  await publishFromHeader(page)
  await poll(async () => (await getDataView(page, token, id)).liveVersion).toBe(1)

  // A change, published as v2: the table's Print off (Views › Table).
  await page.goto(`/admin/dataviews/${id}/settings?section=views&view=TABLE`)
  await main.getByRole('switch', { name: 'Print', exact: true }).first().click()
  await poll(async () => (await getDataView(page, token, id)).hasUnpublishedChanges).toBe(true)
  await publishFromHeader(page)
  await poll(async () => (await getDataView(page, token, id)).liveVersion).toBe(2)

  // v1 restored into the draft: Print on again, unpublished.
  await main.getByRole('button', { name: /^Draft.*Active: v2/ }).click()
  await page.getByRole('menuitemcheckbox', { name: /^v1 / }).click()
  await expect(main.getByText(/read-only/).first()).toBeVisible()
  await main.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Restored v1 into the draft', { exact: true })).toBeVisible()
  await poll(async () => ((await getDataView(page, token, id)).viewConfig.features as Record<string, boolean> | undefined)?.print).toBe(true)
  expect((await getDataView(page, token, id)).hasUnpublishedChanges).toBe(true)

  // v2 saved as a new, unpublished DataView.
  await main.getByRole('button', { name: /^Draft/ }).click()
  await page.getByRole('menuitemcheckbox', { name: /^v2 / }).click()
  await main.getByRole('button', { name: 'Save as…' }).click()
  const modal = page.getByRole('dialog', { name: 'Save as a new copy' })
  await modal.getByLabel('Name').fill(`${PREFIX} Copia`)
  await modal.getByRole('button', { name: 'Create copy' }).click()
  await expect(page.getByText(`Created "${PREFIX} Copia"`, { exact: true })).toBeVisible()
  await page.waitForURL(url => /\/admin\/dataviews\/[0-9a-f-]{36}\/settings/.test(url.pathname) && !url.pathname.includes(id), { waitUntil: 'commit' })
  const copyId = /\/admin\/dataviews\/([0-9a-f-]{36})/.exec(page.url())![1]!
  state.dataviews.add(copyId)
  const copy = await getDataView(page, token, copyId)
  expect(copy.name).toBe(`${PREFIX} Copia`)
  expect(copy.liveVersion ?? null).toBeNull()
  expect((copy.viewConfig.features as Record<string, boolean> | undefined)?.print).toBe(false)

  // The original's restored draft published again - the runtime tests read it.
  await settingsOf(page, id)
  await publishFromHeader(page)
  expect(failures).toEqual([])
})

test('settings: a FORM\'s page options and its Save and Cancel off - the published form has no footer', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.FORM!.id
  const main = await settingsOf(page, id)
  const config = async () => (await getDataView(page, token, id)).viewConfig

  // The page options (DataViews.md §6.7), in Form: Content width, Content align, Fit to screen.
  await page.goto(`/admin/dataviews/${id}/settings?section=form`)
  await main.getByRole('button', { name: 'Wide', exact: true }).click()
  await poll(async () => (await config()).page_content_width).toBe('wide')
  await main.getByRole('button', { name: 'Left', exact: true }).click()
  await poll(async () => (await config()).page_content_align).toBe('left')
  await main.getByRole('switch', { name: 'Fit to screen' }).click()
  await poll(async () => (await config()).fit_to_screen).toBe(true)

  // Save and Cancel off: the page saves through its own buttons.
  await main.getByRole('switch', { name: 'Save and Cancel', exact: true }).click()
  await poll(async () => ((await config()).features as Record<string, boolean> | undefined)?.recordSaveCancel).toBe(false)
  await publishFromHeader(page)

  // The App: Edit opens the record for editing, with no Cancel and Save footer.
  const { slug } = await getDataView(page, token, id)
  await page.goto(`/admin/app/dataviews/${slug}`)
  const app = page.locator('main')
  await app.getByRole('button', { name: 'Edit', exact: true }).click()
  await expect(app.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0)
  await expect(app.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0)
  await expect(app.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0)
  expect(failures).toEqual([])
})

// --- Design (a CUSTOM page) -----------------------------------------------------------

test('design: widgets added, moved and resized, code saved, then published', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.CUSTOM!.id
  await page.goto(`/admin/dataviews/${id}/design`)
  const main = page.locator('main')
  const pageWidgets = async () => (await getFields(page, token, id)).filter(f => f.parent === null && f.widget)
    .sort((a, b) => a.gridY - b.gridY || a.gridX - b.gridX)
  const place = async (label: string) => {
    const search = main.getByRole('textbox', { name: /Search widgets/ }).or(main.getByPlaceholder('Search widgets…')).first()
    await search.fill(label)
    await main.getByRole('button', { name: label, exact: true }).first().click()
    await search.fill('')
  }

  // Two widgets from the palette, in that order.
  await place('Heading')
  await poll(async () => (await pageWidgets()).map(f => f.widget)).toEqual(['THeading'])
  await place('Badge')
  await poll(async () => (await pageWidgets()).map(f => f.widget)).toEqual(['THeading', 'UBadge'])
  const [heading, badge] = await pageWidgets()

  // Moved: the Badge dragged before the Heading.
  const headingItem = main.locator(`[data-canvas-item="${heading!.id}"]`)
  const badgeItem = main.locator(`[data-canvas-item="${badge!.id}"]`)
  await badgeItem.dragTo(headingItem, { targetPosition: { x: 4, y: 4 } })
  await poll(async () => (await pageWidgets()).map(f => f.widget)).toEqual(['UBadge', 'THeading'])

  // Resized: the Heading's right edge dragged to about half the page.
  await headingItem.dispatchEvent('click')
  const box = (await headingItem.boundingBox())!
  const handle = { x: box.x + box.width - 4, y: box.y + box.height / 2 }
  await page.mouse.move(handle.x, handle.y)
  await page.mouse.down()
  await page.mouse.move(handle.x - box.width / 2, handle.y, { steps: 8 })
  await page.mouse.up()
  await poll(async () => (await getFields(page, token, id)).find(f => f.id === heading!.id)?.gridW).toBeLessThan(12)
  const resized = (await getFields(page, token, id)).find(f => f.id === heading!.id)!.gridW
  expect(resized).toBeGreaterThanOrEqual(4)
  expect(resized).toBeLessThanOrEqual(8)

  // Code: typed into the editor, autosaved.
  await main.getByRole('tab', { name: 'Code' }).click()
  const editor = main.locator('.monaco-editor').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('\nfunction uiDvHello(dataview) { return 1 }\n')
  await poll(async () => (await getDataView(page, token, id)).code ?? '', { timeout: 20_000 }).toContain('function uiDvHello(dataview)')

  // Published: the App draws the two widgets.
  await main.getByRole('tab', { name: 'Design' }).click()
  await publishFromHeader(page)
  await poll(async () => (await getDataView(page, token, id)).liveVersion).toBe(1)
  expect(failures).toEqual([])
})

test('design: ?field= reopens a widget\'s inspector and follows the selection', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.CUSTOM!.id
  const [first, second] = (await getFields(page, token, id)).filter(f => f.parent === null && f.widget)
  const main = page.locator('main')

  // Opened on a widget: its inspector, not the empty one.
  await page.goto(`/admin/dataviews/${id}/design?field=${first!.id}`)
  await expect(main.locator(`[data-canvas-item="${second!.id}"]`)).toBeVisible()
  await expect(main.getByText('No widget selected')).toHaveCount(0)

  // Another widget selected: the URL follows, and a reload comes back to it.
  await main.locator(`[data-canvas-item="${second!.id}"]`).dispatchEvent('click')
  await page.waitForURL(url => url.searchParams.get('field') === second!.id, { waitUntil: 'commit' })
  await page.reload()
  await expect(main.locator(`[data-canvas-item="${second!.id}"]`)).toBeVisible()
  await expect(main.getByText('No widget selected')).toHaveCount(0)

  // A widget no longer on the page selects nothing, and leaves the URL.
  await page.goto(`/admin/dataviews/${id}/design?field=00000000-0000-0000-0000-000000000000`)
  await expect(main.getByText('No widget selected')).toBeVisible()
  await page.waitForURL(url => !url.searchParams.has('field'), { waitUntil: 'commit' })
  expect(failures).toEqual([])
})

// --- App menu -------------------------------------------------------------------------

interface MenuNode { kind: string, id: string, name: string, icon?: string | null, children?: MenuNode[] }
type MenuInput = { kind: 'GROUP', id: string, name: string, icon: string | null, children: MenuInput[] } | { kind: string, id: string }
const toInput = (list: MenuNode[]): MenuInput[] => list.map(node => node.kind === 'GROUP'
  ? { kind: 'GROUP', id: node.id, name: node.name, icon: node.icon ?? null, children: toInput(node.children ?? []) }
  : { kind: node.kind, id: node.id })
/** Every node, depth first, with the group holding it. */
function flatten(list: MenuNode[], parent: string | null = null): { node: MenuNode, parent: string | null }[] {
  return list.flatMap(node => [{ node, parent }, ...(node.kind === 'GROUP' ? flatten(node.children ?? [], node.id) : [])])
}

/**
 * A native drag from one menu row onto another, at `ratio` of its height
 * (the editor reads the pointer's height: upper half before, a group's lower
 * part into) - dispatched, not a mouse drag: a long menu scrolls between the
 * two rows, and a scroll mid-drag lands the drop elsewhere.
 */
async function dragRow(source: Locator, target: Locator, ratio: number) {
  const dataTransfer = await source.page().evaluateHandle(() => new DataTransfer())
  await source.dispatchEvent('dragstart', { dataTransfer })
  await target.scrollIntoViewIfNeeded()
  const box = (await target.boundingBox())!
  const at = { dataTransfer, clientX: box.x + 40, clientY: box.y + box.height * ratio }
  await target.dispatchEvent('dragover', at)
  await target.dispatchEvent('drop', at)
  await source.dispatchEvent('dragend', { dataTransfer })
}

test('app menu: a published DataView listed, reordered, grouped, and the arrangement restored', async ({ page }) => {
  test.setTimeout(120_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const original = await api<{ nodes: MenuNode[] }>(page, token, 'GET', '/admin/api/app/menu')
  const menu = async () => flatten((await api<{ nodes: MenuNode[] }>(page, token, 'GET', '/admin/api/app/menu')).nodes)
  const clientes = state.created.TABLE!.id
  const pagina = state.created.CUSTOM!.id
  const GROUP = `${PREFIX} Grupo`.slice(0, 32)
  try {
    await page.goto('/admin/app?edit')
    const main = page.locator('main')
    const row = (name: string) => main.getByRole('treeitem').filter({ hasText: name })
    // Both published DataViews are in the menu.
    await expect(row(`${PREFIX} Clientes`)).toBeVisible()
    await expect(row(`${PREFIX} Pagina`)).toBeVisible()

    // Reordered: the page dragged above the table.
    await dragRow(row(`${PREFIX} Pagina`), row(`${PREFIX} Clientes`), 0.1)
    await poll(async () => {
      const ids = (await menu()).map(e => e.node.id)
      return ids.indexOf(pagina) < ids.indexOf(clientes)
    }).toBe(true)

    // A new group, named, the table dragged into it.
    await main.getByRole('button', { name: 'New group' }).click()
    const groupModal = page.getByRole('dialog')
    await groupModal.getByLabel('Group name').fill(GROUP)
    await groupModal.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(row(GROUP)).toBeVisible()
    await dragRow(row(`${PREFIX} Clientes`), row(GROUP), 0.8)
    await poll(async () => {
      const entries = await menu()
      const group = entries.find(e => e.node.kind === 'GROUP' && e.node.name === GROUP)
      return group ? entries.find(e => e.node.id === clientes)?.parent === group.node.id : false
    }).toBe(true)

    // The group deleted (its Edit, behind Confirm): its entry moves up where it was.
    await row(GROUP).getByRole('button', { name: `Edit ${GROUP}` }).click()
    await page.getByRole('dialog').getByRole('checkbox', { name: 'Confirm' }).check()
    await page.getByRole('dialog').getByRole('button', { name: 'Delete group' }).click()
    await poll(async () => (await menu()).some(e => e.node.name === GROUP)).toBe(false)
    expect((await menu()).find(e => e.node.id === clientes)?.parent).toBeNull()
    await expect(main.getByText('Saved')).toBeVisible()
  } finally {
    // Back as it was - minus any object deleted meanwhile (PostgreSQL refuses an unknown one).
    const present = new Set((await menu()).map(e => e.node.id))
    const keep = (list: MenuNode[]): MenuNode[] => list.filter(n => n.kind === 'GROUP' || present.has(n.id)).map(n => (n.kind === 'GROUP' ? { ...n, children: keep(n.children ?? []) } : n))
    await api(page, token, 'PUT', '/admin/api/app/menu', { data: { nodes: toInput(keep(original.nodes)) } })
  }
  expect(failures).toEqual([])
})

test('app menu: sorted by name Z → A at every level, groups first, and the arrangement restored', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const original = await api<{ nodes: MenuNode[] }>(page, token, 'GET', '/admin/api/app/menu')
  const read = async () => (await api<{ nodes: MenuNode[] }>(page, token, 'GET', '/admin/api/app/menu')).nodes
  const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true })
  /** Every level: groups before entries, each part by name Z → A. */
  const sortedDesc = (list: MenuNode[]): boolean => {
    const groups = list.filter(n => n.kind === 'GROUP')
    const entries = list.filter(n => n.kind !== 'GROUP')
    const desc = (part: MenuNode[]) => part.every((n, i) => i === 0 || collator.compare(part[i - 1]!.name, n.name) >= 0)
    return list.slice(0, groups.length).every(n => n.kind === 'GROUP') && desc(groups) && desc(entries)
      && groups.every(g => sortedDesc(g.children ?? []))
  }
  try {
    await page.goto('/admin/app?edit')
    const main = page.locator('main')
    await main.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Sort by name…' }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('radio', { name: 'Z → A' }).check()
    await dialog.getByRole('button', { name: 'Sort', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    // What the other files publish meanwhile joins the end of the menu (Security.md §8.2): only what was there is judged.
    const known = new Set(flatten(original.nodes).map(e => e.node.id))
    const theirs = (list: MenuNode[]): MenuNode[] => list.filter(n => n.kind === 'GROUP' || known.has(n.id)).map(n => (n.kind === 'GROUP' ? { ...n, children: theirs(n.children ?? []) } : n))
    await poll(async () => sortedDesc(theirs(await read()))).toBe(true)
  } finally {
    const present = new Set(flatten(await read()).map(e => e.node.id))
    const keep = (list: MenuNode[]): MenuNode[] => list.filter(n => n.kind === 'GROUP' || present.has(n.id)).map(n => (n.kind === 'GROUP' ? { ...n, children: keep(n.children ?? []) } : n))
    await api(page, token, 'PUT', '/admin/api/app/menu', { data: { nodes: toInput(keep(original.nodes)) } })
  }
  expect(failures).toEqual([])
})

test('app menu: an item hidden from the menu, listed under Hidden, and shown again', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const id = state.created.TABLE!.id
  const name = `${PREFIX} Clientes`
  const scope = async () => (await api<{ scope: string }>(page, token, 'GET', `/admin/api/dataviews/${id}`)).scope
  try {
    await page.goto('/admin/app?edit')
    const main = page.locator('main')
    const row = main.getByRole('treeitem').filter({ hasText: name })
    // Its Edit: Remove from the menu.
    await row.getByRole('button', { name: `Edit ${name}` }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Remove from the menu' }).click()
    await expect(row).toHaveCount(0)
    await poll(scope).toBe('EMBEDDED_ONLY')
    await expect(main.getByText('Hidden', { exact: true })).toBeVisible()

    await main.getByRole('button', { name: `Show ${name} in the menu` }).click()
    await expect(row).toBeVisible()
    await poll(scope).toBe('LISTED')
  } finally {
    if (await scope() !== 'LISTED') await api(page, token, 'PATCH', `/admin/api/dataviews/${id}`, { data: { scope: 'LISTED' } })
  }
  expect(failures).toEqual([])
})

// --- Runtime: saved views, shares, the viewer's own prefs, export/print audit ----------

async function openGrid(page: Page, slug: string, query = '') {
  await page.goto(`/admin/app/dataviews/${slug}${query}`)
  const main = page.locator('main')
  await expect(main.locator('tbody tr').first()).toBeVisible()
  return main
}
const gridRows = (page: Page) => page.locator('main tbody tr')

/** The fixture viewer's own session - a new browser context, signed in through the login page. */
async function asViewer(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await login(page, USER_EMAIL, USER_PASSWORD)
  return { context, page }
}

test('saved views: saved, shared with a user who applies it, opened by link, unshared and deleted', async ({ page, browser }) => {
  test.setTimeout(150_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const dv = await getDataView(page, token, state.created.TABLE!.id)
  const VIEW = 'Solo Rosario'
  const main = await openGrid(page, dv.slug)

  // A filter, saved as a view.
  await main.getByRole('button', { name: /^Filter/ }).click()
  const filter = page.getByRole('dialog', { name: 'Filter' })
  await filter.getByRole('button', { name: 'Advanced' }).click()
  await filter.getByRole('textbox').last().fill('{ "ciudad": { "_eq": "Rosario" } }')
  await filter.getByRole('textbox').last().blur()
  await filter.getByRole('button', { name: 'Close' }).last().click()
  await expect(gridRows(page)).toHaveCount(1)
  // The views popover ("View: Default"): Save current view…, and each of one's own views shared and deleted on its row.
  const selector = (m: Locator) => m.getByRole('button', { name: /^View: / }).first()
  await selector(main).click()
  await page.getByRole('button', { name: 'Save current view…' }).click()
  await page.getByLabel('Name').fill(VIEW)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('View saved').first()).toBeVisible()
  const views = () => api<{ id: string, name: string, sharedCount: number }[]>(page, token, 'GET', `/app/api/dataviews/${dv.id}/saved-views`)
  await poll(async () => (await views()).map(v => v.name)).toEqual([VIEW])
  const viewId = (await views())[0]!.id
  const shares = () => api<{ kind: string, id: string }[]>(page, token, 'GET', `/app/api/dataviews/${dv.id}/saved-views/${viewId}/shares`)

  // Shared with the fixture user.
  await selector(main).click()
  await page.getByRole('button', { name: 'Share this view' }).click()
  const share = page.getByRole('dialog', { name: `Share “${VIEW}”` })
  // One search over roles and people - picking one shares it at once.
  await share.getByRole('combobox', { name: 'Add roles or people' }).or(share.getByRole('button', { name: 'Add roles or people' })).first().click()
  await page.keyboard.type(USER_EMAIL)
  await page.getByRole('option', { name: new RegExp(USER_EMAIL.replace(/[.]/g, '\\.')) }).click()
  await expect(share.getByText(`${PREFIX} Viewer`)).toBeVisible()
  await poll(async () => (await shares()).map(s => s.id)).toEqual([state.userId])
  await share.getByRole('button', { name: 'Done' }).click()

  // The user sees it, marked Shared, and applies it.
  const viewer = await asViewer(browser)
  const viewerFailures = watchApiFailures(viewer.page)
  try {
    const viewerMain = await openGrid(viewer.page, dv.slug)
    await expect(gridRows(viewer.page)).toHaveCount(4)
    await selector(viewerMain).click()
    await expect(viewer.page.getByText('Shared', { exact: true })).toBeVisible()
    await viewer.page.getByRole('button', { name: new RegExp(`^${VIEW}`) }).click()
    await expect(gridRows(viewer.page)).toHaveCount(1)
    await expect(gridRows(viewer.page).first()).toContainText('Acme')

    // The link: applied once, never added to the opener's list.
    await openGrid(viewer.page, dv.slug, `?view=${viewId}`)
    await expect(viewer.page.getByText(`Applied view "${VIEW}"`, { exact: true })).toBeVisible()
    await expect(gridRows(viewer.page)).toHaveCount(1)
    await expect(viewer.page).not.toHaveURL(/view=/)
    expect(viewerFailures).toEqual([])
  } finally {
    await viewer.context.close()
  }

  // Unshared, then deleted - asked on its row.
  await selector(main).click()
  await page.getByRole('button', { name: 'Share this view' }).click()
  await share.getByRole('button', { name: 'Stop sharing' }).click()
  await expect(share.getByText(`${PREFIX} Viewer`)).toHaveCount(0)
  await poll(async () => (await shares()).length).toBe(0)
  await share.getByRole('button', { name: 'Done' }).click()
  await selector(main).click()
  await page.getByRole('button', { name: 'Delete saved view' }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  await poll(async () => (await views()).length).toBe(0)
  expect(failures).toEqual([])
})

test('grid prefs: a column moved and a sort chosen come back after a reload', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const dv = await getDataView(page, token, state.created.TABLE!.id)
  const main = await openGrid(page, dv.slug)
  const headers = async () => (await main.getByRole('columnheader').allInnerTexts()).map(t => t.trim()).filter(Boolean)
  // Email moved one place to the right, in the viewer's own Columns panel.
  const before = await headers()
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: /^Columns/ }).click()
  const columns = page.getByRole('dialog', { name: 'Columns' })
  await columns.getByRole('button', { name: 'Move Email down' }).click()
  await columns.getByRole('button', { name: 'Close' }).last().click()
  await poll(async () => (await headers()).indexOf('Email')).toBe(before.indexOf('Email') + 1)
  const moved = await headers()

  // Sorted by Email, descending: Gamma's address first.
  await main.getByRole('button', { name: 'Email', exact: true }).click()
  await main.getByRole('button', { name: 'Email', exact: true }).click()
  await expect(gridRows(page).first()).toContainText('gamma@ui-dv.test')
  const prefs = async () => (await api<{ config: { sort?: string, columnPrefs?: Record<string, { order: number }> } } | null>(page, token, 'GET', `/app/api/dataviews/${dv.id}/user-prefs`))?.config
  await poll(async () => (await prefs())?.sort).toBe('-email')

  await page.reload()
  await expect(gridRows(page).first()).toContainText('gamma@ui-dv.test')
  expect(await headers()).toEqual(moved)
  expect(failures).toEqual([])
})

test('export and print each record one audit event', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const dv = await getDataView(page, token, state.created.TABLE!.id)
  const main = await openGrid(page, dv.slug)
  const events = (action: string) => api<{ id: string }[]>(page, token, 'GET', `/admin/api/audit/logs?resource=${state.resources.clientes}&action=${action}`)
  const exportsBefore = (await events('EXPORT')).length
  const printsBefore = (await events('PRINT')).length

  await main.getByRole('button', { name: 'Actions', exact: true }).click()

  await page.getByRole('menuitem', { name: /^Export/ }).click()
  const download = page.waitForEvent('download')
  await page.getByRole('dialog', { name: 'Export' }).getByRole('button', { name: 'Export', exact: true }).click()
  await download
  await poll(async () => (await events('EXPORT')).length).toBe(exportsBefore + 1)
  await page.keyboard.press('Escape')

  await main.getByRole('button', { name: 'Actions', exact: true }).click()

  await page.getByRole('menuitem', { name: /^Print/ }).click()
  await page.getByRole('dialog', { name: 'Print' }).getByRole('button', { name: 'Print', exact: true }).click()
  await poll(async () => (await events('PRINT')).length).toBe(printsBefore + 1)
  expect(failures).toEqual([])
})
