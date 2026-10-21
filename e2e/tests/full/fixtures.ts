import { test as base, expect, request as pwRequest, type APIRequestContext } from '@playwright/test'
import { BASE_URL } from '../helpers'

/**
 * The exhaustive phase (e2e/tests/full): one system built from scratch -
 * tables, views, a function, resources, roles, users, DataViews, dashboards -
 * then every exposed API, the security of all of it (escalation, bypass,
 * injection, IDOR), and its performance. Pure API (no browser): a bearer
 * token and raw requests, so an attack sends exactly what it wants.
 */

export { expect }

const BASE = BASE_URL
const ADMIN_EMAIL = process.env.TOTALBASE_ADMIN_EMAIL ?? 'admin@totalbase.local'
const ADMIN_PASSWORD = process.env.TOTALBASE_ADMIN_PASSWORD ?? '1234567'

export interface Api {
  ctx: APIRequestContext
  token: string | null
  get<T = unknown>(path: string): Promise<{ status: number, data?: T, errors?: { code: string, message: string }[], raw: string }>
  send<T = unknown>(method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number, data?: T, errors?: { code: string, message: string }[], raw: string }>
}

async function parse(response: import('@playwright/test').APIResponse) {
  const raw = await response.text()
  let body: Record<string, unknown> = {}
  try { body = raw ? JSON.parse(raw) : {} } catch { /* non-JSON (a file, HTML) */ }
  return { status: response.status(), data: body.data, errors: body.errors as { code: string, message: string }[] | undefined, raw }
}

/** An API client bound to a token (or none). Reuses one request context. */
export function client(ctx: APIRequestContext, token: string | null): Api {
  const headers = () => (token ? { Authorization: `Bearer ${token}` } : {})
  return {
    ctx,
    token,
    async get(path) { return parse(await ctx.get(`${BASE}${path}`, { headers: headers() })) },
    async send(method, path, body, extra) {
      const fn = method === 'POST' ? ctx.post : method === 'PATCH' ? ctx.patch : method === 'PUT' ? ctx.put : ctx.delete
      return parse(await fn.call(ctx, `${BASE}${path}`, { headers: { ...headers(), ...extra }, data: body === undefined ? undefined : body }))
    }
  }
}

async function loginAdmin(ctx: APIRequestContext): Promise<string> {
  const res = await ctx.post(`${BASE}/admin/api/auth/login`, { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })
  const body = await res.json()
  const token = body.data?.token
  if (!token) throw new Error(`Admin login failed: ${res.status()} ${JSON.stringify(body)}`)
  return token
}

/** Logs in through the Data API's own /api/auth/login (any plane). */
export async function loginApp(ctx: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await ctx.post(`${BASE}/api/auth/login`, { data: { email, password } })
  const body = await res.json()
  if (!body.data?.token) throw new Error(`App login failed for ${email}: ${res.status()} ${JSON.stringify(body)}`)
  return body.data.token
}

interface Fixtures {
  admin: Api
  anon: Api
}

export const test = base.extend<Fixtures>({
  admin: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext()
    const token = await loginAdmin(ctx)
    await use(client(ctx, token))
    await ctx.dispose()
  },
  anon: async ({ playwright }, use) => {
    const ctx = await playwright.request.newContext()
    await use(client(ctx, null))
    await ctx.dispose()
  }
})

/** A standalone admin client for beforeAll/afterAll (no test fixtures there). */
export async function adminApi(): Promise<{ api: Api, dispose: () => Promise<void> }> {
  const ctx = await pwRequest.newContext()
  const token = await loginAdmin(ctx)
  return { api: client(ctx, token), dispose: () => ctx.dispose() }
}

// --- Admin API helpers -------------------------------------------------------------

