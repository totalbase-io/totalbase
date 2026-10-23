import type { Page } from '@playwright/test'
import { addWidget, adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * The widget catalog's binding review (DataViews.md §9.2,
 * 2026-10-02): a CUSTOM page with one widget per change, run
 * live in the App and checked in the Design form's inspector.
 *
 * - formulas on a Badge's Variant and a Button's Trailing icon;
 * - an option list's Label, Icon and Disabled field per option;
 * - Tabs' items (label, Disabled, Visible by formula) and Open tab ↔ a Value;
 * - a Dropdown menu's items running their Code function, off or hidden by formula;
 * - a Table's computed column, Color per row, Row color and actions per row;
 * - a User's Image, an embedded DataView's Read only, a Pattern message formula.
 *
 * Over the e2e_v1 rows: categories as the option list, order items as the
 * Table's rows, a customers TABLE as the embedded DataView.
 */
const NAME = 'V1 Bindings'
const SLUG = 'v1-bindings'
const CUSTOMERS = 'V1 Bindings Clientes'
const DETAIL = 'V1 Bindings Items'
const READ_ONLY = 'V1 Detail Read Only'
let customers: DataViewRef
let detail: DataViewRef
/** An image that loads offline - a remote one would fall back to the initials. */
const AVATAR = 'data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%274%27 height=%274%27%3E%3Crect width=%274%27 height=%274%27 fill=%27teal%27/%3E%3C/svg%3E'

