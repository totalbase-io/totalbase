import { expect, request, test, type APIRequestContext, type Page } from '@playwright/test'
import { ADMIN_EMAIL, ADMIN_PASSWORD, watchApiFailures } from './helpers.js'

/**
 * Every write action of the Users, Roles, API tokens and Sessions screens,
 * driven through the real admin UI. Fixtures (prefix "UI Users") are set up
 * and cleaned up through the API, deleted by primary key; the admin account
 * itself is never changed.
 */
const BASE = 'http://localhost:3050'
const PASSWORD = 'UiUsers-Password-12345'
const RUN = Math.random().toString(36).slice(2, 8)
const SMTP_SEND = /^POST \/admin\/api\/users\/[^/]+\/(invite|reset-password)$/

let api: APIRequestContext
let adminToken = ''
const userIds = new Set<string>()
const roleIds = new Set<string>()

/**
 * The UI and the API calls run as a fixture administrator, not the
 * instance admin: every spec running at the same time signs the instance
 * admin in, and its oldest sessions are evicted past
 * auth.max_sessions_per_user - a page could lose its session mid-flow.
 */
const FIXTURE_ADMIN = { email: `ui-users-admin-${RUN}@example.com`, password: PASSWORD, id: '' }

test.use({ permissions: ['clipboard-read', 'clipboard-write'] })
// The dev server is shared with other specs running at the same time.
test.describe.configure({ timeout: 120_000 })

interface User { id: string, email: string, name: string | null, roles: string[], active: boolean, hasPassword: boolean, avatarUrl: string | null, emailVerifiedAt: string | null }
interface Role { id: string, name: string, description: string | null, active: boolean }

/**
 * The dev server's rate limit (security.rate_limit_per_minute, per IP) is
 * shared by every spec running at the same time - a 429 on a setup call
 * waits and retries instead of failing the flow under test.
 */
async function fetchRetrying(send: () => ReturnType<APIRequestContext['fetch']>) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await send()
    if (response.status() !== 429 || attempt === 12) return response
    await new Promise(resolve => setTimeout(resolve, 5_000))
  }
}

async function portalLogin(email: string, password: string): Promise<string> {
  const response = await fetchRetrying(() => api.post(`${BASE}/admin/api/auth/login`, { data: { email, password } }))
  if (!response.ok()) throw new Error(`login ${email} -> ${response.status()}`)
  return (await response.json()).data.token
}

/** A fixture user's own sign-in (Data API login - fixture roles grant API access). */
function userLogin(email: string, password: string) {
  return fetchRetrying(() => api.post(`${BASE}/api/auth/login`, { data: { email, password } }))
}