export async function sql(api: Api, statement: string): Promise<Record<string, unknown>[]> {
  const res = await api.send<{ rows: Record<string, unknown>[] }>('POST', '/admin/api/sql/execute', { data: { sql: statement } })
  if (res.status !== 200) throw new Error(`SQL failed: ${res.status} ${res.raw.slice(0, 300)}`)
  return res.data!.rows
}

export async function resourceId(api: Api, table: string): Promise<string> {
  const res = await api.get<{ id: string }[]>(`/api/totalbase/table/resources?fields=id&where[schema][_eq]=public&where[name][_eq]=${table}&where[status][_eq]=ACTIVE`)
  if (!res.data?.[0]) throw new Error(`No ACTIVE resource for ${table}`)
  return res.data[0].id
}

export async function expose(api: Api, table: string, methods: string[] = ['GET', 'POST', 'PATCH', 'DELETE']) {
  await api.send('PATCH', `/admin/api/resources/${await resourceId(api, table)}`, { data: { exposedMethods: methods } })
}

// --- The e2e_full schema -----------------------------------------------------------

export const FULL_TABLES = ['e2e_full_items', 'e2e_full_pedidos', 'e2e_full_sucursales', 'e2e_full_empleados', 'e2e_full_categorias'] as const

/**
 * A small business: branches with employees, categories, orders over a
 * branch with a status CHECK and a trigger-kept total, and order items. Varied
 * types (uuid, serial, numeric, date, timestamptz, boolean, jsonb, point,
 * text[]), FKs, UNIQUE, CHECK, a view and a function. Dropped and recreated
 * whole; a few thousand orders for performance.
 */
