import { adminApi, expose, FULL_TABLES, resetFullSchema, resourceId, sql, test, expect, type Api } from './fixtures.js'

/**
 * Phase 1: a whole system built from scratch over the e2e_full schema -
 * resources reconciled from the catalog, every DataView type, a dashboard,
 * each confirmed to exist and serve its data. The later phases (APIs,
 * security, performance) run against what this builds.
 */
let api: Api
let dispose: () => Promise<void>
// validateName allows letters, digits and normal separators - not MASTER_DETAIL's underscore.
const DV = (t: string) => `E2E Full ${t.replace(/_/g, ' ').toLowerCase()}`
const created: Record<string, { id: string, slug: string }> = {}
const dashboards: string[] = []

test.beforeAll(async () => {
  ({ api, dispose } = await adminApi())
  await resetFullSchema(api)
})
// Cleanup by primary key: only what this run created, by the ids it got back.
test.afterAll(async () => {
  for (const d of Object.values(created)) await api.send('DELETE', `/admin/api/dataviews/${d.id}`)
  for (const id of dashboards) await api.send('DELETE', `/admin/api/dashboards/${id}`)
  await dispose()
})

test('the catalog reconciled every table, the view and the functions as resources', async () => {
  const rows = await sql(api, "SELECT name, type, status FROM totalbase.resources WHERE schema = 'public' AND name LIKE 'e2e_full_%' AND status = 'ACTIVE' ORDER BY name")
  const byName = Object.fromEntries(rows.map(r => [r.name, r]))
  for (const t of FULL_TABLES) expect(byName[t], t).toMatchObject({ type: 'TABLE', status: 'ACTIVE' })
  expect(byName.e2e_full_ventas_por_sucursal).toMatchObject({ type: 'VIEW', status: 'ACTIVE' })
  expect(byName.e2e_full_resumen).toMatchObject({ type: 'FUNCTION' })
})

test('a dropped-and-recreated table is a new resource, hidden by default - identity follows the OID, not the name', async () => {
  const before = await resourceId(api, 'e2e_full_categorias')
  await sql(api, 'DROP TABLE public.e2e_full_categorias CASCADE; CREATE TABLE public.e2e_full_categorias (id serial PRIMARY KEY, nombre text NOT NULL UNIQUE)')
  await api.send('POST', '/admin/api/catalog/refresh')
  const rows = await sql(api, "SELECT id, status, exposed_methods FROM totalbase.resources WHERE schema = 'public' AND name = 'e2e_full_categorias'")
  // The old resource went MISSING and was purged (its OID can never come
  // back); the recreated table is a new resource with a new id, not exposed.
  expect(rows).toHaveLength(1)
  expect(rows[0]!.id).not.toBe(before)
  expect(rows[0]).toMatchObject({ status: 'ACTIVE', exposed_methods: [] })
  // Re-seed the categories the items reference (the FK went with the CASCADE).
  await sql(api, 'INSERT INTO public.e2e_full_categorias (nombre) VALUES (\'Hardware\'), (\'Software\'), (\'Servicios\')')
})

