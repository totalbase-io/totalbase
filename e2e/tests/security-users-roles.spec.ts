import { expect, test, type Browser, type Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL, apiRequest, login, sessionToken } from './helpers.js'

/**
 * The users and roles security work, as a person would use it (Security.md §2.18, §2.19, §6.11, §9.5-§9.7,
 * §1.9-§1.10): the portal's cookie session, re-authentication, and the driving case - a site's manager builds a
 * role below theirs, grants it within the ceiling, and an operator of the site sees their own site only.
 */
test.describe.configure({ mode: 'serial' })

const P = `e2e-sec-${Date.now().toString(36)}`
const PASSWORD = 'e2e-security-password-1'
const SITE_COLUMN = 'e2e_sec_site'
const TABLE = 'e2e_sec_controls'

type Api = <T = unknown>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown) => Promise<T>

function apiFor(page: Page, token: string): Api {
  return <T>(method: string, path: string, body?: unknown) => apiRequest<T>(page, token, method as 'GET', path, body)
}

async function signInAs(browser: Browser, email: string, password: string) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(url => !url.pathname.startsWith('/login'), { timeout: 30_000 })
  return { context, page, token: await sessionToken(page) }
}

test('the portal keeps its session in an HttpOnly cookie, behind security headers', async ({ page }) => {
  await login(page)
  const cookie = (await page.context().cookies()).find(c => c.name.endsWith('tb_session'))
  expect(cookie?.httpOnly).toBe(true)
  expect(cookie?.sameSite).toBe('Lax')
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.includes('token')))).toEqual([])

  // A reload asks the server, and is still signed in.
  await page.reload()
  await expect(page).not.toHaveURL(/\/login/)

  const ui = await page.request.get(`${BASE_URL}/login`)
  expect(ui.headers()['content-security-policy']).toContain("object-src 'none'")
  expect(ui.headers()['x-content-type-options']).toBe('nosniff')
  const me = await page.request.get(`${BASE_URL}/admin/api/auth/me`)
  expect(me.status()).toBe(200)
  expect(me.headers()['cache-control']).toBe('no-store')

  // From another site, the cookie writes nothing.
  const forged = await page.request.fetch(`${BASE_URL}/app/api/me`, { method: 'PATCH', headers: { origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' }, data: { data: { name: 'x' } } })
  expect(forged.status()).toBe(403)
  expect((await forged.json()).errors[0].code).toBe('CROSS_SITE_REQUEST_REFUSED')
})

test('a sensitive change from an older session asks "Confirm it\'s you", then goes ahead', async ({ page }) => {
  const token = await login(page)
  const api = apiFor(page, token)
  const target = await api<{ id: string }>('POST', '/admin/api/users', { data: { email: `${P}-target@example.com`, name: 'Reauth target' } })
  try {
    const me = await api<{ id: string }>('GET', '/admin/api/auth/me')
    // This session signed in an hour ago and confirmed nothing since.
    await api('POST', '/admin/api/sql/execute', { data: { sql: `UPDATE totalbase.sessions SET created_at = now() - interval '1 hour', reauthenticated_at = NULL WHERE "user" = '${me.id}' AND revoked_at IS NULL` } })

    await page.goto(`/users/${target.id}`)
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click()
    const changeEmail = page.getByRole('dialog', { name: 'Change email' })
    await changeEmail.getByLabel('New email').fill(`${P}-target-new@example.com`)
    await changeEmail.getByText('Mark as verified').click()
    await changeEmail.getByRole('button', { name: 'Save' }).click()

    const confirm = page.getByRole('dialog', { name: 'Confirm it\'s you' })
    await expect(confirm).toBeVisible()
    await confirm.getByLabel('Your password').fill('not-the-password')
    await confirm.getByRole('button', { name: 'Confirm' }).click()
    await expect(confirm.getByText('The password is incorrect.')).toBeVisible()
    await confirm.getByLabel('Your password').fill(ADMIN_PASSWORD)
    await confirm.getByRole('button', { name: 'Confirm' }).click()

    await expect(page.getByText('Email changed').first()).toBeVisible()
    const updated = await api<{ email: string }>('GET', `/admin/api/users/${target.id}`)
    expect(updated.email).toBe(`${P}-target-new@example.com`)
  } finally {
    await api('POST', '/admin/api/sql/execute', { data: { sql: `UPDATE totalbase.users SET failed_login_count = 0 WHERE email = '${ADMIN_EMAIL}'` } }).catch(() => undefined)
    await api('POST', '/admin/api/sql/execute', { data: { sql: `DELETE FROM totalbase.users WHERE email LIKE '${P}-%'` } }).catch(() => undefined)
  }
})

test.describe('a site manager runs their own branch of roles', () => {
  let adminPage: Page
  let api: Api
  let managerRole: string
  let operatorId: string
  let controls: string

  test.beforeAll(async ({ browser }) => {
    adminPage = await (await browser.newContext({ baseURL: BASE_URL })).newPage()
    api = apiFor(adminPage, await login(adminPage))
    const sql = (statement: string) => api('POST', '/admin/api/sql/execute', { data: { sql: statement } })
    await sql(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${SITE_COLUMN} text`)
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`)
    await sql(`CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, site text NOT NULL, kind text NOT NULL, notes text)`)
    await sql(`INSERT INTO public.${TABLE} (site, kind, notes) VALUES ('A', 'night', 'a1'), ('A', 'day', 'a2'), ('B', 'night', 'b1')`)
    await api('POST', '/admin/api/catalog/refresh')
    const resources = await api<{ id: string, name: string, schema: string }[]>('GET', `/api/totalbase/table/resources?fields=id,name,schema&where[status][_eq]=ACTIVE&limit=500`)
    const id = (schema: string, name: string) => resources.find(r => r.schema === schema && r.name === name)!.id
    controls = id('public', TABLE)
    await api('PATCH', `/admin/api/resources/${controls}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })

    // What an administrator sets up once per site: the managers' role, its data and its branch.
    managerRole = (await api<{ id: string }>('POST', '/api/totalbase/table/roles', { data: { name: `${P}-site-a-managers` } })).id
    await api('POST', '/api/totalbase/table/roles_capabilities', { data: { role: managerRole, capability: 'MANAGE_ROLES', effect: 'ALLOW' } })
    const allow = (...fields: string[]) => fields.map(field => ({ field, effect: 'ALLOW' }))
    const grant = (resource: string, action: string, body: object) =>
      api('PUT', `/admin/api/roles/${managerRole}/resources/${resource}/permissions/${action}`, { data: { effect: 'ALLOW', ...body } })
    await grant(controls, 'READ', { where: { site: { _eq: `$USER.${SITE_COLUMN}` } }, fields: allow('id', 'site', 'kind') })
    await grant(id('totalbase', 'roles'), 'READ', { fields: allow('id', 'name', 'description', 'icon', 'color', 'active', 'parent', 'created_by') })
    await grant(id('totalbase', 'roles'), 'CREATE', { fields: allow('name', 'description', 'icon', 'color', 'parent') })
    await grant(id('totalbase', 'roles'), 'UPDATE', { fields: allow('id', 'name', 'description', 'icon', 'color') })
    await grant(id('totalbase', 'users_roles'), 'READ', { fields: allow('id', 'user', 'role') })
    await grant(id('totalbase', 'users_roles'), 'CREATE', { fields: allow('user', 'role') })
    await grant(id('totalbase', 'users'), 'READ', { where: { [SITE_COLUMN]: { _eq: `$USER.${SITE_COLUMN}` } }, fields: allow('id', 'name', 'email') })

    for (const [name, roles] of [['manager-a', [managerRole]], ['operator-a', []]] as const) {
      const user = await api<{ id: string }>('POST', '/admin/api/users', { data: { email: `${P}-${name}@example.com`, name, password: PASSWORD, roleIds: roles } })
      await api('PATCH', `/api/totalbase/table/users/${user.id}`, { data: { [SITE_COLUMN]: 'A' } })
      if (name === 'operator-a') operatorId = user.id
    }
  })

  test.afterAll(async () => {
    const sql = (statement: string) => api('POST', '/admin/api/sql/execute', { data: { sql: statement } }).catch(() => undefined)
    await sql(`DELETE FROM totalbase.users WHERE email LIKE '${P}-%'`)
    await sql(`DELETE FROM totalbase.permissions WHERE role IN (SELECT id FROM totalbase.roles WHERE name LIKE '${P}-%')`)
    await sql(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%' AND parent IS NOT NULL`)
    await sql(`DELETE FROM totalbase.roles WHERE name LIKE '${P}-%'`)
    await sql(`DROP TABLE IF EXISTS public.${TABLE}`)
    await sql(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${SITE_COLUMN}`)
    await api('POST', '/admin/api/catalog/refresh').catch(() => undefined)
  })

  test('the manager creates a role under theirs, grants it within the ceiling and assigns it; the operator sees their site only', async ({ browser }) => {
    const manager = await signInAs(browser, `${P}-manager-a@example.com`, PASSWORD)
    const page = manager.page
    await page.goto('/roles')
    await page.getByRole('button', { name: 'New role' }).click()
    const form = page.getByRole('dialog', { name: 'New role' })
    await form.getByLabel('Name').fill(`${P}-night-operators-a`)
    // A manager's new role goes under the role they manage from.
    await expect(form.getByRole('button', { name: 'Parent role' })).toContainText(`${P}-site-a-managers`)
    await form.getByRole('button', { name: /create|save/i }).click()
    await page.waitForURL(/\/roles\/[0-9a-f-]{36}$/)
    const operatorRole = page.url().split('/').pop()!

    // Its Permissions offer only what the parent has: READ on the controls, without the notes column.
    const permissions = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Permissions' }) })
    await expect(permissions.getByText(`public.${TABLE}`)).toBeVisible()
    await permissions.getByRole('row').filter({ hasText: `public.${TABLE}` }).getByRole('button', { name: 'Read' }).click()
    const editor = page.getByRole('dialog', { name: `Read on public.${TABLE}` })
    await expect(editor.getByText('notes')).toHaveCount(0)
    await editor.getByLabel('Row filter').fill('{"kind": {"_eq": "night"}}')
    await editor.getByRole('button', { name: 'Save' }).click()
    await expect(page.getByText('Permission saved').first()).toBeVisible()

    // Past the ceiling - a column, an action - the server refuses, naming it.
    const managerApi = apiFor(page, manager.token)
    await expect(managerApi('PUT', `/app/api/roles/${operatorRole}/resources/${controls}/permissions/READ`, { data: { effect: 'ALLOW', fields: [{ field: 'notes', effect: 'ALLOW' }] } }))
      .rejects.toThrow(/PERMISSION_EXCEEDS_CEILING/)
    await expect(managerApi('PUT', `/app/api/roles/${operatorRole}/resources/${controls}/permissions/UPDATE`, { data: { effect: 'ALLOW' } }))
      .rejects.toThrow(/PERMISSION_EXCEEDS_CEILING/)

    // They assign it to a person of their site.
    await managerApi('POST', '/api/totalbase/table/users_roles', { data: { user: operatorId, role: operatorRole } })

    // The operator signs in and reads: their site's night rows, nothing else.
    const operator = await signInAs(browser, `${P}-operator-a@example.com`, PASSWORD)
    const rows = await apiFor(operator.page, operator.token)<{ site: string, kind: string }[]>('GET', `/api/public/table/${TABLE}?fields=site,kind`)
    expect(rows).toEqual([{ site: 'A', kind: 'night' }])

    // The administrator cuts the managers' role: the operator loses it on the next request.
    await api('DELETE', `/admin/api/roles/${managerRole}/resources/${controls}/permissions/READ`)
    await expect(apiFor(operator.page, operator.token)('GET', `/api/public/table/${TABLE}?fields=site,kind`)).rejects.toThrow(/403/)

    // The tree, as the administrator sees it: the new role under the managers'.
    await adminPage.goto(`/roles/${operatorRole}`)
    await expect(adminPage.getByText(`${P}-night-operators-a`).first()).toBeVisible()

    await manager.context.close()
    await operator.context.close()
  })

  test('two incompatible roles are never held together, and an assignment can end', async () => {
    const auditor = (await api<{ id: string }>('POST', '/api/totalbase/table/roles', { data: { name: `${P}-auditors` } })).id
    const clerk = (await api<{ id: string }>('POST', '/api/totalbase/table/roles', { data: { name: `${P}-clerks` } })).id
    await api('PUT', `/admin/api/roles/${clerk}/incompatible`, { data: { roleIds: [auditor] } })
    await api('PUT', `/admin/api/users/${operatorId}/roles`, { data: { roleIds: [clerk] } })
    await expect(api('PUT', `/admin/api/users/${operatorId}/roles`, { data: { roleIds: [clerk, auditor] } })).rejects.toThrow(/can't be held together/)

    // In the admin: the clerks' General shows the pair, their Members the operator's role ending tomorrow.
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    await api('PUT', `/admin/api/users/${operatorId}/roles/${clerk}/expiry`, { data: { expiresAt: tomorrow } })
    await adminPage.goto(`/roles/${clerk}`)
    await expect(adminPage.getByRole('button', { name: 'Can\'t be held with' })).toContainText(`${P}-auditors`)
    await adminPage.goto(`/roles/${clerk}?section=users`)
    await expect(adminPage.getByText(/^Ends /)).toBeVisible()
  })
})
