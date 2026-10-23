import { expect, test, type Browser, type Locator, type Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, apiRequest, login, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Every write action of the Database area, driven through the real UI:
 * schema management (schemas, tables, columns, constraints, indexes, views,
 * functions), a resource's settings, the SQL Console and Maintenance. The
 * API only sets up and cleans up fixtures and re-reads what a flow saved.
 *
 * Fixtures live in their own schema `ui_db_<random>` (plus a second one the
 * New schema flow creates), dropped with CASCADE at the end; their
 * resources rows are deleted by id, then a catalog refresh.
 */

const SUFFIX = Math.random().toString(36).slice(2, 8)
const SCHEMA = `ui_db_${SUFFIX}`
const NEW_SCHEMA = `ui_db_${SUFFIX}_new`
const CREATED_TABLE = 'created_items'
const RENAMED_TABLE = 'items_renamed'

const FIXTURE_SQL = `
CREATE SCHEMA ${SCHEMA};
CREATE TABLE ${SCHEMA}.parents (id serial PRIMARY KEY, code text);
CREATE TABLE ${SCHEMA}.items (id integer PRIMARY KEY, name text, qty integer, note text, parent integer);
CREATE TABLE ${SCHEMA}.checked (id integer PRIMARY KEY, price numeric(12,2));
CREATE TABLE ${SCHEMA}.maint (id integer PRIMARY KEY, label text);
CREATE TABLE ${SCHEMA}.audited (id integer PRIMARY KEY, name text, qty integer, note text);
INSERT INTO ${SCHEMA}.audited VALUES (1, 'first', 1, 'plain');
INSERT INTO ${SCHEMA}.maint SELECT g, 'row ' || g FROM generate_series(1, 200) g;
INSERT INTO ${SCHEMA}.parents (code) VALUES ('P1');
CREATE TABLE ${SCHEMA}.browsed (id integer PRIMARY KEY, label text);
INSERT INTO ${SCHEMA}.browsed SELECT g, 'row ' || g FROM generate_series(1, 30) g;
CREATE TABLE ${SCHEMA}.keyed (id integer PRIMARY KEY, label text);
CREATE VIEW ${SCHEMA}.items_view AS SELECT id, name FROM ${SCHEMA}.checked c JOIN (SELECT 1 AS k, 'x'::text AS name) s ON true;
CREATE FUNCTION ${SCHEMA}.double_it(x integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT x * 2 $$;
CREATE FUNCTION ${SCHEMA}.lonely(a integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT a $$;
CREATE FUNCTION ${SCHEMA}.overloaded(x integer) RETURNS integer LANGUAGE sql IMMUTABLE AS $$ SELECT x $$;
CREATE FUNCTION ${SCHEMA}.overloaded(x text, y integer) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT x $$;
`

interface ResourceRow { id: string, name: string, schema: string, type: string, exposed_methods: string[], description: string | null, function_class: string | null, audit_read: boolean, require_idempotency_key: boolean, row_presentation?: Record<string, string> }
interface RelationDetail {
  columns: { name: string, dataType: string, nullable: boolean, defaultExpression: string | null }[]
  primaryKey: string[]
  relations: { name: string, sourceColumn: string, targetSchema: string, targetTable: string, targetColumn: string }[]
  uniqueConstraints: string[][]
  uniqueConstraintNames: string[]
  checkConstraints: { name: string, expression: string, message: string | null }[]
}

/** Fixture setup/cleanup: a bearer token from the auth API - no UI, so a page mid-reload can't fail it. */
async function adminSession(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  // The auth API rate-limits sign-ins (other suites share the server): wait and retry, cleanup must not be skipped.
  for (let attempt = 0; ; attempt++) {
    const response = await page.request.post(`${BASE_URL}/api/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
    if (response.ok()) return { context, page, token: ((await response.json()) as { data: { token: string } }).data.token }
    if (response.status() !== 429 || attempt >= 12) throw new Error(`login -> ${response.status()}`)
    await page.waitForTimeout(5000)
  }
}

function sql(page: Page, token: string, statement: string) {
  return apiRequest<{ rows: Record<string, unknown>[] }>(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: statement } })
}

async function resourcesIn(page: Page, token: string, schema: string): Promise<ResourceRow[]> {
  return apiRequest<ResourceRow[]>(page, token, 'GET', `/api/totalbase/table/resources?where[schema][_eq]=${schema}&where[status][_eq]=ACTIVE&limit=100`)
}

async function resourceNamed(page: Page, token: string, name: string): Promise<ResourceRow | undefined> {
  return (await resourcesIn(page, token, SCHEMA)).find(r => r.name === name)
}

async function resourceById(page: Page, token: string, id: string): Promise<ResourceRow | undefined> {
  return (await apiRequest<ResourceRow[]>(page, token, 'GET', `/api/totalbase/table/resources?where[id][_eq]=${id}&limit=1`))[0]
}

async function mustResource(page: Page, token: string, name: string): Promise<ResourceRow> {
  const row = await resourceNamed(page, token, name)
  if (!row) throw new Error(`No ACTIVE resource ${SCHEMA}.${name}`)
  return row
}

function tableDetail(page: Page, token: string, id: string) {
  return apiRequest<RelationDetail>(page, token, 'GET', `/admin/api/catalog/table/${id}`)
}

/** A Nuxt UI select: open it, pick the option. */
async function choose(page: Page, select: Locator, option: string) {
  await select.click()
  await page.getByRole('option', { name: option, exact: true }).click()
}

/** The Database group's own panel (DatabaseTree.vue), switched to the fixture schema. */
async function openTree(page: Page) {
  await page.goto('/resources')
  // The panel holding the Schema picker - the innermost such box.
  const tree = page.locator('[data-slot="root"]').filter({ has: page.getByRole('combobox', { name: 'Schema' }) }).last()
  await choose(page, tree.getByRole('combobox', { name: 'Schema' }), SCHEMA)
  return tree
}

// A dev server shared with other suites is slow at times - generous per-test time.
test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000)
  const { context, page, token } = await adminSession(browser)
  await sql(page, token, FIXTURE_SQL)
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  await context.close()
})

test.afterAll(async ({ browser }) => {
  test.setTimeout(120_000)
  const { context, page, token } = await adminSession(browser)
  const ids = [...await resourcesIn(page, token, SCHEMA), ...await resourcesIn(page, token, NEW_SCHEMA)].map(r => r.id)
  await sql(page, token, `DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; DROP SCHEMA IF EXISTS ${NEW_SCHEMA} CASCADE;`)
  if (ids.length > 0) {
    await sql(page, token, `DELETE FROM totalbase.resources WHERE id IN (${ids.map(id => `'${id}'`).join(', ')})`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/catalog/refresh')
  await context.close()
})

test('New schema creates a PostgreSQL schema', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)

  await page.goto('/resources')
  // In the New table button's menu, with New view and New function.
  await page.getByRole('button', { name: 'More to create' }).click()
  await page.getByRole('menuitem', { name: 'New schema' }).click()
  const dialog = page.getByRole('dialog', { name: 'New schema' })
  await dialog.getByLabel('Name').fill(NEW_SCHEMA)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const schemas = await apiRequest<{ schema: string }[]>(page, token, 'GET', '/admin/api/catalog/schemas')
  expect(schemas.map(s => s.schema)).toContain(NEW_SCHEMA)
  // The tree offers it right away.
  await page.getByRole('combobox', { name: 'Schema' }).click()
  await expect(page.getByRole('option', { name: NEW_SCHEMA, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  expect(failures).toEqual([])
})

test('New table, then a NOT NULL column with a default and a relation column', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)

  const tree = await openTree(page)
  await tree.getByRole('button', { name: 'New table' }).click()
  const dialog = page.getByRole('dialog', { name: 'New table' })
  await dialog.getByLabel('Name').first().fill(CREATED_TABLE)
  await choose(page, dialog.getByLabel('Schema'), SCHEMA)
  await choose(page, dialog.getByLabel('Type'), 'Serial')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  // Lands on the new table's own page.
  await page.waitForURL(/\/resources\/[0-9a-f-]{36}$/)
  const resource = await mustResource(page, token, CREATED_TABLE)
  expect(page.url()).toContain(resource.id)
  let detail = await tableDetail(page, token, resource.id)
  expect(detail.primaryKey).toEqual(['id'])
  expect(detail.columns.find(c => c.name === 'id')?.dataType).toBe('integer')

  const main = page.locator('main')
  // A Text column: NOT NULL, with a default.
  await main.getByRole('button', { name: 'Add Column' }).click()
  const wizard = page.getByRole('dialog', { name: 'Add column' })
  await wizard.locator('button').filter({ has: page.getByText('Text', { exact: true }) }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Name', { exact: true }).fill('title')
  await wizard.getByRole('switch', { name: 'Not null' }).click()
  await wizard.getByLabel('Default (SQL expression)').fill(`'untitled'`)
  await wizard.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(wizard).toBeHidden()
  await expect(main.getByRole('cell', { name: 'title', exact: true })).toBeVisible()

  // A Relation column to another fixture table.
  await main.getByRole('button', { name: 'Add Column' }).click()
  await wizard.locator('button').filter({ has: page.getByText('Relation', { exact: true }) }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Name', { exact: true }).fill('parent')
  await choose(page, wizard.getByLabel('Target schema'), SCHEMA)
  await choose(page, wizard.getByLabel('Target table'), 'parents')
  await choose(page, wizard.getByLabel('Target column'), 'id')
  await wizard.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(wizard).toBeHidden()
  await expect(main.getByRole('cell', { name: 'parent', exact: true })).toBeVisible()

  detail = await tableDetail(page, token, resource.id)
  const title = detail.columns.find(c => c.name === 'title')
  expect(title?.nullable).toBe(false)
  expect(title?.defaultExpression).toContain('untitled')
  expect(detail.relations).toEqual([expect.objectContaining({ sourceColumn: 'parent', targetSchema: SCHEMA, targetTable: 'parents', targetColumn: 'id' })])
  // Each column keeps the control it was created with (its presentation's input).
  const meta = await apiRequest<{ columnName: string, presentation: { input?: string } }[]>(page, token, 'GET', `/admin/api/resources/${resource.id}/columns`)
  expect(meta.find(c => c.columnName === 'title')?.presentation.input).toBe('text')
  expect(meta.find(c => c.columnName === 'parent')?.presentation.input).toBe('relation-select')
  expect(failures).toEqual([])
})

/** The Tables list of the fixture schema, then a row's "Edit" - TableDrawer. */
async function openEditDrawer(page: Page, table: string) {
  const tree = await openTree(page)
  await tree.getByRole('button', { name: /^Tables/ }).click()
  await page.waitForURL(/\/resources$/)
  await page.locator('main').getByRole('button', { name: `Actions for ${SCHEMA}.${table}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Edit' }).click()
  // AppDrawer's title is a plain heading, not the dialog's accessible name.
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: `Edit ${SCHEMA}.${table}` }) })
  await expect(drawer.getByLabel('id name')).toBeVisible()
  return drawer
}