test('a DataView of every type is created and serves its data', async () => {
  const sucursales = await resourceId(api, 'e2e_full_sucursales')
  const empleados = await resourceId(api, 'e2e_full_empleados')
  const pedidos = await resourceId(api, 'e2e_full_pedidos')
  const items = await resourceId(api, 'e2e_full_items')
  for (const t of FULL_TABLES) await expose(api, t)

  const make = async (type: string, body: Record<string, unknown>) => {
    const res = await api.send<{ id: string, slug: string }>('POST', '/admin/api/dataviews', { data: { name: DV(type), viewType: type, ...body } })
    expect(res.status, `${type}: ${res.raw.slice(0, 200)}`).toBe(201)
    created[type] = res.data!
    const pub = await api.send('POST', `/admin/api/dataviews/${res.data!.id}/publish`)
    expect(pub.status, `${type} publish: ${pub.raw.slice(0, 200)}`).toBe(201)
  }
  await make('TABLE', { sourceResourceId: pedidos, selectedColumns: ['fecha', 'sucursal', 'estado', 'total'] })
  await make('FORM', { sourceResourceId: empleados, selectedColumns: ['nombre', 'email', 'sucursal', 'salario'] })
  await make('CARDS', { sourceResourceId: empleados, viewConfig: { card_layout: { titleFormula: '{{nombre}}', descriptionFormula: '{{email}}', imageFormula: null } } })
  await make('MAP', { sourceResourceId: sucursales, viewConfig: { map_layout: { latitudeColumn: 'latitud', longitudeColumn: 'longitud', nameFormula: '{{nombre}}', descriptionFormula: '{{ciudad}}', iconFormula: null, colorFormula: null, defaultIcon: 'i-lucide-store', defaultColor: 'emerald' }, map_view: { centerLat: -34, centerLng: -60, zoom: 4 } } })
  await make('KANBAN', { sourceResourceId: pedidos, viewConfig: { kanban_layout: { groupColumn: 'sucursal', titleFormula: "'Pedido ' || {{id}}", descriptionFormula: '{{estado}}', imageFormula: null, laneOrder: [] } } })
  await make('CALENDAR', { sourceResourceId: pedidos, viewConfig: { calendar_layout: { dateColumn: 'fecha', titleFormula: "'Pedido ' || {{id}}", descriptionFormula: null, colorFormula: null, defaultColor: 'blue', weekStartsOn: 1, defaultView: 'month' } } })
  await make('GANTT', { sourceResourceId: pedidos, viewConfig: { gantt_layout: { startDateColumn: 'fecha', endDateColumn: 'fecha', groupColumn: 'sucursal', titleFormula: "'Pedido ' || {{id}}", descriptionFormula: null, colorFormula: null, defaultColor: 'blue', laneOrder: [], defaultZoom: 'month' } } })
  await make('MASTER_DETAIL', { sourceResourceId: pedidos, detail: { resourceId: items, fkColumn: 'pedido' } })
  await make('CUSTOM', {})
  await make('EXTERNALFRAME', { viewConfig: { frame_url: 'https://example.com/' } })

  // The App serves each published list DataView's own data by slug.
  for (const type of ['TABLE', 'CARDS', 'MAP', 'KANBAN', 'CALENDAR', 'GANTT']) {
    const res = await api.get<unknown[]>(`/app/api/dataviews/${created[type]!.slug}/fields`)
    expect(res.status, type).toBe(200)
  }
})

test('a dashboard is created, its widgets run, and it is published', async () => {
  const res = await api.send<{ id: string, slug: string }>('POST', '/admin/api/dashboards', { data: { name: DV('Panel') } })
  expect(res.status).toBe(201)
  const dash = res.data!
  dashboards.push(dash.id)
  const widget = async (type: string, query: string) => {
    const w = await api.send<{ id: string }>('POST', `/admin/api/dashboards/${dash.id}/widgets`, { data: { type, gridX: 0, gridY: 0, gridW: 6, gridH: 4 } })
    expect(w.status, `${type}: ${w.raw.slice(0, 200)}`).toBe(201)
    const patched = await api.send('PATCH', `/admin/api/dashboards/${dash.id}/widgets/${w.data!.id}`, { data: { query } })
    expect(patched.status, `${type}: ${patched.raw.slice(0, 200)}`).toBe(200)
    const run = await api.send<{ rows: unknown[] }>('POST', `/admin/api/dashboards/${dash.id}/widgets/${w.data!.id}/data`, { data: {} })
    expect(run.status, `${type}: ${run.raw.slice(0, 200)}`).toBe(200)
    return run.data!
  }
  const kpi = await widget('KPI', 'SELECT count(*) AS n FROM public.e2e_full_pedidos')
  expect(Number((kpi.rows[0] as { n: string }).n)).toBe(4000)
  await widget('BAR', 'SELECT nombre, total FROM public.e2e_full_ventas_por_sucursal ORDER BY total DESC')
  await widget('TABLE', 'SELECT nombre, ciudad FROM public.e2e_full_sucursales ORDER BY nombre')
  const pub = await api.send('POST', `/admin/api/dashboards/${dash.id}/publish`)
  expect(pub.status).toBe(201)
})