async function call<T>(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number, data: T, meta?: Record<string, unknown> }> {
  const send = () => fetchRetrying(() => api.fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token ?? adminToken}` },
    ...(body !== undefined && { data: body })
  }))
  let response = await send()
  // The fixture admin's own sign-ins (one per test) can evict this session too.
  if (response.status() === 401 && token === undefined) {
    adminToken = await portalLogin(FIXTURE_ADMIN.email, FIXTURE_ADMIN.password)
    response = await send()
  }
  const text = await response.text()
  const json = text ? JSON.parse(text) : {}
  return { status: response.status(), data: json.data as T, meta: json.meta }
}

async function ok<T>(method: string, path: string, body?: unknown): Promise<T> {
  const result = await call<T>(method, path, body)
  if (result.status >= 400) throw new Error(`${method} ${path} -> ${result.status}`)
  return result.data
}

/** The admin UI, signed in as the fixture administrator. */
async function signIn(page: Page) {
  await page.goto('/admin/login')
  await page.getByLabel('Email').fill(FIXTURE_ADMIN.email)
  await page.getByLabel('Password').fill(FIXTURE_ADMIN.password)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/admin\/(status|app)?\/?$/, { waitUntil: 'commit' })
}

let counter = 0
function unique(label: string) {
  counter += 1
  return `UI Users ${label} ${RUN}${counter}`
}
function uniqueEmail() {
  counter += 1
  return `ui-users-${RUN}-${counter}@example.com`
}

async function createRole(name = unique('Role')): Promise<Role> {
  const role = await ok<Role>('POST', '/api/totalbase/table/roles', { data: { name, app_access: true, api_access: true } })
  roleIds.add(role.id)
  return role
}

async function createUser(options: { roles?: string[], password?: boolean } = {}): Promise<User> {
  const user = await ok<User>('POST', '/admin/api/users', {
    data: { email: uniqueEmail(), name: unique('User'), ...(options.password !== false && { password: PASSWORD }), roleIds: options.roles ?? [] }
  })
  userIds.add(user.id)
  return user
}

const getUser = (id: string) => ok<User>('GET', `/admin/api/users/${id}`)
const getRole = async (id: string) => (await ok<Role[]>('GET', `/api/totalbase/table/roles?where[id][_eq]=${id}`))[0]

test.beforeAll(async () => {
  api = await request.newContext()
  const instanceAdmin = await portalLogin(ADMIN_EMAIL, ADMIN_PASSWORD)
  const listed = await call<User[]>('GET', `/admin/api/users?q=${encodeURIComponent(ADMIN_EMAIL)}`, undefined, instanceAdmin)
  const roles = listed.data.find(u => u.email === ADMIN_EMAIL)!.roles
  const created = await call<User>('POST', '/admin/api/users', {
    data: { email: FIXTURE_ADMIN.email, name: `UI Users Admin ${RUN}`, password: PASSWORD, roleIds: roles }
  }, instanceAdmin)
  if (created.status >= 300) throw new Error(`fixture admin -> ${created.status}`)
  FIXTURE_ADMIN.id = created.data.id
  adminToken = await portalLogin(FIXTURE_ADMIN.email, FIXTURE_ADMIN.password)
})

test.afterAll(async () => {
  for (const id of userIds) await call('DELETE', `/admin/api/users/${id}`)
  for (const id of roleIds) await call('DELETE', `/api/totalbase/table/roles/${id}`)
  // An administrator can't delete itself - the instance admin removes the fixture one.
  const instanceAdmin = await portalLogin(ADMIN_EMAIL, ADMIN_PASSWORD)
  await call('DELETE', `/admin/api/users/${FIXTURE_ADMIN.id}`, undefined, instanceAdmin)
  await api.dispose()
})

/** A multi-select's option, picked from its open listbox, then the listbox closed. */
async function pickOptions(page: Page, trigger: ReturnType<Page['getByRole']>, names: string[]) {
  await trigger.click()
  for (const name of names) await page.getByRole('option', { name }).click()
  await page.keyboard.press('Escape')
}

/** A toast, by its title. */
function toast(page: Page, title: string) {
  return page.locator('[data-slot="title"]', { hasText: title }).first()
}

/** The new id at the end of /admin/<section>/<id>. */
async function idFromUrl(page: Page, section: string) {
  await page.waitForURL(new RegExp(`/admin/${section}/[0-9a-f-]{36}`))
  return page.url().split('/').pop()!.split('?')[0]!
}

// ---------------------------------------------------------------- Users

test('create a user with a password and roles', async ({ page }) => {
  const role = await createRole()
  await signIn(page)
  const failures = watchApiFailures(page)
  const name = unique('Created')
  const email = uniqueEmail()

  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog', { name: 'New user' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Email').fill(email)
  await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await dialog.getByLabel('Confirm password').fill(PASSWORD)
  await pickOptions(page, dialog.getByRole('combobox', { name: 'Roles' }), [role.name])
  await dialog.getByRole('button', { name: 'Create' }).click()

  const id = await idFromUrl(page, 'users')
  userIds.add(id)
  await expect(page.getByRole('heading', { name })).toBeVisible()

  const user = await getUser(id)
  expect(user).toMatchObject({ email, name, hasPassword: true, roles: [role.id] })
  const signedIn = await userLogin(email, PASSWORD)
  expect(signedIn.status()).toBe(200)
  expect(failures).toEqual([])
})

test('invite a user without a password', async ({ page }) => {
  const role = await createRole()
  await signIn(page)
  // SMTP isn't configured on the dev server: the email fails on purpose and
  // the UI offers the link instead.
  const failures = watchApiFailures(page, [SMTP_SEND])
  const name = unique('Invited')
  const email = uniqueEmail()

  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Invite user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Invite user' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Email').fill(email)
  await pickOptions(page, dialog.getByRole('combobox', { name: 'Roles' }), [role.name])
  await dialog.getByRole('button', { name: 'Send invitation' }).click()

  const id = await idFromUrl(page, 'users')
  userIds.add(id)
  const sent = toast(page, 'Invitation sent')
  const notSent = toast(page, 'User created, but the invitation was not sent')
  await expect(sent.or(notSent)).toBeVisible()
  if (await notSent.isVisible()) {
    await page.getByRole('button', { name: 'Copy link instead' }).click()
    await expect(toast(page, 'Invitation link copied')).toBeVisible()
    const link = await page.evaluate(() => navigator.clipboard.readText())
    expect(link).toContain('accept-invitation?token=')
  }

  const user = await getUser(id)
  expect(user).toMatchObject({ email, name, hasPassword: false, roles: [role.id] })
  expect(failures).toEqual([])
})

test('edit a user: name, email, roles and avatar', async ({ page }) => {
  const [first, second] = [await createRole(), await createRole()]
  const user = await createUser({ roles: [first.id] })
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/users/${user.id}`)
  // Name - saved from the header.
  const newName = unique('Renamed')
  await page.getByLabel('Name').fill(newName)
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, 'User saved')).toBeVisible()
  expect((await getUser(user.id)).name).toBe(newName)

  // Email - its own dialog, marked verified so no email is sent.
  const newEmail = uniqueEmail()
  await page.getByRole('button', { name: 'Edit' }).click()
  const emailDialog = page.getByRole('dialog', { name: 'Change email' })
  await emailDialog.getByLabel('New email').fill(newEmail)
  await emailDialog.getByText('Mark as verified').click()
  await emailDialog.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, 'Email changed')).toBeVisible()
  const afterEmail = await getUser(user.id)
  expect(afterEmail.email).toBe(newEmail)
  expect(afterEmail.emailVerifiedAt).not.toBeNull()

  // Roles - swap the first role for the second, then Save.
  await page.getByRole('link', { name: 'Roles' }).click()
  await page.locator('label', { hasText: first.name }).getByRole('checkbox').click()
  await page.locator('label', { hasText: second.name }).getByRole('checkbox').click()
  // The roles' own PUT, not the "User saved" toast: the name step's toast
  // can still be on screen and would match before this save even ran.
  const rolesSaved = page.waitForResponse(r => r.url().endsWith(`/admin/api/users/${user.id}/roles`) && r.request().method() === 'PUT')
  await page.getByRole('button', { name: 'Save' }).click()
  expect((await rolesSaved).status()).toBe(204)
  expect((await getUser(user.id)).roles).toEqual([second.id])

  // Avatar - upload, then remove.
  await page.getByRole('link', { name: 'Profile' }).click()
  await page.locator('input[type=file]').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64')
  })
  await expect(page.getByRole('button', { name: 'Replace' })).toBeVisible()
  expect((await getUser(user.id)).avatarUrl).not.toBeNull()
  await page.getByRole('button', { name: 'Remove' }).click()
  await expect(page.getByRole('button', { name: 'Upload' })).toBeVisible()
  expect((await getUser(user.id)).avatarUrl).toBeNull()
  expect(failures).toEqual([])
})