test('Edit table: alter, rename and constrain several columns at once - preview, then apply', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const items = await mustResource(page, token, 'items')

  const drawer = await openEditDrawer(page, 'items')
  // Rename a column, change a type, set NOT NULL, a default, a UNIQUE and a foreign key.
  await drawer.getByLabel('note name').fill('remark')
  const qtyType = drawer.getByLabel('qty type')
  await qtyType.fill('bigint')
  await page.getByRole('option', { name: 'bigint', exact: true }).click()
  await drawer.getByLabel('qty default').fill('0')
  await drawer.getByRole('checkbox', { name: 'name not null' }).click()
  await drawer.getByRole('checkbox', { name: 'name unique' }).click()
  await drawer.getByRole('button', { name: 'Edit parent foreign key' }).click()
  const fk = page.getByRole('dialog', { name: 'Foreign key: parent' })
  await choose(page, fk.getByLabel('Target schema'), SCHEMA)
  await choose(page, fk.getByLabel('Target table'), 'parents')
  await choose(page, fk.getByLabel('Target column'), 'id')
  await fk.getByRole('button', { name: 'Done' }).click()
  await expect(drawer.getByRole('textbox', { name: 'parent foreign key', exact: true })).toHaveValue('parents.id')

  await drawer.getByRole('button', { name: 'Save' }).click()
  const confirm = page.getByRole('dialog', { name: 'Confirm changes' })
  const preview = confirm.locator('pre')
  await expect(preview).toContainText('RENAME COLUMN "note" TO "remark"')
  await expect(preview).toContainText('TYPE bigint')
  await expect(preview).toContainText('SET NOT NULL')
  await expect(preview).toContainText('SET DEFAULT 0')
  await expect(preview).toContainText(/unique \("name"\)/i)
  await expect(preview).toContainText(/foreign key \("parent"\) references/i)
  await confirm.getByRole('button', { name: 'Confirm & Save' }).click()
  await expect(confirm).toBeHidden()
  await expect(drawer).toBeHidden()

  const detail = await tableDetail(page, token, items.id)
  const byName = Object.fromEntries(detail.columns.map(c => [c.name, c]))
  expect(byName.note).toBeUndefined()
  expect(byName.remark).toBeDefined()
  expect(byName.qty?.dataType).toBe('bigint')
  expect(byName.qty?.defaultExpression).toBe('0')
  expect(byName.name?.nullable).toBe(false)
  expect(detail.uniqueConstraints).toContainEqual(['name'])
  expect(detail.relations).toEqual([expect.objectContaining({ sourceColumn: 'parent', targetTable: 'parents', targetColumn: 'id' })])
  expect(failures).toEqual([])
})

