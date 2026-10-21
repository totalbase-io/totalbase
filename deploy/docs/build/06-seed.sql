-- Seed rows (DATASET.md §10). Dates are offsets from the demo day (today at 00:00),
-- random() runs from a fixed seed and ids are md5 of a stable key: every reset yields the same rows,
-- only their dates move with the day.
CREATE OR REPLACE FUNCTION pg_temp.uid(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('acme:' || k)::uuid $$;
CREATE OR REPLACE FUNCTION pg_temp.d0() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT date_trunc('day', now()) $$;
SELECT setseed(0.42);

-- A reset: everything the seed writes goes first (the reference rows of 04-reference.sql stay).
TRUNCATE technicians, vehicles, vehicle_positions, vehicle_maintenance, warehouses, stock, stock_movements, purchase_orders,
  purchase_order_items, customers, sites, contracts, equipment, work_orders, visits, time_entries, work_order_parts,
  work_order_photos, projects, project_tasks, quotes, quote_items, invoices, invoice_items CASCADE;
INSERT INTO warehouses (id, branch, name, kind) SELECT pg_temp.uid('warehouse:' || code), id, 'Warehouse ' || code, 'BRANCH' FROM branches;

-- Technicians: the users holding Technician, by name.
INSERT INTO technicians (id, "user", name, branch, skills, hourly_cost, color)
SELECT pg_temp.uid('tech:' || u.email), u.id, u.name, u.branch,
  CASE (row_number() OVER (ORDER BY u.email))::int % 4 WHEN 0 THEN ARRAY['HVAC', 'ELECTRICAL'] WHEN 1 THEN ARRAY['SOLAR', 'ELECTRICAL'] WHEN 2 THEN ARRAY['HVAC'] ELSE ARRAY['HVAC', 'SOLAR'] END,
  14000 + 1000 * ((row_number() OVER (ORDER BY u.email))::int % 5),
  (ARRAY['primary', 'info', 'success', 'warning', 'error', 'secondary'])[1 + (row_number() OVER (ORDER BY u.email))::int % 6]
FROM totalbase.users u
JOIN totalbase.users_roles a ON a."user" = u.id
JOIN totalbase.roles r ON r.id = a.role AND r.name = 'Technician';
-- Each branch's first technician by name leads it; the others report to them.
UPDATE technicians t SET lead = l.id
FROM (SELECT DISTINCT ON (branch) id, branch FROM technicians ORDER BY branch, name) l
WHERE l.branch = t.branch AND l.id <> t.id;

-- The fleet: ten vans, ten of the twelve technicians drive one; each van is a warehouse too.
INSERT INTO vehicles (id, plate, make, model, year, branch, technician, status, odometer_km, insurance_until, inspection_until, next_service_km)
SELECT pg_temp.uid('vehicle:' || n), v.plate, v.make, v.model, v.year, t.branch, t.id,
  (ARRAY['ON_ROUTE', 'ON_ROUTE', 'AVAILABLE', 'ON_ROUTE', 'IN_SHOP'])[1 + n % 5],
  v.km, (pg_temp.d0() + (v.ins || ' days')::interval)::date, (pg_temp.d0() + (v.insp || ' days')::interval)::date, v.km + v.svc
FROM (VALUES
  (1, 'AE 412 KD', 'Renault', 'Kangoo', 2021, 84200, 120, 200, 3800), (2, 'AF 118 JX', 'Peugeot', 'Partner', 2022, 61500, 25, 160, 9500),
  (3, 'AD 905 LM', 'Fiat', 'Fiorino', 2019, 132700, 210, 18, 1300), (4, 'AG 377 PQ', 'Renault', 'Kangoo', 2023, 28900, 300, 330, 1100),
  (5, 'AE 760 RS', 'Toyota', 'Hilux', 2021, 97400, 12, 90, 2600), (6, 'AF 233 TB', 'Peugeot', 'Partner', 2022, 70100, 150, 240, 4900),
  (7, 'AC 581 WZ', 'Ford', 'Ranger', 2018, 168300, 60, 7, 700), (8, 'AG 042 NV', 'Fiat', 'Fiorino', 2023, 19800, 280, 310, 10200),
  (9, 'AF 694 HC', 'Toyota', 'Hilux', 2022, 75600, 95, 45, 4400), (10, 'AD 318 YE', 'Renault', 'Kangoo', 2020, 118900, 190, 120, 1100)
) AS v (n, plate, make, model, year, km, ins, insp, svc)
JOIN (SELECT id, branch, row_number() OVER (ORDER BY name) AS rn FROM technicians) t ON t.rn = v.n;

INSERT INTO warehouses (id, branch, name, kind, vehicle)
SELECT pg_temp.uid('warehouse:van:' || plate), branch, 'Van ' || plate, 'VEHICLE', id FROM vehicles;

INSERT INTO vehicle_maintenance (vehicle, kind, done_on, odometer_km, cost, notes)
SELECT v.id, (ARRAY['SERVICE', 'TIRES', 'REPAIR', 'INSPECTION'])[1 + (g + length(v.plate)) % 4],
  (pg_temp.d0() - (g * 55 || ' days')::interval)::date, greatest(0, v.odometer_km - g * 6500), 45000 + (g * 23000) % 160000,
  (ARRAY['10,000 km service', 'Four new tires', 'Brake pads', 'Annual technical inspection'])[1 + (g + length(v.plate)) % 4]
FROM vehicles v, generate_series(1, 3) g;

-- Customers: four groups with their subsidiaries, and independent ones.
INSERT INTO customers (id, name, parent, tax_id, email, phone, status, account_manager)
SELECT pg_temp.uid('customer:' || c.n), c.name, CASE WHEN c.parent IS NOT NULL THEN pg_temp.uid('customer:' || c.parent) END,
  '30-' || lpad((70000000 + c.n * 137911)::text, 8, '0') || '-' || (c.n % 10), lower(regexp_replace(c.name, '[^A-Za-z]+', '', 'g')) || '@example.com',
  '+54 ' || (ARRAY['387', '388', '381'])[1 + c.n % 3] || ' 4' || lpad((c.n * 7919 % 1000000)::text, 6, '0'),
  CASE WHEN c.n % 13 = 0 THEN 'PROSPECT' WHEN c.n % 17 = 0 THEN 'INACTIVE' ELSE 'ACTIVE' END,
  (SELECT id FROM totalbase.users WHERE email = (ARRAY['lucia.figueroa@acme-field.example', 'martin.cruz@acme-field.example'])[1 + c.n % 2])
FROM (VALUES
  (1, 'Grupo Norte Hoteles', NULL), (2, 'Hotel Salta Plaza', 1), (3, 'Hotel Cerro Jujuy', 1), (4, 'Posada Tucumán Centro', 1),
  (5, 'Supermercados del Valle', NULL), (6, 'Del Valle Salta Centro', 5), (7, 'Del Valle Tres Cerritos', 5), (8, 'Del Valle Yerba Buena', 5), (9, 'Del Valle Palpalá', 5),
  (10, 'Clínicas Andinas', NULL), (11, 'Clínica Andina Salta', 10), (12, 'Clínica Andina Jujuy', 10),
  (13, 'Agroindustrias Calchaquí', NULL), (14, 'Bodega Calchaquí', 13), (15, 'Packing Calchaquí Rosario de Lerma', 13),
  (16, 'Escuela Técnica N° 3', NULL), (17, 'Colegio San Martín', NULL), (18, 'Banco Regional del NOA', NULL), (19, 'Farmacia Belgrano', NULL),
  (20, 'Cines del Norte', NULL), (21, 'Gimnasio Activa', NULL), (22, 'Restaurante La Casona', NULL), (23, 'Panadería El Molino', NULL),
  (24, 'Estudio Jurídico Arias', NULL), (25, 'Municipalidad de Yerba Buena', NULL), (26, 'Universidad del Noroeste', NULL),
  (27, 'Frigorífico San Javier', NULL), (28, 'Concesionaria Ruta 9', NULL), (29, 'Hostel Los Lapachos', NULL), (30, 'Club Atlético Gimnasia', NULL),
  (31, 'Laboratorio Bioanálisis', NULL), (32, 'Ferretería Industrial NOA', NULL), (33, 'Centro Médico San Lorenzo', NULL), (34, 'Café Martínez Jujuy', NULL),
  (35, 'Shopping Alto Noa', NULL), (36, 'Data Center Tucumán', NULL), (37, 'Imprenta Güemes', NULL), (38, 'Lavadero El Rápido', NULL),
  (39, 'Residencia Los Ceibos', NULL), (40, 'Taller Mecánico Ortiz', NULL)
) AS c (n, name, parent)
ORDER BY c.parent NULLS FIRST, c.n;

-- Sites: about 70 around the three cities, served by the nearest branch.
INSERT INTO sites (id, customer, name, address, location, access_notes, branch)
SELECT pg_temp.uid('site:' || c.n || ':' || s), pg_temp.uid('customer:' || c.n),
  CASE WHEN s = 1 THEN 'Main building' ELSE (ARRAY['Annex', 'Warehouse', 'Branch office', 'Rooftop'])[1 + (c.n + s) % 4] END,
  (ARRAY['Av. Belgrano', 'Calle Caseros', 'Av. San Martín', 'Calle España', 'Av. Roca', 'Calle Mitre', 'Av. Sarmiento', 'Calle Alvarado'])[1 + (c.n * s) % 8]
    || ' ' || (100 + (c.n * 37 + s * 211) % 2400),
  point(b.x + ((c.n * 13 + s * 7) % 41 - 20) * 0.0016, b.y + ((c.n * 11 + s * 5) % 37 - 18) * 0.0014),
  CASE WHEN (c.n + s) % 4 = 0 THEN 'Ask for maintenance at the front desk; parking at the back.' END, b.id
FROM generate_series(1, 40) AS c (n)
CROSS JOIN LATERAL generate_series(1, CASE WHEN c.n % 3 = 0 THEN 1 WHEN c.n % 5 = 0 THEN 3 ELSE 2 END) AS s
CROSS JOIN LATERAL (
  SELECT id, location[0] AS x, location[1] AS y FROM branches
  WHERE code = (ARRAY['SAL', 'SAL', 'JUJ', 'TUC', 'SAL', 'TUC'])[1 + (c.n + s) % 6]
) b
WHERE c.n NOT IN (1, 5, 10, 13);

INSERT INTO contracts (customer, plan, starts_on, ends_on, response_hours, monthly_fee)
SELECT c.id, p.plan, (pg_temp.d0() - interval '200 days')::date, (pg_temp.d0() + interval '165 days')::date, p.hours, p.fee
FROM customers c
CROSS JOIN LATERAL (SELECT (ARRAY['BASIC', 'STANDARD', 'PREMIUM'])[1 + abs(hashtext(c.name)) % 3] AS plan) pl
JOIN (VALUES ('BASIC', 72, 180000), ('STANDARD', 24, 350000), ('PREMIUM', 8, 720000)) AS p (plan, hours, fee) ON p.plan = pl.plan
WHERE c.status = 'ACTIVE' AND c.parent IS NOT NULL OR (c.status = 'ACTIVE' AND c.parent IS NULL AND abs(hashtext(c.name)) % 2 = 0 AND NOT EXISTS (SELECT 1 FROM customers k WHERE k.parent = c.id));

-- Equipment: about 150 units on the sites.
INSERT INTO equipment (id, site, model, serial, installed_on, warranty_until, status)
SELECT pg_temp.uid('equipment:' || s.id || ':' || g), s.id, pg_temp.uid('model:' || (1 + (abs(hashtext(s.id::text)) + g) % 8)),
  upper(substr(md5(s.id::text || g), 1, 3)) || '-' || lpad((abs(hashtext(s.id::text || g)) % 1000000)::text, 6, '0'),
  (pg_temp.d0() - ((200 + abs(hashtext(s.id::text || g)) % 1600) || ' days')::interval)::date,
  (pg_temp.d0() - ((200 + abs(hashtext(s.id::text || g)) % 1600) || ' days')::interval + interval '2 years')::date,
  (ARRAY['OPERATIONAL', 'OPERATIONAL', 'OPERATIONAL', 'NEEDS_SERVICE', 'OPERATIONAL', 'OUT_OF_SERVICE', 'OPERATIONAL'])[1 + (abs(hashtext(s.id::text)) + g) % 7]
FROM sites s, generate_series(1, 2 + abs(hashtext(s.name || s.id)) % 2) g;

-- Stock: plenty in the branch warehouses, a little on each van.
INSERT INTO stock (part, warehouse, quantity)
SELECT p.id, w.id, CASE WHEN w.kind = 'BRANCH' THEN p.reorder_point * 6 + 20 ELSE p.reorder_point + 3 END
FROM parts p CROSS JOIN warehouses w;

-- Work orders: about 300 over the last six months, about 30 still open.
-- A pooled connection may still hold it from an earlier run of this script.
DROP TABLE IF EXISTS pg_temp.seed_orders;
CREATE TEMP TABLE seed_orders AS
SELECT g, s.id AS site, s.branch, e.id AS equipment,
  (g > 290 OR (g > 230 AND g % 3 = 0)) AS open,
  CASE WHEN g > 290 OR (g > 230 AND g % 3 = 0) THEN pg_temp.d0() - (((300 - g) % 4) || ' days')::interval + ((8 + g % 10) || ' hours')::interval - interval '1 day'
       ELSE pg_temp.d0() - ((180 - g * 0.6) || ' days')::interval + ((8 + g % 9) || ' hours')::interval END AS reported_at,
  (ARRAY['REPAIR', 'MAINTENANCE', 'REPAIR', 'INSTALLATION', 'INSPECTION', 'MAINTENANCE'])[1 + g % 6] AS type,
  (ARRAY['NORMAL', 'HIGH', 'NORMAL', 'LOW', 'URGENT', 'NORMAL', 'HIGH'])[1 + g % 7] AS priority
FROM generate_series(1, 300) g
CROSS JOIN LATERAL (SELECT id, branch FROM sites ORDER BY md5(sites.id::text || g) LIMIT 1) s
LEFT JOIN LATERAL (SELECT id FROM equipment WHERE site = s.id ORDER BY md5(equipment.id::text || g) LIMIT 1) e ON g % 5 <> 0;

INSERT INTO work_orders (id, number, type, priority, status, site, equipment, branch, technician, reported_at, completed_at, description, resolution, signed_by)
SELECT pg_temp.uid('wo:' || o.g), 'WO-' || lpad((1000 + o.g)::text, 6, '0'), o.type, o.priority,
  CASE WHEN NOT o.open THEN CASE WHEN o.g % 23 = 0 THEN 'CANCELLED' ELSE 'COMPLETED' END
       ELSE (ARRAY['NEW', 'ASSIGNED', 'IN_PROGRESS', 'ASSIGNED', 'WAITING_PARTS', 'NEW', 'IN_PROGRESS'])[1 + o.g % 7] END,
  o.site, o.equipment, o.branch,
  CASE WHEN o.open AND (o.g % 7 IN (0, 5)) THEN NULL ELSE t.id END,
  o.reported_at,
  CASE WHEN NOT o.open AND o.g % 23 <> 0 THEN least(o.reported_at + ((4 + o.g % 40) || ' hours')::interval, now() - interval '1 hour') END,
  (ARRAY['Unit not cooling, warm air from the vents.', 'Scheduled maintenance visit.', 'Water dripping from the indoor unit.',
    'Install a new unit in the meeting room.', 'Annual inspection of the installation.', 'Inverter showing a fault code.',
    'Generator does not start on power loss.', 'Strange noise from the outdoor unit.'])[1 + o.g % 8],
  CASE WHEN NOT o.open AND o.g % 23 <> 0 THEN (ARRAY['Replaced the run capacitor; cooling restored.', 'Cleaned filters and coils; checked pressures.',
    'Cleared the condensate drain and replaced the pump.', 'Installed and commissioned the unit.', 'Inspection passed; report attached.',
    'Replaced the inverter fan; fault cleared.', 'Replaced the starter battery; tested the transfer.', 'Replaced the fan motor bearings.'])[1 + o.g % 8] END,
  CASE WHEN NOT o.open AND o.g % 23 <> 0 THEN (ARRAY['R. Gómez', 'M. Álvarez', 'C. Pereyra', 'L. Torres', 'S. Díaz'])[1 + o.g % 5] END
FROM seed_orders o
CROSS JOIN LATERAL (SELECT id FROM technicians WHERE branch = o.branch ORDER BY md5(technicians.id::text || o.g) LIMIT 1) t
ORDER BY o.g;
SELECT setval('work_order_numbers', 1300);

-- Visits: one per assigned order, never two at once for a technician (the exclusion constraint holds).
INSERT INTO visits (work_order, technician, vehicle, scheduled_start, scheduled_end, check_in_at, check_in_location, check_out_at)
SELECT o.id, o.technician, (SELECT id FROM vehicles WHERE technician = o.technician),
  v.start, v.start + interval '2 hours',
  CASE WHEN o.status IN ('COMPLETED', 'IN_PROGRESS', 'WAITING_PARTS') THEN v.start + interval '7 minutes' END,
  CASE WHEN o.status IN ('COMPLETED', 'IN_PROGRESS', 'WAITING_PARTS') THEN s.location END,
  CASE WHEN o.status = 'COMPLETED' THEN v.start + interval '1 hour 50 minutes' END
FROM (SELECT *, row_number() OVER (PARTITION BY technician ORDER BY reported_at) AS rn FROM work_orders WHERE technician IS NOT NULL AND status <> 'CANCELLED') o
JOIN sites s ON s.id = o.site
CROSS JOIN LATERAL (SELECT date_trunc('day', o.reported_at) + interval '1 day' + ((8 + 3 * (o.rn % 3)) || ' hours 30 minutes')::interval
  + CASE WHEN o.status IN ('NEW', 'ASSIGNED') THEN ((o.rn % 4) || ' days')::interval ELSE interval '0' END AS start) v
ON CONFLICT DO NOTHING;
-- A second visit on some completed orders: a return trip, two weeks later.
INSERT INTO visits (work_order, technician, vehicle, scheduled_start, scheduled_end, check_in_at, check_out_at)
SELECT v.work_order, v.technician, v.vehicle, v.scheduled_start + interval '14 days 1 hour', v.scheduled_end + interval '14 days 1 hour',
  v.check_in_at + interval '14 days 1 hour', v.check_out_at + interval '14 days 1 hour'
FROM visits v JOIN work_orders o ON o.id = v.work_order
WHERE o.status = 'COMPLETED' AND abs(hashtext(o.number)) % 3 = 0
ON CONFLICT DO NOTHING;

INSERT INTO time_entries (work_order, technician, started_at, ended_at, billable)
SELECT v.work_order, v.technician, v.check_in_at, v.check_in_at + ((45 + abs(hashtext(v.id::text)) % 120) || ' minutes')::interval, abs(hashtext(v.id::text)) % 9 <> 0
FROM visits v WHERE v.check_in_at IS NOT NULL;

-- Parts used: one or two per repair or maintenance, from the van when it has one (the trigger moves the stock).
INSERT INTO work_order_parts (work_order, part, warehouse, quantity, unit_price)
SELECT o.id, p.id, CASE WHEN o.status = 'IN_PROGRESS' THEN coalesce(vw.id, bw.id) ELSE bw.id END, 1 + abs(hashtext(o.number || p.sku)) % 2, p.unit_price
FROM work_orders o
JOIN equipment e ON e.id = o.equipment JOIN equipment_models m ON m.id = e.model
CROSS JOIN LATERAL (SELECT id, sku, unit_price FROM parts WHERE category = m.category ORDER BY md5(parts.id::text || o.number) LIMIT 1 + abs(hashtext(o.number)) % 2) p
JOIN warehouses bw ON bw.branch = o.branch AND bw.kind = 'BRANCH'
LEFT JOIN vehicles veh ON veh.technician = o.technician
LEFT JOIN warehouses vw ON vw.vehicle = veh.id
WHERE o.type IN ('REPAIR', 'MAINTENANCE') AND o.status IN ('COMPLETED', 'IN_PROGRESS');

-- A few parts low on purpose: the stock alerts have something to show.
UPDATE stock SET quantity = least(quantity, 1) WHERE part IN (SELECT id FROM parts WHERE sku IN ('HV-FAN-01', 'SO-SPD-01', 'GE-BAT-12')) AND warehouse IN (SELECT id FROM warehouses WHERE kind = 'BRANCH');

-- Quotes: about 40, the newer ones still open.
INSERT INTO quotes (id, customer, site, status, valid_until, created_at)
SELECT pg_temp.uid('quote:' || g), s.customer, s.id,
  CASE WHEN g > 32 THEN (ARRAY['DRAFT', 'SENT'])[1 + g % 2] ELSE (ARRAY['ACCEPTED', 'REJECTED', 'ACCEPTED', 'SENT'])[1 + g % 4] END,
  (pg_temp.d0() - ((160 - g * 4) || ' days')::interval + interval '30 days')::date, pg_temp.d0() - ((160 - g * 4) || ' days')::interval
FROM generate_series(1, 40) g
CROSS JOIN LATERAL (SELECT id, customer FROM sites ORDER BY md5(sites.id::text || 'q' || g) LIMIT 1) s;
INSERT INTO quote_items (quote, description, part, quantity, unit_price, discount_pct)
SELECT q.id, coalesce(p.name, 'Installation labor'), p.id, CASE WHEN p.id IS NULL THEN 6 ELSE 1 + i % 3 END,
  coalesce(p.unit_price, 24000), (ARRAY[0, 5, 10, 0, 15, 20])[1 + (i + length(q.id::text)) % 6]
FROM quotes q, generate_series(1, 3) i
LEFT JOIN LATERAL (SELECT id, name, unit_price FROM parts WHERE i < 3 ORDER BY md5(parts.id::text || q.id::text || i) LIMIT 1) p ON true;

-- Invoices: one per completed order (about 200 of them), paid but for the latest.
INSERT INTO invoices (id, number, customer, work_order, issued_on, due_on, status, tax_rate)
SELECT pg_temp.uid('invoice:' || o.number), 'A-0001-' || lpad((5000 + rn)::text, 8, '0'), s.customer, o.id,
  o.completed_at::date, o.completed_at::date + 30,
  CASE WHEN o.completed_at > pg_temp.d0() - interval '20 days' THEN 'ISSUED'
       WHEN o.completed_at > pg_temp.d0() - interval '45 days' AND rn % 4 = 0 THEN 'OVERDUE' ELSE 'PAID' END, 21
FROM (SELECT *, row_number() OVER (ORDER BY completed_at) AS rn FROM work_orders WHERE status = 'COMPLETED') o
JOIN sites s ON s.id = o.site
WHERE o.rn > 40;
SELECT setval('invoice_numbers', 5300);
INSERT INTO invoice_items (invoice, description, quantity, unit_price)
SELECT i.id, 'Labor - ' || o.number, round(greatest(sum(te.minutes), 60) / 60.0, 2), 24000
FROM invoices i JOIN work_orders o ON o.id = i.work_order LEFT JOIN time_entries te ON te.work_order = o.id
GROUP BY i.id, o.number;
INSERT INTO invoice_items (invoice, description, quantity, unit_price)
SELECT i.id, p.name, wp.quantity, wp.unit_price
FROM invoices i JOIN work_order_parts wp ON wp.work_order = i.work_order JOIN parts p ON p.id = wp.part;

-- Projects: four installations, ten tasks each, one after another.
INSERT INTO projects (id, customer, name, starts_on, ends_on, status)
SELECT pg_temp.uid('project:' || p.n), pg_temp.uid('customer:' || p.customer), p.name,
  (pg_temp.d0() + (p.start || ' days')::interval)::date, (pg_temp.d0() + ((p.start + 60) || ' days')::interval)::date, p.status
FROM (VALUES (1, 36, 'Data Center Tucumán - cooling', -40, 'IN_PROGRESS'), (2, 26, 'University solar plant', -20, 'IN_PROGRESS'),
  (3, 35, 'Shopping Alto Noa - HVAC renewal', 10, 'PLANNED'), (4, 27, 'Frigorífico backup generators', -75, 'DONE')) AS p (n, customer, name, start, status);
INSERT INTO project_tasks (id, project, name, starts_on, ends_on, depends_on, technician, progress)
SELECT pg_temp.uid('task:' || p.id || ':' || k), p.id, t.name, p.starts_on + (k - 1) * 6, p.starts_on + (k - 1) * 6 + 5,
  CASE WHEN k > 1 THEN pg_temp.uid('task:' || p.id || ':' || (k - 1)) END,
  (SELECT id FROM technicians ORDER BY md5(technicians.id::text || p.id::text || k) LIMIT 1),
  CASE WHEN p.status = 'DONE' THEN 100 WHEN p.status = 'PLANNED' THEN 0
       ELSE greatest(0, least(100, ((current_date - (p.starts_on + (k - 1) * 6)) * 100 / 6)::int)) END
FROM projects p
CROSS JOIN LATERAL (SELECT k::int AS k, name FROM unnest(ARRAY['Site survey', 'Design and approval', 'Procurement', 'Electrical works', 'Mounting',
  'Installation', 'Wiring', 'Commissioning', 'Training', 'Handover']) WITH ORDINALITY AS x (name, k)) t
ORDER BY p.id, t.k;

-- Purchase orders: the received ones added their stock (trigger); a few still in draft or sent.
INSERT INTO purchase_orders (id, supplier, warehouse, status, created_at)
SELECT pg_temp.uid('po:' || g), pg_temp.uid('supplier:' || (1 + g % 3)), (SELECT id FROM warehouses WHERE kind = 'BRANCH' ORDER BY name OFFSET g % 3 LIMIT 1),
  'DRAFT', pg_temp.d0() - ((150 - g * 9) || ' days')::interval
FROM generate_series(1, 16) g;
INSERT INTO purchase_order_items (purchase_order, part, quantity, unit_cost)
SELECT po.id, p.id, 5 + (abs(hashtext(p.sku)) % 4) * 5, p.unit_cost
FROM purchase_orders po CROSS JOIN LATERAL (SELECT id, sku, unit_cost FROM parts WHERE supplier = po.supplier ORDER BY md5(parts.id::text || po.id::text) LIMIT 3) p;
UPDATE purchase_orders SET status = 'SENT' WHERE created_at < pg_temp.d0() - interval '10 days';
UPDATE purchase_orders SET status = 'RECEIVED', received_at = created_at + interval '6 days' WHERE created_at < pg_temp.d0() - interval '20 days';

-- GPS: one recorded day per van on route - every 30 s between 08:00 and 14:00, from its branch out to
-- three of its branch's sites and back, along straight legs between them.
INSERT INTO vehicle_positions (vehicle, location, speed_kmh, heading, recorded_at)
SELECT v.id,
  point(a.x + (b.x - a.x) * f.t, a.y + (b.y - a.y) * f.t),
  CASE WHEN f.t IN (0, 1) THEN 0 ELSE 25 + abs(hashtext(v.id::text || leg.n || f.k)) % 35 END,
  ((degrees(atan2(b.x - a.x, b.y - a.y)) + 360)::int) % 360,
  pg_temp.d0() + interval '8 hours' + ((leg.n - 1) * 90 + f.k * 0.5) * interval '1 minute'
FROM vehicles v
JOIN branches br ON br.id = v.branch
CROSS JOIN LATERAL (
  SELECT row_number() OVER () AS n, location FROM (SELECT location FROM sites WHERE branch = v.branch ORDER BY md5(sites.id::text || v.plate) LIMIT 3) x
) st
CROSS JOIN LATERAL (SELECT st.n AS n) leg
CROSS JOIN LATERAL (
  SELECT CASE WHEN leg.n = 1 THEN br.location[0] ELSE (SELECT location[0] FROM sites WHERE branch = v.branch ORDER BY md5(sites.id::text || v.plate) OFFSET leg.n - 2 LIMIT 1) END AS x,
         CASE WHEN leg.n = 1 THEN br.location[1] ELSE (SELECT location[1] FROM sites WHERE branch = v.branch ORDER BY md5(sites.id::text || v.plate) OFFSET leg.n - 2 LIMIT 1) END AS y
) a
CROSS JOIN LATERAL (SELECT st.location[0] AS x, st.location[1] AS y) b
CROSS JOIN LATERAL (SELECT k, k / 180.0 AS t FROM generate_series(0, 180) k) f
WHERE v.status <> 'IN_SHOP';

-- Images (uploaded once by 10-images.mjs), set again on every reset by their file names.
CREATE OR REPLACE FUNCTION pg_temp.file(n text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT id FROM totalbase.files WHERE name = n ORDER BY created_at LIMIT 1 $$;
UPDATE equipment e SET photo = pg_temp.file(m.brand || ' ' || m.model || '.png') FROM equipment_models m WHERE m.id = e.model;
UPDATE vehicles SET photo = pg_temp.file('Van ' || plate || '.png');
UPDATE technicians SET photo = pg_temp.file(name || '.png');
UPDATE work_orders SET customer_signature = pg_temp.file('Signature ' || (ARRAY[3, 7, 11, 13, 17])[1 + abs(hashtext(number)) % 5] || '.png') WHERE status = 'COMPLETED';
INSERT INTO work_order_photos (work_order, file, caption, taken_at)
SELECT o.id, pg_temp.file(c.caption || '.png'), c.caption, coalesce(o.completed_at, now()) - interval '30 minutes'
FROM (SELECT id, completed_at, row_number() OVER (ORDER BY reported_at DESC) AS rn FROM work_orders WHERE status IN ('COMPLETED', 'IN_PROGRESS') ORDER BY reported_at DESC LIMIT 12) o
JOIN (VALUES (0, 'Before - condenser coil'), (0, 'After - coil cleaned'), (1, 'Replaced capacitor'), (1, 'Inverter display')) AS c (k, caption) ON c.k = o.rn % 2
WHERE pg_temp.file(c.caption || '.png') IS NOT NULL;
