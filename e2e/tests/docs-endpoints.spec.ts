import { expect, test } from '@playwright/test'
import { login } from './helpers.js'

const SHOTS = process.env.E2E_SHOTS_DIR

/**
 * Docs > Endpoints (Specification_Admin_UI.md §12): the whole HTTP
 * surface - resources, workflows and fixed routes -, filtered and searched,
 * a row's cURL with an example body, and "Open in API docs" landing on the
 * route in the Data API document.
 */
test('endpoints list every route and open one in the API docs', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  await login(page)
  await page.goto('/admin/docs/endpoints')
  await expect(page.getByRole('heading', { name: 'Endpoints' })).toBeVisible()

  await page.getByRole('combobox', { name: 'Type' }).click()
  await page.getByRole('option', { name: 'System' }).click()
  await page.getByRole('textbox', { name: 'Search' }).fill('auth/login')
  const row = page.getByRole('row').filter({ hasText: '/api/auth/login' })
  await expect(row).toBeVisible()
  await expect(row.getByText('Public')).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/endpoints.png`, fullPage: true })

  await row.getByRole('button', { name: 'Endpoint actions' }).click()
  await page.getByRole('menuitem', { name: 'Copy cURL' }).click()
  await expect(page.getByText('cURL copied', { exact: true })).toBeVisible()
  const curl = await page.evaluate(() => navigator.clipboard.readText())
  expect(curl).toContain('curl -X POST')
  expect(curl).toContain('/api/auth/login')
  expect(curl).not.toContain('Authorization')
  expect(curl).toContain('"email"')

  await row.getByRole('button', { name: 'Endpoint actions' }).click()
  await page.getByRole('menuitem', { name: 'Open in API docs' }).click()
  await page.waitForURL(/\/admin\/docs\/openapi\?/)
  await expect(page.getByText(/paths visible to Administrators/)).toBeVisible()
  // Scrolled to the route: its key is in view.
  await expect(page.locator('.monaco-editor .view-line', { hasText: '"/api/auth/login": {' })).toBeVisible()
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/openapi.png`, fullPage: true })
})
