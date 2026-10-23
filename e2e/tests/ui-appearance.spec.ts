import { expect as baseExpect, test, type Page } from '@playwright/test'
import { login, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Settings > Appearance (Admin_UI.md §4.1.1, §3.6), through
 * the real UI: a primary color, the sign-in layout and custom CSS saved
 * from the page, then seen on the sign-in page itself - and `?safe-css`
 * loading without the sheet. The API only reads back and cleans up.
 */

const expect = baseExpect.configure({ timeout: 15_000 })
test.describe.configure({ timeout: 120_000 })

const BASE = BASE_URL
const SAVE = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })

async function api<T = unknown>(page: Page, token: string, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined && { data: { data } })
  })
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text).data : undefined) as T
}

const primary500 = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ui-color-primary-500').trim())

test('appearance: color, sign-in layout and custom CSS saved from the page reach the sign-in page; safe-css drops the sheet', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const read = () => api<Record<string, unknown>>(page, token, 'GET', '/admin/api/settings/appearance')
  const original = await read()
  const CSS = ':root { --ui-radius: 0px }\nhtml[data-surface="auth"] { --totalbase-e2e: on }'

  try {
    await page.goto('/settings/appearance')
    await expect(page.getByRole('heading', { name: 'Appearance' })).toBeVisible()
    // Tailwind's own blue is an oklch() too: the test tells the shades apart by value.
    const defaultPrimary = await primary500(page)

    // The color: a preset. Preview applies it to this window before any save.
    const colorRow = page.locator('#setting-appearance-primary_color')
    await colorRow.getByRole('button', { name: '#0f766e' }).click()
    await expect(colorRow.getByText('Unsaved')).toBeVisible()
    await page.getByRole('button', { name: 'Preview' }).click()
    await expect.poll(() => primary500(page)).not.toBe(defaultPrimary)
    await page.getByRole('button', { name: 'Stop preview' }).click()
    await expect.poll(() => primary500(page)).toBe(defaultPrimary)

    // The sign-in layout: an option card.
    await page.locator('#setting-appearance-login_layout').getByText('Simple', { exact: true }).click()

    // Custom CSS: Monaco. Click into it and type.
    const cssRow = page.locator('#setting-appearance-custom_css')
    await cssRow.locator('.monaco-editor').click()
    await page.keyboard.press('ControlOrMeta+A')
    await page.keyboard.insertText(CSS)

    await SAVE(page).click()
    await expect(page.getByText('3 settings saved', { exact: true })).toBeVisible()
    const saved = await read()
    expect(saved['appearance.primary_color']).toBe('#0f766e')
    expect(saved['appearance.login_layout']).toBe('SIMPLE')
    expect(saved['appearance.custom_css']).toContain('--totalbase-e2e: on')

    // The sheet itself, as the browser gets it.
    const sheet = await page.request.get(`${BASE}/theme.css`)
    expect(await sheet.text()).toContain('--ui-color-primary-500: oklch(')
    expect(await sheet.text()).toContain('--totalbase-e2e: on')

    // Seen on the sign-in page, with no session.
    await page.evaluate(() => localStorage.removeItem('totalbase_admin_token'))
    await page.goto('/login')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-surface', 'auth')
    await expect(page.locator('[data-login-layout="SIMPLE"]')).toBeVisible()
    await expect(page.getByText('POSTGRESQL. EXPOSED.')).toHaveCount(0)
    expect(await primary500(page)).not.toBe(defaultPrimary)
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--totalbase-e2e').trim())).toBe('on')

    // Safe mode: the same page without the sheet.
    await page.goto('/login?safe-css')
    await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
    await expect(page.locator('#totalbase-theme')).toHaveCount(0)
    expect(await primary500(page)).toBe(defaultPrimary)
  } finally {
    for (const key of ['primary_color', 'login_layout', 'custom_css']) {
      const value = original[`appearance.${key}`]
      await api(page, token, 'PATCH', '/admin/api/settings/appearance', { [key]: value })
    }
  }
  expect(failures).toEqual([])
})
