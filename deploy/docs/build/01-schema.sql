-- Acme Field Services - the documentation demo's schema (deploy/docs/DATASET.md §3).
-- Everything in public; the one object outside it is the `branch` column on totalbase.users.
-- PostgreSQL decides: stock, schedules, due dates and totals are constraints, triggers, functions and views.

-- 3.1 Organization -------------------------------------------------------------------------------

CREATE TABLE branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z]{3}$'),
  address text NOT NULL,
  location point NOT NULL,
  phone text
);

ALTER TABLE totalbase.users ADD COLUMN branch uuid REFERENCES public.branches (id);

CREATE TABLE technicians (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user" uuid NOT NULL UNIQUE REFERENCES totalbase.users (id),
  -- How a technician shows wherever an order points at one: a row presentation names only its own table's columns.
  name text NOT NULL,
  branch uuid NOT NULL REFERENCES branches (id),
  skills text[] NOT NULL DEFAULT '{}' CHECK (skills <@ ARRAY['HVAC', 'SOLAR', 'ELECTRICAL']),
  hourly_cost numeric(12,2) NOT NULL CHECK (hourly_cost >= 0),
  color text NOT NULL DEFAULT 'neutral',
  photo uuid REFERENCES totalbase.files (id),
  -- Who a technician reports to: their branch's lead - the Team org chart.
  lead uuid REFERENCES technicians (id) CHECK (lead <> id),
  active boolean NOT NULL DEFAULT true
);

-- 3.2 Customers and equipment ---------------------------------------------------------------------

CREATE TABLE customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  parent uuid REFERENCES customers (id),
  tax_id text UNIQUE,
  email text,
  phone text,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PROSPECT', 'INACTIVE')),
  account_manager uuid REFERENCES totalbase.users (id),
  CHECK (parent IS DISTINCT FROM id)
);

CREATE TABLE sites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer uuid NOT NULL REFERENCES customers (id),
  name text NOT NULL,
  address text NOT NULL,
  location point NOT NULL,
  access_notes text,
  branch uuid NOT NULL REFERENCES branches (id),
  UNIQUE (customer, name)
);

CREATE TABLE equipment_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand text NOT NULL,
  model text NOT NULL,
  category text NOT NULL CHECK (category IN ('HVAC', 'SOLAR', 'GENERATOR')),
  maintenance_interval_days integer NOT NULL CHECK (maintenance_interval_days > 0),
  UNIQUE (brand, model)
);

CREATE TABLE equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site uuid NOT NULL REFERENCES sites (id),
  model uuid NOT NULL REFERENCES equipment_models (id),
  serial text NOT NULL UNIQUE,
  installed_on date NOT NULL,
  warranty_until date,
  status text NOT NULL DEFAULT 'OPERATIONAL' CHECK (status IN ('OPERATIONAL', 'NEEDS_SERVICE', 'OUT_OF_SERVICE', 'RETIRED')),
  photo uuid REFERENCES totalbase.files (id),
  CHECK (warranty_until IS NULL OR warranty_until >= installed_on)
);

CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer uuid NOT NULL REFERENCES customers (id),
  plan text NOT NULL CHECK (plan IN ('BASIC', 'STANDARD', 'PREMIUM')),
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  response_hours integer NOT NULL CHECK (response_hours > 0),
  monthly_fee numeric(12,2) NOT NULL CHECK (monthly_fee >= 0),
  CHECK (ends_on > starts_on)
);

-- 3.6 Fleet (before inventory: a van is a warehouse too) -------------------------------------------

CREATE TABLE vehicles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate text NOT NULL UNIQUE,
  make text NOT NULL,
  model text NOT NULL,
  year integer NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  branch uuid NOT NULL REFERENCES branches (id),
  technician uuid REFERENCES technicians (id),
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('AVAILABLE', 'ON_ROUTE', 'IN_SHOP')),
  odometer_km integer NOT NULL DEFAULT 0 CHECK (odometer_km >= 0),
  insurance_until date,
  inspection_until date,
  next_service_km integer,
  photo uuid REFERENCES totalbase.files (id)
);