const CODE = `
async function onIrPagos(dataview) {
  dataview.vars.tab.set('pagos')
}
async function onAnular(dataview, event) {
  dataview.notify('Picked ' + event.item.value)
}
async function onBorrar(dataview, event) {
  dataview.notify('Picked ' + event.item.value)
}
async function onAction(dataview, event) {
  dataview.notify('Action ' + event.action + ' on ' + event.row.descripcion)
}
async function onSubmit(dataview) {
  dataview.notify('Submitted')
}
`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME, READ_ONLY, CUSTOMERS, DETAIL])
  await resetSchema(page, token)
  customers = await createDataView(page, token, {
    name: CUSTOMERS,
    viewType: 'TABLE',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'),
    selectedColumns: ['nombre', 'email', 'categoria']
  })
  detail = await createDataView(page, token, {
    name: DETAIL,
    viewType: 'TABLE',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_pedidos_items'),
    selectedColumns: ['pedido', 'descripcion', 'cantidad', 'precio', 'importe']
  })
  await publish(page, token, customers.id)
  await publish(page, token, detail.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [NAME, READ_ONLY, CUSTOMERS, DETAIL])
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
        { kind: 'VALUE', name: 'flag', type: 'boolean', default: { value: false, source: 'constant' } },
        { kind: 'VALUE', name: 'n', type: 'number', default: { value: 3, source: 'constant' } },
        { kind: 'VALUE', name: 'tab', type: 'text', default: { value: null, source: 'constant' } },
        { kind: 'VALUE', name: 'cond', type: 'number', default: { value: null, source: 'constant' } },
        { kind: 'VALUE', name: 'codigoForm', type: 'text', default: { value: null, source: 'constant' } },
        {
          kind: 'RESOURCE', name: 'categorias', mode: 'list', resource: await resourceId(page, token, 'e2e_v1_categorias'), immediate: true, watch: false, count: false,
          query: { fields: 'id,nombre,color', order_by: 'id', limit: 100 }
        },
        {
          kind: 'RESOURCE', name: 'items', mode: 'list', resource: await resourceId(page, token, 'e2e_v1_pedidos_items'), immediate: true, watch: false, count: false,
          query: { fields: 'id,descripcion,precio', order_by: 'id', limit: 5 }
        }
      ]
    }
  })
  await api(page, token, 'POST', `/admin/api/dataviews/${dataview.id}/code`, { data: { code: CODE } })

  const add = (widget: string, config: Record<string, unknown>, label?: string, parent?: string) =>
    addWidget(page, token, dataview.id, widget, config, { label, parent })
  const formula = (f: string) => ({ kind: 'formula', formula: f })
  const variable = (v: string) => ({ kind: 'variable', variable: v })

  await add('USwitch', { props: { label: 'Flag' }, bindings: { modelValue: variable('flag') } })
  await add('UBadge', { props: { label: 'Estado', color: 'error' }, bindings: { variant: formula('{{vars.flag.value}} ? "solid" : "outline"') } })
  await add('UButton', { props: { label: 'Trailing' }, bindings: { trailingIcon: formula('{{vars.flag.value}} ? "i-lucide-check" : "i-lucide-x"') } })
  await add('USelectMenu', {
    props: { valueKey: 'id', labelKey: 'nombre' },
    bindings: {
      modelValue: variable('cond'),
      items: variable('categorias'),
      labelKey: formula('{{nombre}} + " #" + {{id}}'),
      // An icon per option, from its row: the categories carry a color, not an icon.
      iconKey: formula('{{color}} == "blue" ? "i-lucide-banknote" : "i-lucide-tag"'),
      disabledKey: formula('{{id}} == 2')
    }
  }, 'condicion')

  const tabs = await add('UTabs', {
    props: {
      items: [
        { value: 'general', label: 'General' },
        { value: 'pagos', label: 'Pagos', formulas: { label: '"Pagos (" + {{vars.n.value}} + ")"' } },
        { value: 'secreto', label: 'Secreto', formulas: { visible: '{{vars.flag.value}}' } },
        { value: 'bloqueado', label: 'Bloqueado', formulas: { disabled: '!{{vars.flag.value}}' } }
      ]
    },
    bindings: { modelValue: variable('tab') }
  })
  await add('TText', { props: { label: 'Contenido de pagos', slot: undefined }, slot: 'content:pagos' }, undefined, tabs.id)
  await add('TText', { props: { label: 'Contenido general' }, slot: 'content:general' }, undefined, tabs.id)
  await add('UButton', { props: { label: 'Ir a pagos' }, emits: { click: 'onIrPagos' } })

  const menu = await add('UDropdownMenu', {
    props: {
      items: [
        { value: 'anular', label: 'Anular', color: 'error', onSelect: 'onAnular', formulas: { disabled: '{{vars.flag.value}}' } },
        { value: 'borrar', label: 'Borrar', onSelect: 'onBorrar', formulas: { visible: '{{vars.flag.value}}' } }
      ]
    }
  })
  await add('UButton', { props: { label: 'Menu' }, slot: 'default' }, undefined, menu.id)

  await add('UTable', {
    props: {
      computedColumns: [{ key: 'doble', label: 'Doble', type: 'number', formula: '{{precio}} * 2' }],
      columnSettings: { precio: { colorFormula: '{{precio}} < 1200 ? "red" : ""' }, id: { hidden: true } },
      actions: [
        { name: 'ver', icon: 'i-lucide-eye', label: 'Ver', formulas: { disabled: '{{descripcion}} == "Cable 10 m"' } },
        { name: 'quitar', icon: 'i-lucide-trash', label: 'Quitar', formulas: { visible: '{{vars.flag.value}}' } }
      ]
    },
    bindings: { data: variable('items'), rowColorKey: formula('{{precio}} > 2000 ? "amber" : ""') },
    emits: { action: 'onAction' }
  })

  await add('UUser', { props: { name: 'Ana Pérez', description: 'Cliente' }, bindings: { avatar: formula(`"${AVATAR}"`) } })
  await add('TDataView', { props: { dataview: customers.id }, bindings: { readOnly: formula('{{vars.flag.value}}') } })

  const form = await add('UForm', { emits: { submit: 'onSubmit' } })
  const field = await add('UFormField', {
    props: { label: 'Codigo', pattern: '[0-9]{3}' },
    bindings: { patternMessage: formula('"Tres digitos, n=" + {{vars.n.value}}') },
    slot: 'default'
  }, undefined, form.id)
  await add('UInput', { bindings: { modelValue: variable('codigoForm') }, slot: 'default' }, undefined, field.id)
  await add('UButton', { props: { label: 'Enviar', type: 'submit' }, slot: 'default' }, undefined, form.id)

  await publish(page, token, dataview.id)
  return dataview.id
}

