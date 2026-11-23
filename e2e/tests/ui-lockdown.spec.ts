import { expect as baseExpect, test, type Browser, type Page } from '@playwright/test'
import { BASE_URL, apiRequest, login, sessionToken } from './helpers.js'

/**
 * Lockdown (Security.md §2.21), driven through the real UI: Settings > General > Lockdown, the banner above every
 * page, the sign-in page and where a user it keeps out waits. An administrator turns it on, a user who isn't one
 * meets it, and it is turned off again.
 *
 * A lockdown closes the instance to every other spec's users and tokens, so this file runs alone, after the rest
 * (playwright.config.ts's `lockdown` project, scripts/test-e2e.sh) - and each test leaves the lockdown off.
 */

const expect = baseExpect.configure({ timeout: 15_000 })
test.describe.configure({ mode: 'serial', timeout: 120_000 })

const ROLE_NAME = 'Lockdown E2E App'
const USER_EMAIL = 'lockdown-e2e-user@example.com'
const PASSWORD = 'lockdown-e2e-password'
const MESSAGE = 'Importing the new catalog - back soon.'

interface Role { id: string, name: string }
interface User { id: string, email: string }
type LockdownSettings = Record<string, unknown>

/** Everything off and empty again - whatever a test, or one that failed halfway, left. */
const OFF = { enabled: false, when: 'NOW', mode: 'FULL', from: '', until: '', allowed_roles: [], pause_workflows: false, notice_minutes: 0, message: '' }

const setLockdown = (page: Page, token: string, data: LockdownSettings) =>
  apiRequest<LockdownSettings>(page, token, 'PATCH', '/admin/api/settings/lockdown', { data })
const readLockdown = (page: Page, token: string) =>
  apiRequest<LockdownSettings>(page, token, 'GET', '/admin/api/settings/lockdown')

/** A setting's row on the page: `#setting-<key, dots as dashes>`. */
const row = (page: Page, key: string) => page.locator(`#setting-lockdown-${key}`)
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })
/** The line above every page (LockdownBanner.vue). */
const banner = (page: Page, text: string | RegExp) => page.getByRole('status').filter({ hasText: text })

/**
 * A request by a session's token - the status and the body, never thrown. Sent from that session's own page: a
 * page's requests carry its browser's cookies, and another user's would travel beside the token.
 */
async function asUser(page: Page, token: string, method: string, path: string, data?: unknown) {
  const response = await page.request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined && { data: { data } })
  })
  const text = await response.text()
  return { status: response.status(), body: text ? JSON.parse(text) as { errors?: { code: string, meta?: Record<string, unknown> }[] } : {} }
}

/** The sign-in form, filled and sent as the fixture user - in a browser of their own. */
async function userSignsIn(browser: Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(USER_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  return { context, page, submit: () => page.getByRole('button', { name: 'Sign in' }).click() }
}

let roleId = ''

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage()
  const token = await login(page)
  await setLockdown(page, token, OFF)

  // Leftovers of an earlier run first.
  const users = await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')
  for (const user of users.filter(u => u.email === USER_EMAIL)) await apiRequest(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  const roles = await apiRequest<Role[]>(page, token, 'GET', '/api/totalbase/table/roles?fields=id,name&limit=500')
  for (const role of roles.filter(r => r.name === ROLE_NAME)) await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)

  roleId = (await apiRequest<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: ROLE_NAME, app_access: true } })).id
  await apiRequest(page, token, 'POST', '/admin/api/users', { data: { email: USER_EMAIL, name: 'Lockdown E2E', password: PASSWORD, roleIds: [roleId] } })
  await page.close()
})

