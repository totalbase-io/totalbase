// Templates and workflows (Docs_Demo_Field_Service.md §8, §9), through the MCP server.
//   TOTALBASE_TOKEN=... node 09-workflows.mjs
import { call } from './mcp.mjs'

const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const res = Object.fromEntries(rows(await json('list_resources', { schema: 'public' })).map(r => [r.name, r.id]))
const systemUser = rows(await json('query_records', { schema: 'totalbase', name: 'users', fields: 'id', where: { email: { _eq: 'workflows@system.totalbase.internal' } } }))[0].id
const role = Object.fromEntries(rows(await json('list_roles', {})).map(r => [r.name, r.id]))
const TZ = 'America/Argentina/Salta'

// --- Templates ---
const brand = body => `<div style="font-family:Arial,sans-serif;max-width:560px"><p style="color:#0e7490;font-weight:bold">Acme Field Services</p>${body}<p style="color:#64748b;font-size:12px">Acme Field Services · Av. Belgrano 1250, Salta</p></div>`
const MAILINGS = [
  ['Visit scheduled', 'Your visit for {{number}} is scheduled', brand('<p>Hello {{customer}},</p><p>A technician will visit <b>{{site}}</b> on <b>{{when}}</b> for work order {{number}}.</p>')],
  ['Order completed', 'Work order {{number}} completed', brand('<p>Hello {{customer}},</p><p>Work order <b>{{number}}</b> at {{site}} is complete: {{resolution}}</p><p>The report and the invoice are attached.</p>')],
  ['Quote sent', 'Your quote from Acme Field Services', brand('<p>Hello {{customer}},</p><p>Here is your quote for {{total}}, valid until {{valid_until}}.</p>')],
  ['SLA alert', '{{count}} work orders due within 2 hours', brand('<p>These open work orders are due soon:</p><pre>{{orders}}</pre>')],
  ['Fleet digest', 'Fleet: {{count}} vehicles need attention', brand('<p>Insurance, inspection or service due within 30 days:</p><pre>{{vehicles}}</pre>')],
  ['Request received', 'We received your service request {{number}}', brand('<p>Hello {{customer}},</p><p>Your request was registered as <b>{{number}}</b>. We will contact you to schedule the visit.</p>')]
]
const TEXT = (name, x, y, w, h, size, extra = {}) => ({ name, type: 'text', position: { x, y }, width: w, height: h, fontSize: size, content: '', ...extra })
const LABEL = (name, content, x, y, w, size = 9) => ({ name, type: 'text', readOnly: true, textFormat: 'inline-markdown', content, position: { x, y }, width: w, height: 6, fontSize: size })
const TABLE_STYLES = {
  tableStyles: { borderColor: '#cbd5e1', borderWidth: 0.2 },
  headStyles: { alignment: 'left', verticalAlignment: 'middle', fontSize: 9, lineHeight: 1, characterSpacing: 0, borderWidth: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 }, padding: { top: 2, right: 2, bottom: 2, left: 2 }, fontColor: '#ffffff', backgroundColor: '#0e7490', borderColor: '' },
  bodyStyles: { alignment: 'left', verticalAlignment: 'middle', fontSize: 9, lineHeight: 1, characterSpacing: 0, borderWidth: { top: 0.1, right: 0.1, bottom: 0.1, left: 0.1 }, padding: { top: 2, right: 2, bottom: 2, left: 2 }, fontColor: '#0f172a', backgroundColor: '', borderColor: '#cbd5e1', alternateBackgroundColor: '#f1f5f9' },
  columnStyles: {}
}
const PDFS = [
  ['Work order report', { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[
    LABEL('title', '**Acme Field Services** - Work order report', 15, 12, 180, 16),
    TEXT('number', 15, 24, 90, 8, 14), TEXT('date', 135, 24, 60, 8, 10, { alignment: 'right' }),
    LABEL('l_customer', '**Customer**', 15, 38, 40), TEXT('customer', 55, 38, 140, 6, 10),
    LABEL('l_site', '**Site**', 15, 45, 40), TEXT('site', 55, 45, 140, 6, 10),
    LABEL('l_tech', '**Technician**', 15, 52, 40), TEXT('technician', 55, 52, 140, 6, 10),
    LABEL('l_desc', '**Reported**', 15, 62, 40), TEXT('description', 55, 62, 140, 14, 10),
    LABEL('l_res', '**Resolution**', 15, 80, 40), TEXT('resolution', 55, 80, 140, 20, 10),
    { name: 'parts', type: 'table', position: { x: 15, y: 106 }, width: 180, height: 120, showHead: true, head: ['Part', 'Qty.', 'Price'], headWidthPercentages: [64, 12, 24], ...TABLE_STYLES, content: '[]' },
    LABEL('l_signed', '**Signed by**', 15, 240, 40), TEXT('signed_by', 55, 240, 80, 6, 10)
  ]] }],
  ['Invoice', { basePdf: { width: 210, height: 297, padding: [0, 0, 0, 0] }, schemas: [[
    LABEL('title', '**INVOICE** A', 15, 12, 90, 18), TEXT('number', 135, 12, 60, 8, 12, { alignment: 'right' }),
    LABEL('issuer', '**Acme Field Services SA**\nCUIT 30-71583920-4 · Av. Belgrano 1250, Salta', 15, 25, 120), TEXT('issued_on', 135, 22, 60, 6, 10, { alignment: 'right' }),
    TEXT('customer', 15, 40, 180, 6, 11),
    { name: 'lines', type: 'table', position: { x: 15, y: 52 }, width: 180, height: 180, showHead: true, head: ['Description', 'Qty.', 'Price', 'Amount'], headWidthPercentages: [52, 12, 18, 18], ...TABLE_STYLES, content: '[]' },
    TEXT('total', 115, 240, 80, 8, 13, { alignment: 'right' })
  ]] }]
]
const templates = Object.fromEntries(rows(await json('list_templates', {})).map(t => [t.name, t.id]))
for (const [name, subject, message] of MAILINGS) templates[name] ??= (await json('save_template', { name, kind: 'MAILING', subject, message })).id
for (const [name, content] of PDFS) templates[name] ??= (await json('save_template', { name, kind: 'PDF', content })).id

