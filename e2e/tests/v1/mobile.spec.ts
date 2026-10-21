import type { Page } from '@playwright/test'
import { addWidget, adminSession, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * The App on a phone (AGENTS.md section 25, "Phone, tablet, desktop"): the
 * compact shell, a grid that never scrolls the page sideways, its record form
 * working with a finger, a CUSTOM page laid out in one column.
 */
const TABLE = 'V1 Movil Tabla'
const PAGE = 'V1 Movil Pagina'
let table: DataViewRef
let custom: DataViewRef

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [TABLE, PAGE])
  await resetSchema(page, token)
  table = await createDataView(page, token, { name: TABLE, viewType: 'TABLE', sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'), selectedColumns: ['nombre', 'email', 'categoria', 'limite_credito', 'fecha_alta'] })
  await publish(page, token, table.id)
  custom = await createDataView(page, token, { name: PAGE, viewType: 'CUSTOM' })
  const card = await addWidget(page, token, custom.id, 'UCard', { props: { title: 'Resumen' } })
  await addWidget(page, token, custom.id, 'TText', { props: { label: 'Dentro de la tarjeta' }, slot: 'default' }, { parent: card.id })
  await addWidget(page, token, custom.id, 'UButton', { props: { label: 'Una acción', block: true } })
  await publish(page, token, custom.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [TABLE, PAGE])
  await context.close()
})

/** The page never scrolls sideways - only a grid's own box may. */
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)

test('a grid on a phone: its rows, no sideways page scroll, a record form to edit with a finger', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${table.slug}`)
  const main = page.locator('main')
  await expect(main.locator('tbody tr').filter({ hasText: 'Acme SA' })).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)

  await main.locator('tbody tr').filter({ hasText: 'Beta SRL' }).tap()
  const form = page.getByRole('dialog')
  const email = form.getByRole('textbox', { name: 'Email' })
  await expect(email).toHaveValue('info@beta.test')
  // Fits the phone: its Save and Cancel within the screen.
  const save = form.getByRole('button', { name: 'Save', exact: true })
  // Polled: measured while the modal is still sliding in, it sits off to one side.
  await expect.poll(async () => {
    const box = await save.boundingBox()
    return !!box && box.x >= 0 && box.x + box.width <= 390
  }).toBe(true)
  await email.fill('movil@beta.test')
  await save.tap()
  await expect(form).toBeHidden()
  await expect(main.locator('tbody tr').filter({ hasText: 'Beta SRL' })).toContainText('movil@beta.test')
  expect(await noSidewaysScroll(page)).toBe(true)
})

test('the App shell on a phone: a header and a menu that slides over, never a rail', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${table.slug}`)
  await expect(page.locator('main tbody tr').first()).toBeVisible()
  await page.getByRole('button', { name: /menu|navigation/i }).first().tap()
  await expect(page.getByRole('link', { name: TABLE })).toBeVisible()
})

test('a CUSTOM page on a phone: one column, its widgets full width', async ({ page, token: _ }) => {
  await page.goto(`/admin/app/dataviews/${custom.slug}`)
  const main = page.locator('main')
  await expect(main.getByText('Dentro de la tarjeta')).toBeVisible()
  expect(await noSidewaysScroll(page)).toBe(true)
  const button = await main.getByRole('button', { name: 'Una acción' }).boundingBox()
  expect(button!.width).toBeGreaterThan(300)
})