CREATE TABLE vehicle_positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle uuid NOT NULL REFERENCES vehicles (id),
  location point NOT NULL,
  speed_kmh numeric(5,1) NOT NULL DEFAULT 0 CHECK (speed_kmh >= 0),
  heading integer CHECK (heading BETWEEN 0 AND 359),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vehicle_positions_vehicle_recorded_idx ON vehicle_positions (vehicle, recorded_at DESC);

CREATE TABLE vehicle_maintenance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle uuid NOT NULL REFERENCES vehicles (id),
  kind text NOT NULL CHECK (kind IN ('SERVICE', 'TIRES', 'REPAIR', 'INSPECTION')),
  done_on date NOT NULL,
  odometer_km integer NOT NULL CHECK (odometer_km >= 0),
  cost numeric(12,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  notes text
);

-- 3.4 Inventory and purchasing ---------------------------------------------------------------------

CREATE TABLE suppliers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  email text,
  phone text,
  lead_time_days integer NOT NULL DEFAULT 7 CHECK (lead_time_days >= 0)
);

CREATE TABLE warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  branch uuid NOT NULL REFERENCES branches (id),
  name text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('BRANCH', 'VEHICLE')),
  vehicle uuid UNIQUE REFERENCES vehicles (id),
  CHECK ((kind = 'VEHICLE') = (vehicle IS NOT NULL))
);

CREATE TABLE parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL,
  unit_cost numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  reorder_point integer NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  supplier uuid REFERENCES suppliers (id)
);

CREATE TABLE stock (
  part uuid NOT NULL REFERENCES parts (id),
  warehouse uuid NOT NULL REFERENCES warehouses (id),
  quantity integer NOT NULL DEFAULT 0 CONSTRAINT stock_not_negative CHECK (quantity >= 0),
  PRIMARY KEY (part, warehouse)
);
COMMENT ON CONSTRAINT stock_not_negative ON stock IS 'Not enough stock in this warehouse.';

CREATE TABLE purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier uuid NOT NULL REFERENCES suppliers (id),
  warehouse uuid NOT NULL REFERENCES warehouses (id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'RECEIVED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz
);

CREATE TABLE purchase_order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order uuid NOT NULL REFERENCES purchase_orders (id) ON DELETE CASCADE,
  part uuid NOT NULL REFERENCES parts (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_cost numeric(12,2) NOT NULL CHECK (unit_cost >= 0),
  UNIQUE (purchase_order, part)
);

-- 3.3 Work -----------------------------------------------------------------------------------------

CREATE SEQUENCE work_order_numbers;

CREATE TABLE work_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT 'WO-' || lpad(nextval('work_order_numbers')::text, 6, '0'),
  type text NOT NULL CHECK (type IN ('REPAIR', 'MAINTENANCE', 'INSTALLATION', 'INSPECTION')),
  priority text NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  status text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_PARTS', 'COMPLETED', 'CANCELLED')),
  site uuid NOT NULL REFERENCES sites (id),
  equipment uuid REFERENCES equipment (id),
  branch uuid NOT NULL REFERENCES branches (id),
  technician uuid REFERENCES technicians (id),
  reported_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  completed_at timestamptz,
  description text NOT NULL,
  resolution text,
  customer_signature uuid REFERENCES totalbase.files (id),
  signed_by text
);
CREATE INDEX work_orders_open_idx ON work_orders (branch, status) WHERE status NOT IN ('COMPLETED', 'CANCELLED');

CREATE TABLE visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order uuid NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  technician uuid NOT NULL REFERENCES technicians (id),
  vehicle uuid REFERENCES vehicles (id),
  scheduled_start timestamptz NOT NULL,
  scheduled_end timestamptz NOT NULL,
  check_in_at timestamptz,
  check_in_location point,
  check_out_at timestamptz,
  CHECK (scheduled_end > scheduled_start),
  CONSTRAINT visits_no_double_booking EXCLUDE USING gist (technician WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
);
COMMENT ON CONSTRAINT visits_no_double_booking ON visits IS 'This technician already has a visit at that time.';

CREATE TABLE time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order uuid NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  technician uuid NOT NULL REFERENCES technicians (id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz NOT NULL,
  minutes integer GENERATED ALWAYS AS ((extract(epoch FROM ended_at - started_at) / 60)::integer) STORED,
  billable boolean NOT NULL DEFAULT true,
  CHECK (ended_at > started_at)
);