test('Edit table: drop the UNIQUE and the foreign key, and rename the table', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const items = await mustResource(page, token, 'items')

  const drawer = await openEditDrawer(page, 'items')
  await expect(drawer.getByRole('checkbox', { name: 'name unique' })).toBeChecked()
  await drawer.getByRole('checkbox', { name: 'name unique' }).click()
  await drawer.getByRole('button', { name: 'Edit parent foreign key' }).click()
  const fk = page.getByRole('dialog', { name: 'Foreign key: parent' })
  await fk.getByRole('button', { name: 'Clear' }).click()
  await expect(fk).toBeHidden()
  await drawer.getByLabel('Table name').fill(RENAMED_TABLE)

  await drawer.getByRole('button', { name: 'Save' }).click()
  const confirm = page.getByRole('dialog', { name: 'Confirm changes' })
  await expect(confirm.locator('pre')).toContainText(new RegExp(`rename to "${RENAMED_TABLE}"`, 'i'))
  await expect(confirm.locator('pre')).toContainText(/drop constraint/i)
  const applied = page.waitForResponse(r => r.url().endsWith(`/tables/items/edit`) && r.request().method() === 'POST')
  await confirm.getByRole('button', { name: 'Confirm & Save' }).click()
  expect((await applied).status()).toBe(204)
  await expect(drawer).toBeHidden()

  // Same OID, same resource: renamed in place.
  await expect.poll(async () => (await resourceById(page, token, items.id))?.name).toBe(RENAMED_TABLE)
  const detail = await tableDetail(page, token, items.id)
  expect(detail.uniqueConstraints).toEqual([])
  expect(detail.relations).toEqual([])
  expect(failures).toEqual([])
})

test('Constraints: add a CHECK with a message, then drop it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const checked = await mustResource(page, token, 'checked')

  await page.goto(`/resources/${checked.id}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Add Constraint' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add check constraint' })
  await dialog.getByLabel('Name').fill('checked_price_positive')
  await dialog.getByRole('textbox', { name: 'Expression' }).fill('price > 0')
  await dialog.getByLabel('Error Message').fill('Price must be greater than zero')
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(main.getByText('"Price must be greater than zero"')).toBeVisible()

  let detail = await tableDetail(page, token, checked.id)
  expect(detail.checkConstraints).toEqual([expect.objectContaining({ name: 'checked_price_positive', message: 'Price must be greater than zero' })])
  // PostgreSQL enforces it, with the message.
  await expect(sql(page, token, `INSERT INTO ${SCHEMA}.checked VALUES (1, -1)`)).rejects.toThrow(/Price must be greater than zero|checked_price_positive/)

  await main.getByRole('button', { name: 'Delete constraint checked_price_positive' }).click()
  await page.getByRole('dialog').filter({ hasText: 'Delete this constraint?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByText('No check constraints on this table')).toBeVisible()
  detail = await tableDetail(page, token, checked.id)
  expect(detail.checkConstraints).toEqual([])
  expect(failures).toEqual([])
})

test('Indexes: create one, then drop it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const checked = await mustResource(page, token, 'checked')
  const indexNames = async () => (await apiRequest<{ name: string, columns: string[], isUnique: boolean }[]>(page, token, 'GET', `/admin/api/catalog/table/${checked.id}/indexes`))

  await page.goto(`/resources/${checked.id}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Add Index' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add index' })
  await dialog.getByLabel('Name').fill('checked_price_idx')
  await dialog.getByRole('switch', { name: 'Unique' }).click()
  await dialog.getByRole('button', { name: /^Columns/ }).click()
  await page.getByRole('option', { name: 'price', exact: true }).click()
  await dialog.getByRole('heading', { name: 'Add index' }).click()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(main.getByRole('cell', { name: 'checked_price_idx', exact: true })).toBeVisible()
  expect(await indexNames()).toContainEqual(expect.objectContaining({ name: 'checked_price_idx', columns: ['price'], isUnique: true }))

  await main.getByRole('button', { name: 'Delete index checked_price_idx' }).click()
  await page.getByRole('dialog').filter({ hasText: 'Delete this index?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByRole('cell', { name: 'checked_price_idx', exact: true })).toBeHidden()
  expect((await indexNames()).map(i => i.name)).not.toContain('checked_price_idx')
  expect(failures).toEqual([])
})

