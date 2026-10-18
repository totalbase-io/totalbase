// What the documentation's screenshots show beyond the demo's core (docs/content's ::screenshot captions):
// a widget gallery, a few more workflows and versions, auth, appearance, files in folders, a device token,
// secrets, colors on the work orders. MCP where it has a tool; the Admin API (a signed-in administrator) for
// what only an administrator's session changes.
//   TOTALBASE_TOKEN=... node 13-extras.mjs
import { readFileSync } from 'node:fs'
import { call } from './mcp.mjs'

const base = process.env.TOTALBASE_URL ?? 'http://localhost:3080'
const env = Object.fromEntries(readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n').filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const session = (await (await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: env.TOTALBASE_ADMIN_EMAIL, password: env.TOTALBASE_ADMIN_PASSWORD }) })).json()).data.token
async function admin(method, path, data) {
  const res = await fetch(`${base}/admin/api${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${session}` }, body: data === undefined ? undefined : JSON.stringify({ data }) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text).data : undefined
}
const role = Object.fromEntries(rows(await json('list_roles', {})).map(r => [r.name, r.id]))
const res = Object.fromEntries(rows(await json('list_resources', { schema: 'public' })).map(r => [r.name, r.id]))
const dataviews = Object.fromEntries(rows(await json('list_dataviews', {})).map(d => [d.slug, d.id]))
const dashboards = Object.fromEntries(rows(await json('list_dashboards', {})).map(d => [d.name, d.id]))

// --- Colors: a work order card and row by its priority, overdue rows red ---
await call('update_dataview', { id: dataviews['work-orders'], view_config: {
  kanban_layout: { groupColumn: 'status', titleFormula: '{{number}}', descriptionFormula: '{{description}}' },
  layouts: ['KANBAN', 'TABLE', 'CALENDAR'], calendar_layout: { dateColumn: 'due_at', titleFormula: '{{number}}' },
  edit_presentation: 'SIDEBAR' } })
for (let v = 0; v < 3; v++) await call('publish_dataview', { id: dataviews['work-orders'], role_ids: [role.Dispatcher, role.Manager], note: ['Lanes colored by status', 'Cards titled by number', 'Table and calendar views'][v] })
await call('update_dataview', { id: dataviews['work-orders'], description: 'Every open order of the branch, by status.' })
// An unpublished change, for the Versions and Publish screenshots: the resolution hidden from the board.
await call('update_dataview', { id: dataviews['work-orders'], fields: [{ column: 'resolution', visible: false }] })

// --- Dashboards: Fleet refreshes every minute; Operations gets versions and an unpublished change ---
await call('update_dashboard', { id: dashboards.Fleet, refresh_interval_seconds: 60 })
for (const note of ['SLA met as a percentage', 'Technician hours', 'Overdue orders table']) await call('publish_dashboard', { id: dashboards.Operations, role_ids: [role.Manager, role.Dispatcher], note })
await call('update_dashboard', { id: dashboards.Operations, description: 'Open work, SLA and the technicians\' load - by branch and period.' })