test('set a user\'s password, send a password reset, revoke sessions', async ({ page }) => {
  const role = await createRole()
  const user = await createUser({ roles: [role.id] })
  await signIn(page)
  const failures = watchApiFailures(page, [SMTP_SEND])

  await page.goto(`/admin/users/${user.id}`)
  await page.getByRole('button', { name: 'Set password' }).click()
  const dialog = page.getByRole('dialog', { name: 'Set password' })
  const newPassword = 'UiUsers-Changed-67890'
  await dialog.getByLabel('New password').fill(newPassword)
  await dialog.getByLabel('Confirm password').fill(newPassword)
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, 'Password set')).toBeVisible()
  const signedIn = await userLogin(user.email, newPassword)
  expect(signedIn.status()).toBe(200)
  const oldLogin = await userLogin(user.email, PASSWORD)
  expect(oldLogin.status()).toBe(401)

  // Send password reset - SMTP isn't configured, so the UI offers the link. With a real relay this would email a
  // reserved address (refused, after the relay's own minutes): skipped there.
  const smtp = (await call<Record<string, unknown>>('GET', '/admin/api/settings/smtp')).data
  if (!smtp['smtp.host'] || !smtp['smtp.from']) {
    await page.getByRole('button', { name: 'Actions', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Send password reset' }).click()
    await expect(toast(page, 'Could not send password reset')).toBeVisible()
    await page.getByRole('button', { name: 'Copy link instead' }).click()
    await expect(toast(page, 'Password reset link copied')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('reset-password?token=')
  }

  // Revoke all sessions - the sign-in above opened one.
  const active = () => call<unknown[]>('GET', `/admin/api/sessions?user=${user.id}&status=ACTIVE`)
  expect((await active()).meta?.total).toBe(1)
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Revoke all sessions' }).click()
  await expect(toast(page, 'Sessions revoked')).toBeVisible()
  expect((await active()).meta?.total).toBe(0)
  expect(failures).toEqual([])
})

test('deactivate, activate and delete a user from its page', async ({ page }) => {
  const user = await createUser()
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/users/${user.id}`)
  await page.getByRole('button', { name: 'Deactivate' }).click()
  await expect(page.getByRole('button', { name: 'Activate' })).toBeVisible()
  expect((await getUser(user.id)).active).toBe(false)
  await page.getByRole('button', { name: 'Activate' }).click()
  await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible()
  expect((await getUser(user.id)).active).toBe(true)

  await page.getByRole('button', { name: 'Delete user' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete this user?' })
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await page.waitForURL(/\/admin\/users$/)
  expect((await call('GET', `/admin/api/users/${user.id}`)).status).toBe(404)
  expect(failures).toEqual([])
})

/** Searches the users list and waits for its answer - a search landing after a click would clear the selection. */
async function searchUsers(page: Page, text: string) {
  const answered = page.waitForResponse(r => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/admin/api/users') && new URL(r.url()).searchParams.get('q') === text)
  await page.getByPlaceholder('Search by name or email...').fill(text)
  await answered
}

test('the users list: row deactivate/activate, row delete and bulk delete', async ({ page }) => {
  const [a, b, c] = [await createUser(), await createUser(), await createUser()]
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto('/admin/users')
  await searchUsers(page, `ui-users-${RUN}-`)
  await expect(page.getByRole('button', { name: `Actions for ${a.name}`, exact: true })).toBeVisible()

  await page.getByRole('button', { name: `Actions for ${a.name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Deactivate' }).click()
  await expect.poll(async () => (await getUser(a.id)).active).toBe(false)
  await page.getByRole('button', { name: `Actions for ${a.name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Activate' }).click()
  await expect.poll(async () => (await getUser(a.id)).active).toBe(true)

  await page.getByRole('button', { name: `Actions for ${a.name}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete' }).click()
  let dialog = page.getByRole('dialog', { name: 'Delete user?' })
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page, 'User deleted')).toBeVisible()
  expect((await call('GET', `/admin/api/users/${a.id}`)).status).toBe(404)

  await page.getByRole('checkbox', { name: `Select ${b.name}` }).click()
  await page.getByRole('checkbox', { name: `Select ${c.name}` }).click()
  await page.getByRole('button', { name: 'Delete', exact: true }).click()
  dialog = page.getByRole('dialog', { name: 'Delete 2 users?' })
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page, '2 users deleted')).toBeVisible()
  expect((await call('GET', `/admin/api/users/${b.id}`)).status).toBe(404)
  expect((await call('GET', `/admin/api/users/${c.id}`)).status).toBe(404)
  expect(failures).toEqual([])
})