test('Table settings: description, exposed methods and a column\'s presentation', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const checked = await mustResource(page, token, 'checked')

  await page.goto(`/resources/${checked.id}`)
  const main = page.locator('main')
  await main.getByRole('textbox', { name: 'Description' }).fill('Prices to check')
  await main.getByRole('textbox', { name: 'Description' }).blur()
  await expect.poll(async () => (await resourceById(page, token, checked.id))?.description).toBe('Prices to check')

  await main.getByRole('switch', { name: 'Expose GET' }).click()
  await expect(main.getByRole('switch', { name: 'Expose GET' })).toBeChecked()
  await main.getByRole('switch', { name: 'Expose POST' }).click()
  await expect(main.getByRole('switch', { name: 'Expose POST' })).toBeChecked()
  await expect.poll(async () => (await resourceById(page, token, checked.id))?.exposed_methods?.slice().sort()).toEqual(['GET', 'POST'])
  await main.getByRole('switch', { name: 'Expose POST' }).click()
  await expect(main.getByRole('switch', { name: 'Expose POST' })).not.toBeChecked()
  await expect.poll(async () => (await resourceById(page, token, checked.id))?.exposed_methods).toEqual(['GET'])

  await main.getByRole('button', { name: 'How price shows' }).click()
  const slideover = page.getByRole('dialog', { name: 'price' })
  await slideover.getByLabel('Label', { exact: true }).fill('Unit price')
  await slideover.getByRole('button', { name: 'Save' }).click()
  await expect(slideover).toBeHidden()
  await expect(main.getByRole('cell', { name: 'Unit price', exact: true })).toBeVisible()
  const meta = await apiRequest<{ columnName: string, presentation: { label?: string } }[]>(page, token, 'GET', `/admin/api/resources/${checked.id}/columns`)
  expect(meta.find(c => c.columnName === 'price')?.presentation.label).toBe('Unit price')
  expect(failures).toEqual([])
})

