import { adminSession, deleteDataViewsNamed, expect, resetSchema, test } from './fixtures.js'

/**
 * A DataView's life through the admin's own screens, as an administrator
 * lives it: created with the wizard, a draft until published, published
 * into the App, changed (an unpublished change the App doesn't see), its
 * versions listed and an earlier one restored, and deleted.
 */
const NAME = 'V1 Ciclo'

/** Publish from the header: its button opens a short confirmation (a note), whose own Publish publishes. */
async function publishFromHeader(page: import('@playwright/test').Page) {
  const header = page.locator('main').getByRole('button', { name: 'Publish', exact: true }).first()
  await header.click()
  await expect(header).toHaveAttribute('aria-expanded', 'true')
  await page.getByRole('dialog').filter({ hasNot: page.locator('main') }).getByRole('button', { name: 'Publish', exact: true }).last().click()
}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

test('created with the wizard, published, changed, restored and deleted - all through its screens', async ({ page, token: _ }) => {
  test.setTimeout(150_000)

  // --- The wizard ---
  await page.goto('/admin/dataviews')
  await page.getByRole('button', { name: 'New DataView' }).first().click()
  const wizard = page.getByRole('dialog', { name: 'New DataView' })
  await wizard.getByRole('button', { name: /^Table A sortable/ }).click()
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByLabel('Name').fill(NAME)
  await wizard.getByRole('button', { name: 'Next' }).click()
  await wizard.getByRole('button', { name: 'Table or view', exact: true }).click()
  await page.getByRole('option', { name: /e2e_v1_clientes$/ }).click()
  // Columns and the features steps: their defaults - Next until it can Create.
  for (let step = 0; step < 6 && !(await wizard.getByRole('button', { name: 'Create' }).isVisible()); step++) {
    await wizard.getByRole('button', { name: 'Next' }).click()
  }
  await wizard.getByRole('button', { name: 'Create' }).click()
  await expect(page.getByText('DataView created').first()).toBeVisible()

  // --- A draft until published: not in the App yet ---
  await page.waitForURL(/\/admin\/dataviews\/[0-9a-f-]+/)
  const settingsUrl = page.url()
  // The grid's Search is in Actions, with the toolbar's other features (DataViews.md §3.6).
  const actionsUrl = `/admin/dataviews/${settingsUrl.match(/\/admin\/dataviews\/([0-9a-f-]+)/)![1]}/settings?section=actions`
  const main = page.locator('main')
  await expect(main.getByRole('button', { name: /^Draft/ })).toBeVisible()
  await publishFromHeader(page)
  await expect(main.getByRole('button', { name: /Active: v1/ })).toBeVisible()

  await page.goto('/admin/app/dataviews/v1-ciclo')
  await expect(page.locator('main tbody tr').filter({ hasText: 'Acme SA' })).toBeVisible()
  await expect(page.locator('main').getByRole('heading', { name: NAME })).toBeVisible()

  // --- A rename: identity isn't versioned - live in the App at once, nothing left to publish ---
  await page.goto(settingsUrl)
  const status = () => main.ariaSnapshot().then(tree => tree.split('\n').slice(0, 12).join('\n'))
  await main.getByRole('textbox', { name: 'Name*' }).fill(`${NAME} 2`)
  await main.getByRole('textbox', { name: 'Name*' }).blur()
  await expect.poll(status).toContain('Saved')
  expect(await status()).not.toContain('Unpublished changes')
  await page.goto('/admin/app/dataviews/v1-ciclo')
  await expect(page.locator('main').getByRole('heading', { name: `${NAME} 2` })).toBeVisible()

  // --- A versioned change (the grid's Search off): a draft until published ---
  await page.goto(actionsUrl)
  await main.getByRole('switch', { name: 'Search', exact: true }).click()
  await expect.poll(status).toContain('Unpublished changes')
  await page.goto('/admin/app/dataviews/v1-ciclo')
  await expect(page.locator('main').getByRole('textbox', { name: 'Search', exact: true })).toBeVisible()
  await page.goto(settingsUrl)
  await publishFromHeader(page)
  await expect.poll(status).not.toContain('Unpublished changes')
  await page.goto('/admin/app/dataviews/v1-ciclo')
  await expect(page.locator('main tbody tr').first()).toBeVisible()
  await expect(page.locator('main').getByRole('textbox', { name: 'Search', exact: true })).toHaveCount(0)

  // --- Versions: version 1 restored - its Search back in the draft ---
  await page.goto(settingsUrl)
  await main.getByRole('button', { name: /^Draft/ }).click()
  await page.getByRole('menuitemcheckbox', { name: /^v1 / }).click()
  await expect(main.getByText(/read-only/).first()).toBeVisible()
  await main.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(page.getByText('Restored v1 into the draft', { exact: true })).toBeVisible()
  await page.goto(actionsUrl)
  await expect(main.getByRole('switch', { name: 'Search', exact: true })).toBeChecked()
  await expect.poll(status).toContain('Unpublished changes')

  // --- Deleted ---
  await main.getByRole('button', { name: /More|Actions/ }).last().click()
  await page.getByRole('menuitem', { name: /Delete/ }).click()
  const confirm = page.getByRole('dialog').last()
  await confirm.getByRole('checkbox', { name: 'Confirm' }).check().catch(() => undefined)
  await confirm.getByRole('button', { name: /^Delete/ }).click()
  await page.goto('/admin/app/dataviews/v1-ciclo')
  await expect(page.locator('main tbody tr')).toHaveCount(0)
})
