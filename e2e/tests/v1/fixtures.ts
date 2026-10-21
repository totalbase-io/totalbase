import { test as base, expect, type Page } from '@playwright/test'
import { apiRequest, login } from '../helpers.js'
import { BASE_URL } from '../helpers'

/**
 * The DataViews V1 acceptance suite's shared ground (e2e/tests/v1): an
 * admin token, the `e2e_v1_*` schema with known rows, DataViews created and
 * published by API and always deleted by id, and a console watchdog - a
 * test fails when its page throws, logs an error or a Vue warning.
 */

export { expect }

interface Fixtures {
  /** The admin's bearer token - logged in once per test. */
  token: string
  /** Console errors, uncaught exceptions and Vue warnings the page produced - checked after the test. */
  consoleProblems: string[]
}

/** Noise that isn't the app's: the browser's own reports of a request that failed (a test asserting an error state). */
const IGNORED = [/Failed to load resource/, /net::ERR_/, /\[Vue warn\]: Hydration/]

export const test = base.extend<Fixtures>({
  consoleProblems: async ({ page }, use) => {
    const problems: string[] = []
    page.on('pageerror', error => problems.push(`pageerror: ${error.message}`))
    page.on('console', (message) => {
      const text = message.text()
      const isVueWarning = message.type() === 'warning' && text.startsWith('[Vue warn]')
      if ((message.type() === 'error' || isVueWarning) && !IGNORED.some(r => r.test(text))) problems.push(`${message.type()}: ${text.slice(0, 400)}`)
    })
    await use(problems)
    expect(problems, 'the page logged errors').toEqual([])
  },
  token: async ({ page, consoleProblems: _ }, use) => {
    await use(await login(page))
  }
})

// --- Admin API ---------------------------------------------------------------------

export function api<T>(page: Page, token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', path: string, body?: unknown): Promise<T> {
  return apiRequest<T>(page, token, method as 'GET', path, body)
}

export async function sql(page: Page, token: string, statement: string): Promise<{ rows: Record<string, unknown>[] }> {
  return api(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: statement } })
}

/** A resource's id by table name - TotalBase's own tables are Data API data. */
export async function resourceId(page: Page, token: string, table: string): Promise<string> {
  const rows = await api<{ id: string }[]>(page, token, 'GET', `/api/totalbase/table/resources?fields=id&where[schema][_eq]=public&where[name][_eq]=${table}&where[status][_eq]=ACTIVE`)
  if (!rows[0]) throw new Error(`No ACTIVE resource for public.${table}`)
  return rows[0].id
}

export interface DataViewRef { id: string, slug: string }