// --- The widget gallery: one tab per family, for the widget pages ---
const W = (type, label, query, config = {}, tab) => ({ type, label, query, config, tab })
const gallery = { name: 'Widget gallery', description: 'Every widget family on Acme\'s data.', scope: 'LISTED',
  variables: [{ name: 'branch', label: 'Branch', type: 'SELECT', options: { source: 'TABLE', resource: res.branches } }],
  tabs: ['indicators', 'comparison', 'trend', 'proportion', 'distribution', 'maps', 'tables', 'presentation'].map(v => ({ value: v, label: v[0].toUpperCase() + v.slice(1) })),
  widgets: [
    W('KPI', 'Completed orders', `SELECT date_trunc('week', completed_at)::date AS week, count(*) AS completed FROM public.work_orders WHERE status = 'COMPLETED' AND completed_at > now() - interval '12 weeks' GROUP BY 1 ORDER BY 1`, { roles: { value: 'completed', time: 'week' }, showDelta: true, sparkline: true }, 'indicators'),
    W('GAUGE', 'SLA met this month', `SELECT round(100.0 * count(*) FILTER (WHERE completed_at <= due_at) / nullif(count(*), 0), 1) AS sla FROM public.work_orders WHERE completed_at >= date_trunc('month', now())`, { displayFormat: '0 %', thresholds: [{ color: 'red' }, { from: 70, color: 'amber' }, { from: 90, color: 'green' }] }, 'indicators'),
    W('PROGRESS', 'Monthly revenue goal', `SELECT coalesce(sum(ii.quantity * ii.unit_price), 0) AS revenue, 6000000 AS goal FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id WHERE i.issued_on >= date_trunc('month', now())`, { roles: { value: 'revenue', target: 'goal' }, displayFormat: 'CURRENCY:ARS' }, 'indicators'),
    W('BAR', 'Orders by branch', `SELECT b.name AS branch, count(o.id) AS orders FROM public.branches b LEFT JOIN public.work_orders o ON o.branch = b.id AND o.reported_at > now() - interval '90 days' GROUP BY b.name ORDER BY b.name`, {}, 'comparison'),
    W('BAR_HORIZONTAL', 'Parts used by category', `SELECT p.category, sum(wp.quantity) AS units FROM public.work_order_parts wp JOIN public.parts p ON p.id = wp.part GROUP BY p.category ORDER BY units DESC`, {}, 'comparison'),
    W('LEADERBOARD', 'Top customers', `SELECT c.name AS customer, sum(ii.quantity * ii.unit_price) AS revenue FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id JOIN public.customers c ON c.id = i.customer GROUP BY c.name ORDER BY revenue DESC LIMIT 8`, { displayFormat: 'CURRENCY:ARS' }, 'comparison'),
    W('LINE', 'Orders reported per week, by type', `SELECT date_trunc('week', reported_at)::date AS week, type, count(*) AS orders FROM public.work_orders WHERE reported_at > now() - interval '26 weeks' GROUP BY 1, 2 ORDER BY 1`, { roles: { category: 'week', series: 'type', values: ['orders'] } }, 'trend'),
    W('AREA', 'Cumulative revenue this year', `SELECT d AS day, sum(sum(ii.quantity * ii.unit_price)) OVER (ORDER BY d) AS revenue FROM (SELECT i.issued_on AS d, ii.quantity, ii.unit_price FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id WHERE i.issued_on >= date_trunc('year', now())) ii GROUP BY d ORDER BY d`, { displayFormat: 'CURRENCY:ARS' }, 'trend'),
    W('DONUT', 'Open orders by status', `SELECT status, count(*) AS orders FROM public.work_orders WHERE status NOT IN ('COMPLETED', 'CANCELLED') GROUP BY status`, {}, 'proportion'),
    W('FUNNEL', 'Quote conversion', `SELECT 1 AS _n, 'Created' AS stage, count(*) AS quotes FROM public.quotes UNION ALL SELECT 2, 'Sent', count(*) FILTER (WHERE status IN ('SENT', 'ACCEPTED', 'REJECTED')) FROM public.quotes UNION ALL SELECT 3, 'Accepted', count(*) FILTER (WHERE status = 'ACCEPTED') FROM public.quotes ORDER BY 1`, {}, 'proportion'),
    W('TREEMAP', 'Stock value by branch and warehouse', `SELECT b.name AS branch, w.name AS warehouse, sum(s.quantity * p.unit_cost) AS value FROM public.stock s JOIN public.parts p ON p.id = s.part JOIN public.warehouses w ON w.id = s.warehouse JOIN public.branches b ON b.id = w.branch GROUP BY 1, 2`, { roles: { levels: ['branch', 'warehouse'], value: 'value' } }, 'proportion'),
    W('HEATMAP', 'Orders by weekday and hour', `SELECT to_char(reported_at, 'Dy') AS weekday, lpad(extract(hour FROM reported_at)::text, 2, '0') AS hour, count(*) AS orders, min(extract(isodow FROM reported_at)) AS _d FROM public.work_orders GROUP BY 1, 2 ORDER BY _d, 2`, {}, 'distribution'),
    W('CALENDAR', 'Visits per day', `SELECT scheduled_start::date AS day, count(*) AS visits FROM public.visits GROUP BY 1 ORDER BY 1`, {}, 'distribution'),
    W('SCATTER', 'Orders and hours by technician', `SELECT t.name AS technician, count(DISTINCT te.work_order) AS orders, round(sum(te.minutes) / 60.0, 1) AS hours FROM public.time_entries te JOIN public.technicians t ON t.id = te.technician GROUP BY t.name`, { roles: { x: 'orders', y: 'hours', label: 'technician' } }, 'distribution'),
    W('MAP', 'Sites with open orders', `SELECT s.name AS site, s.location, count(*) AS orders, CASE WHEN bool_or(o.due_at < now()) THEN 'red' ELSE 'blue' END AS _color FROM public.work_orders o JOIN public.sites s ON s.id = o.site WHERE o.status NOT IN ('COMPLETED', 'CANCELLED') AND ($VAR.branch IS NULL OR o.branch = $VAR.branch::uuid) GROUP BY s.id`, { roles: { location: 'location', label: 'site', size: 'orders' } }, 'maps'),
    W('TABLE', 'Overdue orders', `SELECT o.number, o.priority, c.name AS customer, o.due_at, CASE o.priority WHEN 'URGENT' THEN 'red' WHEN 'HIGH' THEN 'orange' ELSE 'gray' END AS _priority_color, CASE WHEN o.priority = 'URGENT' THEN 'red' END AS _color FROM public.work_orders o JOIN public.sites s ON s.id = o.site JOIN public.customers c ON c.id = s.customer WHERE o.status NOT IN ('COMPLETED', 'CANCELLED') AND o.due_at < now() ORDER BY o.due_at`, {}, 'tables'),
    W('PIVOT', 'Billing by customer and month', `SELECT c.name AS customer, to_char(i.issued_on, 'YYYY-MM') AS month, ii.quantity * ii.unit_price AS amount FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id JOIN public.customers c ON c.id = i.customer WHERE i.issued_on > now() - interval '4 months'`, { roles: { rows: ['customer'], columns: ['month'], values: ['amount'] }, aggregates: { amount: 'sum' }, columnSettings: { amount: { displayFormat: 'CURRENCY:ARS' } } }, 'tables'),
    W('THeading', 'Branch heading', null, { props: { label: 'x', level: 'h2' }, bindings: { label: { kind: 'formula', formula: '"Branch: " + IF({{vars.branch.label}}, {{vars.branch.label}}, "All")' } } }, 'presentation'),
    W('UAlert', 'Overdue alert', `SELECT count(*) AS overdue FROM public.work_orders WHERE status NOT IN ('COMPLETED', 'CANCELLED') AND due_at < now()`, { props: { title: 'x', color: 'error', variant: 'subtle', icon: 'i-lucide-alarm-clock' }, bindings: { title: { kind: 'formula', formula: '{{row.overdue}} + " orders are overdue"' } } }, 'presentation'),
    W('USeparator', 'Separator', null, { props: {} }, 'presentation')
  ] }