CREATE TABLE work_order_parts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order uuid NOT NULL REFERENCES work_orders (id),
  part uuid NOT NULL REFERENCES parts (id),
  warehouse uuid NOT NULL REFERENCES warehouses (id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE work_order_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order uuid NOT NULL REFERENCES work_orders (id) ON DELETE CASCADE,
  file uuid NOT NULL REFERENCES totalbase.files (id),
  caption text,
  taken_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer uuid NOT NULL REFERENCES customers (id),
  name text NOT NULL UNIQUE,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED', 'IN_PROGRESS', 'DONE', 'ON_HOLD')),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE project_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  depends_on uuid REFERENCES project_tasks (id),
  technician uuid REFERENCES technicians (id),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  CHECK (ends_on >= starts_on)
);

-- 3.5 Billing --------------------------------------------------------------------------------------

CREATE TABLE quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer uuid NOT NULL REFERENCES customers (id),
  site uuid REFERENCES sites (id),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED')),
  valid_until date NOT NULL,
  total numeric(14,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quote_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quote uuid NOT NULL REFERENCES quotes (id) ON DELETE CASCADE,
  description text NOT NULL,
  part uuid REFERENCES parts (id),
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0),
  discount_pct numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100)
);

CREATE SEQUENCE invoice_numbers;

CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE DEFAULT 'A-0001-' || lpad(nextval('invoice_numbers')::text, 8, '0'),
  customer uuid NOT NULL REFERENCES customers (id),
  work_order uuid UNIQUE REFERENCES work_orders (id),
  quote uuid UNIQUE REFERENCES quotes (id),
  issued_on date NOT NULL DEFAULT current_date,
  due_on date NOT NULL DEFAULT current_date + 30,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'ISSUED', 'PAID', 'OVERDUE')),
  tax_rate numeric(5,2) NOT NULL DEFAULT 21 CHECK (tax_rate BETWEEN 0 AND 100),
  CHECK (due_on >= issued_on)
);

CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice uuid NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
  description text NOT NULL,
  quantity numeric(10,2) NOT NULL CHECK (quantity > 0),
  unit_price numeric(12,2) NOT NULL CHECK (unit_price >= 0)
);

CREATE TABLE parameters (
  key text PRIMARY KEY CHECK (key ~ '^[a-z][a-z0-9_]*$'),
  value jsonb NOT NULL,
  title text NOT NULL,
  description text,
  section text NOT NULL,
  position integer NOT NULL DEFAULT 0
);

-- Logic in PostgreSQL ------------------------------------------------------------------------------