test('the users list: bulk Add to role, Remove from role and Deactivate', async ({ page }) => {
  const role = await createRole()
  const [a, b] = [await createUser(), await createUser()]
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto('/admin/users')
  await searchUsers(page, `ui-users-${RUN}-`)
  await expect(page.getByRole('button', { name: `Actions for ${b.name}`, exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Actions for ${a.name}`, exact: true })).toBeVisible()
  await page.getByRole('checkbox', { name: `Select ${a.name}` }).click()
  await page.getByRole('checkbox', { name: `Select ${b.name}` }).click()
  await page.getByRole('button', { name: 'Add to role…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Add to role' })
  await dialog.getByLabel('Role', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(role.name) }).click()
  await dialog.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getUser(a.id)).roles).toContain(role.id)
  expect((await getUser(b.id)).roles).toContain(role.id)

  await page.getByRole('checkbox', { name: `Select ${a.name}` }).click()
  await page.getByRole('button', { name: 'Remove from role…' }).click()
  const remove = page.getByRole('dialog', { name: 'Remove from role' })
  await remove.getByLabel('Role', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(role.name) }).click()
  await remove.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect.poll(async () => (await getUser(a.id)).roles).not.toContain(role.id)
  expect((await getUser(b.id)).roles).toContain(role.id)

  await page.getByRole('checkbox', { name: `Select ${b.name}` }).click()
  await page.getByRole('button', { name: 'Deactivate', exact: true }).click()
  await expect.poll(async () => (await getUser(b.id)).active).toBe(false)
  expect(failures).toEqual([])
})

test('a role\'s members: move the checked ones to another role', async ({ page }) => {
  const [from, to] = [await createRole(), await createRole()]
  const member = await createUser({ roles: [from.id] })
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/roles/${from.id}`)
  await page.getByRole('link', { name: /Members/ }).click()
  await page.getByRole('checkbox', { name: `Select ${member.name}` }).click()
  await page.getByRole('button', { name: 'Move to role…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Move to role' })
  await dialog.getByLabel('Role', { exact: true }).click()
  await page.getByRole('option', { name: new RegExp(to.name) }).click()
  await dialog.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await getUser(member.id)).roles).toEqual([to.id])
  expect(failures).toEqual([])
})