// --- Workflows ---
// A step's label is what the canvas shows; unset, its key.
const LABELS = { due_soon: 'Read orders due soon', any: 'Summarize', has_orders: 'Any due?', alert: 'Email the alert', invoice: 'Create the invoice',
  order: 'Read the order', site: 'Read its site', customer: 'Read the customer', report: 'Render the report', report_file: 'Store the PDF',
  email: 'Email the customer', part: 'Read the part', decide: 'Below reorder point?', is_low: 'Reorder?', po: 'Create a draft PO', line: 'Add the part',
  check: 'Validate the request', known: 'Known customer?', found: 'Found?', confirm: 'Confirm by email', done: 'Answer the number',
  unknown: 'Unknown customer', due: 'Read what is due', digest: 'Build the digest', each: 'For each unit', post: 'Post to accounting' }
const op = (key, type, configuration, extra = {}) => ({ key, type, configuration, ...(LABELS[key] && { label: LABELS[key] }), ...extra })
const link = (source, target, output = 'next') => ({ source, output, target })
const as = { execute_as: systemUser }
const WORKFLOWS = [
  { name: 'SLA watch', description: 'Every 15 minutes: open orders due within 2 hours, by email.',
    start: { trigger: 'CRON', cron_expression: '*/15 * * * *', timezone: TZ, ...as },
    operations: [
      op('due_soon', 'totalbase.read-records', { resource: res.orders_due_soon, query: { fields: 'number,priority,site,due_at', order_by: 'due_at' } }),
      op('any', 'totalbase.execute-javascript', { code: 'const rows = results.due_soon.data; return { count: rows.length, orders: rows.map(r => `${r.number}  ${r.priority}  ${r.site}  ${r.due_at}`).join("\\n") }' }),
      op('has_orders', 'totalbase.condition', { input: '{{any.data}}', filter: { count: { _gt: '0' } } }),
      op('alert', 'totalbase.send-email', { to: 'operations@acme-field.example', template: templates['SLA alert'], data: { count: '{{any.data.count}}', orders: '{{any.data.orders}}' } })
    ],
    connections: [link('start', 'due_soon'), link('due_soon', 'any'), link('any', 'has_orders'), link('has_orders', 'alert', 'true')] },
  { name: 'Order completed', description: 'Invoices a completed order and emails the customer its report.',
    start: { trigger: 'DATA_EVENT', resource: res.work_orders, events: ['UPDATE'], changed_fields: ['status'], filter: { status: { _eq: 'COMPLETED' } }, ...as },
    operations: [
      op('invoice', 'totalbase.execute-function', { function: res.create_invoice_from_work_order, arguments: { p_work_order: '{{start.data.id}}' } }),
      op('order', 'totalbase.read-records', { resource: res.work_orders_overview, query: { where: { id: { _eq: '{{start.data.id}}' } }, limit: 1 } }),
      op('site', 'totalbase.read-records', { resource: res.sites, query: { fields: 'customer', where: { id: { _eq: '{{start.data.site}}' } }, limit: 1 } }),
      op('customer', 'totalbase.read-records', { resource: res.customers, query: { fields: 'name,email', where: { id: { _eq: '{{site.data[0].customer}}' } }, limit: 1 } }),
      op('report', 'totalbase.generate-pdf-template', { template: templates['Work order report'], data: {
        number: '{{order.data[0].number}}', date: '{{order.data[0].completed_at}}', customer: '{{order.data[0].customer}}', site: '{{order.data[0].site}}',
        technician: '{{order.data[0].technician}}', description: '{{start.data.description}}', resolution: '{{start.data.resolution}}', parts: [], signed_by: '{{start.data.signed_by}}' } }),
      op('report_file', 'totalbase.create-file', { name: 'Report {{order.data[0].number}}.pdf', contentType: 'application/pdf', content: '{{report.data.content}}', encoding: 'base64' }),
      op('email', 'totalbase.send-email', { to: '{{customer.data[0].email}}', template: templates['Order completed'], attachments: ['{{report_file.data.asset}}'],
        data: { customer: '{{order.data[0].customer}}', number: '{{order.data[0].number}}', site: '{{order.data[0].site}}', resolution: '{{start.data.resolution}}' } })
    ],
    connections: [link('start', 'invoice'), link('invoice', 'order'), link('order', 'site'), link('site', 'customer'), link('customer', 'report'), link('report', 'report_file'), link('report_file', 'email')] },
  { name: 'Reorder parts', description: 'A part used below its reorder point goes on a draft purchase order.',
    start: { trigger: 'DATA_EVENT', resource: res.work_order_parts, events: ['CREATE'], ...as },
    operations: [
      op('alert', 'totalbase.read-records', { resource: res.stock_alerts, query: { where: { part: { _eq: '{{start.data.part}}' }, warehouse: { _eq: '{{start.data.warehouse}}' } }, limit: 1 } }),
      op('part', 'totalbase.read-records', { resource: res.parts, query: { fields: 'id,supplier,unit_cost,reorder_point', where: { id: { _eq: '{{start.data.part}}' } }, limit: 1 } }),
      op('decide', 'totalbase.execute-javascript', { code: 'const low = results.alert.data.length > 0; const p = results.part.data[0]; return { low, supplier: p.supplier, unit_cost: p.unit_cost, quantity: Math.max(5, p.reorder_point * 3) }' }),
      op('is_low', 'totalbase.condition', { input: '{{decide.data}}', filter: { low: { _eq: 'true' } } }),
      op('po', 'totalbase.create-records', { resource: res.purchase_orders, records: [{ supplier: '{{decide.data.supplier}}', warehouse: '{{start.data.warehouse}}', status: 'DRAFT' }] }),
      op('line', 'totalbase.create-records', { resource: res.purchase_order_items, records: [{ purchase_order: '{{po.data[0].id}}', part: '{{start.data.part}}', quantity: '{{decide.data.quantity}}', unit_cost: '{{decide.data.unit_cost}}' }] })
    ],
    connections: [link('start', 'alert'), link('alert', 'part'), link('part', 'decide'), link('decide', 'is_low'), link('is_low', 'po', 'true'), link('po', 'line')] },
  { name: 'Service request intake', slug: 'service-request', description: 'The website form: a NEW work order for the customer\'s site.',
    start: { trigger: 'WEBHOOK', method: 'POST', access: 'PUBLIC', response_mode: 'SYNC', ...as },
    operations: [
      op('check', 'totalbase.validate-data', { input: '{{start.data.body}}', rules: [{ filter: { email: { _nnull: true } }, message: 'email is required' }, { filter: { description: { _nnull: true } }, message: 'description is required' }] }),
      op('customer', 'totalbase.read-records', { resource: res.customers, query: { fields: 'id,name,email', where: { email: { _eq: '{{start.data.body.email}}' } }, limit: 1 } }),
      op('known', 'totalbase.execute-javascript', { code: 'return { found: results.customer.data.length > 0 }' }),
      op('found', 'totalbase.condition', { input: '{{known.data}}', filter: { found: { _eq: 'true' } } }),
      op('site', 'totalbase.read-records', { resource: res.sites, query: { fields: 'id,branch', where: { customer: { _eq: '{{customer.data[0].id}}' } }, limit: 1 } }),
      op('order', 'totalbase.create-records', { resource: res.work_orders, records: [{ type: 'REPAIR', priority: 'NORMAL', site: '{{site.data[0].id}}', branch: '{{site.data[0].branch}}', description: '{{start.data.body.description}}' }] }),
      op('confirm', 'totalbase.send-email', { to: '{{customer.data[0].email}}', template: templates['Request received'], data: { customer: '{{customer.data[0].name}}', number: '{{order.data[0].number}}' } }),
      op('done', 'totalbase.finish-result', { result: { number: '{{order.data[0].number}}' } }),
      op('unknown', 'totalbase.finish-error', { code: 'UNKNOWN_CUSTOMER', message: 'No customer has that email - call us at +54 387 421-5500.' })
    ],
    connections: [link('start', 'check'), link('check', 'customer'), link('customer', 'known'), link('known', 'found'), link('found', 'site', 'true'), link('found', 'unknown', 'false'),
      link('site', 'order'), link('order', 'confirm'), link('confirm', 'done')] },
  { name: 'Fleet expirations', description: 'Daily at 07:00: insurance, inspection or service due within 30 days.',
    start: { trigger: 'CRON', cron_expression: '0 7 * * *', timezone: TZ, ...as },
    operations: [
      op('due', 'totalbase.execute-sql', { executeAs: systemUser, statement: "SELECT plate, insurance_until, inspection_until, next_service_km - odometer_km AS km_to_service FROM public.vehicles WHERE insurance_until < current_date + 30 OR inspection_until < current_date + 30 OR next_service_km - odometer_km < 1500 ORDER BY plate" }),
      op('digest', 'totalbase.execute-javascript', { code: 'const rows = results.due.data.rows ?? results.due.data; return { count: rows.length, vehicles: rows.map(r => `${r.plate}  insurance ${r.insurance_until}  inspection ${r.inspection_until}  service in ${r.km_to_service} km`).join("\\n") }' }),
      op('any', 'totalbase.condition', { input: '{{digest.data}}', filter: { count: { _gt: '0' } } }),
      op('email', 'totalbase.send-email', { to: 'fleet@acme-field.example', template: templates['Fleet digest'], data: { count: '{{digest.data.count}}', vehicles: '{{digest.data.vehicles}}' } })
    ],
    connections: [link('start', 'due'), link('due', 'digest'), link('digest', 'any'), link('any', 'email', 'true')] },
  { name: 'Maintenance plan', description: 'Monthly: a MAINTENANCE order for each unit its model\'s interval makes due.',
    start: { trigger: 'CRON', cron_expression: '0 6 1 * *', timezone: TZ, ...as },
    operations: [
      op('due', 'totalbase.execute-sql', { executeAs: systemUser, statement: "SELECT e.id AS equipment, e.site, s.branch, m.brand || ' ' || m.model AS model FROM public.equipment e JOIN public.sites s ON s.id = e.site JOIN public.equipment_models m ON m.id = e.model WHERE e.status <> 'RETIRED' AND NOT EXISTS (SELECT 1 FROM public.work_orders o WHERE o.equipment = e.id AND o.type = 'MAINTENANCE' AND o.reported_at > now() - make_interval(days => m.maintenance_interval_days - 14))" }),
      op('each', 'totalbase.for-each', { items: '{{due.data.rows}}' }),
      op('order', 'totalbase.create-records', { resource: res.work_orders, records: [{ type: 'MAINTENANCE', priority: 'LOW', site: '{{item.site}}', equipment: '{{item.equipment}}', branch: '{{item.branch}}', description: 'Scheduled maintenance - {{item.model}}' }] }, { parent: 'each' })
    ],
    connections: [link('start', 'due'), link('due', 'each'), link('each', 'order', 'item')] },
  { name: 'Accounting sync', description: 'Every new invoice to the accounting system.',
    start: { trigger: 'DATA_EVENT', resource: res.invoices, events: ['CREATE'], ...as },
    operations: [
      op('post', 'totalbase.http-request', { method: 'POST', url: 'https://accounting.example.com/api/invoices', headers: { 'content-type': 'application/json' },
        secretHeaders: [{ name: 'x-api-key', secret: 'accounting-api-key' }], body: { number: '{{start.data.number}}', customer: '{{start.data.customer}}', issued_on: '{{start.data.issued_on}}' } })
    ],
    connections: [link('start', 'post')] }
]

const existing = Object.fromEntries(rows(await json('list_workflows', {})).map(w => [w.name, w.id]))
for (const { start, operations, connections, ...meta } of WORKFLOWS) {
  let id = existing[meta.name]
  if (!id) id = (await json('create_workflow', { ...meta, start })).id
  let wf = await json('get_workflow', { id })
  const startOp = (wf.definition ?? wf.draft?.definition).operations.find(o => o.type === 'totalbase.start')
  const saved = await json('save_workflow', { id, revision: wf.revision ?? wf.workflow?.revision,
    operations: [{ id: startOp.id, type: 'totalbase.start', key: 'start', configuration: start }, ...operations], connections })
  const revision = saved.revision ?? saved.workflow?.revision ?? (await json('get_workflow', { id })).revision
  try {
    await call('publish_workflow', { id, revision, enabled: true, role_ids: [role.Manager] })
    console.log('published', meta.name)
  } catch (error) {
    console.log('NOT PUBLISHED', meta.name, error.message.slice(0, 700))
  }
}
