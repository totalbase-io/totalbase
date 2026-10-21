// Presentation before any DataView (DATASET.md §5): how a referenced row shows, labels the
// humanized name doesn't get right, each state's label and color, money and dates.
import { writeFileSync } from 'node:fs'
const ARS = { displayFormat: 'CURRENCY:ARS', align: 'right' }
const o = (pairs) => Object.fromEntries(pairs.map(([v, label, color]) => [v, { label, color }]))
const rows = {
  branches: { display_field: 'name' }, technicians: { display_field: 'name' }, customers: { display_field: 'name' },
  sites: { display_field: 'name' }, equipment_models: { display_template: '{{brand}} {{model}}' }, equipment: { display_field: 'serial' },
  contracts: { display_template: '{{plan}} - {{starts_on}}' }, vehicles: { display_template: '{{plate}} ({{make}} {{model}})' },
  suppliers: { display_field: 'name' }, warehouses: { display_field: 'name' }, parts: { display_template: '{{sku}} - {{name}}' },
  purchase_orders: { display_template: '{{status}} - {{created_at}}' }, work_orders: { display_field: 'number' },
  projects: { display_field: 'name' }, project_tasks: { display_field: 'name' }, quotes: { display_template: '{{status}} - {{valid_until}}' },
  invoices: { display_field: 'number' }
}
const cols = {
  branches: { code: { label: 'Code', mono: true } },
  technicians: { user: { label: 'Person' }, hourly_cost: { label: 'Hourly cost', ...ARS } },
  customers: { parent: { label: 'Group' }, tax_id: { label: 'Tax ID (CUIT)', mono: true }, account_manager: { label: 'Account manager' },
    status: { options: o([['ACTIVE', 'Active', 'success'], ['PROSPECT', 'Prospect', 'info'], ['INACTIVE', 'Inactive', 'neutral']]) } },
  sites: { access_notes: { label: 'Access notes' }, branch: { label: 'Served by' } },
  equipment_models: { maintenance_interval_days: { label: 'Maintenance every (days)', shortLabel: 'Interval' },
    category: { options: o([['HVAC', 'HVAC', 'info'], ['SOLAR', 'Solar', 'warning'], ['GENERATOR', 'Generator', 'neutral']]) } },
  equipment: { serial: { label: 'Serial number', mono: true }, installed_on: { label: 'Installed', displayFormat: 'dd/MM/yyyy' }, warranty_until: { label: 'Warranty until', displayFormat: 'dd/MM/yyyy' },
    status: { options: o([['OPERATIONAL', 'Operational', 'success'], ['NEEDS_SERVICE', 'Needs service', 'warning'], ['OUT_OF_SERVICE', 'Out of service', 'error'], ['RETIRED', 'Retired', 'neutral']]) } },
  contracts: { response_hours: { label: 'Response time (hours)', shortLabel: 'Response' }, monthly_fee: { label: 'Monthly fee', ...ARS }, starts_on: { label: 'Starts', displayFormat: 'dd/MM/yyyy' }, ends_on: { label: 'Ends', displayFormat: 'dd/MM/yyyy' },
    plan: { options: o([['BASIC', 'Basic', 'neutral'], ['STANDARD', 'Standard', 'info'], ['PREMIUM', 'Premium', 'primary']]) } },
  vehicles: { plate: { mono: true }, technician: { label: 'Driver' }, odometer_km: { label: 'Odometer (km)', displayFormat: '#,##0' }, next_service_km: { label: 'Next service (km)', displayFormat: '#,##0' },
    insurance_until: { label: 'Insurance until', displayFormat: 'dd/MM/yyyy' }, inspection_until: { label: 'Inspection until', displayFormat: 'dd/MM/yyyy' },
    status: { options: o([['AVAILABLE', 'Available', 'success'], ['ON_ROUTE', 'On route', 'info'], ['IN_SHOP', 'In the shop', 'warning']]) } },
  vehicle_positions: { speed_kmh: { label: 'Speed (km/h)' }, recorded_at: { label: 'Recorded', displayFormat: 'dd/MM/yyyy HH:mm:ss' } },
  vehicle_maintenance: { done_on: { label: 'Date', displayFormat: 'dd/MM/yyyy' }, odometer_km: { label: 'Odometer (km)', displayFormat: '#,##0' }, cost: ARS,
    kind: { options: o([['SERVICE', 'Service', 'info'], ['TIRES', 'Tires', 'neutral'], ['REPAIR', 'Repair', 'warning'], ['INSPECTION', 'Inspection', 'success']]) } },
  suppliers: { lead_time_days: { label: 'Lead time (days)' } },
  warehouses: { kind: { options: o([['BRANCH', 'Branch', 'neutral'], ['VEHICLE', 'Van', 'info']]) } },
  parts: { sku: { label: 'SKU', mono: true }, unit_cost: { label: 'Cost', ...ARS }, unit_price: { label: 'Price', ...ARS }, reorder_point: { label: 'Reorder at' } },
  stock: { quantity: { label: 'On hand' } },
  stock_movements: { created_at: { label: 'When', displayFormat: 'dd/MM/yyyy HH:mm' },
    reason: { options: o([['PURCHASE', 'Purchase', 'success'], ['WORK_ORDER', 'Work order', 'info'], ['TRANSFER', 'Transfer', 'neutral'], ['ADJUSTMENT', 'Adjustment', 'warning']]) } },
  purchase_orders: { created_at: { label: 'Created', displayFormat: 'dd/MM/yyyy' }, received_at: { label: 'Received', displayFormat: 'dd/MM/yyyy' },
    status: { options: o([['DRAFT', 'Draft', 'neutral'], ['SENT', 'Sent', 'info'], ['RECEIVED', 'Received', 'success']]) } },
  purchase_order_items: { unit_cost: { label: 'Unit cost', ...ARS } },
  work_orders: { number: { label: 'Order', mono: true }, reported_at: { label: 'Reported', displayFormat: 'dd/MM/yyyy HH:mm' }, due_at: { label: 'Due', displayFormat: 'dd/MM/yyyy HH:mm' },
    completed_at: { label: 'Completed', displayFormat: 'dd/MM/yyyy HH:mm' }, customer_signature: { label: 'Customer signature', input: 'signature' }, signed_by: { label: 'Signed by' },
    type: { options: o([['REPAIR', 'Repair', 'error'], ['MAINTENANCE', 'Maintenance', 'info'], ['INSTALLATION', 'Installation', 'primary'], ['INSPECTION', 'Inspection', 'neutral']]) },
    priority: { options: o([['LOW', 'Low', 'neutral'], ['NORMAL', 'Normal', 'info'], ['HIGH', 'High', 'warning'], ['URGENT', 'Urgent', 'error']]) },
    status: { options: o([['NEW', 'New', 'neutral'], ['ASSIGNED', 'Assigned', 'info'], ['IN_PROGRESS', 'In progress', 'primary'], ['WAITING_PARTS', 'Waiting for parts', 'warning'], ['COMPLETED', 'Completed', 'success'], ['CANCELLED', 'Cancelled', 'error']]) } },
  visits: { scheduled_start: { label: 'Starts', displayFormat: 'dd/MM/yyyy HH:mm' }, scheduled_end: { label: 'Ends', displayFormat: 'dd/MM/yyyy HH:mm' },
    check_in_at: { label: 'Checked in', displayFormat: 'HH:mm' }, check_in_location: { label: 'Check-in location' }, check_out_at: { label: 'Checked out', displayFormat: 'HH:mm' } },
  time_entries: { started_at: { label: 'Started', displayFormat: 'dd/MM/yyyy HH:mm' }, ended_at: { label: 'Ended', displayFormat: 'HH:mm' } },
  work_order_parts: { unit_price: { label: 'Unit price', ...ARS } },
  work_order_photos: { taken_at: { label: 'Taken', displayFormat: 'dd/MM/yyyy HH:mm' } },
  projects: { starts_on: { label: 'Starts', displayFormat: 'dd/MM/yyyy' }, ends_on: { label: 'Ends', displayFormat: 'dd/MM/yyyy' },
    status: { options: o([['PLANNED', 'Planned', 'neutral'], ['IN_PROGRESS', 'In progress', 'info'], ['DONE', 'Done', 'success'], ['ON_HOLD', 'On hold', 'warning']]) } },
  project_tasks: { depends_on: { label: 'After' }, starts_on: { label: 'Starts', displayFormat: 'dd/MM/yyyy' }, ends_on: { label: 'Ends', displayFormat: 'dd/MM/yyyy' }, progress: { label: 'Progress (%)', displayFormat: '0%' } },
  quotes: { valid_until: { label: 'Valid until', displayFormat: 'dd/MM/yyyy' }, total: ARS, created_at: { label: 'Created', displayFormat: 'dd/MM/yyyy' },
    status: { options: o([['DRAFT', 'Draft', 'neutral'], ['SENT', 'Sent', 'info'], ['ACCEPTED', 'Accepted', 'success'], ['REJECTED', 'Rejected', 'error']]) } },
  quote_items: { unit_price: { label: 'Unit price', ...ARS }, discount_pct: { label: 'Discount (%)', displayFormat: '0.0%' } },
  invoices: { number: { mono: true }, issued_on: { label: 'Issued', displayFormat: 'dd/MM/yyyy' }, due_on: { label: 'Due', displayFormat: 'dd/MM/yyyy' }, tax_rate: { label: 'VAT (%)', displayFormat: '0%' },
    status: { options: o([['DRAFT', 'Draft', 'neutral'], ['ISSUED', 'Issued', 'info'], ['PAID', 'Paid', 'success'], ['OVERDUE', 'Overdue', 'error']]) } },
  invoice_items: { unit_price: { label: 'Unit price', ...ARS } }
}
const steps = [
  ...Object.entries(rows).map(([name, r]) => ['set_row_presentation', { name, ...r }]),
  ...Object.entries(cols).map(([name, columns]) => ['set_column_presentations', { name, columns, merge: true }]),
  // Rows colored by a condition: an overdue order and an order's priority - before any DataView, which inherits them
  // when it's published (DataViews.md §15).
  ['set_column_presentations', { name: 'work_orders', merge: true, columns: {
    number: { conditions: [{ name: 'Overdue', where: { due_at: { _lt: '$CURRENT_DATE' }, status: { _nin: ['COMPLETED', 'CANCELLED'] } }, applyTo: 'row', style: { color: 'red' } }] },
    priority: { conditions: [{ name: 'Urgent', where: { priority: { _eq: 'URGENT' } }, applyTo: 'row', style: { color: 'red' } }, { name: 'High', where: { priority: { _eq: 'HIGH' } }, applyTo: 'row', style: { color: 'amber' } }] } } }]
]
writeFileSync(new URL('./03-present.json', import.meta.url), JSON.stringify(steps))
console.log(steps.length)