/** Deletes every DataView named `name` - by id, as each was created. */
export async function deleteDataViewsNamed(page: Page, token: string, names: readonly string[]) {
  const dataviews = await api<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dataviews')
  // Owned ones (a Master-detail's detail) go with their owner - delete owners first.
  for (const dv of dataviews.filter(d => names.includes(d.name))) {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`).catch(() => undefined)
  }
}

export async function createDataView(page: Page, token: string, body: Record<string, unknown>): Promise<DataViewRef> {
  return api<DataViewRef>(page, token, 'POST', '/admin/api/dataviews', { data: body })
}

export async function publish(page: Page, token: string, id: string) {
  await api(page, token, 'POST', `/admin/api/dataviews/${id}/publish`)
}

export async function addWidget(page: Page, token: string, dataviewId: string, widget: string, config: Record<string, unknown> = {}, options: { label?: string, parent?: string } = {}) {
  return api<{ id: string }>(page, token, 'POST', `/admin/api/dataviews/${dataviewId}/widgets`, {
    data: { widget, label: options.label, parent: options.parent, config: { props: {}, bindings: {}, emits: {}, ...config } }
  })
}

// --- The e2e_v1 schema -------------------------------------------------------------

/**
 * A small business schema with known rows - categories, customers, orders and
 * their items (a trigger keeps each order's total), tasks with dates and a
 * place. Dropped and recreated whole, so every run starts from the same rows.
 */
export const SCHEMA_SQL = `
-- The previous run's resources go with their tables (a recreated table is a new OID, a new resource).
DELETE FROM totalbase.resources WHERE schema = 'public' AND name IN ('e2e_v1_pedidos_items', 'e2e_v1_pedidos', 'e2e_v1_tareas', 'e2e_v1_clientes', 'e2e_v1_categorias');
DROP TABLE IF EXISTS public.e2e_v1_pedidos_items, public.e2e_v1_pedidos, public.e2e_v1_tareas, public.e2e_v1_clientes, public.e2e_v1_categorias CASCADE;
DROP FUNCTION IF EXISTS public.e2e_v1_pedido_total() CASCADE;

CREATE TABLE public.e2e_v1_categorias (
  id serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  color text
);
CREATE TABLE public.e2e_v1_clientes (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  email text UNIQUE,
  telefono text,
  categoria integer REFERENCES public.e2e_v1_categorias(id),
  activo boolean NOT NULL DEFAULT true,
  limite_credito numeric(12,2) NOT NULL DEFAULT 0 CHECK (limite_credito >= 0),
  fecha_alta date NOT NULL DEFAULT current_date,
  notas text,
  -- A CHECK no form can anticipate: PostgreSQL's alone to decide.
  CONSTRAINT e2e_v1_clientes_nombre_permitido CHECK (nombre <> 'Prohibido')
);
CREATE TABLE public.e2e_v1_pedidos (
  id serial PRIMARY KEY,
  cliente integer NOT NULL REFERENCES public.e2e_v1_clientes(id),
  fecha date NOT NULL DEFAULT current_date,
  estado text NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'CONFIRMADO', 'ANULADO')),
  total numeric(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE public.e2e_v1_pedidos_items (
  id serial PRIMARY KEY,
  pedido integer NOT NULL REFERENCES public.e2e_v1_pedidos(id) ON DELETE CASCADE,
  descripcion text NOT NULL,
  cantidad numeric(12,2) NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio numeric(12,2) NOT NULL DEFAULT 0,
  importe numeric(12,2) GENERATED ALWAYS AS (cantidad * precio) STORED
);
CREATE FUNCTION public.e2e_v1_pedido_total() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.e2e_v1_pedidos p SET total = coalesce((SELECT sum(importe) FROM public.e2e_v1_pedidos_items WHERE pedido = p.id), 0)
  WHERE p.id IN (coalesce(NEW.pedido, OLD.pedido), coalesce(OLD.pedido, NEW.pedido));
  RETURN NULL;
END $$;
CREATE TRIGGER e2e_v1_pedido_total AFTER INSERT OR UPDATE OR DELETE ON public.e2e_v1_pedidos_items
  FOR EACH ROW EXECUTE FUNCTION public.e2e_v1_pedido_total();
CREATE TABLE public.e2e_v1_tareas (
  id serial PRIMARY KEY,
  titulo text NOT NULL,
  estado text NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE', 'EN_CURSO', 'HECHA')),
  proyecto text NOT NULL DEFAULT 'General',
  inicio date NOT NULL,
  fin date NOT NULL,
  lat double precision,
  long double precision,
  avance integer NOT NULL DEFAULT 0 CHECK (avance BETWEEN 0 AND 100)
);

INSERT INTO public.e2e_v1_categorias (nombre, color) VALUES ('Mayorista', 'blue'), ('Minorista', 'green'), ('Gobierno', 'amber');
INSERT INTO public.e2e_v1_clientes (nombre, email, telefono, categoria, activo, limite_credito, fecha_alta) VALUES
  ('Acme SA', 'compras@acme.test', '011 4000-1000', 1, true, 500000, '2025-01-10'),
  ('Beta SRL', 'info@beta.test', '011 4000-2000', 2, true, 120000, '2025-03-15'),
  ('Gamma Coop', 'admin@gamma.test', NULL, 3, false, 0, '2024-11-02'),
  ('Delta y Asociados', 'delta@delta.test', '0351 400-3000', 1, true, 75000, '2026-02-20');
INSERT INTO public.e2e_v1_clientes (nombre, email, categoria, limite_credito, fecha_alta)
  SELECT 'Cliente ' || lpad(n::text, 2, '0'), 'cliente' || n || '@e2e.test', 2, n * 1000, '2026-01-01'::date + n
  FROM generate_series(1, 26) n;
INSERT INTO public.e2e_v1_pedidos (cliente, fecha, estado) VALUES (1, '2026-09-01', 'CONFIRMADO'), (2, '2026-09-15', 'BORRADOR');
INSERT INTO public.e2e_v1_pedidos_items (pedido, descripcion, cantidad, precio) VALUES
  (1, 'Tornillos x100', 2, 1500), (1, 'Arandelas x100', 1, 800), (2, 'Cable 10 m', 3, 2200);
-- Sales over the last 120 days, relative to today - a dashboard's date ranges read them. Never Gamma Coop (id 3): a test deletes it.
INSERT INTO public.e2e_v1_pedidos (cliente, fecha, estado)
  SELECT (ARRAY[1, 2, 4])[1 + n % 3], current_date - (n * 6), (ARRAY['CONFIRMADO', 'CONFIRMADO', 'BORRADOR', 'ANULADO'])[1 + n % 4]
  FROM generate_series(0, 19) n;
INSERT INTO public.e2e_v1_pedidos_items (pedido, descripcion, cantidad, precio)
  SELECT p.id, 'Venta ' || p.id, 1 + p.id % 3, 1000 * (1 + p.id % 5) FROM public.e2e_v1_pedidos p WHERE p.id > 2;
INSERT INTO public.e2e_v1_tareas (titulo, estado, proyecto, inicio, fin, lat, long, avance) VALUES
  ('Relevar requisitos', 'HECHA', 'Portal', '2026-10-01', '2026-10-05', -34.60, -58.38, 100),
  ('Diseñar pantallas', 'EN_CURSO', 'Portal', '2026-10-06', '2026-10-12', -31.42, -64.18, 40),
  ('Migrar datos', 'PENDIENTE', 'Datos', '2026-10-10', '2026-10-20', -32.95, -60.64, 0);
`

export const TABLES = ['e2e_v1_categorias', 'e2e_v1_clientes', 'e2e_v1_pedidos', 'e2e_v1_pedidos_items', 'e2e_v1_tareas'] as const

/**
 * Recreates the e2e_v1 schema with its rows and makes TotalBase see it - once
 * per file (beforeAll). A new table isn't exposed until an administrator says
 * so (Foundations.md §11.5): each is exposed for every method, as the Resources
 * screen does.
 */
export async function resetSchema(page: Page, token: string) {
  // Every DataView over these test-only tables is a test's - whatever it was renamed to: deleted by id.
  const resources = await api<{ id: string }[]>(page, token, 'GET', `/api/totalbase/table/resources?fields=id&where[schema][_eq]=public&where[name][_in]=${TABLES.join(',')}`)
  const ids = new Set(resources.map(r => r.id))
  const dataviews = await api<{ id: string, sourceResource: string | null, owner?: string | null }[]>(page, token, 'GET', '/admin/api/dataviews')
  for (const dv of dataviews.filter(d => d.sourceResource && ids.has(d.sourceResource)).sort((a, b) => Number(Boolean(a.owner)) - Number(Boolean(b.owner)))) {
    await api(page, token, 'DELETE', `/admin/api/dataviews/${dv.id}`).catch(() => undefined)
  }
  await sql(page, token, SCHEMA_SQL)
  await api(page, token, 'POST', '/admin/api/catalog/refresh')
  for (const table of TABLES) {
    await api(page, token, 'PATCH', `/admin/api/resources/${await resourceId(page, token, table)}`, { data: { exposedMethods: ['GET', 'POST', 'PATCH', 'DELETE'] } })
  }
}

/** A fresh page logged in as admin - for beforeAll/afterAll, which have no `page` fixture. */
export async function adminSession(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext({ baseURL: BASE_URL })
  const page = await context.newPage()
  const token = await login(page)
  return { context, page, token }
}

// --- Dashboards --------------------------------------------------------------------

export interface DashboardRef { id: string, slug: string }

/** Deletes every dashboard named `name` - by id, as each was created. */
export async function deleteDashboardsNamed(page: Page, token: string, names: readonly string[]) {
  const dashboards = await api<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dashboards')
  for (const d of dashboards.filter(d => names.includes(d.name))) await api(page, token, 'DELETE', `/admin/api/dashboards/${d.id}`).catch(() => undefined)
}

export async function createDashboard(page: Page, token: string, name: string, variables?: unknown[]): Promise<DashboardRef> {
  const dashboard = await api<DashboardRef>(page, token, 'POST', '/admin/api/dashboards', { data: { name } })
  if (variables) await api(page, token, 'PATCH', `/admin/api/dashboards/${dashboard.id}`, { data: { variables } })
  return dashboard
}

/** A widget at (x, y), its query and config. */
export async function addDashboardWidget(page: Page, token: string, dashboardId: string, widget: { type: string, label?: string, x?: number, y?: number, w?: number, h?: number, query?: string | null, config?: Record<string, unknown> }) {
  const created = await api<{ id: string }>(page, token, 'POST', `/admin/api/dashboards/${dashboardId}/widgets`, {
    data: { type: widget.type, label: widget.label ?? null, gridX: widget.x ?? 0, gridY: widget.y ?? 0, gridW: widget.w ?? 6, gridH: widget.h ?? 4 }
  })
  if (widget.query !== undefined || widget.config) {
    await api(page, token, 'PATCH', `/admin/api/dashboards/${dashboardId}/widgets/${created.id}`, {
      data: {
        ...(widget.query !== undefined ? { query: widget.query } : {}),
        ...(widget.config ? { config: widget.config } : {})
      }
    })
  }
  return created
}

export async function publishDashboard(page: Page, token: string, id: string) {
  await api(page, token, 'POST', `/admin/api/dashboards/${id}/publish`)
}
