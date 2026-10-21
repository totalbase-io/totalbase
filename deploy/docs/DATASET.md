# Documentation demo - Acme Field Services

Status: Proposed · Roadmap: none (documentation tooling) · Recorded: 2026-10-14

The dataset behind the documentation site's screenshots and examples (`docs/`):
a fictional field service company that installs and maintains HVAC and solar
equipment at its customers' sites, with a vehicle fleet tracked by GPS. It
lives in its own database, `totalbase_docs`, in English, and every feature the
documentation covers has a natural place in it.

## 1. Principles

- **Its own database.** `totalbase_docs`, never the dev database: screenshots
  don't depend on what dev holds that day, and the Spanish demo (Empresa
  Ejemplo) stays as it is.
- **English throughout** - tables, columns, labels, records, templates - and
  the admin's language set to `en`.
- **Reproducible.** One reset rebuilds it from nothing to the same state, so a
  screenshot run only changes images when the UI changed.
- **Dates relative to a demo day.** Every date in the seed is an offset from
  an anchor the reset takes as *today* (`anchor + interval '3 days 09:30'`):
  "overdue", "this month" and `$PERIOD.*` widgets always have data, and only
  the date labels change between runs. Names, amounts, positions and ids
  (fixed uuids) never change.
- **Built through the MCP server**, the way a customer's agent would build it.
  What gets in the way is fixed in the MCP server. The result is then
  exported as the reset script (schema + TotalBase objects + rows).
- **PostgreSQL decides.** Stock, schedules and totals are constraints,
  triggers, functions and views, so the documentation shows the database
  doing the work.

## 2. The company

Acme Field Services: about 12 technicians, 10 vehicles, 40 customers with 70
sites and about 150 installed units, in northwestern Argentina. Currency ARS,
VAT 21%. Records stay in English (labels, descriptions, statuses); people,
streets and phone numbers are Argentine.

| Branch | Code | Role |
|---|---|---|
| Salta | SAL | Head office: management, accounting, the main warehouse |
| San Salvador de Jujuy | JUJ | Branch |
| San Miguel de Tucumán | TUC | Branch |

Sites and vehicle routes use real coordinates and streets around those three
cities; the Salta-Jujuy and Salta-Tucumán highways (RN 9, RN 34) carry the
trips between them.

## 3. Data model

Everything in schema `public` - tables, views, functions, triggers,
sequences. The one object outside it is the `branch` column added to
`totalbase.users` (§3.1), which `$USER.branch` needs. PostgreSQL conventions: plural tables, uuid `id`, FK columns
without `_id`, uppercase states, `timestamptz` for instants, `point` for
locations (x = longitude).

### 3.1 Organization

| Table | Key columns | Notes |
|---|---|---|
| `branches` | name, code (UNIQUE), address, location `point`, phone | |
| `totalbase.users` + `branch` | FK branches, nullable | Extends the users table (Foundations.md §11): the row filter `$USER.branch` |
| `technicians` | user (FK users, UNIQUE), branch, skills `text[]` (HVAC, SOLAR, ELECTRICAL), hourly_cost, color, photo (FK files), active | |

### 3.2 Customers and equipment

| Table | Key columns | Notes |
|---|---|---|
| `customers` | name, parent (FK customers - a group and its subsidiaries), tax_id, email, phone, status (ACTIVE, PROSPECT, INACTIVE), account_manager (FK users) | TREE |
| `sites` | customer, name, address, location `point`, access_notes, branch (the one that serves it) | MAP |
| `equipment_models` | brand, model, category (HVAC, SOLAR, GENERATOR), maintenance_interval_days | |
| `equipment` | site, model, serial (UNIQUE), installed_on, warranty_until, status (OPERATIONAL, NEEDS_SERVICE, OUT_OF_SERVICE, RETIRED), photo (FK files) | CARDS; the serial is read with the scanner |
| `contracts` | customer, plan (BASIC, STANDARD, PREMIUM), starts_on, ends_on, response_hours, monthly_fee | CHECK ends_on > starts_on |

### 3.3 Work

