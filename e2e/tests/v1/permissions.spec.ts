import type { Browser, Page } from '@playwright/test'
import { adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * A sales user (an APP role, not an administrator) as a real system has one
 * (AGENTS.md section 13, Security.md §7.1): they see the DataViews their
 * role opens and no other; in them, only the active customers (an ALLOW row
 * filter), never the credit limit (a field DENY); they may edit but not
 * create or delete. The Data API underneath enforces the same grants - the
 * page hiding something is never what protects it.
 */
const ROLE = 'V1 Ventas'
const EMAIL = 'v1-ventas@e2e.test'
const PASSWORD = 'v1-ventas-password'
const OPEN = 'V1 Perm Clientes'
const CLOSED = 'V1 Perm Oculta'
let open: DataViewRef
let closed: DataViewRef

interface Role { id: string, name: string }
interface User { id: string, email: string }

async function cleanUp(page: Page, token: string) {
  await deleteDataViewsNamed(page, token, [OPEN, CLOSED])
  for (const user of (await api<User[]>(page, token, 'GET', '/admin/api/users')).filter(u => u.email === EMAIL)) {
    await api(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  }
  // Roles are TotalBase data, written by administrators through the Data API (Security.md §10).
  for (const role of await api<Role[]>(page, token, 'GET', `/api/totalbase/table/roles?fields=id,name&where[name][_eq]=${encodeURIComponent(ROLE)}`)) {
    await api(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)
  }
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await cleanUp(page, token)
  await resetSchema(page, token)
  const clientes = await resourceId(page, token, 'e2e_v1_clientes')
  const categorias = await resourceId(page, token, 'e2e_v1_categorias')

  const role = await api<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: ROLE, app_access: true } })
  await api(page, token, 'POST', '/admin/api/users', { data: { email: EMAIL, name: 'Ventas E2E', password: PASSWORD, roleIds: [role.id] } })
  const grant = (resource: string, action: string, body: Record<string, unknown>) =>
    api(page, token, 'PUT', `/admin/api/roles/${role.id}/resources/${resource}/permissions/${action}`, { data: body })
  // A field a grant doesn't name is UNDEFINED - denied (DENY > ALLOW > UNDEFINED): every other field ALLOWed, the credit limit DENIED.
  const fields = [
    ...['id', 'nombre', 'email', 'telefono', 'categoria', 'activo', 'fecha_alta', 'notas'].map(field => ({ field, effect: 'ALLOW' })),
    { field: 'limite_credito', effect: 'DENY' }
  ]
  await grant(clientes, 'READ', { effect: 'ALLOW', where: { activo: { _eq: 'true' } }, fields })
  await grant(clientes, 'UPDATE', { effect: 'ALLOW', where: { activo: { _eq: 'true' } }, fields })
  await grant(categorias, 'READ', { effect: 'ALLOW' })

  const columns = ['nombre', 'email', 'categoria', 'activo', 'limite_credito']
  open = await createDataView(page, token, { name: OPEN, viewType: 'TABLE', sourceResourceId: clientes, selectedColumns: columns })
  closed = await createDataView(page, token, { name: CLOSED, viewType: 'TABLE', sourceResourceId: clientes, selectedColumns: columns })
  await api(page, token, 'PUT', `/admin/api/dataviews/${open.id}/roles`, { data: { roleIds: [role.id] } })
  await publish(page, token, open.id)
  await publish(page, token, closed.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await cleanUp(page, token)
  await context.close()
})

/** The sales user's own session - a new browser context, logged in through the login page. */
async function asSeller(browser: Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/admin/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/admin\/app/)
  const token = await page.evaluate(() => localStorage.getItem('totalbase_admin_token'))
  return { context, page, token: token! }
}

test('the menu lists the DataView their role opens, and no other; the other one\'s URL shows nothing', async ({ browser, token: _ }) => {
  const { context, page } = await asSeller(browser)
  try {
    await page.goto('/admin/app')
    await expect(page.getByRole('link', { name: OPEN })).toBeVisible()
    await expect(page.getByRole('link', { name: CLOSED })).toHaveCount(0)
    await page.goto(`/admin/app/dataviews/${closed.slug}`)
    await expect(page.locator('main tbody tr').filter({ hasText: 'Acme SA' })).toHaveCount(0)
    await expect(page.locator('main')).toContainText(/not available|not found|access|permission/i)
  } finally {
    await context.close()
  }
})

