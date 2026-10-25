import { adminSession, api, expect, test } from './fixtures.js'
import { BASE_URL, sessionToken } from '../helpers'

/**
 * The UI's language (Admin_UI.md §14): a user picks Español in
 * My account and the screens follow at once, and after a reload. A user of
 * its own - the instance admin's language stays English for every other
 * spec running beside this one.
 */
const RUN = Math.random().toString(36).slice(2, 8)
const EMAIL = `ui-language-${RUN}@example.com`
const PASSWORD = 'UiLanguage-Password-12345'
let userId = ''
let roleId = ''

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  roleId = (await api<{ id: string }>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: `UI Language ${RUN}`, app_access: true } })).id
  userId = (await api<{ id: string }>(page, token, 'POST', '/admin/api/users', { data: { email: EMAIL, name: 'Idioma E2E', password: PASSWORD, roleIds: [roleId] } })).id
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  if (userId) await api(page, token, 'DELETE', `/admin/api/users/${userId}`)
  if (roleId) await api(page, token, 'DELETE', `/api/totalbase/table/roles/${roleId}`)
  await context.close()
})

test('a user switches to Spanish in My account - at once, and after a reload', async ({ browser }) => {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await sessionToken(page)

  await page.goto('/account?tab=preferences')
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: 'Date and time' })).toBeVisible()
  await main.getByLabel('Language').click()
  await page.getByRole('option', { name: 'Español' }).click()
  await expect(main.getByRole('heading', { name: 'Fecha y hora' })).toBeVisible()
  await expect(main.getByRole('heading', { name: 'Idioma', exact: true }).first()).toBeVisible()

  await page.reload()
  await expect(main.getByRole('heading', { name: 'Fecha y hora' })).toBeVisible()

  // Back to the instance's language.
  await main.getByLabel('Idioma').click()
  await page.getByRole('option', { name: /Predeterminado de la instancia/ }).click()
  await expect(main.getByRole('heading', { name: 'Date and time' })).toBeVisible()
  await context.close()
})
