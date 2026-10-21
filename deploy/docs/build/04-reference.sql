-- Reference data (DATASET.md §2, §10): fixed ids (md5 of a stable key), so every reset
-- rebuilds the same rows.
CREATE OR REPLACE FUNCTION pg_temp.uid(k text) RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT md5('acme:' || k)::uuid $$;

INSERT INTO branches (id, name, code, address, location, phone) VALUES
  (pg_temp.uid('branch:SAL'), 'Salta', 'SAL', 'Av. Belgrano 1250, Salta', point(-65.4117, -24.7859), '+54 387 421-5500'),
  (pg_temp.uid('branch:JUJ'), 'San Salvador de Jujuy', 'JUJ', 'Av. 19 de Abril 820, San Salvador de Jujuy', point(-65.2971, -24.1858), '+54 388 422-3100'),
  (pg_temp.uid('branch:TUC'), 'San Miguel de Tucumán', 'TUC', 'Av. Mate de Luna 2400, San Miguel de Tucumán', point(-65.2226, -26.8241), '+54 381 430-7700');

INSERT INTO equipment_models (id, brand, model, category, maintenance_interval_days) VALUES
  (pg_temp.uid('model:1'), 'Coolwave', 'Split 3000', 'HVAC', 180),
  (pg_temp.uid('model:2'), 'Coolwave', 'Split 6000', 'HVAC', 180),
  (pg_temp.uid('model:3'), 'Coolwave', 'Rooftop RT-20', 'HVAC', 90),
  (pg_temp.uid('model:4'), 'Aerotherm', 'Chiller CH-120', 'HVAC', 90),
  (pg_temp.uid('model:5'), 'Sunfield', 'Inverter SF-5K', 'SOLAR', 365),
  (pg_temp.uid('model:6'), 'Sunfield', 'Panel Array 10kW', 'SOLAR', 365),
  (pg_temp.uid('model:7'), 'Voltara', 'Generator G-45', 'GENERATOR', 120),
  (pg_temp.uid('model:8'), 'Voltara', 'Generator G-90', 'GENERATOR', 120);

INSERT INTO suppliers (id, name, email, phone, lead_time_days) VALUES
  (pg_temp.uid('supplier:1'), 'Norte Refrigeración', 'ventas@norterefri.example', '+54 387 431-2200', 5),
  (pg_temp.uid('supplier:2'), 'Andes Solar', 'pedidos@andessolar.example', '+54 381 455-0900', 10),
  (pg_temp.uid('supplier:3'), 'Electro Calchaquí', 'compras@electrocalchaqui.example', '+54 387 422-8800', 3);

INSERT INTO parts (id, sku, name, category, unit_cost, unit_price, reorder_point, supplier)
SELECT pg_temp.uid('part:' || p.sku), p.sku, p.name, p.category, p.cost, round(p.cost * 1.45, -1), p.reorder, pg_temp.uid('supplier:' || p.supplier)
FROM (VALUES
  ('HV-CAP-35', 'Run capacitor 35 µF', 'HVAC', 4800, 6, 1), ('HV-CAP-45', 'Run capacitor 45 µF', 'HVAC', 5600, 6, 1),
  ('HV-FAN-01', 'Condenser fan motor', 'HVAC', 38000, 2, 1), ('HV-FIL-20', 'Air filter 20"', 'HVAC', 3200, 12, 1),
  ('HV-FIL-24', 'Air filter 24"', 'HVAC', 3900, 12, 1), ('HV-GAS-410', 'Refrigerant R410A (kg)', 'HVAC', 21000, 8, 1),
  ('HV-GAS-32', 'Refrigerant R32 (kg)', 'HVAC', 18500, 8, 1), ('HV-THR-01', 'Digital thermostat', 'HVAC', 26000, 3, 1),
  ('HV-CNT-30', 'Contactor 30 A', 'HVAC', 9800, 4, 3), ('HV-DRN-01', 'Condensate pump', 'HVAC', 31000, 2, 1),
  ('HV-VLV-38', 'Expansion valve 3/8"', 'HVAC', 24500, 2, 1), ('HV-BRD-01', 'Indoor unit control board', 'HVAC', 64000, 1, 1),
  ('SO-FUS-15', 'PV fuse 15 A', 'SOLAR', 2100, 20, 2), ('SO-MC4-10', 'MC4 connector pair', 'SOLAR', 1500, 30, 2),
  ('SO-CAB-06', 'PV cable 6 mm² (m)', 'SOLAR', 1800, 100, 2), ('SO-SPD-01', 'DC surge protector', 'SOLAR', 29000, 2, 2),
  ('SO-INV-FAN', 'Inverter cooling fan', 'SOLAR', 17500, 2, 2), ('SO-PNL-450', 'Solar panel 450 W', 'SOLAR', 145000, 2, 2),
  ('GE-OIL-15', 'Engine oil 15W40 (l)', 'GENERATOR', 6500, 20, 3), ('GE-FIL-OIL', 'Oil filter', 'GENERATOR', 8900, 6, 3),
  ('GE-FIL-AIR', 'Air filter (generator)', 'GENERATOR', 12400, 4, 3), ('GE-FIL-FUE', 'Fuel filter', 'GENERATOR', 9700, 6, 3),
  ('GE-BAT-12', 'Starter battery 12 V', 'GENERATOR', 89000, 2, 3), ('GE-AVR-01', 'Voltage regulator (AVR)', 'GENERATOR', 72000, 1, 3),
  ('EL-BRK-20', 'Circuit breaker 2x20 A', 'ELECTRICAL', 7600, 10, 3), ('EL-BRK-40', 'Circuit breaker 2x40 A', 'ELECTRICAL', 11200, 6, 3),
  ('EL-RCD-40', 'Residual current device 40 A', 'ELECTRICAL', 34000, 4, 3), ('EL-CAB-25', 'Cable 2.5 mm² (m)', 'ELECTRICAL', 900, 200, 3),
  ('EL-CAB-40', 'Cable 4 mm² (m)', 'ELECTRICAL', 1400, 150, 3), ('EL-TER-01', 'Terminal block set', 'ELECTRICAL', 5200, 8, 3)
) AS p (sku, name, category, cost, reorder, supplier);

INSERT INTO warehouses (id, branch, name, kind)
SELECT pg_temp.uid('warehouse:' || code), id, 'Warehouse ' || code, 'BRANCH' FROM branches;

INSERT INTO parameters (key, value, title, description, section, position) VALUES
  ('tax_rate', '21', 'VAT rate (%)', 'Applied to every new invoice.', 'Billing', 1),
  ('invoice_due_days', '30', 'Invoice due in (days)', 'Days between an invoice''s issue and due dates.', 'Billing', 2),
  ('response_hours_default', '72', 'Response time without a contract (hours)', 'A work order''s due date when its customer has no contract.', 'Service', 1),
  ('sla_warning_hours', '2', 'SLA warning (hours)', 'How long before its due time an open order is flagged.', 'Service', 2),
  ('alerts_email', '"operations@acme-field.example"', 'Alerts email', 'Where the SLA and fleet alerts are sent.', 'Notifications', 1),
  ('maintenance_lead_days', '14', 'Maintenance lead (days)', 'How early the monthly plan creates a maintenance order.', 'Service', 3);
