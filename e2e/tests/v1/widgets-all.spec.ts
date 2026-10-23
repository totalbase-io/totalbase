import { WIDGET_NAMES } from '../../../packages/tb-catalog/dist/index.js'
import { addWidget, adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * Every widget of the widget catalog (WIDGET_NAMES, read from
 * @totalbase/tb-catalog itself) placed on one CUSTOM page, published, run in the
 * App and drawn on the Design form's canvas - with no console error either
 * way. A widget added to the catalog without a line in SETUP fails the first
 * test: this page covers the catalog, not a list kept by hand.
 */
const PAGE = 'V1 Widgets'
const EMBEDDED = 'V1 Widgets Embedded'
let dataview: DataViewRef

type Add = (widget: string, config?: Record<string, unknown>, options?: { label?: string, parent?: string }) => Promise<{ id: string }>
interface Ctx { add: Add, value: (name: string, type: string) => void, embedded: string, dashboard: string | null }

const v = (variable: string) => ({ kind: 'variable', variable })
const f = (formula: string) => ({ kind: 'formula', formula })
const text = (label: string) => ({ props: { label } })
const mark = (name: string, config: Record<string, unknown> = {}) => ({ ...config, props: { ...(config.props as object ?? {}), htmlAttrs: { 'data-test': name } } })

/** An input bound to a Value of `type`, named after it. */
const input = (type: string, extra: Record<string, unknown> = {}) => async (name: string, c: Ctx) => {
  c.value(`v${name}`, type)
  await c.add(name, mark(name, { ...extra, bindings: { modelValue: v(`v${name}`), ...(extra.bindings as object ?? {}) } }))
}
/** An option list over the categories. */
const options = (type: string, extra: Record<string, unknown> = {}) =>
  input(type, { ...extra, props: { valueKey: 'id', labelKey: 'nombre', ...(extra.props as object ?? {}) }, bindings: { items: v('categorias') } })
/** A container holding a Text in `slot`. */
const container = (slot: string, extra: Record<string, unknown> = {}) => async (name: string, c: Ctx) => {
  const box = await c.add(name, mark(name, extra))
  await c.add('TText', { ...text(`Inside ${name}`), slot }, { parent: box.id })
}
/** An overlay opened from Code, a Text in its body. */
const overlay = (slot: string) => async (name: string, c: Ctx) => {
  const box = await c.add(name, mark(name, { props: { title: `${name} title` } }), { label: `o${name}` })
  await c.add('TText', { ...text(`Inside ${name}`), slot }, { parent: box.id })
  await c.add('UButton', { props: { label: `Open ${name}` }, emits: { click: `open${name}` } })
}

const SETUP: Record<string, (name: string, c: Ctx) => Promise<void>> = {
  UForm: async (name, c) => {
    c.value('vFormInput', 'text')
    const form = await c.add(name, mark(name))
    const field = await c.add('UFormField', { props: { label: 'Form field label' }, slot: 'default' }, { parent: form.id })
    await c.add('UInput', { bindings: { modelValue: v('vFormInput') }, slot: 'default' }, { parent: field.id })
  },
  UFormField: async () => undefined, // inside UForm's
  TDataView: async (name, c) => { await c.add(name, mark(name, { props: { dataview: c.embedded } })) },
  TDashboard: async (name, c) => { await c.add(name, mark(name, c.dashboard ? { props: { dashboard: c.dashboard } } : {})) },
  TFrame: async (name, c) => { await c.add(name, mark(name, { props: { url: 'https://example.com/', title: 'Example' } })) },
  UInput: input('text'),
  UTextarea: input('text'),
  UInputNumber: input('number'),
  UInputDate: input('date'),
  UInputTime: input('time'),
  USwitch: input('boolean', { props: { label: 'A switch' } }),
  UCheckbox: input('boolean', { props: { label: 'A checkbox' } }),
  USelect: options('number'),
  USelectMenu: options('number'),
  UInputMenu: options('number'),
  URadioGroup: options('number'),
  UInputTags: input('array'),
  UCheckboxGroup: options('array'),
  UListbox: options('number'),
  UPinInput: input('text', { props: { length: 4 } }),
  USlider: input('number'),
  UInputRating: input('number'),
  UFileUpload: async (name, c) => { await c.add(name, mark(name, { props: { label: 'Drop a file' } })) },
  UEditor: input('text'),
  TJson: input('json'),
  TColorSelect: input('text'),
  TLeafletMap: input('point'),
  TScanner: input('text'),
  TCamera: input('text'),
  TSignature: input('text'),
  TGeolocation: input('text', { props: { auto: false } }),
  TRangeInput: input('text'),
  TResult: async (name, c) => { await c.add(name, mark(name)) },
  TImage: async (name, c) => { await c.add(name, mark(name, { props: { emptyText: 'No image yet' } })) },
  TQrCode: async (name, c) => { await c.add(name, mark(name, { bindings: { value: f('ABC-123') } })) },
  THeading: async (name, c) => { await c.add(name, mark(name, text('A heading'))) },
  TText: async (name, c) => { await c.add(name, mark(name, text('A paragraph'))) },
  UTable: async (name, c) => { await c.add(name, mark(name, { bindings: { data: v('categorias') } })) },
  UBadge: async (name, c) => { await c.add(name, mark(name, text('A badge'))) },
  UAlert: async (name, c) => { await c.add(name, mark(name, { props: { title: 'An alert', description: 'Its description' } })) },
  USeparator: async (name, c) => { await c.add(name, mark(name, text('A separator'))) },
  UProgress: async (name, c) => { await c.add(name, mark(name, { bindings: { modelValue: f('40') } })) },
  UAvatar: async (name, c) => { await c.add(name, mark(name, { props: { text: 'AB' } })) },
  UUser: async (name, c) => { await c.add(name, mark(name, { props: { name: 'A user', description: 'Its role' } })) },
  UEmpty: async (name, c) => { await c.add(name, mark(name, { props: { title: 'Nothing here', icon: 'i-lucide-inbox' } })) },
  UIcon: async (name, c) => { await c.add(name, mark(name, { props: { name: 'i-lucide-smile' } })) },
  UCard: container('default', { props: { title: 'A card' } }),
  TBox: container('default'),
  UTabs: container('content:tab1'),
  UAccordion: container('body:section1'),
  UCollapsible: async (name, c) => {
    const box = await c.add(name, mark(name, { props: { defaultOpen: true } }))
    await c.add('UButton', { props: { label: 'Collapsible trigger' }, slot: 'default' }, { parent: box.id })
    await c.add('TText', { ...text(`Inside ${name}`), slot: 'content' }, { parent: box.id })
  },
  USplitter: container('panel:left'),
  UScrollArea: container('default'),
  UModal: overlay('body'),
  USlideover: overlay('body'),
  TDrawer: overlay('body'),
  UPopover: async (name, c) => {
    const box = await c.add(name, mark(name))
    await c.add('UButton', { props: { label: 'Popover trigger' }, slot: 'default' }, { parent: box.id })
    await c.add('TText', { ...text(`Inside ${name}`), slot: 'content' }, { parent: box.id })
  },
  UTooltip: async (name, c) => {
    const box = await c.add(name, mark(name, { props: { text: 'A tooltip' } }))
    await c.add('UButton', { props: { label: 'Tooltip target' }, slot: 'default' }, { parent: box.id })
  },
  UDropdownMenu: async (name, c) => {
    const box = await c.add(name, mark(name, { props: { items: [{ value: 'one', label: 'Menu item one', onSelect: 'onMenuOne' }] } }))
    await c.add('UButton', { props: { label: 'Menu trigger' }, slot: 'default' }, { parent: box.id })
  },
  UButton: async (name, c) => { await c.add(name, mark(name, { props: { label: 'A button' } })) }
}

/** The widgets that draw nothing until opened, or only their trigger. */
const NO_ROOT = new Set(['UFormField', 'UModal', 'USlideover', 'TDrawer', 'UPopover', 'UTooltip', 'UDropdownMenu', 'UCollapsible'])

const CODE = `
async function openUModal(dataview) { dataview.controls.oUModal.open() }
async function openUSlideover(dataview) { dataview.controls.oUSlideover.open() }
async function openTDrawer(dataview) { dataview.controls.oTDrawer.open() }
async function onMenuOne(dataview) { dataview.notify('Menu one ran') }
`

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000)
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [PAGE, EMBEDDED])
  await resetSchema(page, token)
  const embedded = await createDataView(page, token, { name: EMBEDDED, viewType: 'TABLE', sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'), selectedColumns: ['nombre', 'email'] })
  await publish(page, token, embedded.id)
  const dashboards = await api<{ id: string, slug: string }[]>(page, token, 'GET', '/admin/api/dashboards')
  const dashboard = dashboards.find(d => d.slug === 'sales-overview')?.id ?? null

  const variables: Record<string, unknown>[] = [{
    kind: 'RESOURCE', name: 'categorias', mode: 'list', resource: await resourceId(page, token, 'e2e_v1_categorias'),
    immediate: true, watch: false, count: false, query: { fields: 'id,nombre', order_by: 'id', limit: 100 }
  }]
  dataview = await createDataView(page, token, { name: PAGE, viewType: 'CUSTOM' })
  const pending: Array<() => Promise<void>> = []
  const ctx: Ctx = {
    add: (widget, config = {}, options = {}) => addWidget(page, token, dataview.id, widget, config, options),
    value: (name, type) => { variables.push({ kind: 'VALUE', name, type, default: { value: null, source: 'constant' } }) },
    embedded: embedded.id,
    dashboard
  }
  // The variables first - widgets are checked against them as they're placed.
  for (const name of WIDGET_NAMES) {
    if (!SETUP[name]) continue
    pending.push(() => SETUP[name]!(name, ctx))
  }
  // Collect every Value the setups declare, then save them before placing anything.
  const declared = { ...ctx }
  ctx.add = async () => ({ id: '' })
  for (const run of pending) await run()
  ctx.add = declared.add
  await api(page, token, 'PATCH', `/admin/api/dataviews/${dataview.id}`, { data: { viewConfig: { variables } } })
  ctx.value = () => undefined
  for (const run of pending) await run()
  await api(page, token, 'POST', `/admin/api/dataviews/${dataview.id}/code`, { data: { code: CODE } })
  await publish(page, token, dataview.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [PAGE, EMBEDDED])
  await context.close()
})

