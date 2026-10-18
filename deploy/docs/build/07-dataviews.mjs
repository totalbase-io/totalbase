// DataViews (Docs_Demo_Field_Service.md §5) - created, configured and published through the MCP server.
//   TOTALBASE_TOKEN=... node 07-dataviews.mjs
import { call } from './mcp.mjs'

const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const role = Object.fromEntries(rows(await json('list_roles', {})).map(r => [r.name, r.id]))
const existing = Object.fromEntries(rows(await json('list_dataviews', {})).map(d => [d.slug, d.id]))
const STATUS_COLOR = 'IF({{status}} = "ON_ROUTE", "info", IF({{status}} = "AVAILABLE", "success", "warning"))'

const DATAVIEWS = [
  { slug: 'customers', name: 'Customers', view_type: 'TREE', table: 'customers', icon: 'i-lucide-building-2',
    columns: ['name', 'parent', 'status', 'tax_id', 'email', 'phone', 'account_manager'],
    view_config: { tree_layout: { parentColumn: 'parent', titleFormula: '{{name}}', descriptionFormula: '{{email}}', expandLevel: 1 } },
    roles: ['Manager', 'Sales', 'Dispatcher', 'Accounting'] },
  { slug: 'team', name: 'Team', view_type: 'TREE', table: 'technicians', icon: 'i-lucide-network',
    columns: ['name', 'lead', 'branch', 'skills', 'photo'],
    view_config: { tree_layout: { parentColumn: 'lead', titleFormula: '{{name}}', descriptionFormula: '{{branch.name}}', imageFormula: '{{photo}}', defaultDisplay: 'org', expandLevel: 2 } },
    roles: ['Manager', 'Dispatcher'] },
  { slug: 'sites', name: 'Sites', view_type: 'MAP', table: 'sites', icon: 'i-lucide-map-pin',
    columns: ['name', 'customer', 'address', 'branch', 'location', 'access_notes'],
    view_config: { map_layout: { pointColumn: 'location', nameFormula: '{{name}}', descriptionFormula: '{{address}}' }, layouts: ['MAP', 'TABLE'] },
    roles: ['Manager', 'Sales', 'Dispatcher', 'Technician'] },
  { slug: 'equipment', name: 'Equipment', view_type: 'CARDS', table: 'equipment', icon: 'i-lucide-air-vent',
    columns: ['serial', 'model', 'site', 'status', 'installed_on', 'warranty_until', 'photo'],
    view_config: { card_layout: { titleFormula: '{{serial}}', descriptionFormula: '{{status}}', imageFormula: '{{photo}}', imageAspect: '4:3', imageFit: 'cover' } },
    roles: ['Manager', 'Dispatcher', 'Technician', 'Sales'] },
  { slug: 'work-orders', name: 'Work orders', view_type: 'KANBAN', table: 'work_orders', icon: 'i-lucide-clipboard-list',
    columns: ['number', 'type', 'priority', 'status', 'site', 'equipment', 'branch', 'technician', 'reported_at', 'due_at', 'description', 'resolution'],
    view_config: { kanban_layout: { groupColumn: 'status', titleFormula: '{{number}}', descriptionFormula: '{{description}}' }, edit_presentation: 'PAGE' },
    roles: ['Manager', 'Dispatcher'] },
  { slug: 'work-orders-list', name: 'Work orders (list)', view_type: 'TABLE', table: 'work_orders', icon: 'i-lucide-list-checks',
    columns: ['number', 'status', 'priority', 'type', 'site', 'branch', 'technician', 'reported_at', 'due_at', 'completed_at'],
    view_config: { default_state: { sort: '-reported_at' } }, roles: ['Manager', 'Dispatcher', 'Accounting'] },
  { slug: 'my-work', name: 'My work', view_type: 'TABLE', table: 'work_orders', icon: 'i-lucide-wrench',
    columns: ['number', 'status', 'priority', 'site', 'due_at', 'description'],
    view_config: { base_where: { status: { _nin: ['COMPLETED', 'CANCELLED'] } }, default_state: { sort: 'due_at' }, edit_presentation: 'PAGE', allow: ['update'] },
    roles: ['Technician'] },
  { slug: 'work-order', name: 'Work order (technician)', view_type: 'FORM', table: 'work_orders', icon: 'i-lucide-clipboard-check',
    columns: ['number', 'status', 'site', 'equipment', 'description', 'resolution', 'customer_signature', 'signed_by'],
    view_config: { form_view_mode: 'UPDATE', allow: ['update'] }, roles: ['Technician'] },
  { slug: 'schedule', name: 'Schedule', view_type: 'CALENDAR', table: 'visits', icon: 'i-lucide-calendar-days',
    columns: ['work_order', 'technician', 'vehicle', 'scheduled_start', 'scheduled_end', 'check_in_at', 'check_out_at'],
    view_config: { calendar_layout: { dateColumn: 'scheduled_start', titleFormula: '{{work_order.number}}', descriptionFormula: '{{technician.name}}', defaultView: 'week', weekStartsOn: 1 } },
    roles: ['Manager', 'Dispatcher', 'Technician'] },
  { slug: 'projects', name: 'Projects', view_type: 'GANTT', table: 'project_tasks', icon: 'i-lucide-gantt-chart',
    columns: ['name', 'project', 'starts_on', 'ends_on', 'depends_on', 'technician', 'progress'],
    view_config: { gantt_layout: { startDateColumn: 'starts_on', endDateColumn: 'ends_on', groupColumn: 'project', titleFormula: '{{name}}', progressColumn: 'progress', defaultZoom: 'week' } },
    roles: ['Manager', 'Dispatcher'] },
  { slug: 'fleet-map', name: 'Fleet map', view_type: 'MAP', table: 'vehicles_latest_positions', icon: 'i-lucide-truck',
    columns: ['plate', 'status', 'driver', 'branch', 'speed_kmh', 'recorded_at', 'location'],
    view_config: { map_layout: { pointColumn: 'location', nameFormula: '{{plate}}', descriptionFormula: '{{driver}}', colorFormula: STATUS_COLOR }, auto_refresh: '10s' },
    roles: ['Manager', 'Dispatcher'] },
  { slug: 'vehicles', name: 'Vehicles', view_type: 'TABLE', table: 'vehicles', icon: 'i-lucide-car-front',
    columns: ['plate', 'make', 'model', 'year', 'branch', 'technician', 'status', 'odometer_km', 'insurance_until', 'inspection_until', 'next_service_km'],
    roles: ['Manager', 'Dispatcher'] },
  { slug: 'stock', name: 'Stock', view_type: 'TABLE', table: 'stock', icon: 'i-lucide-boxes',
    columns: ['part', 'warehouse', 'quantity', 'part.reorder_point'], roles: ['Manager', 'Dispatcher', 'Technician', 'Accounting'] },
  { slug: 'purchase-orders', name: 'Purchase orders', view_type: 'MASTER_DETAIL', table: 'purchase_orders', icon: 'i-lucide-shopping-cart',
    columns: ['supplier', 'warehouse', 'status', 'created_at', 'received_at'],
    detail: { table: 'purchase_order_items', fk_column: 'purchase_order', columns: ['part', 'quantity', 'unit_cost'] },
    roles: ['Accounting', 'Manager'] },
  { slug: 'quotes', name: 'Quotes', view_type: 'MASTER_DETAIL', table: 'quotes', icon: 'i-lucide-file-text',
    columns: ['customer', 'site', 'status', 'valid_until', 'total'],
    detail: { table: 'quote_items', fk_column: 'quote', columns: ['description', 'part', 'quantity', 'unit_price', 'discount_pct'] },
    roles: ['Sales', 'Manager', 'Dispatcher'] },
  { slug: 'invoices', name: 'Invoices', view_type: 'TABLE', table: 'invoices', icon: 'i-lucide-receipt',
    columns: ['number', 'customer', 'work_order', 'issued_on', 'due_on', 'status', 'tax_rate'],
    view_config: { default_state: { sort: '-issued_on' } }, roles: ['Accounting', 'Manager'] },
  { slug: 'parameters', name: 'Parameters', view_type: 'SETTINGS', table: 'parameters', icon: 'i-lucide-sliders-horizontal',
    view_config: { settings_layout: { keyColumn: 'key', valueColumn: 'value', titleColumn: 'title', descriptionColumn: 'description', groupColumn: 'section', orderColumn: 'position' } },
    roles: ['Manager'] },
  { slug: 'supplier-portal', name: 'Supplier portal', view_type: 'EXTERNALFRAME', icon: 'i-lucide-external-link',
    view_config: { frame_url: 'https://www.example.com/' }, roles: ['Accounting', 'Manager'] }
]

for (const { roles, ...dv } of DATAVIEWS) {
  let id = existing[dv.slug]
  if (!id) id = (await json('create_dataview', dv)).id
  await call('publish_dataview', { id, role_ids: roles.map(r => role[r]) })
  console.log('published', dv.slug)
}