| Table | Key columns | Notes |
|---|---|---|
| `work_orders` | number (sequence, `WO-000123`), type (REPAIR, MAINTENANCE, INSTALLATION, INSPECTION), priority (LOW, NORMAL, HIGH, URGENT), status (NEW, ASSIGNED, IN_PROGRESS, WAITING_PARTS, COMPLETED, CANCELLED), site, equipment (nullable), branch, technician (nullable), reported_at, due_at (from the contract's response hours, trigger), completed_at (set by the status trigger when it becomes COMPLETED), description, resolution, customer_signature (FK files), signed_by | KANBAN, the core table |
| `visits` | work_order, technician, vehicle, scheduled_start, scheduled_end, check_in_at, check_in_location `point`, check_out_at | CALENDAR; check-in with geolocation |
| `time_entries` | work_order, technician, started_at, ended_at, minutes (generated), billable | |
| `work_order_parts` | work_order, part, warehouse, quantity, unit_price | Stock moves by trigger |
| `work_order_photos` | work_order, file (FK files), caption, taken_at | The camera |
| `projects` | customer, name, starts_on, ends_on, status | Installation projects |
| `project_tasks` | project, name, starts_on, ends_on, depends_on (FK project_tasks), technician, progress (0-100) | GANTT |

Constraints and logic in PostgreSQL:

- **No double booking.** A technician can't have two visits that overlap:
  `EXCLUDE USING gist (technician WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)`.
  It needs the `btree_gist` extension, which the demo's PostgreSQL container
  creates on first start (§11) - the documentation's example of a TotalBase
  installation relying on an extension.
- **`due_at`** is set by a trigger from the site's customer contract
  (`reported_at + response_hours`), or 72 h without a contract.
- **Status transitions** (no COMPLETED → NEW, no closing a CANCELLED order) in
  a trigger with a readable `RAISE EXCEPTION`.

### 3.4 Inventory and purchasing

| Table | Key columns | Notes |
|---|---|---|
| `warehouses` | branch, name, kind (BRANCH, VEHICLE - a van carries stock too), vehicle (nullable) | |
| `parts` | sku (UNIQUE), name, category, unit_cost, unit_price, reorder_point, supplier | |
| `stock` | part, warehouse, quantity | PK (part, warehouse); **CHECK quantity >= 0** |
| `stock_movements` | part, warehouse, quantity (+/-), reason (PURCHASE, WORK_ORDER, TRANSFER, ADJUSTMENT), work_order, purchase_order, created_at | Written by triggers, read-only through the API |
| `suppliers` | name, email, phone, lead_time_days | |
| `purchase_orders` + `purchase_order_items` | supplier, warehouse, status (DRAFT, SENT, RECEIVED); part, quantity, unit_cost | Receiving adds stock (trigger) |

A part used on a work order takes the stock out of its warehouse in the same
transaction. Not enough stock is the CHECK's error (`23514`), and the
documentation shows it as such.

### 3.5 Billing

| Table | Key columns | Notes |
|---|---|---|
| `quotes` + `quote_items` | customer, site, status (DRAFT, SENT, ACCEPTED, REJECTED), valid_until, total (kept by a trigger over its items); description, part (nullable), quantity, unit_price, discount_pct | CHECK discount_pct between 0 and 100 |
| `invoices` + `invoice_items` | number (sequence), customer, work_order (nullable), issued_on, due_on, status (DRAFT, ISSUED, PAID, OVERDUE), tax_rate; description, quantity, unit_price | |

Functions: `quote_total(quote)`, `invoice_total(invoice)`,
`create_invoice_from_work_order(work_order)` (hours at the plan's rate +
parts), `issue_invoice_from_quote(p_quote)` (the invoice of an accepted quote,
returning its PDF) and `assign_work_order(p_work_order, p_technician, p_start)`
(assigns the order and schedules its visit in one transaction - the Dispatch
board's call), exposed as FUNCTION resources.

`parameters` (key, value `jsonb`, title, description, section, position): the
company's own settings - default tax rate, response hours without a contract,
the alerts email - edited with a SETTINGS DataView.

### 3.6 Fleet

| Table | Key columns | Notes |
|---|---|---|
| `vehicles` | plate (UNIQUE), make, model, year, branch, technician (nullable - assigned driver), status (AVAILABLE, ON_ROUTE, IN_SHOP), odometer_km, insurance_until, inspection_until, next_service_km, photo (FK files) | |
| `vehicle_positions` | vehicle, location `point`, speed_kmh, heading, recorded_at | Append-only: CREATE grant only, no UPDATE or DELETE for anyone; index (vehicle, recorded_at DESC) |
| `vehicle_maintenance` | vehicle, kind (SERVICE, TIRES, REPAIR, INSPECTION), done_on, odometer_km, cost, notes | |

Views:

- **`vehicles_latest_positions`** - the latest position of each vehicle
  (`DISTINCT ON (vehicle) ... ORDER BY vehicle, recorded_at DESC`), with its
  plate, status, driver and branch: the live fleet map.
- **`work_orders_overview`** - an order with its customer, site, technician,
  hours, parts total and `due_at < now()` as `overdue`.
- **`stock_alerts`** - parts at or below their reorder point, per warehouse.
- **`orders_due_soon`** - open orders due within the next 2 hours: what *SLA
  watch* reads ("within 2 h" is a future window, which the filter variables
  don't express - `$INTERVAL` is now minus a duration).

The view columns are the documentation's: `vehicles_latest_positions` has
vehicle, plate, status, driver, branch, location, recorded_at.

## 4. Roles and permissions

| Role | Sees and does |
|---|---|
| Administrator | Everything (TotalBase administrator) |
| Manager | Reads everything; approves quotes; any discount |
| Dispatcher | Their branch (`branch = $USER.branch`): creates and assigns work orders, schedules visits; reads fleet and stock of their branch |
| Technician | Work orders assigned to them (`technician.user = $USER.id`); updates status, resolution, signature; adds visits' check-in, time, parts and photos on those orders; reads their own vehicle and its stock |
| Sales | Customers where `account_manager = $USER.id`, their sites, contracts and quotes |
| Accounting | Invoices and purchase orders; reads customers |
| Customer portal | No account - the signed embed (§7) |
| GPS device | A token's role: CREATE on `vehicle_positions` only, fields vehicle, location, speed_kmh, heading, recorded_at |

Payload checks, the examples the security pages need:

- **Discount cap**: Sales and Dispatcher write `quote_items` only with
  `discount_pct <= 20`; Manager has no such check.
- **Closing an order**: a Technician can set `status = COMPLETED` only with
  `resolution` and `customer_signature` not null
  (`{"_or": [{"status": {"_neq": "COMPLETED"}}, {"_and": [{"resolution": {"_nnull": true}}, {"customer_signature": {"_nnull": true}}]}]}`).

Row filters combine with OR across roles: a user who is Dispatcher and Sales
sees both sets, an example for the Permissions concept page.

Users (fixed names, `@acme-field.example` addresses): one Manager, three
Dispatchers (one per branch), twelve Technicians, two Sales, one Accounting.

## 5. DataViews

| DataView | Type | Shows |
|---|---|---|
| Customers | TREE | Groups and subsidiaries, with a Sites relation panel |
| Sites | MAP | Every site, colored by branch |
| Equipment | CARDS | Photo, model, serial, status color |
| Work orders | KANBAN | By status, card colored by priority, Master-detail form with Visits, Time, Parts and Photos panels |
| Work orders (list) | TABLE | Saved views: "Overdue", "Unassigned", "My branch this week" |
| My work | TABLE, phone-first | A technician's open orders for today |
| Work order (technician) | FORM | Check-in (Location), photos (Camera), parts, signature (Signature), close |
| Schedule | CALENDAR | Visits, colored by technician |
| Projects | GANTT | Project tasks, a swimlane per project, bars filled by progress (a Gantt draws no dependency links) |
| Fleet map | MAP | `vehicles_latest_positions`, auto-refresh 10 s, colored by status |
| Vehicles | TABLE | With Maintenance and Positions panels |
| Stock | TABLE | Per warehouse, `stock_alerts` highlighted |
| Purchase orders | FORM | Master-detail with its items |
| Quotes | FORM | Master-detail, discount check, PDF |
| Invoices | TABLE | Status colors, PDF, export |
| Parameters | SETTINGS | `parameters`, by section |
| Supplier portal | EXTERNALFRAME | The parts supplier's order tracking page |
| Dispatch board | CUSTOM | Pick an unassigned order; see free technicians and nearby vehicles on one map; assign and schedule in one step |
| New service request | CUSTOM | Find the customer and site, the equipment by scanning its serial, check the contract, create the order |

Column presentation is set for every table (labels, state colors) and row
presentation for every referenced table (a site by its name, a vehicle by
`{{plate}} ({{make}} {{model}})` - a template names only the table's own
columns) before any DataView is built.

## 6. Dashboards

| Dashboard | Widgets | Variables |
|---|---|---|
| Operations | Open orders by status, SLA met this month (%, from `completed_at` and `due_at`), overdue orders table, orders by branch, technician utilization | `$VAR.branch`, `$VAR.period` (a Date range) |
| Fleet | Vehicles by status, km per vehicle this month, map of latest positions, expiring insurance and inspections | `$VAR.branch` |
| Finance | Revenue by month, invoices by status, top customers, quote conversion | `$VAR.period` (a Date range - `$PERIOD` is the Data API's, not available in widget SQL) |
| Inventory | Stock value by warehouse, parts below reorder point, consumption by category | `$VAR.warehouse` |
| Customer portal | Their sites and equipment, open and recent orders, next maintenance | `$VAR.customer` locked by the embed |

## 7. Embeds

- **Customer portal**: a signed embed of the Customer portal dashboard. The
  customer's own (fictional) website signs a short-lived token per visit, with
  `$VAR.customer` locked to that customer. The documentation's example of the
  signed flow.
- **Public status**: a public link to a small "Service status" dashboard
  (orders completed this week, average response time), data that may be
  public.

## 8. Workflows

| Workflow | Trigger | Steps |
|---|---|---|
| SLA watch | CRON every 15 min | Read `orders_due_soon` → email the branch's dispatcher |
| Order completed | DATA_EVENT `work_orders` UPDATE to COMPLETED | Execute `create_invoice_from_work_order` → PDF from the work order template → email the customer with the PDF |
| Reorder parts | DATA_EVENT `work_order_parts` CREATE | Read the part's stock in that warehouse; at or below its reorder point, create a DRAFT purchase order for the supplier, or add to an open one (stock itself changes by trigger, and trigger-made writes emit no data events) |
| Service request intake | WEBHOOK (the customer's website form) | Validate data → find the site by the customer's email → create a NEW work order → email confirmation |
| Fleet expirations | CRON daily 07:00 | Vehicles with insurance or inspection expiring within 30 days, or past their service km → one email digest |
| Maintenance plan | CRON monthly | For each unit due by its model's interval, create a MAINTENANCE order |
| Accounting sync | DATA_EVENT `invoices` CREATE | HTTP request to the (fictional) accounting system, its API key a secret header - the documentation's outgoing-integration example (there is no separate webhooks feature) |

## 9. Templates

- **PDF**: work order (with photos and the customer's signature), quote,
  invoice, equipment label (QR with the equipment's id).
- **Email**: visit scheduled, order completed (with the PDF), quote sent, SLA
  alert, fleet digest; and the system templates (invitation, welcome) with
  Acme's branding.

## 10. Seed data

| Data | Volume |
|---|---|
| Customers / sites / equipment | 40 / 70 / 150 |
| Work orders | about 300 over the last 6 months, about 30 open |
| Visits / time entries | about 400 / 600 |
| Parts / warehouses | 60 / 3 branch + 10 vehicle |
| Quotes / invoices | 40 / 200 |
| Projects / tasks | 4 / 40 |
| Vehicle positions | One recorded day per vehicle along real streets, every 30 s while on route (about 10 vehicles x 800 points) |
| Files | Generated images: equipment and vehicle photos, technician portraits, customer signatures, work order photos - small, no real people or brands |

Positions are recorded routes, shifted to the demo day, so the fleet map
looks alive and identical in every run. A small simulator script (outside the
seed) replays them through the Data API with the GPS device token, for the
live map's GIF.

## 11. How it is built

1. A Docker Compose for the demo, shaped like `deploy/lab`: PostgreSQL 18
   whose init script (`docker-entrypoint-initdb.d`) creates the
   `totalbase_docs` database, its non-superuser owner role and
   `CREATE EXTENSION btree_gist` in it, plus a TotalBase instance pointed at
   it (language `en`).
2. Build schema, permissions, presentations, DataViews, dashboards, workflows
   and templates through the MCP server, in the order of the `build` guide;
   log findings.
3. Export the reset: SQL for schema and rows (`anchor`-relative dates), plus
   the TotalBase objects. Where it lives (`docs/demo/`) and how it runs (one
   script) is decided with step 2's result.
4. The screenshot script (Playwright, outside the test suites) resets the
   database, signs in as each role it needs and captures light and dark
   versions into `docs/public/screenshots/`.

## 12. Decisions

Recorded 2026-10-14:

- **Geography**: northwestern Argentina, Salta as head office, branches in
  Jujuy and Tucumán (§2).
- **`btree_gist`**: created by the demo's Docker init script (§11); the
  exclusion constraint relies on it.
- **Images**: generated (§10).
- **Schema**: everything in `public` (§3).