test('a CUSTOM page runs every binding of the review', async ({ page, token }) => {
  test.setTimeout(120_000)
  const id = await setUp(page, token)
  try {
    await page.goto(`/app/dataviews/${SLUG}`)
    const main = page.locator('main')
    const flag = main.getByRole('switch', { name: 'Flag' })
    await expect(flag).toBeVisible()

    // Pattern message by formula.
    await main.getByRole('textbox', { name: 'Codigo' }).fill('12')
    await main.getByRole('button', { name: 'Enviar' }).click()
    await expect(main.getByText('Tres digitos, n=3')).toBeVisible()

    // Variant and Trailing icon follow the page.
    const badge = main.getByText('Estado', { exact: true }).locator('..')
    const trailing = main.getByRole('button', { name: 'Trailing' })
    const badgeOff = await badge.getAttribute('class')
    await expect(trailing.locator('.iconify.i-lucide\\:x, [class*="i-lucide:x"]')).toHaveCount(1)

    // Tabs: a label by formula, a hidden tab, a disabled one; Open tab ↔ its Value.
    await expect(main.getByRole('tab', { name: 'Pagos (3)' })).toBeVisible()
    await expect(main.getByRole('tab', { name: 'Secreto' })).toHaveCount(0)
    await expect(main.getByRole('tab', { name: 'Bloqueado' })).toBeDisabled()
    await expect(main.getByText('Contenido general')).toBeVisible()
    await main.getByRole('button', { name: 'Ir a pagos' }).click()
    await expect(main.getByRole('tab', { name: 'Pagos (3)' })).toHaveAttribute('aria-selected', 'true')
    await expect(main.getByText('Contenido de pagos')).toBeVisible()

    // Table: computed column, Color per row, Row color, actions per row.
    const table = main.locator('table').first()
    await expect(table.getByRole('columnheader', { name: 'Doble' })).toBeVisible()
    // Cable 10 m (2200): over 2000, its row amber, Ver off; Arandelas x100 (800): its price red.
    const ace = table.getByRole('row').filter({ hasText: 'Cable 10 m' })
    const azu = table.getByRole('row').filter({ hasText: 'Arandelas x100' })
    await expect(ace).toContainText(/4[.,]400/)
    expect(await ace.getAttribute('style')).toContain('color-mix')
    expect((await azu.getAttribute('style')) ?? '').not.toContain('color-mix')
    await expect(azu.locator('span[style*="color"]', { hasText: '800' })).toHaveCount(1)
    await expect(ace.getByRole('button', { name: 'Ver' })).toBeDisabled()
    await expect(azu.getByRole('button', { name: 'Ver' })).toBeEnabled()
    await expect(table.getByRole('button', { name: 'Quitar' })).toHaveCount(0)
    await azu.getByRole('button', { name: 'Ver' }).click()
    await expect(page.getByText('Action ver on Arandelas x100', { exact: true })).toBeVisible()

    // User's Image.
    await expect(main.locator(`img[src="${AVATAR}"]`)).toHaveCount(1)

    // Embedded DataView: writable while flag is off.
    const embedNew = main.getByRole('button', { name: /^New/ })
    await expect(embedNew.first()).toBeVisible()

    // Dropdown menu: Anular runs its function, Borrar hidden.
    await main.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('menuitem', { name: 'Borrar' })).toHaveCount(0)
    await page.getByRole('menuitem', { name: 'Anular' }).click()
    await expect(page.getByText('Picked anular', { exact: true })).toBeVisible()

    // Select menu: label formula, icon per option, one option off.
    await main.locator('button[aria-haspopup="listbox"]').click()
    await expect(page.getByRole('option', { name: 'Mayorista #1' })).toBeVisible()
    await expect(page.getByRole('option', { name: 'Minorista #2' })).toHaveAttribute('data-disabled', '')
    await expect(page.getByRole('option', { name: 'Mayorista #1' }).locator('[class*="banknote"]')).toHaveCount(1)
    await expect(page.getByRole('option', { name: 'Gobierno #3' }).locator('[class*="tag"]')).toHaveCount(1)
    // Picking one closes it - and writes its Value.
    await page.getByRole('option', { name: 'Mayorista #1' }).click()
    await expect(page.getByRole('listbox')).toHaveCount(0)

    // Flag on: everything that follows it changes.
    await flag.click()
    await expect.poll(() => badge.getAttribute('class')).not.toBe(badgeOff)
    await expect(trailing.locator('.iconify.i-lucide\\:check, [class*="i-lucide:check"]')).toHaveCount(1)
    await expect(main.getByRole('tab', { name: 'Secreto' })).toBeVisible()
    await expect(main.getByRole('tab', { name: 'Bloqueado' })).toBeEnabled()
    await expect(table.getByRole('button', { name: 'Quitar' })).toHaveCount(5)
    await expect(main.getByRole('button', { name: /^New/ })).toHaveCount(0)
    await main.getByRole('button', { name: 'Menu' }).click()
    await expect(page.getByRole('menuitem', { name: 'Anular' })).toHaveAttribute('data-disabled', '')
    await page.getByRole('menuitem', { name: 'Borrar' }).click()
    await expect(page.getByText('Picked borrar', { exact: true })).toBeVisible()
  } finally {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${id}`)
  }
})

test('the Design form edits the new bindings', async ({ page, token }) => {
  test.setTimeout(120_000)
  const id = await setUp(page, token)
  try {
    const fields = await api<{ id: string, widget: string | null }[]>(page, token, 'GET', `/admin/api/dataviews/${id}/fields`)
    const main = page.locator('main')
    await page.goto(`/dataviews/${id}/design`)
    // A click on the canvas selects the innermost widget under it - a click on the widget's own box selects it, not what it holds.
    const open = async (widget: string) => {
      await main.locator(`[data-canvas-item="${fields.find(f => f.widget === widget)!.id}"]`).dispatchEvent('click')
    }

    // An embedded DataView, chosen, draws what it shows - not "Pick its DataView".
    await expect(main.getByText('Every row.', { exact: true })).toBeVisible()

    // A Badge's Variant takes a formula: its bind button, bound.
    await open('UBadge')
    await expect(main.getByRole('button', { name: 'Bind Variant' })).toBeVisible()

    // Tabs: its items one by one, each key shown, Add item.
    await open('UTabs')
    await expect(main.getByLabel('Item 2 label', { exact: true })).toHaveValue('Pagos')
    await expect(main.getByText('pagos', { exact: true })).toBeVisible()
    await expect(main.getByText('label = "Pagos (" + {{vars.n.value}} + ")"')).toBeVisible()
    await main.getByRole('button', { name: 'Add item' }).click()
    await expect(main.getByLabel('Item 5 label', { exact: true })).toHaveValue('Tab 5')
    // Saved with its key - the canvas area it will hold is content:tab5.
    const saved = async (widget: string) => (await api<{ widget: string | null, config: { props: Record<string, unknown> } }[]>(page, token, 'GET', `/admin/api/dataviews/${id}/fields`))
      .find(f => f.widget === widget)!.config.props
    await expect.poll(async () => (await saved('UTabs')).items).toContainEqual({ value: 'tab5', label: 'Tab 5' })

    // Dropdown: a function per item.
    await open('UDropdownMenu')
    await expect(main.getByRole('combobox', { name: 'Function' }).first()).toContainText('onAnular')

    // Table: computed columns, Row color, actions' formulas, a column's Color per row.
    await open('UTable')
    await expect(main.getByLabel('Computed column 1 title')).toHaveValue('Doble')
    await expect(main.getByText('doble = {{precio}} * 2')).toBeVisible()
    await expect(main.getByRole('button', { name: 'Bind Row color - per row' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Bind ver disabled - per row' })).toBeVisible()
    await main.getByRole('button', { name: /^precio/ }).click()
    await expect(main.getByText('{{precio}} < 1200 ? "red" : ""')).toBeVisible()
    // A computed column added and titled here is saved, and listed in Columns under its name.
    await main.getByRole('button', { name: 'Add computed column' }).click()
    await main.getByLabel('Computed column 2 title').fill('Margen')
    await main.getByLabel('Computed column 2 title').blur()
    await expect.poll(async () => (await saved('UTable')).computedColumns).toContainEqual({ key: 'computed_2', label: 'Margen', type: 'number', formula: '' })
    await expect(main.getByRole('button', { name: /^computed_2/ })).toBeVisible()

    // A Select menu's Icon and Disabled fields.
    await open('USelectMenu')
    await expect(main.getByRole('button', { name: 'Bind Icon field - per option' })).toBeVisible()
    await expect(main.getByRole('button', { name: 'Bind Disabled field - per option' })).toBeVisible()
    await expect(main.getByText('Label template')).toHaveCount(0)
  } finally {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${id}`)
  }
})