const existingGallery = dashboards['Widget gallery']
const draft = existingGallery ? await json('get_dashboard', { id: existingGallery }) : null
const applied = await json('apply_dashboard', { ...(existingGallery && { id: existingGallery, draft_version: draft.draftVersion }), spec: gallery })
if (!applied.applied) throw new Error('Widget gallery: ' + JSON.stringify(applied.errors).slice(0, 1500))
const galleryId = existingGallery ?? rows(await json('list_dashboards', {})).find(d => d.name === 'Widget gallery').id
await call('publish_dashboard', { id: galleryId, role_ids: [role.Manager] })

// --- Workflows: Send reminder (MANUAL, a one-field form, Sales may run it) ---
const workflows = Object.fromEntries(rows(await json('list_workflows', {})).map(w => [w.name, w.id]))
let reminder = workflows['Send reminder']
if (!reminder) reminder = (await json('create_workflow', { name: 'Send reminder', description: 'Emails a customer a reminder about a quote.',
  start: { trigger: 'MANUAL', input_fields: [{ name: 'quote', label: 'Quote number', type: 'text', required: true }] } })).id
await call('publish_workflow', { id: reminder, revision: (await json('get_workflow', { id: reminder })).revision, enabled: true, role_ids: [role.Sales] }).catch(e => console.log('Send reminder:', e.message.slice(0, 300)))

