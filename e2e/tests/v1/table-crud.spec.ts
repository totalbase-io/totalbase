import type { Page } from '@playwright/test'
import { adminSession, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * A customers TABLE as any system has one: search, sort, pages; create,
 * edit and delete through its record form; PostgreSQL's NOT NULL, UNIQUE,
 * CHECK and foreign keys deciding what saves, shown where they apply; unsaved
 * edits never dropped without asking.
 */
const NAME = 'V1 Clientes'
let dataview: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await resetSchema(page, token)
  // A customer with orders: deleting it is PostgreSQL's foreign key to refuse.
  dataview = await createDataView(page, token, {
    name: NAME,
    viewType: 'TABLE',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'),
    selectedColumns: ['nombre', 'email', 'categoria', 'activo', 'limite_credito', 'fecha_alta']
  })
  await publish(page, token, dataview.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME])
  await context.close()
})

async function openGrid(page: Page) {
  await page.goto(`/app/dataviews/${dataview.slug}`)
  const main = page.locator('main')
  await expect(main.locator('tbody tr').first()).toBeVisible()
  return main
}
const row = (page: Page, text: string) => page.locator('main tbody tr').filter({ hasText: text })

test('search narrows the rows on the server, and clearing it brings them back', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('acme')
  await expect(main.locator('tbody tr')).toHaveCount(1)
  await expect(row(page, 'Acme SA')).toBeVisible()
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('')
  await expect(main.locator('tbody tr')).not.toHaveCount(1)
})

test('a header sorts its column, both ways', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  const first = () => main.locator('tbody tr').first()
  await main.getByRole('button', { name: 'Nombre', exact: true }).click()
  await expect(first()).toContainText('Acme SA')
  await main.getByRole('button', { name: 'Nombre', exact: true }).click()
  await expect(first()).toContainText('Gamma Coop')
})

test('thirty customers come in pages', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await expect(main.getByText(/of 30/)).toBeVisible()
})

test('a new customer saves with PostgreSQL\'s defaults, its category picked from its table', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('button', { name: 'New' }).click()
  const form = page.getByRole('dialog')
  await form.getByRole('textbox', { name: 'Nombre*' }).fill('Zeta SA')
  await form.getByRole('textbox', { name: 'Email' }).fill('zeta@e2e.test')
  await form.locator('button[aria-haspopup="listbox"]').click()
  await page.getByRole('option', { name: 'Minorista' }).click()
  // Its list closes before the next field is typed in - as a person's hand would wait.
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await form.getByRole('spinbutton', { name: 'Limite Credito' }).fill('1500')
  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toBeHidden()
  await main.getByRole('textbox', { name: 'Search', exact: true }).fill('zeta')
  await expect(row(page, 'Zeta SA')).toContainText('Minorista')
  await expect(row(page, 'Zeta SA')).toContainText(/1[.,]500/)
})

test('PostgreSQL decides what saves: NOT NULL, UNIQUE and CHECK, each shown on its field', async ({ page, token: _ }) => {
  const main = await openGrid(page)
  await main.getByRole('button', { name: 'New' }).click()
  const form = page.getByRole('dialog')
  const save = form.getByRole('button', { name: 'Save', exact: true })

  // NOT NULL: required before it's sent.
  await save.click()
  await expect(form.getByText('Required')).toBeVisible()

  // UNIQUE: an email another customer has - on its field; with no message of its own, a plain sentence (T65).
  await form.getByRole('textbox', { name: 'Nombre*' }).fill('Duplicado')
  await form.getByRole('textbox', { name: 'Email' }).fill('compras@acme.test')
  await save.click()
  await expect(form.getByRole('textbox', { name: 'Email' })).toHaveAttribute('aria-invalid', 'true')
  await expect(form).toContainText('That value is already used by another record.')

  // A CHECK the form reads (limite_credito >= 0): a negative is flagged on its field, nothing sent.
  await form.getByRole('textbox', { name: 'Email' }).fill('otro@e2e.test')
  const limite = form.getByRole('spinbutton', { name: 'Limite Credito' })
  await limite.fill('-5')
  await save.click()
  await expect(limite).toHaveAttribute('aria-invalid', 'true')
  await limite.fill('5')

  // A CHECK only PostgreSQL decides: refused, its message shown, the form kept.
  await form.getByRole('textbox', { name: 'Nombre*' }).fill('Prohibido')
  await save.click()
  // With no message of its own, a plain sentence (T65) - on the field PostgreSQL names.
  await expect(form).toContainText('A value isn\'t allowed - check the highlighted fields.')
  await expect(form).toBeVisible()
  await form.getByRole('button', { name: 'Cancel' }).click()
})

test('editing a customer saves the change; closing with unsaved edits asks first', async ({ page, token: _ }) => {
  await openGrid(page)
  await row(page, 'Beta SRL').click()
  const form = page.getByRole('dialog')
  const limite = form.getByRole('spinbutton', { name: 'Limite Credito' })
  await expect(limite).toBeVisible()

  // An unsaved edit: closing asks; keeping it leaves the form as it was.
  await limite.fill('130000')
  await form.getByRole('button', { name: 'Close' }).click()
  const ask = page.getByRole('alertdialog').or(page.getByRole('dialog').filter({ hasText: /discard|unsaved/i }))
  await expect(ask.first()).toBeVisible()
  await ask.first().getByRole('button', { name: /keep|cancel|continue editing/i }).first().click()
  await expect(limite).toHaveValue(/130/)

  await form.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(form).toBeHidden()
  await expect(row(page, 'Beta SRL')).toContainText(/130[.,]000/)
})

test('deleting: a customer goes; one with orders stays - its foreign key says why', async ({ page, token: _ }) => {
  await openGrid(page)
  const remove = async (name: string) => {
    await row(page, name).getByRole('button', { name: 'Record actions' }).click()
    await page.getByRole('menuitem', { name: /Delete/ }).click()
    await page.getByRole('button', { name: /^Delete/ }).last().click()
  }
  await remove('Gamma Coop')
  await expect(row(page, 'Gamma Coop')).toHaveCount(0)

  await remove('Acme SA')
  await expect(page.getByText(/referenced|foreign|still|in use|other records use it|pedidos/i).first()).toBeVisible()
  await expect(row(page, 'Acme SA')).toHaveCount(1)
})