export const FULL_SCHEMA_SQL = `
DROP VIEW IF EXISTS public.e2e_full_ventas_por_sucursal CASCADE;
DROP FUNCTION IF EXISTS public.e2e_full_total_pedido() CASCADE;
DROP FUNCTION IF EXISTS public.e2e_full_resumen(integer) CASCADE;
DROP TABLE IF EXISTS public.e2e_full_items, public.e2e_full_pedidos, public.e2e_full_empleados, public.e2e_full_sucursales, public.e2e_full_categorias CASCADE;

CREATE TABLE public.e2e_full_sucursales (
  id serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE,
  ciudad text NOT NULL,
  ubicacion point,
  latitud numeric(9,6),
  longitud numeric(9,6),
  activa boolean NOT NULL DEFAULT true
);
CREATE TABLE public.e2e_full_empleados (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre text NOT NULL,
  email text UNIQUE,
  sucursal integer REFERENCES public.e2e_full_sucursales(id),
  salario numeric(12,2) NOT NULL DEFAULT 0 CHECK (salario >= 0),
  etiquetas text[] NOT NULL DEFAULT '{}',
  datos jsonb NOT NULL DEFAULT '{}',
  ingreso date NOT NULL DEFAULT current_date,
  secreto text NOT NULL DEFAULT 'oculto'
);
CREATE TABLE public.e2e_full_categorias (
  id serial PRIMARY KEY,
  nombre text NOT NULL UNIQUE
);
CREATE TABLE public.e2e_full_pedidos (
  id serial PRIMARY KEY,
  sucursal integer NOT NULL REFERENCES public.e2e_full_sucursales(id),
  vendedor uuid REFERENCES public.e2e_full_empleados(id),
  fecha date NOT NULL DEFAULT current_date,
  creado timestamptz NOT NULL DEFAULT now(),
  estado text NOT NULL DEFAULT 'BORRADOR' CHECK (estado IN ('BORRADOR', 'CONFIRMADO', 'ENVIADO', 'ANULADO')),
  total numeric(12,2) NOT NULL DEFAULT 0
);
CREATE TABLE public.e2e_full_items (
  id serial PRIMARY KEY,
  pedido integer NOT NULL REFERENCES public.e2e_full_pedidos(id) ON DELETE CASCADE,
  categoria integer REFERENCES public.e2e_full_categorias(id),
  descripcion text NOT NULL,
  cantidad integer NOT NULL DEFAULT 1 CHECK (cantidad > 0),
  precio numeric(12,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
  importe numeric(12,2) GENERATED ALWAYS AS (cantidad * precio) STORED
);
CREATE FUNCTION public.e2e_full_total_pedido() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE public.e2e_full_pedidos p SET total = coalesce((SELECT sum(importe) FROM public.e2e_full_items WHERE pedido = p.id), 0)
  WHERE p.id = coalesce(NEW.pedido, OLD.pedido);
  RETURN NULL;
END $fn$;
CREATE TRIGGER e2e_full_total AFTER INSERT OR UPDATE OR DELETE ON public.e2e_full_items
  FOR EACH ROW EXECUTE FUNCTION public.e2e_full_total_pedido();
CREATE VIEW public.e2e_full_ventas_por_sucursal AS
  SELECT s.id AS sucursal, s.nombre, count(p.id) AS pedidos, coalesce(sum(p.total), 0) AS total
  FROM public.e2e_full_sucursales s LEFT JOIN public.e2e_full_pedidos p ON p.sucursal = s.id GROUP BY s.id, s.nombre;
CREATE FUNCTION public.e2e_full_resumen(dias integer) RETURNS TABLE(pedidos bigint, total numeric) LANGUAGE sql STABLE AS $fn$
  SELECT count(*), coalesce(sum(total), 0) FROM public.e2e_full_pedidos WHERE fecha >= current_date - dias
$fn$;

INSERT INTO public.e2e_full_sucursales (nombre, ciudad, ubicacion, latitud, longitud, activa) VALUES
  ('Centro', 'Buenos Aires', point(-58.38, -34.60), -34.60, -58.38, true),
  ('Norte', 'Córdoba', point(-64.18, -31.42), -31.42, -64.18, true),
  ('Sur', 'Rosario', point(-60.65, -32.95), -32.95, -60.65, false);
INSERT INTO public.e2e_full_categorias (nombre) VALUES ('Hardware'), ('Software'), ('Servicios');
INSERT INTO public.e2e_full_empleados (nombre, email, sucursal, salario, etiquetas, datos, secreto) VALUES
  ('Ana Gómez', 'ana@e2e.test', 1, 850000, '{"ventas","senior"}', '{"nivel":3}', 'pin-ana'),
  ('Luis Paz', 'luis@e2e.test', 2, 620000, '{"ventas"}', '{"nivel":2}', 'pin-luis'),
  ('Marta Ruiz', 'marta@e2e.test', 1, 540000, '{"soporte"}', '{"nivel":1}', 'pin-marta');
-- A few thousand orders for performance, spread over branches, sellers and dates.
INSERT INTO public.e2e_full_pedidos (sucursal, vendedor, fecha, estado)
  SELECT 1 + n % 3,
         (ARRAY(SELECT id FROM public.e2e_full_empleados ORDER BY nombre))[1 + n % 3],
         current_date - (n % 365),
         (ARRAY['BORRADOR','CONFIRMADO','ENVIADO','ANULADO'])[1 + n % 4]
  FROM generate_series(1, 4000) n;
INSERT INTO public.e2e_full_items (pedido, categoria, descripcion, cantidad, precio)
  SELECT p.id, 1 + p.id % 3, 'Item ' || p.id, 1 + p.id % 5, (100 + p.id % 900)::numeric
  FROM public.e2e_full_pedidos p;
ANALYZE public.e2e_full_pedidos;
ANALYZE public.e2e_full_items;
`

/**
 * Drops and recreates the schema. The previous build's resources need no
 * cleanup of their own: the catalog refresh marks the dropped OIDs MISSING
 * and purges them (packages/resources reconcile-resources.ts).
 */
export async function resetFullSchema(api: Api) {
  await sql(api, FULL_SCHEMA_SQL)
  await api.send('POST', '/admin/api/catalog/refresh')
}