-- A new order's due date: reported + the customer's contract response hours, else the parameter.
CREATE FUNCTION work_orders_due_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.due_at IS NULL THEN
    NEW.due_at := NEW.reported_at + make_interval(hours => coalesce(
      (SELECT c.response_hours FROM sites s JOIN contracts c ON c.customer = s.customer
        WHERE s.id = NEW.site AND NEW.reported_at::date BETWEEN c.starts_on AND c.ends_on
        ORDER BY c.response_hours LIMIT 1),
      (SELECT (value #>> '{}')::integer FROM parameters WHERE key = 'response_hours_default'),
      72));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_orders_due_at BEFORE INSERT ON work_orders FOR EACH ROW EXECUTE FUNCTION work_orders_due_at();

-- What an order's status may become, and completed_at kept with it.
CREATE FUNCTION work_orders_status() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    IF OLD.status = 'CANCELLED' THEN
      RAISE EXCEPTION 'A cancelled work order can''t change status.' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'COMPLETED' AND NEW.status <> 'CANCELLED' THEN
      RAISE EXCEPTION 'A completed work order can''t go back to %.', NEW.status USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'COMPLETED' THEN
      NEW.completed_at := coalesce(NEW.completed_at, now());
    END IF;
  END IF;
  IF NEW.status = 'ASSIGNED' AND NEW.technician IS NULL THEN
    RAISE EXCEPTION 'An assigned work order needs its technician.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER work_orders_status BEFORE UPDATE ON work_orders FOR EACH ROW EXECUTE FUNCTION work_orders_status();

-- A part used on an order leaves its warehouse in the same transaction; not enough is stock's CHECK (23514).
CREATE FUNCTION work_order_parts_stock() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE stock SET quantity = quantity + OLD.quantity WHERE part = OLD.part AND warehouse = OLD.warehouse;
    INSERT INTO stock_movements (part, warehouse, quantity, reason, work_order) VALUES (OLD.part, OLD.warehouse, OLD.quantity, 'WORK_ORDER', OLD.work_order);
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    INSERT INTO stock (part, warehouse, quantity) VALUES (NEW.part, NEW.warehouse, 0) ON CONFLICT DO NOTHING;
    UPDATE stock SET quantity = quantity - NEW.quantity WHERE part = NEW.part AND warehouse = NEW.warehouse;
    INSERT INTO stock_movements (part, warehouse, quantity, reason, work_order) VALUES (NEW.part, NEW.warehouse, -NEW.quantity, 'WORK_ORDER', NEW.work_order);
  END IF;
  RETURN NULL;
END $$;

CREATE TABLE stock_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part uuid NOT NULL REFERENCES parts (id),
  warehouse uuid NOT NULL REFERENCES warehouses (id),
  quantity integer NOT NULL CHECK (quantity <> 0),
  reason text NOT NULL CHECK (reason IN ('PURCHASE', 'WORK_ORDER', 'TRANSFER', 'ADJUSTMENT')),
  work_order uuid REFERENCES work_orders (id),
  purchase_order uuid REFERENCES purchase_orders (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER work_order_parts_stock AFTER INSERT OR UPDATE OR DELETE ON work_order_parts FOR EACH ROW EXECUTE FUNCTION work_order_parts_stock();

-- Receiving a purchase order adds its items to its warehouse's stock.
CREATE FUNCTION purchase_orders_receive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'RECEIVED' AND OLD.status IS DISTINCT FROM 'RECEIVED' THEN
    NEW.received_at := coalesce(NEW.received_at, now());
    INSERT INTO stock (part, warehouse, quantity)
      SELECT i.part, NEW.warehouse, i.quantity FROM purchase_order_items i WHERE i.purchase_order = NEW.id
      ON CONFLICT (part, warehouse) DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity;
    INSERT INTO stock_movements (part, warehouse, quantity, reason, purchase_order)
      SELECT i.part, NEW.warehouse, i.quantity, 'PURCHASE', NEW.id FROM purchase_order_items i WHERE i.purchase_order = NEW.id;
  ELSIF OLD.status = 'RECEIVED' AND NEW.status <> 'RECEIVED' THEN
    RAISE EXCEPTION 'A received purchase order stays received.' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER purchase_orders_receive BEFORE UPDATE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION purchase_orders_receive();

CREATE FUNCTION quote_total(p_quote uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(round(sum(quantity * unit_price * (1 - discount_pct / 100)), 2), 0) FROM public.quote_items WHERE quote = p_quote
$$;

CREATE FUNCTION quote_items_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE quotes SET total = quote_total(q.id) FROM (SELECT coalesce(NEW.quote, OLD.quote) AS id) q WHERE quotes.id = q.id;
  RETURN NULL;
END $$;
CREATE TRIGGER quote_items_total AFTER INSERT OR UPDATE OR DELETE ON quote_items FOR EACH ROW EXECUTE FUNCTION quote_items_total();

CREATE FUNCTION invoice_total(p_invoice uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(round(sum(ii.quantity * ii.unit_price) * (1 + i.tax_rate / 100), 2), 0)
  FROM public.invoices i LEFT JOIN public.invoice_items ii ON ii.invoice = i.id
  WHERE i.id = p_invoice GROUP BY i.tax_rate
$$;

-- An order's invoice: its billable hours at the contract plan's rate, plus its parts.
CREATE FUNCTION create_invoice_from_work_order(p_work_order uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_order work_orders;
  v_customer uuid;
  v_rate numeric;
  v_invoice uuid;
BEGIN
  SELECT * INTO v_order FROM work_orders WHERE id = p_work_order;
  IF NOT FOUND THEN RAISE EXCEPTION 'No work order %.', p_work_order USING ERRCODE = 'no_data_found'; END IF;
  IF v_order.status <> 'COMPLETED' THEN RAISE EXCEPTION 'Only a completed work order is invoiced.' USING ERRCODE = 'check_violation'; END IF;
  SELECT customer INTO v_customer FROM sites WHERE id = v_order.site;
  SELECT CASE c.plan WHEN 'PREMIUM' THEN 0 WHEN 'STANDARD' THEN 18000 ELSE 24000 END INTO v_rate
    FROM contracts c WHERE c.customer = v_customer AND current_date BETWEEN c.starts_on AND c.ends_on LIMIT 1;
  INSERT INTO invoices (customer, work_order, tax_rate)
    VALUES (v_customer, p_work_order, coalesce((SELECT (value #>> '{}')::numeric FROM parameters WHERE key = 'tax_rate'), 21))
    RETURNING id INTO v_invoice;
  INSERT INTO invoice_items (invoice, description, quantity, unit_price)
    SELECT v_invoice, 'Labor - ' || v_order.number, round(sum(minutes) / 60.0, 2), coalesce(v_rate, 24000)
    FROM time_entries WHERE work_order = p_work_order AND billable HAVING sum(minutes) > 0;
  INSERT INTO invoice_items (invoice, description, quantity, unit_price)
    SELECT v_invoice, p.name, wp.quantity, wp.unit_price FROM work_order_parts wp JOIN parts p ON p.id = wp.part WHERE wp.work_order = p_work_order;
  RETURN v_invoice;
END $$;

-- The invoice of an accepted quote.
CREATE FUNCTION issue_invoice_from_quote(p_quote uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_quote quotes;
  v_invoice uuid;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote;
  IF NOT FOUND THEN RAISE EXCEPTION 'No quote %.', p_quote USING ERRCODE = 'no_data_found'; END IF;
  IF v_quote.status <> 'ACCEPTED' THEN RAISE EXCEPTION 'Only an accepted quote is invoiced.' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO invoices (customer, quote, status) VALUES (v_quote.customer, p_quote, 'ISSUED') RETURNING id INTO v_invoice;
  INSERT INTO invoice_items (invoice, description, quantity, unit_price)
    SELECT v_invoice, description, quantity, round(unit_price * (1 - discount_pct / 100), 2) FROM quote_items WHERE quote = p_quote;
  RETURN v_invoice;
END $$;

-- The Dispatch board's call: assign an order and schedule its visit in one transaction.
CREATE FUNCTION assign_work_order(p_work_order uuid, p_technician uuid, p_start timestamptz, p_hours numeric DEFAULT 2) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
  v_visit uuid;
BEGIN
  UPDATE work_orders SET technician = p_technician, status = 'ASSIGNED' WHERE id = p_work_order AND status IN ('NEW', 'ASSIGNED');
  IF NOT FOUND THEN RAISE EXCEPTION 'Only a new or assigned work order can be scheduled.' USING ERRCODE = 'check_violation'; END IF;
  INSERT INTO visits (work_order, technician, vehicle, scheduled_start, scheduled_end)
    VALUES (p_work_order, p_technician, (SELECT id FROM vehicles WHERE technician = p_technician LIMIT 1), p_start, p_start + make_interval(mins => (p_hours * 60)::integer))
    RETURNING id INTO v_visit;
  RETURN v_visit;
END $$;

-- Views ---------------------------------------------------------------------------------------------

CREATE VIEW vehicles_latest_positions AS
  SELECT DISTINCT ON (p.vehicle)
    p.vehicle, v.plate, v.status, u.name AS driver, b.name AS branch, p.location, p.speed_kmh, p.recorded_at
  FROM vehicle_positions p
  JOIN vehicles v ON v.id = p.vehicle
  JOIN branches b ON b.id = v.branch
  LEFT JOIN technicians t ON t.id = v.technician
  LEFT JOIN totalbase.users u ON u.id = t."user"
  ORDER BY p.vehicle, p.recorded_at DESC;

CREATE VIEW work_orders_overview AS
  SELECT o.id, o.number, o.type, o.priority, o.status, c.name AS customer, s.name AS site, b.name AS branch,
    u.name AS technician, o.reported_at, o.due_at, o.completed_at,
    coalesce((SELECT round(sum(minutes) / 60.0, 1) FROM time_entries te WHERE te.work_order = o.id), 0) AS hours,
    coalesce((SELECT sum(quantity * unit_price) FROM work_order_parts wp WHERE wp.work_order = o.id), 0) AS parts_total,
    (o.status NOT IN ('COMPLETED', 'CANCELLED') AND o.due_at < now()) AS overdue
  FROM work_orders o
  JOIN sites s ON s.id = o.site
  JOIN customers c ON c.id = s.customer
  JOIN branches b ON b.id = o.branch
  LEFT JOIN technicians t ON t.id = o.technician
  LEFT JOIN totalbase.users u ON u.id = t."user";

CREATE VIEW stock_alerts AS
  SELECT s.part, p.sku, p.name AS part_name, s.warehouse, w.name AS warehouse_name, s.quantity, p.reorder_point
  FROM stock s JOIN parts p ON p.id = s.part JOIN warehouses w ON w.id = s.warehouse
  WHERE s.quantity <= p.reorder_point;

CREATE VIEW orders_due_soon AS
  SELECT o.id, o.number, o.priority, o.status, o.branch, o.due_at, s.name AS site
  FROM work_orders o JOIN sites s ON s.id = o.site
  WHERE o.status NOT IN ('COMPLETED', 'CANCELLED') AND o.due_at BETWEEN now() AND now() + interval '2 hours';

-- Each rule a person can break from a form says what to fix, beside its field (DataViews.md §18:
-- CONSTRAINT_WITHOUT_MESSAGE). Lists of values and foreign keys need none: a select offers only valid ones.
COMMENT ON CONSTRAINT branches_code_check ON public.branches IS 'A branch code is three capital letters, like SAL.';
COMMENT ON CONSTRAINT branches_code_key ON public.branches IS 'Another branch already has this code.';
COMMENT ON CONSTRAINT branches_name_key ON public.branches IS 'Another branch already has this name.';
COMMENT ON CONSTRAINT contracts_check ON public.contracts IS 'A contract ends after it starts.';
COMMENT ON CONSTRAINT contracts_monthly_fee_check ON public.contracts IS 'The monthly fee can''t be negative.';
COMMENT ON CONSTRAINT contracts_response_hours_check ON public.contracts IS 'The response time is at least one hour.';
COMMENT ON CONSTRAINT customers_check ON public.customers IS 'A customer can''t be its own parent.';
COMMENT ON CONSTRAINT customers_name_key ON public.customers IS 'Another customer already has this name.';
COMMENT ON CONSTRAINT customers_tax_id_key ON public.customers IS 'Another customer already has this tax ID.';
COMMENT ON CONSTRAINT equipment_check ON public.equipment IS 'The warranty can''t end before the equipment was installed.';
COMMENT ON CONSTRAINT equipment_serial_key ON public.equipment IS 'Another piece of equipment already has this serial number.';
COMMENT ON CONSTRAINT equipment_models_brand_model_key ON public.equipment_models IS 'That brand already has a model with this name.';
COMMENT ON CONSTRAINT equipment_models_maintenance_interval_days_check ON public.equipment_models IS 'The maintenance interval is at least one day.';
COMMENT ON CONSTRAINT invoice_items_quantity_check ON public.invoice_items IS 'The quantity must be more than zero.';
COMMENT ON CONSTRAINT invoice_items_unit_price_check ON public.invoice_items IS 'The unit price can''t be negative.';
COMMENT ON CONSTRAINT invoices_check ON public.invoices IS 'An invoice is due on or after the day it''s issued.';
COMMENT ON CONSTRAINT invoices_number_key ON public.invoices IS 'Another invoice already has this number.';
COMMENT ON CONSTRAINT invoices_quote_key ON public.invoices IS 'That quote already has an invoice.';
COMMENT ON CONSTRAINT invoices_tax_rate_check ON public.invoices IS 'The tax rate goes from 0 to 100.';
COMMENT ON CONSTRAINT invoices_work_order_key ON public.invoices IS 'That work order already has an invoice.';
COMMENT ON CONSTRAINT parameters_key_check ON public.parameters IS 'A parameter key is lowercase letters, digits and underscores, starting with a letter.';
COMMENT ON CONSTRAINT parts_reorder_point_check ON public.parts IS 'The reorder point can''t be negative.';
COMMENT ON CONSTRAINT parts_sku_key ON public.parts IS 'Another part already has this SKU.';
COMMENT ON CONSTRAINT parts_unit_cost_check ON public.parts IS 'The unit cost can''t be negative.';
COMMENT ON CONSTRAINT parts_unit_price_check ON public.parts IS 'The unit price can''t be negative.';
COMMENT ON CONSTRAINT project_tasks_check ON public.project_tasks IS 'A task ends on or after the day it starts.';
COMMENT ON CONSTRAINT project_tasks_progress_check ON public.project_tasks IS 'Progress goes from 0 to 100%.';
COMMENT ON CONSTRAINT projects_check ON public.projects IS 'A project ends on or after the day it starts.';
COMMENT ON CONSTRAINT projects_name_key ON public.projects IS 'Another project already has this name.';
COMMENT ON CONSTRAINT purchase_order_items_purchase_order_part_key ON public.purchase_order_items IS 'That part is already on this purchase order - change its quantity instead.';
COMMENT ON CONSTRAINT purchase_order_items_quantity_check ON public.purchase_order_items IS 'The quantity must be more than zero.';
COMMENT ON CONSTRAINT purchase_order_items_unit_cost_check ON public.purchase_order_items IS 'The unit cost can''t be negative.';
COMMENT ON CONSTRAINT quote_items_discount_pct_check ON public.quote_items IS 'The discount goes from 0 to 100%.';
COMMENT ON CONSTRAINT quote_items_quantity_check ON public.quote_items IS 'The quantity must be more than zero.';
COMMENT ON CONSTRAINT quote_items_unit_price_check ON public.quote_items IS 'The unit price can''t be negative.';
COMMENT ON CONSTRAINT sites_customer_name_key ON public.sites IS 'This customer already has a site with that name.';
COMMENT ON CONSTRAINT stock_movements_quantity_check ON public.stock_movements IS 'A stock movement can''t be zero.';
COMMENT ON CONSTRAINT suppliers_lead_time_days_check ON public.suppliers IS 'The lead time can''t be negative.';
COMMENT ON CONSTRAINT suppliers_name_key ON public.suppliers IS 'Another supplier already has this name.';
COMMENT ON CONSTRAINT technicians_check ON public.technicians IS 'A technician can''t be their own lead.';
COMMENT ON CONSTRAINT technicians_hourly_cost_check ON public.technicians IS 'The hourly cost can''t be negative.';
COMMENT ON CONSTRAINT technicians_user_key ON public.technicians IS 'That user is already a technician.';
COMMENT ON CONSTRAINT time_entries_check ON public.time_entries IS 'The time entry must end after it starts.';
COMMENT ON CONSTRAINT vehicle_maintenance_cost_check ON public.vehicle_maintenance IS 'The cost can''t be negative.';
COMMENT ON CONSTRAINT vehicle_maintenance_odometer_km_check ON public.vehicle_maintenance IS 'The odometer can''t be negative.';
COMMENT ON CONSTRAINT vehicle_positions_heading_check ON public.vehicle_positions IS 'The heading goes from 0 to 359 degrees.';
COMMENT ON CONSTRAINT vehicle_positions_speed_kmh_check ON public.vehicle_positions IS 'The speed can''t be negative.';
COMMENT ON CONSTRAINT vehicles_odometer_km_check ON public.vehicles IS 'The odometer can''t be negative.';
COMMENT ON CONSTRAINT vehicles_plate_key ON public.vehicles IS 'Another vehicle already has this plate.';
COMMENT ON CONSTRAINT vehicles_year_check ON public.vehicles IS 'The year goes from 2000 to 2100.';
COMMENT ON CONSTRAINT visits_check ON public.visits IS 'A visit must end after it starts.';
COMMENT ON CONSTRAINT warehouses_check ON public.warehouses IS 'A vehicle warehouse needs its vehicle, and a branch warehouse has none.';
COMMENT ON CONSTRAINT warehouses_name_key ON public.warehouses IS 'Another warehouse already has this name.';
COMMENT ON CONSTRAINT warehouses_vehicle_key ON public.warehouses IS 'That vehicle already has a warehouse.';
COMMENT ON CONSTRAINT work_order_parts_quantity_check ON public.work_order_parts IS 'The quantity must be more than zero.';
COMMENT ON CONSTRAINT work_order_parts_unit_price_check ON public.work_order_parts IS 'The unit price can''t be negative.';
COMMENT ON CONSTRAINT work_orders_number_key ON public.work_orders IS 'Another work order already has this number.';