// --- Auth: a Google provider (fictional), shown on the sign-in page ---
const providers = await admin('GET', '/auth-providers').catch(() => [])
if (!(providers ?? []).some(p => p.slug === 'google')) {
  await admin('PUT', '/secrets/google-client-secret', { value: 'demo-google-secret-not-real' })
  await admin('POST', '/auth-providers', { name: 'Google', type: 'GOOGLE', enabled: true, showOnSignIn: true,
    configuration: { client_id: '1234567890-acmefield.apps.googleusercontent.com', client_secret_key: 'google-client-secret',
      allowed_redirect_urls: ['https://acme-field.example/auth/callback'], default_role_id: role.Technician } }).catch(e => console.log('provider:', e.message))
}
await admin('PUT', '/secrets/smtp-password', { value: 'demo-smtp-password-not-real' })

// --- Appearance: Acme's green, the company panel on the sign-in page ---
// TotalBase's own primary color: the screenshots show the product as it ships.
await admin('PATCH', '/settings/appearance', { login_layout: 'PANEL',
  login_headline: 'Acme Field Services', login_intro: 'HVAC and solar service across northwestern Argentina.' }).catch(e => console.log('appearance:', e.message))

// --- Files: folders for the equipment and work order photos ---
const folderId = async name => rows(await json('query_records', { schema: 'totalbase', name: 'folders', fields: 'id', where: { name: { _eq: name } } }))[0]?.id
  ?? rows(await json('write_records', { schema: 'totalbase', name: 'folders', operation: 'create', data: { name } }))[0].id
const equipmentFolder = await folderId('Equipment')
const ordersFolder = await folderId('Work orders')
const peopleFolder = await folderId('Technicians')
await call('execute_sql', { sql: `UPDATE totalbase.files SET folder = '${equipmentFolder}' WHERE name ~ '^(Coolwave|Aerotherm|Sunfield|Voltara|Van) ';
UPDATE totalbase.files SET folder = '${ordersFolder}' WHERE name ~ '^(Before|After|Replaced|Inverter|Signature|Report) ';
UPDATE totalbase.files f SET folder = '${peopleFolder}' FROM public.technicians t WHERE f.name = t.name || '.png';
UPDATE totalbase.files SET description = 'Outdoor unit photo for the equipment card.', tags = ARRAY['equipment', 'photo'] WHERE name ~ '^Coolwave ';`, confirm: true })

// --- The GPS device: an account holding only its role, and its token ---
const users = rows(await json('list_users', {}))
let gps = users.find(u => u.email === 'gps-tracker@acme-field.example')?.id
if (!gps) gps = (await json('create_user', { email: 'gps-tracker@acme-field.example', name: 'GPS tracker', role_ids: [role['GPS device']], invite: 'link' })).id ?? null
const gpsId = gps ?? rows(await json('list_users', {})).find(u => u.email === 'gps-tracker@acme-field.example').id
await admin('POST', '/tokens', { userId: gpsId, name: 'Van trackers', plane: 'API', ttlDays: 365 }).catch(e => console.log('gps token:', e.message))

// --- Maintenance: dead rows on vehicle_positions (an update of a day's points) ---
await call('execute_sql', { sql: "UPDATE public.vehicle_positions SET speed_kmh = speed_kmh WHERE recorded_at > now() - interval '1 day'", confirm: true })

// --- Order completed: a failed run (an order whose customer has no email) beside the successful ones ---
const noEmail = rows(await json('query_records', { name: 'work_orders', fields: 'id,site', where: { status: { _eq: 'IN_PROGRESS' } }, limit: 2 }))
if (noEmail.length === 2) {
  await call('write_records', { name: 'work_orders', operation: 'update', id: noEmail[0].id, data: { status: 'COMPLETED', resolution: 'Cleaned the filters; pressures checked.', signed_by: 'M. Álvarez' } })
  await call('execute_sql', { sql: `UPDATE public.customers c SET email = NULL FROM public.sites s WHERE s.customer = c.id AND s.id = '${noEmail[1].site}'`, confirm: true })
  await call('write_records', { name: 'work_orders', operation: 'update', id: noEmail[1].id, data: { status: 'COMPLETED', resolution: 'Replaced the inverter fan.', signed_by: 'S. Díaz' } })
}
console.log('extras done')
