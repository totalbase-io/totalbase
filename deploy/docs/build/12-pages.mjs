// CUSTOM pages (DATASET.md §5): the Dispatch board and the New service request.
//   TOTALBASE_TOKEN=... node 12-pages.mjs
import { call } from './mcp.mjs'

const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const role = Object.fromEntries(rows(await json('list_roles', {})).map(r => [r.name, r.id]))
const dataviews = Object.fromEntries(rows(await json('list_dataviews', {})).map(d => [d.slug, d.id]))
const field = (label, input, extra = {}) => ({ widget: 'UFormField', props: { label, ...extra.field }, width: extra.width, children: [input] })

async function page(slug, create, build) {
  let id = dataviews[slug]
  if (!id) id = (await json('create_dataview', { slug, view_type: 'CUSTOM', ...create })).id
  else {
    // Rebuilt from nothing: the page's widgets go, the variables and code are replaced below.
    const current = await json('get_page', { id })
    for (const w of current.widgets ?? []) if (!w.parent) await call('delete_page_widget', { id, widget: w.name ?? w.id, confirm: true })
  }
  await build(id)
  return id
}

// --- Dispatch board: an unassigned order, a technician of the branch, a start - assigned and scheduled in one call ---
const dispatch = await page('dispatch-board', { name: 'Dispatch board', icon: 'i-lucide-route', view_config: { page_content_width: 'full' } }, async (id) => {
  await call('set_page_variables', { id, variables: [
    { name: 'unassigned', kind: 'RESOURCE', resource: 'public.work_orders', immediate: true,
      query: { fields: 'id,number,priority,type,site.name,due_at,description', where: { status: { _eq: 'NEW' }, technician: { _null: true } }, order_by: 'due_at', limit: 50 } },
    { name: 'technicians', kind: 'RESOURCE', resource: 'public.technicians', immediate: true, query: { fields: 'id,name', where: { active: { _eq: true } }, order_by: 'name', limit: 100 } },
    { name: 'order', kind: 'VALUE', type: 'text' },
    { name: 'tech', kind: 'VALUE', type: 'text' },
    { name: 'start', kind: 'VALUE', type: 'timestamp' },
    { name: 'assign', kind: 'CALL', target: { type: 'FUNCTION', resource: 'public.assign_work_order' },
      input: { data: { p_work_order: '{{vars.order.value}}', p_technician: '{{vars.tech.value}}', p_start: '{{vars.start.value}}' } } }
  ] })
  await call('add_page_widgets', { id, widgets: [
    { widget: 'UTable', name: 'orders', width: 8, height: 10, props: { columnSettings: { id: { hidden: true }, 'site.name': { label: 'Site' } } }, bindings: { data: { variable: 'unassigned' } }, emits: { select: 'onSelect' } },
    { widget: 'UCard', name: 'assignCard', width: 4, children: [
      { widget: 'THeading', slot: 'header', props: { label: 'Assign', level: 'h3' } },
      { widget: 'TText', bindings: { label: { formula: 'IF({{vars.order.value}}, "Order selected - pick who and when.", "Pick an order on the left.")' } } },
      field('Technician', { widget: 'USelectMenu', name: 'techSelect', props: { valueKey: 'id', labelKey: 'name' }, bindings: { modelValue: { variable: 'tech' }, items: { variable: 'technicians' } } }),
      field('Starts', { widget: 'UInputDate', props: { granularity: 'minute' }, bindings: { modelValue: { variable: 'start' } } }),
      { widget: 'UButton', slot: 'footer', props: { label: 'Assign and schedule', icon: 'i-lucide-calendar-check', block: true },
        bindings: { loading: { formula: '{{vars.assign.status}} == "pending"' } }, emits: { click: 'onAssign' } }
    ] },
    { widget: 'TDataView', name: 'fleet', height: 10, props: { dataview: dataviews['fleet-map'], view: 'MAP', toolbarMode: 'none' } }
  ] })
  await call('save_page_code', { id, code: `async function onSelect(dataview, event) {
  dataview.vars.order.set(event.row.id)
}

async function onAssign(dataview) {
  const { order, tech, start } = dataview.vars
  if (!order.value || !tech.value || !start.value) return dataview.notify('Pick an order, a technician and when.', 'warning')
  try {
    await dataview.vars.assign.execute()
    dataview.notify('Assigned and scheduled.', 'success')
    order.reset()
    await dataview.vars.unassigned.refresh()
  } catch (error) {
    dataview.notify(error.message, 'error')
  }
}
` })
})
await call('publish_dataview', { id: dispatch, role_ids: [role.Dispatcher, role.Manager] })

