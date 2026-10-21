// Dashboards and embeds (DATASET.md §6, §7) - one apply_dashboard spec each, published.
//   TOTALBASE_TOKEN=... node 08-dashboards.mjs
import { call } from './mcp.mjs'

const json = async (tool, args) => JSON.parse(await call(tool, args))
const rows = r => Array.isArray(r) ? r : Array.isArray(r?.data) ? r.data : [r?.data ?? r]
const role = Object.fromEntries(rows(await json('list_roles', {})).map(r => [r.name, r.id]))
const resource = Object.fromEntries(rows(await json('list_resources', { schema: 'public', type: 'TABLE' })).map(r => [r.name, r.id]))
const existing = Object.fromEntries(rows(await json('list_dashboards', {})).map(d => [d.name, d.id]))
const dataviews = Object.fromEntries(rows(await json('list_dataviews', {})).map(d => [d.slug, d.id]))

const PERIOD = { name: 'period', label: 'Period', type: 'DATE_RANGE', default: { source: 'constant', value: 'this_month' } }
const list = (name, label, table) => ({ name, label, type: 'SELECT', options: { source: 'TABLE', resource: resource[table] } })
const BRANCH = list('branch', 'Branch', 'branches')
const inBranch = col => `($VAR.branch IS NULL OR ${col} = $VAR.branch::uuid)`
const OPEN = `status NOT IN ('COMPLETED', 'CANCELLED')`
const ARS = 'CURRENCY:ARS'