// ---------------------------------------------------------------- Roles

test('a role\'s access reviews: record one, PostgreSQL keeps who and the members then', async ({ page }) => {
  const role = await createRole()
  const member = await createUser({ roles: [role.id] })
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/roles/${role.id}`)
  await page.getByRole('link', { name: /Access reviews/ }).click()
  await expect(page.getByText('No reviews yet')).toBeVisible()
  await page.getByRole('button', { name: 'Record review' }).click()
  await page.getByRole('radio', { name: /Changes made/ }).click()
  await page.getByLabel('Note').fill('Checked by the UI users spec')
  await page.getByRole('button', { name: 'Record', exact: true }).click()
  await expect(toast(page, 'Access review recorded')).toBeVisible()
  await expect(page.getByRole('cell', { name: 'Checked by the UI users spec' })).toBeVisible()

  const [review] = await ok<Array<{ reviewer: string, outcome: string, members: Array<{ id: string }> }>>(
    'GET', `/api/totalbase/table/roles_reviews?where[role][_eq]=${role.id}`)
  expect(review).toMatchObject({ reviewer: FIXTURE_ADMIN.id, outcome: 'CHANGES_MADE' })
  expect(review!.members.map(m => m.id)).toEqual([member.id])
  expect(failures).toEqual([])
})

test('create a role', async ({ page }) => {
  await signIn(page)
  const failures = watchApiFailures(page)
  const name = unique('NewRole')

  await page.goto('/admin/roles')
  await page.getByRole('button', { name: 'New role' }).click()
  const dialog = page.getByRole('dialog', { name: 'New role' })
  await dialog.getByLabel('Name').fill(name)
  await dialog.getByLabel('Description').fill('Created by the UI users spec')
  await dialog.getByRole('button', { name: 'Create' }).click()

  const id = await idFromUrl(page, 'roles')
  roleIds.add(id)
  await expect(toast(page, 'Role created')).toBeVisible()
  expect(await getRole(id)).toMatchObject({ name, description: 'Created by the UI users spec' })
  // "Apply default totalbase permissions" is on by default.
  const grants = await ok<unknown[]>('GET', `/api/totalbase/table/permissions?where[role][_eq]=${id}`)
  expect(grants.length).toBeGreaterThan(0)
  expect(failures).toEqual([])
})

test('edit a role, deactivate and activate it, and delete it', async ({ page }) => {
  const role = await createRole()
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/roles/${role.id}`)
  // General: its details edited in place.
  const dialog = page.locator('main')
  const newName = unique('EditedRole')
  await dialog.getByLabel('Name').fill(newName)
  await dialog.getByLabel('Description').fill('Edited')
  // Its capabilities (roles_capabilities): sending email from a workflow.
  await dialog.getByRole('switch', { name: 'Can send email' }).click()
  await dialog.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, 'Role updated')).toBeVisible()
  expect(await getRole(role.id)).toMatchObject({ name: newName, description: 'Edited' })
  expect(await ok<Array<{ capability: string, effect: string }>>('GET', `/api/totalbase/table/roles_capabilities?where[role][_eq]=${role.id}&fields=capability,effect`))
    .toEqual([{ capability: 'SEND_EMAIL', effect: 'ALLOW' }])

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Deactivate' }).click()
  await expect.poll(async () => (await getRole(role.id))!.active).toBe(false)
  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Activate' }).click()
  await expect.poll(async () => (await getRole(role.id))!.active).toBe(true)

  await page.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const deleteDialog = page.getByRole('dialog', { name: 'Delete this role?' })
  await deleteDialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await deleteDialog.getByRole('button', { name: 'Delete' }).click()
  await page.waitForURL(/\/admin\/roles$/)
  expect(await getRole(role.id)).toBeUndefined()
  expect(failures).toEqual([])
})

