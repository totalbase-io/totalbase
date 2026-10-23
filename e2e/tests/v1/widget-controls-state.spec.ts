import type { Page } from '@playwright/test'
import { addWidget, adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test } from './fixtures.js'

/**
 * Another widget's state in a formula (DataViews.md §9.1),
 * as WaveMaker binds to `Widgets.x.selecteditem`: a customer
 * select and, beside it, an input showing the chosen customer's email -
 * `{{controls.selectCliente.item.email}}`, a computed input, read
 * only - with no Code and no extra query. A Table's last row clicked, and
 * Code reading the same state.
 */
const NAME = 'V1 Controls State'
const SLUG = 'v1-controls-state'

const CODE = `
async function onElegirDelta(dataview) {
  dataview.vars.cliente.set(4)
}
async function onLeer(dataview) {
  dataview.notify('Code: ' + dataview.controls.selectCliente.item.nombre)
}
`

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

async function setUp(page: Page, token: string) {
  await deleteDataViewsNamed(page, token, [NAME])
  const dataview = await createDataView(page, token, {
    name: NAME,
    slug: SLUG,
    viewType: 'CUSTOM',
    viewConfig: {
      variables: [
        { kind: 'VALUE', name: 'cliente', type: 'number', default: { value: null, source: 'constant' } },
        {
          kind: 'RESOURCE', name: 'clientes', mode: 'list', resource: await resourceId(page, token, 'e2e_v1_clientes'), immediate: true, watch: false, count: false,
          query: { fields: 'id,nombre,email', order_by: 'nombre', limit: 100 }
        }
      ]
    }
  })
  await api(page, token, 'POST', `/admin/api/dataviews/${dataview.id}/code`, { data: { code: CODE } })
  const add = (widget: string, label: string | undefined, config: Record<string, unknown>) => addWidget(page, token, dataview.id, widget, config, { label })
  const variable = (v: string) => ({ kind: 'variable', variable: v })
  const formula = (f: string) => ({ kind: 'formula', formula: f })

  await add('USelectMenu', 'selectCliente', {
    props: { valueKey: 'id', labelKey: 'nombre' },
    bindings: { modelValue: variable('cliente'), items: variable('clientes') }
  })
  await add('UInput', undefined, {
    props: { htmlAttrs: { 'aria-label': 'Email' } },
    bindings: { modelValue: formula('{{controls.selectCliente.item.email}}') }
  })
  await add('UButton', undefined, { props: { label: 'Elegir Delta' }, emits: { click: 'onElegirDelta' } })
  await add('UButton', undefined, { props: { label: 'Leer' }, emits: { click: 'onLeer' } })
  await add('UTable', 'tabla', { bindings: { data: variable('clientes') } })
  await add('TText', undefined, { bindings: { label: formula('"Fila: " + {{controls.tabla.row.nombre}}') } })
  await publish(page, token, dataview.id)
  return dataview.id
}

test('an input shows the chosen customer\'s email - another widget\'s state, no Code', async ({ page, token }) => {
  test.setTimeout(120_000)
  const id = await setUp(page, token)
  try {
    await page.goto(`/app/dataviews/${SLUG}`)
    const main = page.locator('main')
    const email = main.getByRole('textbox', { name: 'Email' })
    await expect(email).toBeVisible()
    // Nothing chosen: nothing to show - and it's read only, written nowhere.
    await expect(email).toHaveValue('')
    await expect(email).toHaveAttribute('readonly', '')

    // Choosing a customer in the select shows its email.
    await main.locator('button[aria-haspopup="listbox"]').click()
    await page.getByRole('option', { name: 'Acme SA' }).click()
    await expect(email).toHaveValue('compras@acme.test')

    // The value set from Code: the item follows - derived, never stored.
    await main.getByRole('button', { name: 'Elegir Delta' }).click()
    await expect(email).toHaveValue('delta@delta.test')

    // Code reads the same state.
    await main.getByRole('button', { name: 'Leer' }).click()
    await expect(page.getByText('Code: Delta y Asociados', { exact: true })).toBeVisible()

    // A Table's last row clicked.
    await expect(main.getByText('Fila: ', { exact: true })).toBeVisible()
    await main.locator('table tbody tr').filter({ hasText: 'Beta SRL' }).click()
    await expect(main.getByText('Fila: Beta SRL', { exact: true })).toBeVisible()
  } finally {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${id}`)
  }
})

test('the Design form binds an input\'s Value to a formula', async ({ page, token }) => {
  test.setTimeout(120_000)
  const id = await setUp(page, token)
  try {
    const fields = await api<{ id: string, widget: string | null }[]>(page, token, 'GET', `/admin/api/dataviews/${id}/fields`)
    await page.goto(`/dataviews/${id}/design`)
    const main = page.locator('main')
    await main.locator(`[data-canvas-item="${fields.find(f => f.widget === 'UInput')!.id}"]`).dispatchEvent('click')
    // Its Value: no variable, a formula - shown under it, its button bound.
    await expect(main.getByRole('button', { name: 'Bind Value - computed, read only' })).toBeVisible()
    await expect(main.getByText('= {{controls.selectCliente.item.email}}')).toBeVisible()
  } finally {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${id}`)
  }
})