test('in it: only active customers, no credit limit, edit but no New nor Delete', async ({ browser, token: _ }) => {
  const { context, page } = await asSeller(browser)
  try {
    await page.goto(`/admin/app/dataviews/${open.slug}`)
    const main = page.locator('main')
    await expect(main.locator('tbody tr').filter({ hasText: 'Acme SA' })).toBeVisible()
    // The row filter: Gamma Coop is inactive.
    await expect(main.locator('tbody tr').filter({ hasText: 'Gamma Coop' })).toHaveCount(0)
    // The field DENY: no column, no value.
    await expect(main.getByRole('columnheader', { name: 'Limite Credito' })).toHaveCount(0)
    await expect(main.locator('tbody tr').filter({ hasText: 'Acme SA' })).not.toContainText(/500[.,]000/)
    // No CREATE grant: no New.
    await expect(main.getByRole('button', { name: 'New' })).toHaveCount(0)
    // No DELETE grant: the row's menu has no Delete.
    await main.locator('tbody tr').filter({ hasText: 'Beta SRL' }).getByRole('button', { name: 'Record actions' }).click()
    await expect(page.getByRole('menuitem', { name: /Delete/ })).toHaveCount(0)
    await page.keyboard.press('Escape')

    // UPDATE: a customer's email changes.
    await main.locator('tbody tr').filter({ hasText: 'Beta SRL' }).click()
    const form = page.getByRole('dialog')
    // The denied field isn't on the form either; the others open once the row is read.
    await expect(form.getByRole('textbox', { name: 'Email' })).toHaveValue('info@beta.test')
    await expect(form.getByRole('spinbutton', { name: 'Limite Credito' })).toHaveCount(0)
    await form.getByRole('textbox', { name: 'Email' }).fill('ventas@beta.test')
    await form.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(form).toBeHidden()
    await expect(main.locator('tbody tr').filter({ hasText: 'Beta SRL' })).toContainText('ventas@beta.test')
  } finally {
    await context.close()
  }
})

test('the Data API enforces the same grants - asking directly gets nothing more', async ({ browser, token: _ }) => {
  const { context, page, token } = await asSeller(browser)
  const get = (query: string) => page.request.fetch(`${BASE_URL}/api/public/table/e2e_v1_clientes?${query}`, { headers: { Authorization: `Bearer ${token}` } })
  const send = (method: string, path: string, data: unknown) => page.request.fetch(`${BASE_URL}/api/public/table/e2e_v1_clientes${path}`, { method, headers: { Authorization: `Bearer ${token}` }, data })
  try {
    // The denied field, asked for by name: refused, not silently dropped.
    expect((await get('fields=id,limite_credito')).status()).toBeGreaterThanOrEqual(400)
    // An inactive customer, asked for by its own filter: the row filter still applies.
    const inactive = await (await get('fields=id,nombre&where[activo][_eq]=false')).json()
    expect(inactive.data).toEqual([])
    // No CREATE, no DELETE.
    expect((await send('POST', '', { data: { nombre: 'Intruso' } })).status()).toBeGreaterThanOrEqual(400)
    expect((await send('DELETE', '/2', undefined)).status()).toBeGreaterThanOrEqual(400)
    // UPDATE of a row outside the filter (Gamma Coop, inactive, id 3): refused.
    expect((await send('PATCH', '/3', { data: { email: 'x@x.test' } })).status()).toBeGreaterThanOrEqual(400)
    // UPDATE writing the denied field: refused.
    expect((await send('PATCH', '/2', { data: { limite_credito: 999999 } })).status()).toBeGreaterThanOrEqual(400)
    // UPDATE moving a row out of the filter (OLD and NEW are both checked): refused.
    expect((await send('PATCH', '/2', { data: { activo: false } })).status()).toBeGreaterThanOrEqual(400)
  } finally {
    await context.close()
  }
})