// --- New service request: scan the unit's serial, its site and equipment fill in, describe it, save ---
const intake = await page('new-service-request', { name: 'New service request', icon: 'i-lucide-clipboard-plus', table: 'work_orders', view_config: { page_content_width: 'narrow' } }, async (id) => {
  await call('set_page_variables', { id, variables: [
    { name: 'serial', kind: 'VALUE', type: 'text' },
    { name: 'units', kind: 'RESOURCE', resource: 'public.equipment', immediate: true, watch: true,
      query: { fields: 'id,serial,site,status', where: { site: { _eq: '{{vars.record.data.site}}' } }, order_by: 'serial', limit: 100 } },
    { name: 'sites', kind: 'RESOURCE', resource: 'public.sites', immediate: true, query: { fields: 'id,name,branch', order_by: 'name', limit: 100 } },
    { name: 'unit', kind: 'RESOURCE', resource: 'public.equipment', mode: 'record', immediate: false, query: { fields: 'id,site', limit: 1 } }
  ] })
  await call('add_page_widgets', { id, widgets: [
    field('Serial number', { widget: 'TScanner', name: 'scanner', bindings: { modelValue: { variable: 'serial' } }, emits: { scan: 'onScan' } },
      { field: { help: 'Scan the label on the unit, or type its serial.' } }),
    { widget: 'UForm', name: 'form', children: [
      { widget: 'UFormField', props: { column: 'site' }, width: 6, children: [{ widget: 'USelectMenu', props: { valueKey: 'id', labelKey: 'name', searchWindow: true }, bindings: { items: { variable: 'sites' } } }] },
      { widget: 'UFormField', props: { column: 'equipment' }, width: 6, children: [{ widget: 'USelectMenu', props: { valueKey: 'id', labelKey: 'serial' }, bindings: { items: { variable: 'units' } } }] },
      { widget: 'UFormField', props: { column: 'type' }, width: 6, children: [{ widget: 'USelect' }] },
      { widget: 'UFormField', props: { column: 'priority' }, width: 6, children: [{ widget: 'USelect' }] },
      { widget: 'UFormField', props: { column: 'description' }, children: [{ widget: 'UTextarea' }] }
    ] },
    { widget: 'UButton', slot: 'footer', props: { label: 'Create work order', icon: 'i-lucide-save' }, emits: { click: 'onSave' } }
  ] })
  await call('save_page_code', { id, code: `async function onScan(dataview, event) {
  const unit = await dataview.vars.unit.find('serial', event.value)
  if (!unit) return dataview.notify('No unit has serial ' + event.value + '.', 'warning')
  dataview.vars.record.set('site', unit.site)
  dataview.vars.record.set('equipment', unit.id)
  const site = dataview.vars.sites.data.find(s => s.id === unit.site)
  if (site) dataview.vars.record.set('branch', site.branch)
}

async function onSave(dataview) {
  const record = dataview.vars.record
  if (!record.data.branch && record.data.site) {
    const site = dataview.vars.sites.data.find(s => s.id === record.data.site)
    if (site) record.set('branch', site.branch)
  }
  if (await record.save()) {
    dataview.notify('Work order ' + record.data.number + ' created.', 'success')
    record.new()
  }
}
` })
})
await call('publish_dataview', { id: intake, role_ids: [role.Dispatcher, role.Manager] })
console.log('pages', dispatch, intake)
