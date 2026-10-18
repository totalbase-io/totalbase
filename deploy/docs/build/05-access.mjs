// Roles, grants and users (Docs_Demo_Field_Service.md §4), through the MCP server.
//   TOTALBASE_TOKEN=... node 05-access.mjs
import { call } from './mcp.mjs'

const DEMO_PASSWORD = 'Acme-demo-2026'
const json = async (tool, args) => JSON.parse(await call(tool, args))
/** A list tool answers the rows, a write the row - with or without a { data } envelope. */
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const branchId = { SAL: null, JUJ: null, TUC: null }
for (const b of rows(await json('query_records', { name: 'branches', fields: 'id,code' }))) branchId[b.code] = b.id

// --- Roles ---
const ROLES = [
  ['Manager', 'Reads everything; approves quotes, any discount.', { app_access: true }],
  ['Dispatcher', 'Their branch: creates and assigns work orders, schedules visits.', { app_access: true }],
  ['Technician', 'The work orders assigned to them: visits, time, parts, photos, closing.', { app_access: true }],
  ['Sales', 'Their own customers, their sites, contracts and quotes.', { app_access: true }],
  ['Accounting', 'Invoices and purchase orders.', { app_access: true }],
  ['GPS device', 'A vehicle tracker\'s token: writes positions, nothing else.', { app_access: false, api_access: true }]
]
const existing = Object.fromEntries((await json('list_roles', {})).map(r => [r.name, r.id]))
const role = {}
for (const [name, description, access] of ROLES) {
  role[name] = existing[name] ?? rows(await json('write_records', { schema: 'totalbase', name: 'roles', operation: 'create', data: { name, description, ...access } }))[0].id
}

// --- Grants ---
const all = ['CREATE', 'READ', 'UPDATE', 'DELETE']
const read = names => names.map(name => ({ name, actions: ['READ'] }))
const EVERY_TABLE = ['branches', 'technicians', 'customers', 'sites', 'equipment_models', 'equipment', 'contracts', 'vehicles', 'vehicle_positions',
  'vehicle_maintenance', 'suppliers', 'warehouses', 'parts', 'stock', 'stock_movements', 'purchase_orders', 'purchase_order_items', 'work_orders', 'visits',
  'time_entries', 'work_order_parts', 'work_order_photos', 'projects', 'project_tasks', 'quotes', 'quote_items', 'invoices', 'invoice_items', 'parameters',
  'vehicles_latest_positions', 'work_orders_overview', 'stock_alerts', 'orders_due_soon']
const MY_BRANCH = { branch: { _eq: '$USER.branch' } }
const DISCOUNT_CAP = [{ rule: { discount_pct: { _lte: 20 } }, label: 'A discount above 20% needs a manager.' }]
const MINE = { 'technician.user': { _eq: '$USER.id' } }