test('a linked DataView\'s Read only follows a formula over the page and its record', async ({ page, token }) => {
  test.setTimeout(120_000)
  await deleteDataViewsNamed(page, token, [READ_ONLY])
  const dataview = await createDataView(page, token, {
    name: READ_ONLY, slug: 'v1-detail-read-only', viewType: 'CUSTOM', sourceResourceId: await resourceId(page, token, 'e2e_v1_pedidos'),
    viewConfig: { variables: [{ kind: 'VALUE', name: 'flag', type: 'boolean', default: { value: false, source: 'constant' } }] }
  })
  try {
    const add = (widget: string, config: Record<string, unknown>) => addWidget(page, token, dataview.id, widget, config)
    await add('USwitch', { props: { label: 'Flag' }, bindings: { modelValue: { kind: 'variable', variable: 'flag' } } })
    await add('TDataView', {
      props: { dataview: detail.id, column: 'pedido', toolbarMode: 'none', paging: false, htmlAttrs: { 'data-test': 'TDataView' } },
      bindings: { readOnly: { kind: 'formula', formula: '{{vars.flag.value}} || {{vars.record.data.id}} == 2' } }
    })
    await publish(page, token, dataview.id)

    const main = page.locator('main')
    // The embedded DataView's own New - the page's header has one too, for its record.
    const embedNew = main.locator('[data-test="TDataView"]').getByRole('button', { name: /^New/ })
    // Order 1: its items can be added - until the page's flag says otherwise.
    await page.goto(`/app/dataviews/${dataview.slug}?pk=1`)
    await expect(main.locator('table tbody tr')).toHaveCount(2)
    await expect(embedNew).toBeVisible()
    await main.getByRole('switch', { name: 'Flag' }).click()
    await expect(embedNew).toHaveCount(0)

    // Order 2: read only from its record alone.
    await page.goto(`/app/dataviews/${dataview.slug}?pk=2`)
    await expect(main.locator('table tbody tr')).toHaveCount(1)
    await expect(embedNew).toHaveCount(0)
  } finally {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${dataview.id}`)
  }
})