const DASHBOARDS = [
  { roles: ['Manager', 'Dispatcher'], spec: { name: 'Operations', description: 'Open work, SLA and the technicians\' load, by branch.', variables: [BRANCH, PERIOD], widgets: [
    { type: 'KPI', label: 'Open orders', query: `SELECT count(*) AS open_orders FROM public.work_orders WHERE ${OPEN} AND ${inBranch('branch')}` },
    { type: 'KPI', label: 'Overdue', query: `SELECT count(*) AS overdue FROM public.work_orders WHERE ${OPEN} AND due_at < now() AND ${inBranch('branch')}`,
      config: { thresholds: [{ color: 'green' }, { from: 1, color: 'amber' }, { from: 10, color: 'red' }] } },
    { type: 'KPI', label: 'SLA met', description: 'Orders completed in the period by their due time.',
      query: `SELECT coalesce(round(100.0 * count(*) FILTER (WHERE completed_at <= due_at) / nullif(count(*), 0), 1), 0) AS sla_met FROM public.work_orders WHERE status = 'COMPLETED' AND completed_at >= $VAR.period.from AND completed_at < $VAR.period.to AND ${inBranch('branch')}`,
      config: { displayFormat: '0.0 %', thresholds: [{ color: 'red' }, { from: 70, color: 'amber' }, { from: 90, color: 'green' }] } },
    { type: 'KPI', label: 'Completed', query: `SELECT count(*) AS completed FROM public.work_orders WHERE status = 'COMPLETED' AND completed_at >= $VAR.period.from AND completed_at < $VAR.period.to AND ${inBranch('branch')}` },
    { type: 'DONUT', label: 'Open orders by status', query: `SELECT status, count(*) AS orders FROM public.work_orders WHERE ${OPEN} AND ${inBranch('branch')} GROUP BY status` },
    { type: 'BAR', label: 'Orders by branch', query: `SELECT b.name AS branch, count(o.id) AS orders FROM public.branches b LEFT JOIN public.work_orders o ON o.branch = b.id AND o.reported_at >= $VAR.period.from AND o.reported_at < $VAR.period.to GROUP BY b.name ORDER BY b.name` },
    { type: 'BAR_HORIZONTAL', label: 'Technician hours', description: 'Hours logged in the period.',
      query: `SELECT t.name AS technician, round(sum(te.minutes) / 60.0, 1) AS hours FROM public.time_entries te JOIN public.technicians t ON t.id = te.technician WHERE te.started_at >= $VAR.period.from AND te.started_at < $VAR.period.to AND ${inBranch('t.branch')} GROUP BY t.name ORDER BY hours DESC`,
      config: { displayFormat: '0.0 h' } },
    // The period's trend: orders reported and completed each day, up to today.
    { type: 'LINE', label: 'Opened vs completed', description: 'Orders reported and orders completed, per day.',
      query: `SELECT d::date AS day,
        (SELECT count(*) FROM public.work_orders o WHERE o.reported_at >= d AND o.reported_at < d + interval '1 day' AND ${inBranch('o.branch')}) AS opened,
        (SELECT count(*) FROM public.work_orders o WHERE o.completed_at >= d AND o.completed_at < d + interval '1 day' AND ${inBranch('o.branch')}) AS completed
        FROM generate_series(date_trunc('day', $VAR.period.from::timestamptz), least($VAR.period.to::timestamptz, now()) - interval '1 second', interval '1 day') d ORDER BY 1` },
    // What to chase now: each late order, the latest first in red - a click opens it.
    { type: 'TABLE', label: 'Overdue orders', description: 'Open orders past their due time. Click one to open it.',
      query: `SELECT o.id AS _id, o.number, o.priority, c.name AS customer, s.name AS site, t.name AS technician, o.due_at, (current_date - o.due_at::date) AS days_late,
        CASE WHEN o.priority = 'URGENT' OR current_date - o.due_at::date > 7 THEN 'red' ELSE 'amber' END AS _color
        FROM public.work_orders o JOIN public.sites s ON s.id = o.site JOIN public.customers c ON c.id = s.customer LEFT JOIN public.technicians t ON t.id = o.technician
        WHERE o.${OPEN} AND o.due_at < now() AND ${inBranch('o.branch')} ORDER BY o.due_at`,
      config: { click: { action: 'RECORD', dataview: dataviews['work-orders-list'], pk: '{{row._id}}', hint: 'Click to open the order' } } }
  ] } },
  { roles: ['Manager', 'Dispatcher'], spec: { name: 'Fleet', description: 'Where the vans are, how far they went and what expires soon.', variables: [BRANCH], widgets: [
    { type: 'DONUT', label: 'Vehicles by status', query: `SELECT status, count(*) AS vehicles FROM public.vehicles WHERE ${inBranch('branch')} GROUP BY status` },
    { type: 'MAP', label: 'Latest positions', query: `SELECT p.plate, p.location FROM public.vehicles_latest_positions p JOIN public.vehicles v ON v.id = p.vehicle WHERE ${inBranch('v.branch')}` },
    { type: 'BAR', label: 'Km today', description: 'Distance between consecutive GPS positions (straight lines).',
      query: `SELECT v.plate, round(coalesce(sum(d.km), 0)::numeric, 1) AS km FROM public.vehicles v LEFT JOIN (SELECT vehicle, (location <-> lag(location) OVER (PARTITION BY vehicle ORDER BY recorded_at)) * 111 AS km FROM public.vehicle_positions WHERE recorded_at >= date_trunc('day', now())) d ON d.vehicle = v.id WHERE ${inBranch('v.branch')} GROUP BY v.plate ORDER BY v.plate`,
      config: { displayFormat: '#,##0.0 km' } },
    { type: 'TABLE', label: 'Expiring within 30 days', query: `SELECT plate, make || ' ' || model AS vehicle, insurance_until, inspection_until, next_service_km - odometer_km AS km_to_service, CASE WHEN least(insurance_until, inspection_until) < current_date + 7 THEN 'red' ELSE 'amber' END AS _color FROM public.vehicles WHERE (insurance_until < current_date + 30 OR inspection_until < current_date + 30 OR next_service_km - odometer_km < 1500) AND ${inBranch('branch')} ORDER BY least(insurance_until, inspection_until)` }
  ] } },
  { roles: ['Manager', 'Accounting'], spec: { name: 'Finance', description: 'Revenue, collections and quotes.', variables: [{ ...PERIOD, default: { source: 'constant', value: 'this_year' } }], widgets: [
    { type: 'KPI', label: 'Revenue', query: `SELECT coalesce(sum(ii.quantity * ii.unit_price), 0) AS revenue FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id WHERE i.issued_on >= $VAR.period.from::date AND i.issued_on < $VAR.period.to::date`, config: { displayFormat: ARS } },
    { type: 'KPI', label: 'Quote conversion', description: 'Accepted of the quotes decided in the period.',
      query: `SELECT coalesce(round(100.0 * count(*) FILTER (WHERE status = 'ACCEPTED') / nullif(count(*) FILTER (WHERE status IN ('ACCEPTED', 'REJECTED')), 0), 1), 0) AS conversion FROM public.quotes WHERE created_at >= $VAR.period.from AND created_at < $VAR.period.to`,
      config: { displayFormat: '0.0 %' } },
    { type: 'LINE', label: 'Revenue by month', query: `SELECT date_trunc('month', i.issued_on)::date AS month, sum(ii.quantity * ii.unit_price) AS revenue FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id WHERE i.issued_on >= $VAR.period.from::date AND i.issued_on < $VAR.period.to::date GROUP BY 1 ORDER BY 1`, config: { displayFormat: ARS } },
    { type: 'DONUT', label: 'Invoices by status', query: `SELECT status, count(*) AS invoices FROM public.invoices WHERE issued_on >= $VAR.period.from::date AND issued_on < $VAR.period.to::date GROUP BY status` },
    { type: 'LEADERBOARD', label: 'Top customers', query: `SELECT c.name AS customer, sum(ii.quantity * ii.unit_price) AS revenue FROM public.invoices i JOIN public.invoice_items ii ON ii.invoice = i.id JOIN public.customers c ON c.id = i.customer WHERE i.issued_on >= $VAR.period.from::date AND i.issued_on < $VAR.period.to::date GROUP BY c.name ORDER BY revenue DESC LIMIT 10`, config: { displayFormat: ARS } }
  ] } },
  { roles: ['Manager', 'Dispatcher', 'Accounting'], spec: { name: 'Inventory', description: 'Stock value, what to reorder and what gets used.', variables: [list('warehouse', 'Warehouse', 'warehouses')], widgets: [
    { type: 'KPI', label: 'Stock value', query: `SELECT coalesce(sum(s.quantity * p.unit_cost), 0) AS value FROM public.stock s JOIN public.parts p ON p.id = s.part WHERE ($VAR.warehouse IS NULL OR s.warehouse = $VAR.warehouse::uuid)`, config: { displayFormat: ARS } },
    { type: 'KPI', label: 'Below reorder point', query: `SELECT count(*) AS parts FROM public.stock_alerts WHERE ($VAR.warehouse IS NULL OR warehouse = $VAR.warehouse::uuid)`,
      config: { thresholds: [{ color: 'green' }, { from: 1, color: 'amber' }, { from: 5, color: 'red' }] } },
    { type: 'BAR_HORIZONTAL', label: 'Stock value by warehouse', query: `SELECT w.name AS warehouse, sum(s.quantity * p.unit_cost) AS value FROM public.stock s JOIN public.parts p ON p.id = s.part JOIN public.warehouses w ON w.id = s.warehouse GROUP BY w.name ORDER BY value DESC`, config: { displayFormat: ARS } },
    { type: 'DONUT', label: 'Used in the last 90 days, by category', query: `SELECT p.category, sum(wp.quantity) AS units FROM public.work_order_parts wp JOIN public.parts p ON p.id = wp.part JOIN public.work_orders o ON o.id = wp.work_order WHERE o.reported_at >= now() - interval '90 days' AND ($VAR.warehouse IS NULL OR wp.warehouse = $VAR.warehouse::uuid) GROUP BY p.category` },
    { type: 'TABLE', label: 'To reorder', query: `SELECT sku, part_name AS part, warehouse_name AS warehouse, quantity, reorder_point FROM public.stock_alerts WHERE ($VAR.warehouse IS NULL OR warehouse = $VAR.warehouse::uuid) ORDER BY quantity` }
  ] } },
  { roles: ['Manager'], embed: 'SIGNED', spec: { name: 'Customer portal', description: 'A customer\'s sites, equipment and orders - embedded in their own website.', variables: [list('customer', 'Customer', 'customers')], widgets: [
    { type: 'KPI', label: 'Open orders', query: `SELECT count(*) AS open_orders FROM public.work_orders o JOIN public.sites s ON s.id = o.site WHERE s.customer = $VAR.customer::uuid AND o.${OPEN}` },
    { type: 'KPI', label: 'Units', query: `SELECT count(*) AS units FROM public.equipment e JOIN public.sites s ON s.id = e.site WHERE s.customer = $VAR.customer::uuid` },
    { type: 'TABLE', label: 'Equipment', query: `SELECT s.name AS site, m.brand || ' ' || m.model AS model, e.serial, e.status, e.installed_on + m.maintenance_interval_days * ((current_date - e.installed_on) / m.maintenance_interval_days + 1) AS next_maintenance FROM public.equipment e JOIN public.sites s ON s.id = e.site JOIN public.equipment_models m ON m.id = e.model WHERE s.customer = $VAR.customer::uuid ORDER BY next_maintenance` },
    { type: 'TABLE', label: 'Recent orders', query: `SELECT o.number, o.type, o.status, s.name AS site, o.reported_at, o.completed_at FROM public.work_orders o JOIN public.sites s ON s.id = o.site WHERE s.customer = $VAR.customer::uuid ORDER BY o.reported_at DESC LIMIT 15` }
  ] } },
  { roles: ['Manager'], embed: 'PUBLIC', spec: { name: 'Service status', description: 'This week\'s service, public.', variables: [], widgets: [
    { type: 'KPI', label: 'Orders completed this week', query: `SELECT count(*) AS completed FROM public.work_orders WHERE status = 'COMPLETED' AND completed_at >= date_trunc('week', now())` },
    { type: 'KPI', label: 'Average response', description: 'From report to completion, this week.',
      query: `SELECT coalesce(round(avg(extract(epoch FROM completed_at - reported_at) / 3600)::numeric, 1), 0) AS hours FROM public.work_orders WHERE status = 'COMPLETED' AND completed_at >= date_trunc('week', now())`,
      config: { displayFormat: '0.0 h' } }
  ] } }
]