/** Widgets whose code is a separate chunk loaded on first use. */
const LAZY_WIDGETS = new Set(['UEditor'])

test('every widget of the catalog has a place on this page', () => {
  expect(WIDGET_NAMES.filter(name => !SETUP[name])).toEqual([])
})

test('every widget runs in the App, with no console error', async ({ page, token: _ }) => {
  test.setTimeout(120_000)
  await page.goto(`/app/dataviews/v1-widgets`)
  const main = page.locator('main')
  await expect(main.getByText('A heading')).toBeVisible()

  for (const name of WIDGET_NAMES.filter(n => !NO_ROOT.has(n))) {
    // UEditor's TipTap bundle loads on demand - a cold dev server takes longer than the rest.
    await expect.soft(main.locator(`[data-test="${name}"]`).first(), `${name} is drawn`).toBeAttached({ timeout: LAZY_WIDGETS.has(name) ? 10_000 : 1500 })
  }
  // Containers show what they hold - an Accordion once its section opens.
  await main.locator('[data-test="UAccordion"]').getByRole('button', { name: 'Section 1' }).click()
  for (const name of ['UCard', 'TBox', 'UTabs', 'UAccordion', 'UCollapsible', 'USplitter', 'UScrollArea']) {
    await expect(main.getByText(`Inside ${name}`), `${name} shows its content`).toBeVisible()
  }
  // Option lists show the categories.
  await expect(main.locator('[data-test="URadioGroup"]')).toContainText('Mayorista')
  await expect(main.locator('[data-test="UCheckboxGroup"]')).toContainText('Gobierno')
  await expect(main.locator('[data-test="UTable"]')).toContainText('Minorista')
  // A form: its field, labelled.
  await expect(main.getByText('Form field label')).toBeVisible()
  // Embeds.
  await expect(main.locator('[data-test="TDataView"]')).toContainText('Acme SA')

  // Overlays open: from Code, from their trigger, on hover.
  for (const name of ['UModal', 'USlideover', 'TDrawer']) {
    await main.getByRole('button', { name: `Open ${name}` }).click()
    await expect(page.getByText(`Inside ${name}`)).toBeVisible()
    // A Drawer is for working - not dismissible (AGENTS.md section 25): its ✕ closes it, Escape doesn't.
    if (name === 'TDrawer') await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click()
    else await page.keyboard.press('Escape')
    await expect(page.getByText(`Inside ${name}`)).toBeHidden()
  }
  await main.getByRole('button', { name: 'Popover trigger' }).click()
  await expect(page.getByText('Inside UPopover')).toBeVisible()
  await page.keyboard.press('Escape')
  await main.getByRole('button', { name: 'Tooltip target' }).hover()
  await expect(page.getByText('A tooltip').first()).toBeVisible()
  await main.getByRole('button', { name: 'Menu trigger' }).click()
  await page.getByRole('menuitem', { name: 'Menu item one' }).click()
  await expect(page.getByText('Menu one ran', { exact: true })).toBeVisible()
})

test('every widget is drawn on the Design form\'s canvas, with no console error', async ({ page, token }) => {
  test.setTimeout(120_000)
  const fields = await api<{ id: string, widget: string | null, parent: string | null }[]>(page, token, 'GET', `/admin/api/dataviews/${dataview.id}/fields`)
  await page.goto(`/dataviews/${dataview.id}/design`)
  const main = page.locator('main')
  // Every widget placed on the page itself (not inside an overlay's own canvas) is on the canvas.
  const onPage = fields.filter(f => f.widget && f.parent === null)
  await expect(main.locator('[data-canvas-item]').first()).toBeVisible()
  for (const field of onPage) await expect(main.locator(`[data-canvas-item="${field.id}"]`), `${field.widget} on the canvas`).toBeAttached()
  // Selecting each opens its inspector.
  for (const field of onPage.slice(0, 12)) {
    await main.locator(`[data-canvas-item="${field.id}"]`).dispatchEvent('click')
    await expect(main.getByRole('tab', { name: 'Props' }).or(main.getByText('Props', { exact: true })).first()).toBeVisible()
  }
})