test('grant and revoke a role permission with a row filter and a field restriction', async ({ page }) => {
  const role = await createRole()
  const resource = (await ok<Array<{ id: string }>>('GET', '/api/totalbase/table/resources?where[name][_eq]=templates&fields=id'))[0]!
  const grants = () => ok<Array<{ action: string, effect: string, where_clause: unknown, field_overrides: Array<{ field: string }> }>>(
    'GET', `/api/totalbase/table/permissions?where[role][_eq]=${role.id}&where[resource][_eq]=${resource.id}`)
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/roles/${role.id}?section=permissions`)
  await page.getByRole('combobox', { name: 'Schema' }).click()
  await page.getByRole('option', { name: 'totalbase' }).click()
  await page.getByPlaceholder('Filter resources...').fill('templates')
  await page.getByRole('button', { name: 'READ on templates' }).click()

  const editor = page.getByRole('dialog', { name: 'totalbase.templates — READ' })
  await editor.getByRole('checkbox', { name: 'name', exact: true }).click()
  await editor.getByRole('checkbox', { name: 'slug', exact: true }).click()
  await expect(editor.getByText('Fields: name, slug')).toBeVisible()
  await editor.getByRole('tab', { name: 'Row filter' }).click()
  await editor.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText('{"kind":{"_eq":"MAILING"}}')
  await editor.getByRole('button', { name: 'Save' }).click()
  await expect(toast(page, 'Permission saved')).toBeVisible()

  const [grant] = await grants()
  expect(grant).toMatchObject({ action: 'READ', effect: 'ALLOW', where_clause: { kind: { _eq: 'MAILING' } } })
  expect(grant!.field_overrides.map(f => f.field)).toEqual(['name', 'slug'])

  // Clear it again from the same cell.
  await page.getByRole('button', { name: 'READ on templates' }).click()
  await editor.getByRole('button', { name: 'Clear grant' }).click()
  await expect(toast(page, 'Grant cleared')).toBeVisible()
  expect(await grants()).toEqual([])
  expect(failures).toEqual([])
})

test('set a role\'s managers, add and remove a member', async ({ page }) => {
  const [role, manager] = [await createRole(), await createRole()]
  const user = await createUser()
  const managers = async () => (await ok<Array<{ manager: string }>>('GET', `/api/totalbase/table/roles_managers?where[role][_eq]=${role.id}&fields=manager`)).map(r => r.manager)
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto(`/admin/roles/${role.id}`)
  await page.getByRole('link', { name: 'Members' }).click()
  await pickOptions(page, page.getByRole('button', { name: 'Managed by' }), [manager.name])
  await expect.poll(managers).toEqual([manager.id])
  await pickOptions(page, page.getByRole('button', { name: 'Managed by' }), [manager.name])
  await expect.poll(managers).toEqual([])

  const add = page.getByRole('button', { name: 'Add an existing user' })
  await add.click()
  await page.keyboard.type(user.email)
  await page.getByRole('option', { name: user.name! }).click()
  await expect(toast(page, `${user.name} added to ${role.name}`)).toBeVisible()
  expect((await getUser(user.id)).roles).toEqual([role.id])

  await page.getByRole('button', { name: `Remove ${user.name} from ${role.name}` }).click()
  await expect(toast(page, `Removed from ${role.name}`)).toBeVisible()
  expect((await getUser(user.id)).roles).toEqual([])
  expect(failures).toEqual([])
})

// ---------------------------------------------------------------- API tokens

test('create, regenerate, revoke and delete an API token', async ({ page }) => {
  const role = await createRole()
  await ok('PATCH', `/api/totalbase/table/roles/${role.id}`, { data: { api_access: true } })
  const user = await createUser({ roles: [role.id] })
  const tokens = () => ok<Array<{ id: string, name: string, active: boolean, revoked_at: string | null, rotated_at: string | null }>>(
    'GET', `/api/totalbase/table/tokens?where[user][_eq]=${user.id}`)
  await signIn(page)
  const failures = watchApiFailures(page)
  const name = `ui-users-${RUN}`

  await page.goto('/admin/tokens')
  await page.getByRole('button', { name: 'New token' }).first().click()
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'New token' }) })
  await drawer.getByRole('button', { name: 'User', exact: true }).click()
  await page.keyboard.type(user.email)
  await page.getByRole('option', { name: new RegExp(user.name!) }).click()
  await expect(page.getByRole('listbox')).toBeHidden()
  await drawer.getByLabel('Name').fill(name)
  await drawer.getByRole('button', { name: 'Create token' }).click()
  await expect(page.getByText(`Token “${name}” created`)).toBeVisible()
  const secret = (await page.locator('code').filter({ hasText: /^tb_[^…]+$/ }).textContent())!.trim()
  const [created] = await tokens()
  expect(created).toMatchObject({ name, active: true, revoked_at: null })
  // The secret authenticates (a 403 would only be a missing grant) ...
  const probe = (key: string) => call('GET', '/api/totalbase/table/roles?limit=1', undefined, key)
  expect((await probe(secret)).status).not.toBe(401)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Regenerate…' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Regenerate' }).click()
  await expect(page.getByText(`Token “${name}” regenerated`)).toBeVisible()
  expect((await tokens())[0]!.rotated_at).not.toBeNull()
  // ... until it's regenerated.
  expect((await probe(secret)).status).toBe(401)
  await page.getByRole('button', { name: 'Done' }).click()

  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Revoke' }).click()
  await expect(toast(page, 'Token revoked')).toBeVisible()
  expect((await tokens())[0]).toMatchObject({ active: false })
  expect((await tokens())[0]!.revoked_at).not.toBeNull()

  await page.getByRole('button', { name: `Actions for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const dialog = page.getByRole('dialog', { name: 'Delete token?' })
  await dialog.getByRole('checkbox').click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await expect(toast(page, 'Token deleted')).toBeVisible()
  expect(await tokens()).toEqual([])
  expect(failures).toEqual([])
})