for (const { roles, spec, embed } of DASHBOARDS) {
  // A widget's description is part of its config.
  spec.widgets = spec.widgets.map(({ description, ...w }) => description ? { ...w, config: { ...w.config, description } } : w)
  let id = existing[spec.name]
  if (id) {
    const draft = await json('get_dashboard', { id })
    await call('apply_dashboard', { id, draft_version: draft.draftVersion, spec })
  } else {
    const applied = await json('apply_dashboard', { spec })
    if (!applied.applied) { console.error(spec.name, JSON.stringify(applied.errors ?? applied).slice(0, 1500)); process.exit(1) }
    id = applied.id ?? applied.dashboard?.id ?? rows(await json('list_dashboards', {})).find(d => d.name === spec.name)?.id
  }
  await call('publish_dashboard', { id, role_ids: roles.map(r => role[r]) })
  if (embed) {
    await call('update_dashboard', { id, embedding_enabled: true, ...(embed === 'SIGNED' && { scope: 'EMBEDDED_ONLY' }) })
    const embeds = rows(await json('list_embeds', { dashboard_id: id }))
    if (!embeds.length) {
      const made = embed === 'SIGNED'
        ? await call('create_embed', { dashboard_id: id, name: 'Customer website', type: 'SIGNED', variables: { customer: { mode: 'LOCKED' } } })
        : await call('create_embed', { dashboard_id: id, name: 'Public status page', type: 'LINK' })
      console.log(made.slice(0, 600))
    }
  }
  console.log('published', spec.name)
}
