import type { Page } from '@playwright/test'
import { adminSession, deleteDashboardsNamed, expect, resetSchema, test } from './fixtures.js'

/**
 * A report built through the editor's own screens, as an administrator
 * builds one: a dashboard created, a widget placed from the palette and
 * configured in its drawer (its Example run, its properties set), another
 * one's SQL typed in the editor, an SQL error shown where it was typed,
 * widgets duplicated and deleted, the dashboard published into the App,
 * previewed on a phone, and deleted.
 */
const NAME = 'V1 Dash Editor'

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await resetSchema(page, token)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDashboardsNamed(page, token, [NAME])
  await context.close()
})

const card = (page: Page, title: string) => page.locator('main .grid-stack div.rounded-lg.border').filter({ has: page.getByText(title, { exact: true }) })

/** Replaces the drawer's SQL - Monaco takes keystrokes, not fill(). */
async function typeSql(page: Page, sql: string) {
  // Monaco's textarea is hidden by design: its editor surface takes the click.
  await page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Run' }) }).locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.press('Delete')
  await page.keyboard.insertText(sql)
}

test('a report built, published and deleted through the editor', async ({ page, token: _ }) => {
  test.setTimeout(150_000)
  const main = page.locator('main')

  // --- Created ---
  await page.goto('/admin/dashboards')
  await expect(async () => {
    await page.getByRole('button', { name: 'New Dashboard' }).click()
    await page.getByRole('menuitem', { name: /^Blank/ }).click({ timeout: 2000 })
  }).toPass()
  const create = page.getByRole('dialog')
  await create.getByLabel('Name').fill(NAME)
  await create.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/admin\/dashboards\/[0-9a-f-]+$/)
  const editorUrl = page.url()

  // --- A KPI from the palette, configured in its drawer ---
  await main.getByRole('button', { name: 'KPI', exact: true }).click()
  await expect(card(page, 'KPI')).toContainText('Not configured')
  await card(page, 'KPI').getByRole('button', { name: 'Configure' }).click()
  // The widget's drawer - the dialog with its Run (a popover over it is a dialog too).
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Run' }) })
  // Its catalog Example, shown first, then used.
  await drawer.getByRole('button', { name: 'Example' }).click()
  await page.getByRole('button', { name: 'Use this query' }).click()
  await drawer.getByRole('button', { name: 'Run' }).click()
  await expect(drawer).toContainText(/1[.,]3K/)
  await drawer.getByRole('textbox', { name: 'Title' }).fill('Ventas')
  // Its Comparison role (D1): a number column of the query, picked by hand.
  await drawer.getByRole('combobox', { name: 'Comparison' }).or(drawer.getByRole('button', { name: 'Comparison' })).first().click()
  await page.getByRole('option', { name: /^previous/ }).click()
  await drawer.getByRole('switch', { name: 'Show change' }).click()
  await drawer.getByRole('button', { name: 'Save' }).click()
  await expect(drawer).toBeHidden()
  // 1250 vs 1100: +13.6%.
  await expect(card(page, 'Ventas')).toContainText(/1[.,]3K/)
  await expect(card(page, 'Ventas')).toContainText(/13[.,]6/)

  // --- A table whose SQL is typed; an SQL error shown in the drawer ---
  await main.getByRole('button', { name: 'Table', exact: true }).click()
  await card(page, 'Table').getByRole('button', { name: 'Configure' }).click()
  await typeSql(page, 'SELECT nombre FROM public.e2e_v1_nada')
  await drawer.getByRole('button', { name: 'Run' }).click()
  await expect(drawer).toContainText(/e2e_v1_nada|does not exist/)
  await typeSql(page, 'SELECT nombre, limite_credito FROM public.e2e_v1_clientes WHERE id IN (1, 2) ORDER BY nombre')
  await drawer.getByRole('button', { name: 'Run' }).click()
  await expect(drawer.getByRole('cell', { name: 'Acme SA' }).first()).toBeVisible()
  await drawer.getByRole('textbox', { name: 'Title' }).fill('Clientes')
  await drawer.getByRole('button', { name: 'Save' }).click()
  await expect(card(page, 'Clientes').getByRole('cell', { name: 'Beta SRL' })).toBeVisible()

  // --- Duplicated, then the copy deleted ---
  await card(page, 'Ventas').getByRole('button', { name: 'Widget actions' }).click()
  await page.getByRole('menuitem', { name: 'Duplicate' }).click()
  // The copy: its query and config, titled as a copy.
  // Placed below, run once in view.
  await card(page, 'Ventas (copy)').scrollIntoViewIfNeeded()
  await expect(card(page, 'Ventas (copy)')).toContainText(/1[.,]3K/)
  await card(page, 'Ventas (copy)').getByRole('button', { name: 'Widget actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  await page.getByRole('dialog').getByRole('checkbox', { name: 'Confirm' }).check()
  await page.getByRole('button', { name: /^Delete/ }).last().click()
  await expect(card(page, 'Ventas (copy)')).toHaveCount(0)
  await expect(card(page, 'Ventas')).toHaveCount(1)

  // --- Published into the App ---
  await main.getByRole('button', { name: 'Publish', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Publish', exact: true }).last().click()
  await expect(main.getByRole('button', { name: /Active: v1/ })).toBeVisible()
  const slug = NAME.toLowerCase().replace(/\s+/g, '-')
  await page.goto(`/admin/app/dashboards/${slug}`)
  await expect(card(page, 'Ventas')).toContainText(/1[.,]3K/)
  await expect(card(page, 'Clientes').getByRole('cell', { name: 'Acme SA' })).toBeVisible()

  // --- Phone preview: a KPI half a row, any other widget the whole row (Dashboards.md §7.2) ---
  await page.goto(editorUrl)
  await main.getByRole('button', { name: 'Phone' }).click()
  // Re-flowed (an animation): the table the phone canvas' width, the KPI half of it.
  const widths = async () => [(await card(page, 'Ventas').boundingBox())?.width ?? 0, (await card(page, 'Clientes').boundingBox())?.width ?? 0]
  await expect.poll(async () => { const [kpi, table] = await widths(); return Math.abs(table / 2 - kpi) }).toBeLessThan(12)
  const [, tableWidth] = await widths()
  expect(tableWidth).toBeLessThan(420)

  // --- Deleted ---
  await main.getByRole('button', { name: 'Actions', exact: true }).click()
  await page.getByRole('menuitem', { name: /Delete/ }).click()
  const confirm = page.getByRole('dialog').last()
  await confirm.getByRole('checkbox', { name: 'Confirm' }).check().catch(() => undefined)
  await confirm.getByRole('button', { name: /^Delete/ }).click()
  await page.goto(`/admin/app/dashboards/${slug}`)
  await expect(page.locator('main')).toContainText(/not found|not available|doesn't exist/i)
})

test('a variable defined in Settings › Variables appears in the bar, its options ready to pick', async ({ page, token }) => {
  const { createDashboard, deleteDashboardsNamed: drop } = await import('./fixtures.js')
  const VARS = 'V1 Dash Variables UI'
  await drop(page, token, [VARS])
  const dashboard = await createDashboard(page, token, VARS)
  try {
    // The ⚙ beside the variables bar opens Settings › Variables (D26).
    await page.goto(`/admin/dashboards/${dashboard.id}`)
    await page.locator('main').getByRole('button', { name: 'Edit variables' }).click()
    await page.waitForURL(/section=variables/)
    const dialog = page.locator('main')
    await dialog.getByRole('button', { name: 'Add variable' }).click()
    await dialog.getByRole('textbox', { name: 'Name' }).fill('estado')
    await dialog.getByRole('textbox', { name: 'Label' }).fill('Estado')
    // A Select, fixed values - its defaults.
    for (const [index, value] of ['PAID', 'CANCELLED'].entries()) {
      await dialog.getByRole('button', { name: 'Add option' }).click()
      await dialog.getByRole('textbox', { name: `Option ${index + 1}: value` }).fill(value)
    }
    await expect(dialog.locator('code')).toContainText('$VAR.estado')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()
    await dialog.getByRole('button', { name: 'Dashboard design' }).click()

    // In the bar, its options.
    await page.waitForURL(url => !url.pathname.endsWith('/settings'))
    const bar = page.locator('main').getByRole('button', { name: 'Estado' }).or(page.locator('main').getByRole('combobox', { name: 'Estado' })).first()
    // The canvas just mounted: clicked again until its options open.
    await expect(async () => {
      await bar.click()
      await expect(page.getByRole('option', { name: 'CANCELLED' })).toBeVisible({ timeout: 2000 })
    }).toPass()
    await expect(page.getByRole('option', { name: 'PAID' })).toBeVisible()
  } finally {
    await drop(page, token, [VARS])
  }
})