test.afterEach(async ({ browser }) => {
  // An administrator always gets in: the lockdown is turned off whatever the test left.
  const page = await browser.newPage()
  await setLockdown(page, await login(page), OFF)
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage()
  const token = await login(page)
  const users = await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')
  for (const user of users.filter(u => u.email === USER_EMAIL)) await apiRequest(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  if (roleId) await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${roleId}`)
  await page.close()
})

test('closed: the switch frees its page, a user is kept out and waits, and gets back in once it is off', async ({ page, browser }) => {
  const token = await login(page)
  await page.goto('/settings/lockdown')

  // Off: everything below the switch waits (Admin_UI.md §11).
  const lockdownSwitch = row(page, 'enabled').getByRole('switch')
  const message = row(page, 'message').getByRole('textbox')
  await expect(lockdownSwitch).not.toBeChecked()
  await expect(message).toBeDisabled()
  await expect(row(page, 'when').getByRole('radio').first()).toBeDisabled()

  // On, in the draft: the page is free at once - and only the fields of the chosen When.
  await lockdownSwitch.click()
  await expect(message).toBeEnabled()
  await expect(row(page, 'from').locator('input')).toBeDisabled()
  await row(page, 'when').getByText('Scheduled once', { exact: true }).click()
  await expect(row(page, 'from').locator('input')).toBeEnabled()
  await expect(row(page, 'recurring_minutes').getByRole('spinbutton')).toBeDisabled()
  await row(page, 'when').getByText('Now', { exact: true }).click()
  await expect(row(page, 'from').locator('input')).toBeDisabled()

  await message.fill(MESSAGE)
  await saveButton(page).click()
  await expect.poll(async () => (await readLockdown(page, token))['lockdown.enabled']).toBe(true)
  expect((await readLockdown(page, token))['lockdown.message']).toBe(MESSAGE)

  // The administrator is told, above every page, and keeps working.
  await expect(banner(page, 'Lockdown is on: only administrators are answered.')).toBeVisible()
  await page.goto('/status')
  await expect(banner(page, 'Lockdown is on')).toBeVisible()
  await expect(banner(page, 'Lockdown is on').getByRole('link', { name: 'Settings' })).toHaveAttribute('href', /\/settings\/lockdown$/)

  // Anyone else: the sign-in page says so before they try, and a correct password leaves them waiting.
  const user = await userSignsIn(browser)
  await expect(user.page.getByText('This instance is in lockdown').first()).toBeVisible()
  await expect(user.page.getByText(MESSAGE).first()).toBeVisible()
  await user.submit()
  await user.page.waitForURL(/\/lockdown$/)
  await expect(user.page.getByRole('heading', { name: 'This instance is in lockdown' })).toBeVisible()
  await expect(user.page.getByText(MESSAGE)).toBeVisible()
  // No session came of it.
  expect((await user.context.cookies()).some(c => /tb_session$/.test(c.name) && c.value)).toBe(false)

  // Off again, from the same page.
  await page.goto('/settings/lockdown')
  await row(page, 'enabled').getByRole('switch').click()
  await saveButton(page).click()
  await expect.poll(async () => (await readLockdown(page, token))['lockdown.enabled']).toBe(false)
  await expect(banner(page, 'Lockdown is on')).toBeHidden()

  // The user tries again, and is in.
  await user.page.getByRole('button', { name: 'Try again' }).click()
  await user.page.waitForURL(/\/login/)
  await expect(user.page.getByText('This instance is in lockdown')).toBeHidden()
  await user.page.getByLabel('Email').fill(USER_EMAIL)
  await user.page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await user.submit()
  await user.page.waitForURL(/\/app$/)
  await user.context.close()
})

test('closed: a user already signed in is taken to the waiting page, still signed in; an exception role keeps working', async ({ page, browser }) => {
  const token = await login(page)

  const user = await userSignsIn(browser)
  await user.submit()
  await user.page.waitForURL(/\/app$/)
  const userToken = await sessionToken(user.page)

  await setLockdown(page, token, { enabled: true, when: 'NOW', message: MESSAGE })
  expect((await asUser(user.page, userToken, 'GET', '/api/auth/me')).body.errors?.[0]?.code).toBe('LOCKDOWN')

  // Their next page asks the server, is refused, and leaves them on /lockdown - the session kept.
  await user.page.goto('/app')
  await user.page.waitForURL(/\/lockdown$/, { timeout: 20_000 })
  await expect(user.page.getByText(MESSAGE)).toBeVisible()
  expect((await user.context.cookies()).some(c => /tb_session$/.test(c.name) && c.value)).toBe(true)

  // Exceptions, picked on the page: their role gets in, as themselves.
  await page.goto('/settings/lockdown')
  await row(page, 'allowed_roles').locator('button[aria-haspopup="listbox"]').click()
  await page.getByRole('option', { name: ROLE_NAME }).click()
  await page.keyboard.press('Escape')
  await saveButton(page).click()
  await expect.poll(async () => (await readLockdown(page, token))['lockdown.allowed_roles']).toEqual([roleId])

  await user.page.getByRole('button', { name: 'Try again' }).click()
  await user.page.waitForURL(/\/app$/)
  // Inside during a lockdown, they are told too - without the administrators' way to its settings.
  await expect(banner(user.page, 'Lockdown is on')).toBeVisible()
  await expect(banner(user.page, 'Lockdown is on').getByRole('link', { name: 'Settings' })).toHaveCount(0)
  expect((await asUser(user.page, userToken, 'GET', '/api/auth/me')).status).toBe(200)
  // Admitted, never promoted: the admin stays the administrators'.
  expect((await asUser(user.page, userToken, 'GET', '/admin/api/settings/lockdown')).status).toBe(403)
  await user.context.close()
})

test('read-only: everyone signs in and reads, a change is refused where it is made', async ({ page, browser }) => {
  const token = await login(page)
  await page.goto('/settings/lockdown')
  await row(page, 'enabled').getByRole('switch').click()
  await row(page, 'mode').getByText('Read-only', { exact: true }).click()
  await saveButton(page).click()
  await expect.poll(async () => (await readLockdown(page, token))['lockdown.mode']).toBe('READ_ONLY')
  await expect(banner(page, 'Lockdown, read-only: only administrators can change anything.')).toBeVisible()

  // The sign-in page says read-only, and lets them in.
  const user = await userSignsIn(browser)
  await expect(user.page.getByText('This instance is read-only for now')).toBeVisible()
  await user.submit()
  await user.page.waitForURL(/\/app$/)
  await expect(banner(user.page, 'Lockdown, read-only')).toBeVisible()
  const userToken = await sessionToken(user.page)

  // Reads as ever; a write is 503 LOCKDOWN, and says which kind.
  expect((await asUser(user.page, userToken, 'GET', '/api/auth/me')).status).toBe(200)
  const refused = await asUser(user.page, userToken, 'PATCH', '/app/api/me/preferences', {})
  expect(refused.status).toBe(503)
  expect(refused.body.errors?.[0]).toMatchObject({ code: 'LOCKDOWN', meta: { mode: 'READ_ONLY' } })
  // They stay where they are: nobody is sent to the waiting page.
  await user.page.goto('/app')
  await expect(user.page).toHaveURL(/\/app$/)

  // An administrator still changes things - the lockdown itself, to begin with.
  await setLockdown(page, token, { message: MESSAGE })
  expect((await readLockdown(page, token))['lockdown.message']).toBe(MESSAGE)
  await user.context.close()
})

test('scheduled once: announced to administrators, and to users from the notice on', async ({ page, browser }) => {
  const token = await login(page)
  const from = new Date(Date.now() + 2 * 3_600_000).toISOString()
  const until = new Date(Date.now() + 3 * 3_600_000).toISOString()

  // Scheduled once without its two ends is refused, as the page would be.
  const refused = await asUser(page, token, 'PATCH', '/admin/api/settings/lockdown', { enabled: true, when: 'ONCE' })
  expect(refused.status).toBe(400)
  expect(refused.body.errors?.[0]?.code).toBe('INVALID_SETTING')

  // Two hours ahead, with no notice: only administrators see it coming.
  await setLockdown(page, token, { enabled: true, when: 'ONCE', from, until, message: MESSAGE })
  await page.goto('/settings/lockdown')
  await expect(banner(page, /^A lockdown is scheduled from /)).toBeVisible()
  await expect(row(page, 'from').locator('input')).not.toHaveValue('')

  const user = await userSignsIn(browser)
  await expect(user.page.getByText('This instance is in lockdown')).toBeHidden()
  await user.submit()
  await user.page.waitForURL(/\/app$/)
  await expect(banner(user.page, /lockdown/i)).toHaveCount(0)

  // With a notice longer than the wait, its users are told as well - with the message.
  await page.goto('/settings/lockdown')
  await row(page, 'notice_minutes').getByRole('spinbutton').fill('180')
  await saveButton(page).click()
  await expect.poll(async () => (await readLockdown(page, token))['lockdown.notice_minutes']).toBe(180)
  await user.page.reload()
  await expect(banner(user.page, /^This instance will be in lockdown from /)).toBeVisible()
  await expect(banner(user.page, MESSAGE)).toBeVisible()
  // Not yet a lockdown: they keep working.
  expect((await asUser(user.page, await sessionToken(user.page), 'GET', '/api/auth/me')).status).toBe(200)
  await user.context.close()
})