test('Auditing: audit reads on and off with its warning, and a column excluded from the audit', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const audited = await mustResource(page, token, 'audited')
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${audited.id}`, { data: { exposedMethods: ['GET', 'PATCH'] } })
  const dataPath = `/api/${SCHEMA}/table/audited`
  const logs = async (action: string) => apiRequest<{ id: string, action: string, changes: unknown, payload: Record<string, unknown> | null, metadata: Record<string, unknown> | null }[]>(page, token, 'GET', `/admin/api/audit/logs?resource=${audited.id}&action=${action}&limit=1`)
  const newestLog = async (action: string) => (await logs(action))[0]

  await page.goto(`/resources/${audited.id}`)
  const main = page.locator('main')
  const auditReads = main.getByRole('switch', { name: 'Audit reads' })
  await expect(auditReads).not.toBeChecked()

  await auditReads.click()
  await expect(auditReads).toBeChecked()
  await expect.poll(async () => (await resourceById(page, token, audited.id))?.audit_read).toBe(true)
  // Turning it on warns about the volume.
  await expect(main.getByText('Every read writes an audit entry')).toBeVisible()
  // A Data API read is now logged - fields and row count, never the rows.
  await apiRequest(page, token, 'GET', `${dataPath}?fields=id,name`)
  const read = await newestLog('READ')
  expect(read?.metadata).toEqual(expect.objectContaining({ rowCount: 1 }))
  expect(JSON.stringify(read)).not.toContain('first')

  await auditReads.click()
  await expect(auditReads).not.toBeChecked()
  await expect.poll(async () => (await resourceById(page, token, audited.id))?.audit_read).toBe(false)
  await apiRequest(page, token, 'GET', `${dataPath}?fields=id,name`)
  expect((await newestLog('READ'))?.id).toBe(read?.id)

  await expect(main.getByText('Every read writes an audit entry')).toHaveCount(0)

  // By default an UPDATE records old and new of every column it changed.
  await apiRequest(page, token, 'PATCH', `${dataPath}/1`, { data: { name: 'second', qty: 2 } })
  expect((await newestLog('UPDATE'))?.changes).toEqual({ name: { old: 'first', new: 'second' }, qty: { old: 1, new: 2 } })

  // `note` excluded: kept out of the next entry's changes and payload.
  await main.getByRole('button', { name: /^Columns excluded from the audit/ }).click()
  await page.getByRole('option', { name: 'note', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await apiRequest<{ excludedFields: string[] }>(page, token, 'GET', `/admin/api/resources/${audited.id}/audit`)).excludedFields)
    .toEqual(['note'])

  // Survives a reload.
  await page.reload()
  await expect(main.getByLabel('Columns excluded from the audit', { exact: true })).toContainText('note')

  await apiRequest(page, token, 'PATCH', `${dataPath}/1`, { data: { name: 'third', note: 'changed' } })
  const update = await newestLog('UPDATE')
  expect(update?.changes).toEqual({ name: { old: 'second', new: 'third' } })
  expect(update?.payload).toEqual(expect.objectContaining({ id: 1, name: 'third' }))
  expect(update?.payload).not.toHaveProperty('note')
  expect(failures).toEqual([])
})

test('View: description and endpoints, then drop it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const view = await mustResource(page, token, 'items_view')

  const tree = await openTree(page)
  await tree.getByRole('button', { name: 'items_view' }).click()
  await page.waitForURL(new RegExp(`/resources/${view.id}$`))
  const main = page.locator('main')
  await main.getByRole('textbox', { name: 'Description' }).fill('A fixture view')
  await main.getByRole('textbox', { name: 'Description' }).blur()
  await expect.poll(async () => (await resourceById(page, token, view.id))?.description).toBe('A fixture view')
  await main.getByRole('switch', { name: 'Expose GET' }).click()
  await expect.poll(async () => (await resourceById(page, token, view.id))?.exposed_methods).toEqual(['GET'])

  await main.getByRole('button', { name: 'Delete view' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete view?' })
  const deleteButton = dialog.getByRole('button', { name: 'Delete', exact: true })
  await expect(deleteButton).toBeDisabled()
  await dialog.getByLabel('Confirm').check()
  await deleteButton.click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await resourceById(page, token, view.id))?.name ?? null).toBeNull()
  const views = await sql(page, token, `SELECT 1 FROM pg_views WHERE schemaname = '${SCHEMA}' AND viewname = 'items_view'`)
  expect(views.rows).toEqual([])
  expect(failures).toEqual([])
})

test('Function: class and description, then drop it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const fn = await mustResource(page, token, 'double_it')

  await page.goto(`/resources/${fn.id}`)
  const main = page.locator('main')
  await choose(page, main.getByLabel('Function class'), 'QUERY')
  await expect.poll(async () => (await resourceById(page, token, fn.id))?.function_class).toBe('QUERY')
  await main.getByRole('textbox', { name: 'Description' }).fill('Doubles a number')
  await main.getByRole('textbox', { name: 'Description' }).blur()
  await expect.poll(async () => (await resourceById(page, token, fn.id))?.description).toBe('Doubles a number')

  await main.getByRole('button', { name: 'Delete function' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete function?' })
  await dialog.getByLabel('Confirm').check()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await resourceById(page, token, fn.id))?.name ?? null).toBeNull()
  const functions = await sql(page, token, `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = '${SCHEMA}' AND p.proname = 'double_it'`)
  expect(functions.rows).toEqual([])
  expect(failures).toEqual([])
})

test('Drop column, then drop the renamed table', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const table = await mustResource(page, token, RENAMED_TABLE)

  await page.goto(`/resources/${table.id}`)
  const main = page.locator('main')
  await main.getByRole('button', { name: 'Delete column remark' }).click()
  await page.getByRole('dialog').filter({ hasText: 'Delete this column?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByRole('cell', { name: 'remark', exact: true })).toBeHidden()
  expect((await tableDetail(page, token, table.id)).columns.map(c => c.name)).not.toContain('remark')

  await main.getByRole('button', { name: 'Delete table' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete table?' })
  await dialog.getByLabel('Confirm').check()
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await resourceById(page, token, table.id))?.name ?? null).toBeNull()
  const tables = await sql(page, token, `SELECT 1 FROM pg_tables WHERE schemaname = '${SCHEMA}' AND tablename = '${RENAMED_TABLE}'`)
  expect(tables.rows).toEqual([])
  expect(failures).toEqual([])
})

/** Replaces the SQL Console's text - Monaco takes keystrokes, not fill(). */
async function typeSql(page: Page, statement: string) {
  await page.locator('main .monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(statement)
}

/**
 * Clicks Run all and returns the execute response. The dev server's rate
 * limit (security.rate_limit_per_minute, a fixed one-minute window per IP)
 * is shared by every spec of a full run: a 429 waits for the window to
 * roll over and runs again - the console shows the 429 as a failed run.
 */
async function runAll(page: Page) {
  for (let attempt = 0; ; attempt++) {
    const executed = page.waitForResponse(r => r.url().endsWith('/admin/api/sql/execute') && r.request().method() === 'POST')
    await page.locator('main').getByRole('button', { name: 'Run all' }).click()
    const response = await executed
    if (response.status() !== 429 || attempt >= 12) return response
    await page.waitForTimeout(5000)
  }
}

/** API failures other than the rate limit's 429, which runAll() retries. */
const notRateLimited = (failures: string[]) => failures.filter(line => !line.endsWith('-> 429'))

test('SQL Console: SELECT, a transactional statement, EXPLAIN, history and purge', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  // "Load more" needs more than one page (100) of history.
  const history = await page.request.get(`${BASE_URL}/admin/api/sql/history?limit=1`, { headers: { Authorization: `Bearer ${token}` } })
  const total = ((await history.json()) as { meta?: { total?: number } }).meta?.total ?? 0
  for (let i = total; i <= 100; i++) await sql(page, token, `SELECT ${i} AS ui_db_history_seed`)

  await page.goto('/sql-console')
  const main = page.locator('main')
  await expect(main.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 30_000 })

  await typeSql(page, `SELECT 41 + 1 AS ui_db_answer_${SUFFIX}`)
  await runAll(page)
  await expect(main.getByText(`ui_db_answer_${SUFFIX}`).last()).toBeVisible()
  await expect(main.getByRole('cell', { name: '42', exact: true })).toBeVisible()

  await main.getByRole('switch', { name: 'Transactional' }).click()
  await expect(main.getByRole('switch', { name: 'Transactional' })).toBeChecked()
  await typeSql(page, `INSERT INTO ${SCHEMA}.maint VALUES (1000, 'from the console')`)
  const response = await runAll(page)
  expect(response.request().postDataJSON()).toEqual({ data: { sql: expect.stringContaining('INSERT'), transactional: true } })
  expect((await sql(page, token, `SELECT label FROM ${SCHEMA}.maint WHERE id = 1000`)).rows).toEqual([{ label: 'from the console' }])

  await typeSql(page, `SELECT * FROM ${SCHEMA}.maint WHERE id = 1`)
  await main.getByRole('button', { name: 'Explain' }).click()
  await expect(main.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true')
  await expect(main.locator('pre').filter({ hasText: 'Node Type' })).toBeVisible()

  await main.getByRole('tab', { name: 'History' }).click()
  const entries = main.locator('button').filter({ has: page.locator('code') })
  // The console's own run is recorded (EXPLAIN isn't).
  await expect(entries.filter({ hasText: `INSERT INTO ${SCHEMA}.maint VALUES (1000` })).toBeVisible()
  await expect(entries).toHaveCount(100)
  await main.getByRole('button', { name: 'Load more' }).click()
  await expect.poll(() => entries.count()).toBeGreaterThan(100)

  // Purge before a date older than any entry: nothing real is deleted.
  await main.getByRole('button', { name: 'Purge' }).click()
  const popover = page.getByRole('dialog').filter({ hasText: 'Deletes every history entry' })
  await popover.getByLabel('Purge entries before').fill('2000-01-01')
  const purged = page.waitForResponse(r => r.url().includes('/admin/api/sql/history') && r.request().method() === 'DELETE')
  await popover.getByRole('button', { name: 'Purge' }).click()
  const purgeResponse = await purged
  expect(purgeResponse.status()).toBe(200)
  expect((await purgeResponse.json()).data).toEqual({ deletedCount: 0 })
  await expect(page.getByText('Purged 0 entries', { exact: true })).toBeVisible()
  expect(notRateLimited(failures)).toEqual([])
})

interface MaintenanceTable { oid: number, schema: string, name: string, lastAnalyze: string | null }
interface MaintenanceRun { tableOid: number, operation: string, status: string }

test('Maintenance: ANALYZE a table, then start a batch and stop it', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const maintTable = async (name: string) => (await apiRequest<{ tables: MaintenanceTable[] }>(page, token, 'GET', '/admin/api/maintenance/tables')).tables.find(t => t.schema === SCHEMA && t.name === name)
  const maint = (await maintTable('maint'))!

  await page.goto('/settings/maintenance')
  const main = page.locator('main')
  await main.getByPlaceholder('Search tables...').fill(SCHEMA)
  await main.getByRole('cell', { name: `${SCHEMA}.maint`, exact: true }).click()
  const sidebar = page.getByRole('dialog', { name: `${SCHEMA}.maint` })
  await sidebar.getByRole('button', { name: 'Analyze' }).click()
  await expect(page.getByText('Analyze queued', { exact: true })).toBeVisible()
  await expect.poll(async () => (await apiRequest<MaintenanceRun[]>(page, token, 'GET', '/admin/api/maintenance/runs'))
    .find(r => r.tableOid === maint.oid && r.operation === 'ANALYZE')?.status, { timeout: 30_000 }).toBe('COMPLETED')
  await expect.poll(async () => (await maintTable('maint'))?.lastAnalyze ?? null, { timeout: 15_000 }).not.toBeNull()
  await page.keyboard.press('Escape')
  await expect(sidebar).toBeHidden()

  // A batch over the fixture tables: preview, start, stop while it runs.
  for (const name of ['maint', 'parents', 'checked']) {
    await main.getByRole('checkbox', { name: `Select ${SCHEMA}.${name}` }).check()
  }
  await main.getByRole('button', { name: 'Vacuum', exact: true }).click()
  const modal = page.getByRole('dialog', { name: 'Vacuum 3 selected tables' })
  await expect(modal.getByText(`${SCHEMA}.maint`)).toBeVisible()
  const started = page.waitForResponse(r => r.url().endsWith('/admin/api/maintenance/batches') && r.request().method() === 'POST')
  await modal.getByRole('button', { name: 'Start 3' }).click()
  expect((await started).status()).toBe(202)
  const batchModal = page.getByRole('dialog').filter({ hasText: /Vacuum (in progress|finished|stopped)/ })
  await expect(batchModal).toBeVisible()
  const stop = batchModal.getByRole('button', { name: 'Stop', exact: true })
  if (await stop.isVisible().catch(() => false)) {
    await stop.click()
    const stopBatch = page.getByRole('button', { name: 'Stop batch' })
    if (await stopBatch.isVisible().catch(() => false)) await stopBatch.click().catch(() => undefined)
  }
  // Stopped or already done - either way it ends, and Close dismisses it.
  await expect(batchModal.getByRole('button', { name: 'Close' }).last()).toBeVisible({ timeout: 30_000 })
  await expect(batchModal).toContainText(/Vacuum (finished|stopped)/)
  await batchModal.getByRole('button', { name: 'Close' }).last().click()
  await expect(batchModal).toBeHidden()
  expect(failures).toEqual([])
})

test('Data browser: a UTable that pages, sorts, edits a cell, adds and deletes rows', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const browsed = await mustResource(page, token, 'browsed')
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${browsed.id}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  const label = async (id: number) => (await sql(page, token, `SELECT label FROM ${SCHEMA}.browsed WHERE id = ${id}`)).rows[0]?.label

  await page.goto(`/resources/${browsed.id}/data`)
  const main = page.locator('main')
  const table = main.getByRole('table')
  await expect(table.getByRole('cell', { name: 'row 1', exact: true })).toBeVisible({ timeout: 30_000 })
  // Page size 25 of 30 rows.
  await expect(table.locator('tbody tr')).toHaveCount(25)

  // The shared sortable header: ascending, then descending - sorted by PostgreSQL.
  const sorted = (order: string) => page.waitForResponse(r => r.url().includes(`/api/${SCHEMA}/table/browsed`) && new URL(r.url()).searchParams.get('order_by') === order)
  let response = sorted('label')
  await table.getByRole('button', { name: 'label' }).click()
  await response
  response = sorted('-label')
  await table.getByRole('button', { name: 'label' }).click()
  await response
  await expect(table.locator('tbody tr').first()).toContainText('row 9')

  // Double-click edits a cell; Enter saves it.
  await table.getByRole('cell', { name: 'row 9', exact: true }).locator('span').dblclick()
  const cellInput = table.getByRole('textbox', { name: 'label' })
  await cellInput.fill('edited 9')
  await cellInput.press('Enter')
  await expect.poll(() => label(9)).toBe('edited 9')

  // The filter popover labels its inputs - no placeholders (Admin_UI.md §7.1).
  await main.getByRole('button', { name: 'Filter' }).click()
  await expect(page.getByRole('textbox', { name: 'Value' })).toBeVisible()
  await page.keyboard.press('Escape')

  // Add row: a first line of inputs inside the table, a line of help above it.
  await main.getByRole('button', { name: 'Add row' }).first().click()
  await expect(main.getByText(/A field left empty is stored as NULL/)).toBeVisible()
  await table.getByRole('textbox', { name: 'id' }).fill('100')
  await table.getByRole('textbox', { name: 'label' }).fill('added')
  await table.getByRole('button', { name: 'Save row' }).click()
  await expect.poll(() => label(100)).toBe('added')

  // Select it and delete it.
  await main.getByRole('textbox', { name: 'Search rows' }).fill('added')
  await table.getByRole('checkbox', { name: 'Select row 100' }).click()
  await main.getByRole('button', { name: 'Delete selected' }).click()
  const modal = page.getByRole('dialog', { name: 'Delete selected rows' })
  await modal.getByRole('checkbox').click()
  await modal.getByRole('button', { name: 'Delete' }).click()
  await expect.poll(() => label(100)).toBeUndefined()
  await expect(table.getByRole('heading', { name: 'No records yet' })).toBeVisible()
  expect(failures).toEqual([])
})

test('Require an idempotency key: the switch saves, and the admin\'s own Add row still writes', async ({ page }) => {
  const token = await login(page)
  // The Data browser's first POST is refused for its missing key, then sent again with one - on purpose.
  const failures = watchApiFailures(page, [new RegExp(`^POST /api/${SCHEMA}/table/keyed$`)])
  const keyed = await mustResource(page, token, 'keyed')
  await apiRequest(page, token, 'PATCH', `/admin/api/resources/${keyed.id}`, { data: { exposedMethods: ['GET', 'POST'] } })
  const required = async () => (await resourceById(page, token, keyed.id))?.require_idempotency_key

  await page.goto(`/resources/${keyed.id}`)
  const main = page.locator('main')
  const toggle = main.getByRole('switch', { name: 'Require an idempotency key' })
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(required).toBe(true)

  await page.goto(`/resources/${keyed.id}/data`)
  const table = main.getByRole('table')
  await main.getByRole('button', { name: 'Add row' }).first().click()
  await table.getByRole('textbox', { name: 'id' }).fill('7')
  await table.getByRole('textbox', { name: 'label' }).fill('keyed row')
  const keyedPost = page.waitForResponse(r => r.url().endsWith(`/api/${SCHEMA}/table/keyed`) && r.request().method() === 'POST' && r.status() === 201)
  await table.getByRole('button', { name: 'Save row' }).click()
  expect((await keyedPost).request().headers()['idempotency-key']).toBeTruthy()
  await expect.poll(async () => (await sql(page, token, `SELECT label FROM ${SCHEMA}.keyed WHERE id = 7`)).rows[0]?.label).toBe('keyed row')

  await page.goto(`/resources/${keyed.id}`)
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(required).toBe(false)
  expect(failures).toEqual([])
})

test('SQL Console: a failed statement shows PostgreSQL\'s diagnostics and marks the editor', async ({ page }) => {
  await login(page)
  const failures = watchApiFailures(page, [/^POST \/admin\/api\/sql\/execute$/])
  await page.goto('/sql-console')
  const main = page.locator('main')
  await expect(main.locator('.monaco-editor .view-lines')).toBeVisible({ timeout: 30_000 })

  await typeSql(page, 'SELECT 1;\nSELECT nope_col_xyz FROM pg_class')
  await runAll(page)
  await expect(main.getByText('Execution failed', { exact: true })).toBeVisible()
  await expect(main.getByText('column "nope_col_xyz" does not exist')).toBeVisible()
  await expect(main.getByRole('definition').filter({ hasText: 'Line 2, column 8' })).toBeVisible()
  await expect(main.getByRole('definition').filter({ hasText: '42703' })).toBeVisible()
  // Monaco's error marker under the offending word; the next edit clears it.
  await expect(main.locator('.monaco-editor .squiggly-error')).toBeVisible()
  await main.locator('.monaco-editor .view-lines').click()
  await page.keyboard.insertText(' ')
  await expect(main.locator('.monaco-editor .squiggly-error')).toHaveCount(0)
  expect(failures).toEqual([])
})

test('New table: a junction table relating two tables - foreign keys and the UNIQUE over them', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const tree = await openTree(page)
  await tree.getByRole('button', { name: 'New table' }).click()
  const dialog = page.getByRole('dialog', { name: 'New table' })
  await dialog.getByText('Junction table', { exact: true }).click()
  await choose(page, dialog.getByLabel('Table 1'), `${SCHEMA}.parents`)
  await choose(page, dialog.getByLabel('Table 2'), `${SCHEMA}.keyed`)
  await expect(dialog.getByLabel('Name').last()).toHaveValue('parents_keyed')
  await choose(page, dialog.getByLabel('Schema'), SCHEMA)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()

  const resource = await mustResource(page, token, 'parents_keyed')
  const detail = await tableDetail(page, token, resource.id)
  expect(detail.primaryKey).toEqual(['id'])
  expect(detail.columns.map(c => c.name)).toEqual(['id', 'parents', 'keyed'])
  expect(detail.uniqueConstraints).toContainEqual(['parents', 'keyed'])
  expect(detail.relations.map(r => `${r.sourceColumn}->${r.targetTable}`).sort()).toEqual(['keyed->keyed', 'parents->parents'])
  expect(failures).toEqual([])
})

test('Add Column: a UID column PostgreSQL fills from another column, and the table\'s row display', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const table = await mustResource(page, token, 'checked')
  await page.goto(`/resources/${table.id}`)
  const main = page.locator('main')

  // UID: generated from price - its slug, whoever writes the row.
  await main.getByRole('button', { name: 'Add Column' }).click()
  const wizard = page.getByRole('dialog', { name: 'Add column' })
  await wizard.getByRole('searchbox', { name: 'Search' }).fill('UID')
  await wizard.getByRole('searchbox', { name: 'Search' }).press('Enter')
  await wizard.getByLabel('Name', { exact: true }).fill('handle')
  await expect(wizard.getByRole('switch', { name: 'Not null' })).toBeHidden()
  await choose(page, wizard.getByRole('combobox', { name: 'Generated from' }), 'price')
  await wizard.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(wizard).toBeHidden()
  await expect(main.getByRole('cell', { name: 'handle', exact: true })).toBeVisible()
  await sql(page, token, `INSERT INTO ${SCHEMA}.checked (id, price) VALUES (9001, 12.5)`)
  expect((await sql(page, token, `SELECT handle FROM ${SCHEMA}.checked WHERE id = 9001`)).rows[0]).toEqual({ handle: '1250' })

  // Row display: how a checked row shows wherever a foreign key points at it.
  await main.getByRole('button', { name: 'Row display' }).click()
  await choose(page, page.getByRole('combobox', { name: 'Show' }), 'price')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await resourceById(page, token, table.id))?.row_presentation).toEqual({ displayField: 'price' })
  await main.getByRole('button', { name: 'Row display: price' }).click()
  await choose(page, page.getByRole('combobox', { name: 'Show' }), 'Default')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await resourceById(page, token, table.id))?.row_presentation).toEqual({})

  await sql(page, token, `DELETE FROM ${SCHEMA}.checked WHERE id = 9001`)
  await main.getByRole('button', { name: 'Delete column handle' }).click()
  await page.getByRole('dialog').filter({ hasText: 'Delete this column?' }).getByRole('button', { name: 'Delete' }).click()
  await expect(main.getByRole('cell', { name: 'handle', exact: true })).toBeHidden()
  expect(failures).toEqual([])
})

test('Add Column: the type picker filters by name or description, says when nothing matches, and Enter takes the first match', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const table = await mustResource(page, token, 'checked')

  await page.goto(`/resources/${table.id}`)
  await page.locator('main').getByRole('button', { name: 'Add Column' }).click()
  const wizard = page.getByRole('dialog', { name: 'Add column' })
  const search = wizard.getByRole('searchbox', { name: 'Search' })
  await expect(search).toBeFocused()
  const card = (label: string) => wizard.locator('button').filter({ has: page.getByText(label, { exact: true }) })

  // By description: only the relation types link to another table.
  await search.fill('another table')
  await expect(card('Relation')).toBeVisible()
  await expect(card('Relation (searchable)')).toBeVisible()
  await expect(card('Email')).toBeHidden()
  await expect(wizard.getByText('Simple controls')).toBeHidden()

  // Nothing matches: an empty state, and Clear search brings every type back.
  await search.fill('zzzz-no-such-type')
  await expect(wizard.getByText('No column types match')).toBeVisible()
  await wizard.getByRole('button', { name: 'Clear search' }).click()
  await expect(search).toHaveValue('')
  await expect(card('Email')).toBeVisible()
  await expect(card('Relation')).toBeVisible()

  // Keyboard: type, Enter - the first match is picked and the wizard moves on.
  await search.fill('email')
  await search.press('Enter')
  await expect(wizard.getByLabel('Name', { exact: true })).toBeVisible()
  await wizard.getByRole('button', { name: 'Cancel' }).click()
  await expect(wizard).toBeHidden()
  expect(failures).toEqual([])
})

test('A table the PostgreSQL role doesn\'t own: structure editing is disabled, with the reason', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const table = await mustResource(page, token, 'checked')
  // The dev database's role is a superuser (it owns everything): the
  // catalog detail is answered as for a table another role owns. The
  // server's own check is covered by object-ownership.test.ts.
  await page.route(`**/admin/api/catalog/table/${table.id}`, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { data: Record<string, unknown> }
    await route.fulfill({ response, json: { ...body, data: { ...body.data, owner: 'someone_else', canAlter: false } } })
  })

  await page.goto(`/resources/${table.id}`)
  const main = page.locator('main')
  await expect(main.getByTestId('not-owned-note')).toContainText('TotalBase\'s PostgreSQL role doesn\'t own this table', { timeout: 30_000 })
  await expect(main.getByTestId('not-owned-note')).toContainText('someone_else')
  await expect(main.getByRole('button', { name: 'Add Column' })).toBeDisabled()
  await expect(main.getByRole('button', { name: 'Add Index' })).toBeDisabled()
  await expect(main.getByRole('button', { name: 'Add Constraint' })).toBeDisabled()
  await expect(main.getByRole('button', { name: 'Delete table' })).toBeDisabled()
  await expect(main.getByRole('button', { name: /^Delete column / })).toHaveCount(0)
  // Exposure is TotalBase's own metadata, not DDL - still editable.
  await expect(main.getByRole('switch', { name: 'Expose GET' })).toBeEnabled()

  // The table editor shows the structure but offers no change.
  const drawer = await openEditDrawer(page, 'checked')
  await expect(drawer.getByTestId('not-owned-note')).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Add column' })).toBeDisabled()
  await expect(drawer.getByRole('button', { name: 'Save' })).toBeDisabled()
  expect(failures).toEqual([])
})

test('Functions list: overloads grouped by name, each signature with its own actions and page', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const overloads = (await resourcesIn(page, token, SCHEMA)).filter(r => r.name === 'overloaded')
  expect(overloads).toHaveLength(2)

  const tree = await openTree(page)
  await tree.getByRole('button', { name: /^Functions/ }).click()
  await page.waitForURL(/\/resources$/)
  const main = page.locator('main')
  // A single function: an ordinary row, its signature beside the name.
  await expect(main.getByText('(a integer)', { exact: true })).toBeVisible()
  // Two overloads: one row, expanded to both signatures.
  await expect(main.getByText('2 overloads')).toBeVisible()
  const group = main.getByRole('list', { name: `Overloads of ${SCHEMA}.overloaded` })
  await expect(group.getByRole('link', { name: 'overloaded(x integer)' })).toBeVisible()
  await expect(group.getByRole('link', { name: 'overloaded(x text, y integer)' })).toBeVisible()
  await expect(group.getByRole('button', { name: `Actions for ${SCHEMA}.overloaded(x text, y integer)`, exact: true })).toBeVisible()

  // Fold and unfold.
  await main.getByRole('button', { name: `Hide overloads of ${SCHEMA}.overloaded`, exact: true }).click()
  await expect(group).toBeHidden()
  await main.getByRole('button', { name: `Show overloads of ${SCHEMA}.overloaded`, exact: true }).click()
  await expect(group).toBeVisible()

  // Each overload keeps its own page (its own resource id).
  await group.getByRole('link', { name: 'overloaded(x text, y integer)' }).click()
  await page.waitForURL(/\/resources\/[0-9a-f-]{36}$/)
  const id = page.url().split('/').pop()
  expect(overloads.map(r => r.id)).toContain(id)
  expect(failures).toEqual([])
})

test('A function the PostgreSQL role doesn\'t own: Delete is disabled, with the reason', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const fn = (await resourcesIn(page, token, SCHEMA)).find(r => r.name === 'overloaded')!
  await page.route(`**/admin/api/catalog/function/${fn.id}`, async (route) => {
    const response = await route.fetch()
    const body = await response.json() as { data: Record<string, unknown> }
    await route.fulfill({ response, json: { ...body, data: { ...body.data, owner: 'someone_else', canAlter: false } } })
  })
  await page.goto(`/resources/${fn.id}`)
  const main = page.locator('main')
  await expect(main.getByTestId('not-owned-note')).toContainText('doesn\'t own this function', { timeout: 30_000 })
  await expect(main.getByRole('button', { name: 'Delete function' })).toBeDisabled()
  expect(failures).toEqual([])
})
