import { expect, test } from '@playwright/test'
import { apiRequest, login } from './helpers.js'

/**
 * Role access levels in the portal:
 * - an APP user lands in the app after login and is kept out of the
 *   admin, even when typing an admin URL;
 * - an API-only user can't log into the portal at all.
 */
const ROLE_NAME = 'Role Access E2E App'
const API_ROLE_NAME = 'Role Access E2E Api'
const APP_EMAIL = 'role-access-e2e-app@example.com'
const API_EMAIL = 'role-access-e2e-api@example.com'
const PASSWORD = 'role-access-e2e-password'

interface Role { id: string, name: string, access: string }
interface User { id: string, email: string }

test('access levels route each user to what their roles open', async ({ page, browser }) => {
  const token = await login(page)

  // Clean up leftovers from an earlier run first.
  const users = await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')
  for (const user of users.filter(u => u.email === APP_EMAIL || u.email === API_EMAIL)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  }
  const roles = await apiRequest<Role[]>(page, token, 'GET', '/api/totalbase/table/roles?fields=id,name&limit=500')
  for (const role of roles.filter(r => r.name === ROLE_NAME || r.name === API_ROLE_NAME)) {
    await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)
  }

  // Roles are TotalBase data, written through the Data API (Specification_Security.md §10).
  const appRole = await apiRequest<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: ROLE_NAME, app_access: true } })
  const apiRole = await apiRequest<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: API_ROLE_NAME, app_access: false, api_access: true } })
  await apiRequest(page, token, 'POST', '/admin/api/users', { data: { email: APP_EMAIL, name: 'App E2E', password: PASSWORD, roleIds: [appRole.id] } })
  await apiRequest(page, token, 'POST', '/admin/api/users', { data: { email: API_EMAIL, name: 'Api E2E', password: PASSWORD, roleIds: [apiRole.id] } })

  // --- An APP user lands in the app and can't reach the admin. ---
  const appContext = await browser.newContext()
  const appPage = await appContext.newPage()
  await appPage.goto('/admin/login')
  await appPage.getByLabel('Email').fill(APP_EMAIL)
  await appPage.getByLabel('Password').fill(PASSWORD)
  await appPage.getByRole('button', { name: 'Sign in' }).click()
  await appPage.waitForURL(/\/admin\/app$/)

  await appPage.goto('/admin/database/resources')
  await appPage.waitForURL(/\/admin\/app$/)
  await appContext.close()

  // --- An API-only user can't log into the portal. ---
  const apiContext = await browser.newContext()
  const apiPage = await apiContext.newPage()
  await apiPage.goto('/admin/login')
  await apiPage.getByLabel('Email').fill(API_EMAIL)
  await apiPage.getByLabel('Password').fill(PASSWORD)
  await apiPage.getByRole('button', { name: 'Sign in' }).click()
  await expect(apiPage.getByText('Invalid email or password.')).toBeVisible()
  await expect(apiPage).toHaveURL(/\/admin\/login/)
  await apiContext.close()

  for (const user of (await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')).filter(u => u.email === APP_EMAIL || u.email === API_EMAIL)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  }
  await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${appRole.id}`)
  await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${apiRole.id}`)
})