test('change and restore an API token setting', async ({ page }) => {
  const original = (await ok<Record<string, number>>('GET', '/admin/api/settings/api_keys'))['api_keys.rotation_warning_days']
  await signIn(page)
  const failures = watchApiFailures(page)
  try {
    await page.goto('/admin/settings/api-tokens')
    const field = page.getByRole('spinbutton', { name: 'Rotation warning window' })
    await field.fill(String(original! + 1))
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(toast(page, 'Setting saved')).toBeVisible()
    expect((await ok<Record<string, number>>('GET', '/admin/api/settings/api_keys'))['api_keys.rotation_warning_days']).toBe(original! + 1)

    await page.getByRole('button', { name: 'Restore default' }).click()
    await page.getByRole('button', { name: 'Save' }).click()
    // The first save's toast may still be up: wait for the value itself.
    await expect.poll(async () => (await ok<Record<string, number>>('GET', '/admin/api/settings/api_keys'))['api_keys.rotation_warning_days']).toBe(30)
  } finally {
    // Leave the setting as it was found.
    const now = (await ok<Record<string, number>>('GET', '/admin/api/settings/api_keys'))['api_keys.rotation_warning_days']
    if (now !== original) await ok('PATCH', '/admin/api/settings/api_keys', { data: { rotation_warning_days: original } })
  }
  expect(failures).toEqual([])
})

// ---------------------------------------------------------------- Sessions

test('revoke a user\'s session', async ({ page }) => {
  const role = await createRole()
  const user = await createUser({ roles: [role.id] })
  const signedIn = await userLogin(user.email, PASSWORD)
  expect(signedIn.status()).toBe(200)
  const userToken = (await signedIn.json()).data.token as string
  const active = () => call<unknown[]>('GET', `/admin/api/sessions?user=${user.id}&status=ACTIVE`)
  expect((await active()).meta?.total).toBe(1)
  await signIn(page)
  const failures = watchApiFailures(page)

  await page.goto('/admin/sessions')
  await page.getByPlaceholder('User, IP or browser').fill(user.email)
  await expect(page.getByRole('link', { name: new RegExp(user.email) })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Session actions' })).toHaveCount(1)
  await page.getByRole('button', { name: 'Session actions' }).click()
  await page.getByRole('menuitem', { name: 'Revoke' }).click()
  await expect(toast(page, 'Session revoked')).toBeVisible()

  expect((await active()).meta?.total).toBe(0)
  expect((await call('GET', '/api/auth/me', undefined, userToken)).status).toBe(401)
  expect(failures).toEqual([])
})