const GRANTS = {
  Manager: [...read(EVERY_TABLE), { name: 'quotes', actions: ['CREATE', 'UPDATE'] }, { name: 'quote_items', actions: all },
    { name: 'issue_invoice_from_quote', actions: ['EXECUTE'] }],
  Dispatcher: [
    ...read(['branches', 'customers', 'equipment_models', 'equipment', 'contracts', 'parts', 'suppliers', 'work_order_parts', 'work_order_photos', 'time_entries', 'parameters', 'projects', 'project_tasks']),
    { name: 'sites', actions: ['READ'], where: MY_BRANCH }, { name: 'technicians', actions: ['READ'], where: MY_BRANCH },
    { name: 'vehicles', actions: ['READ'], where: MY_BRANCH }, { name: 'vehicles_latest_positions', actions: ['READ'] },
    { name: 'warehouses', actions: ['READ'], where: MY_BRANCH }, { name: 'stock', actions: ['READ'], where: { 'warehouse.branch': { _eq: '$USER.branch' } } },
    { name: 'work_orders', actions: ['CREATE', 'READ', 'UPDATE'], where: MY_BRANCH },
    { name: 'visits', actions: ['CREATE', 'READ', 'UPDATE', 'DELETE'], where: { 'work_order.branch': { _eq: '$USER.branch' } } },
    { name: 'work_orders_overview', actions: ['READ'] }, { name: 'orders_due_soon', actions: ['READ'], where: MY_BRANCH }, { name: 'stock_alerts', actions: ['READ'] },
    { name: 'quotes', actions: ['CREATE', 'READ', 'UPDATE'] }, { name: 'quote_items', actions: ['CREATE', 'UPDATE'], payload_checks: DISCOUNT_CAP },
    { name: 'quote_items', actions: ['READ', 'DELETE'] }, { name: 'assign_work_order', actions: ['EXECUTE'] }],
  Technician: [
    ...read(['branches', 'customers', 'sites', 'equipment_models', 'equipment', 'parts', 'warehouses', 'stock', 'technicians']),
    { name: 'work_orders', actions: ['READ'], where: MINE },
    { name: 'work_orders', actions: ['UPDATE'], where: MINE, fields: ['status', 'resolution', 'customer_signature', 'signed_by'],
      payload_checks: [{ rule: { _or: [{ status: { _neq: 'COMPLETED' } }, { _and: [{ resolution: { _nnull: true } }, { customer_signature: { _nnull: true } }] }] },
        label: 'Closing an order needs its resolution and the customer\'s signature.' }] },
    { name: 'visits', actions: ['READ', 'UPDATE'], where: MINE },
    { name: 'time_entries', actions: ['CREATE', 'READ'], where: MINE },
    { name: 'work_order_parts', actions: ['CREATE', 'READ'], where: { 'work_order.technician.user': { _eq: '$USER.id' } } },
    { name: 'work_order_photos', actions: ['CREATE', 'READ'], where: { 'work_order.technician.user': { _eq: '$USER.id' } } },
    { name: 'vehicles', actions: ['READ'], where: MINE }],
  Sales: [
    ...read(['branches', 'parts', 'equipment_models']),
    { name: 'customers', actions: ['CREATE', 'READ', 'UPDATE'], where: { account_manager: { _eq: '$USER.id' } } },
    { name: 'sites', actions: ['CREATE', 'READ', 'UPDATE'], where: { 'customer.account_manager': { _eq: '$USER.id' } } },
    { name: 'equipment', actions: ['READ'], where: { 'site.customer.account_manager': { _eq: '$USER.id' } } },
    { name: 'contracts', actions: ['CREATE', 'READ', 'UPDATE'], where: { 'customer.account_manager': { _eq: '$USER.id' } } },
    { name: 'quotes', actions: ['CREATE', 'READ', 'UPDATE'], where: { 'customer.account_manager': { _eq: '$USER.id' } } },
    { name: 'quote_items', actions: ['CREATE', 'UPDATE'], where: { 'quote.customer.account_manager': { _eq: '$USER.id' } }, payload_checks: DISCOUNT_CAP },
    { name: 'quote_items', actions: ['READ', 'DELETE'], where: { 'quote.customer.account_manager': { _eq: '$USER.id' } } }],
  Accounting: [
    ...read(['branches', 'customers', 'sites', 'suppliers', 'parts', 'warehouses', 'stock', 'technicians', 'work_orders', 'quotes', 'quote_items', 'parameters', 'work_orders_overview']),
    { name: 'invoices', actions: all }, { name: 'invoice_items', actions: all },
    { name: 'purchase_orders', actions: all }, { name: 'purchase_order_items', actions: all },
    { name: 'create_invoice_from_work_order', actions: ['EXECUTE'] }, { name: 'issue_invoice_from_quote', actions: ['EXECUTE'] }],
  'GPS device': [{ name: 'vehicle_positions', actions: ['CREATE'], fields: ['vehicle', 'location', 'speed_kmh', 'heading', 'recorded_at'] }]
}
for (const [name, grants] of Object.entries(GRANTS)) {
  await call('grant_permissions', { role_ids: [role[name]], grants })
  if (name !== 'GPS device') await call('apply_default_permissions', { role_id: role[name] })
  // A technician closes an order in one transaction: the order, its time and its parts (Data API › Transactions).
  if (name === 'Technician') await call('set_capability', { role_id: role[name], capability: 'TRANSACTIONS', effect: 'ALLOW' })
}

// --- Users (fixed names, @acme-field.example) ---
const USERS = [
  ['Mariana Quiroga', 'mariana.quiroga', ['Manager'], 'SAL'],
  ['Diego Arancibia', 'diego.arancibia', ['Dispatcher'], 'SAL'],
  ['Valeria Mamaní', 'valeria.mamani', ['Dispatcher'], 'JUJ'],
  ['Federico Juárez', 'federico.juarez', ['Dispatcher'], 'TUC'],
  ['Lucía Figueroa', 'lucia.figueroa', ['Sales'], 'SAL'],
  ['Martín Cruz', 'martin.cruz', ['Sales', 'Dispatcher'], 'TUC'],
  ['Carolina Ríos', 'carolina.rios', ['Accounting'], 'SAL'],
  ...[['Javier Gutiérrez', 'SAL'], ['Sofía Ledesma', 'SAL'], ['Ramiro Tolaba', 'SAL'], ['Natalia Burgos', 'SAL'], ['Pablo Choque', 'JUJ'], ['Gabriela Vilte', 'JUJ'],
    ['Hernán Sarapura', 'JUJ'], ['Andrea Medina', 'TUC'], ['Lucas Albarracín', 'TUC'], ['Florencia Paz', 'TUC'], ['Ignacio Robles', 'TUC'], ['Camila Sosa', 'SAL']]
    .map(([name, branch]) => [name, name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(' ', '.'), ['Technician'], branch])
]
const users = rows(await json('list_users', {})).map(u => u.email)
for (const [name, handle, roles, branch] of USERS) {
  const email = `${handle}@acme-field.example`
  if (users.includes(email)) continue
  await call('create_user', { email, name, password: DEMO_PASSWORD, role_ids: roles.map(r => role[r]), extra: { branch: branchId[branch] } })
}
console.log('roles', Object.keys(role).length, 'users', USERS.length)
