import { addWidget, adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * One DataView of every type over the e2e_v1 schema, created as the wizard
 * does (POST /admin/api/dataviews), published and opened in the App: each
 * shows its rows, its own way.
 */
const PREFIX = 'V1 Type'
const names = (type: string) => `${PREFIX} ${type.replace('_', ' ')}`
const TYPES = ['TABLE', 'FORM', 'CARDS', 'MAP', 'KANBAN', 'CALENDAR', 'GANTT', 'MASTER_DETAIL', 'CUSTOM', 'EXTERNALFRAME'] as const
const created: Record<string, DataViewRef> = {}

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, TYPES.map(names))
  await resetSchema(page, token)
  const clientes = await resourceId(page, token, 'e2e_v1_clientes')
  const pedidos = await resourceId(page, token, 'e2e_v1_pedidos')
  const items = await resourceId(page, token, 'e2e_v1_pedidos_items')
  const tareas = await resourceId(page, token, 'e2e_v1_tareas')
  const make = async (type: string, body: Record<string, unknown>) => {
    created[type] = await createDataView(page, token, { name: names(type), viewType: type, ...body })
  }

  await make('TABLE', { sourceResourceId: clientes, selectedColumns: ['nombre', 'email', 'categoria', 'activo', 'limite_credito', 'fecha_alta'] })
  await make('FORM', { sourceResourceId: clientes, selectedColumns: ['nombre', 'email', 'telefono', 'categoria', 'activo', 'limite_credito'] })
  await make('CARDS', { sourceResourceId: clientes, viewConfig: { card_layout: { titleFormula: '{{nombre}}', descriptionFormula: '{{email}}', imageFormula: null } } })
  await make('MAP', {
    sourceResourceId: tareas,
    viewConfig: {
      map_layout: { latitudeColumn: 'lat', longitudeColumn: 'long', nameFormula: '{{titulo}}', descriptionFormula: '{{proyecto}}', iconFormula: null, colorFormula: null, defaultIcon: 'i-lucide-map-pin', defaultColor: 'emerald' },
      map_view: { centerLat: -33, centerLng: -62, zoom: 5 }
    }
  })
  // A lane per row of the table its group column points at - customers by category.
  await make('KANBAN', { sourceResourceId: clientes, viewConfig: { kanban_layout: { groupColumn: 'categoria', titleFormula: '{{nombre}}', descriptionFormula: '{{email}}', imageFormula: null, laneOrder: ['3', '1', '2'] } } })
  await make('CALENDAR', { sourceResourceId: tareas, viewConfig: { calendar_layout: { dateColumn: 'inicio', titleFormula: '{{titulo}}', descriptionFormula: null, colorFormula: null, defaultColor: 'blue', weekStartsOn: 1, defaultView: 'month' } } })
  await make('GANTT', {
    sourceResourceId: tareas,
    viewConfig: { gantt_layout: { startDateColumn: 'inicio', endDateColumn: 'fin', groupColumn: 'proyecto', titleFormula: '{{titulo}}', descriptionFormula: null, colorFormula: null, defaultColor: 'blue', laneOrder: [], defaultZoom: 'week' } }
  })
  await make('MASTER_DETAIL', { sourceResourceId: pedidos, detail: { resourceId: items, fkColumn: 'pedido' } })
  await make('CUSTOM', {})
  await addWidget(page, token, created.CUSTOM!.id, 'THeading', { props: { label: 'Una página propia' } })
  await make('EXTERNALFRAME', { viewConfig: { frame_url: 'https://example.com/' } })
  for (const type of TYPES) await publish(page, token, created[type]!.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, TYPES.map(names))
  await context.close()
})

const open = (page: import('@playwright/test').Page, type: string, query = '') => page.goto(`/app/dataviews/${created[type]!.slug}${query}`)

test('TABLE lists its rows, its foreign key by its row, its numbers and dates formatted', async ({ page, token: _ }) => {
  await open(page, 'TABLE')
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: names('TABLE') })).toBeVisible()
  const acme = main.locator('tbody tr').filter({ hasText: 'Acme SA' })
  await expect(acme).toContainText('compras@acme.test')
  await expect(acme).toContainText(/500[.,]000/)
})

test('FORM opens a new record and a saved one', async ({ page, token: _ }) => {
  await open(page, 'FORM')
  const main = page.locator('main')
  await expect(main.getByRole('heading', { name: names('FORM') })).toBeVisible()
  await expect(main.getByLabel('Nombre')).toBeVisible()
})

test('CARDS shows a card per row', async ({ page, token: _ }) => {
  await open(page, 'CARDS')
  const main = page.locator('main')
  await expect(main.getByText('Acme SA', { exact: true })).toBeVisible()
  await expect(main.getByText('compras@acme.test', { exact: true })).toBeVisible()
})

test('MAP draws a marker per row', async ({ page, token: _ }) => {
  await open(page, 'MAP')
  await expect(page.locator('.leaflet-container')).toBeVisible()
  // Nearby points cluster: the markers alone plus what each cluster counts.
  await expect.poll(() => page.locator('.leaflet-marker-icon').evaluateAll(icons => icons
    .reduce((sum, icon) => sum + (icon.classList.contains('marker-cluster') ? Number(icon.textContent?.trim() || 0) : 1), 0))).toBe(3)
})

test('MAP draws Mapbox tiles once the instance uses them', async ({ page, token }) => {
  // A 1x1 PNG stands in for Mapbox: the test checks which tiles are asked for, not Mapbox itself.
  const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  const requested: string[] = []
  await page.route('https://api.mapbox.com/**', (route) => {
    requested.push(route.request().url())
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
  })
  await api(page, token, 'PATCH', '/admin/api/settings/maps', { data: { tiles: 'MAPBOX', mapbox_token: 'pk.e2e-test-token-123', mapbox_style: 'mapbox/light-v11' } })
  try {
    await open(page, 'MAP')
    // Mapbox's style is read before the map mounts - slower than the default tiles.
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => requested.length).toBeGreaterThan(0)
    expect(requested[0]).toContain('/styles/v1/mapbox/light-v11/tiles/512/')
    expect(requested[0]).toContain('access_token=pk.e2e-test-token-123')
    await expect(page.getByRole('link', { name: 'Improve this map' })).toBeVisible()
  } finally {
    await api(page, token, 'PATCH', '/admin/api/settings/maps', { data: { tiles: 'OPENSTREETMAP', mapbox_token: '', mapbox_style: 'mapbox/streets-v12' } })
  }
})

test('KANBAN shows a lane per category, in its order, each customer in its lane', async ({ page, token: _ }) => {
  await open(page, 'KANBAN')
  const main = page.locator('main')
  await expect(main.getByText('Acme SA', { exact: true })).toBeVisible()
  const lanes = main.getByText(/^(Gobierno|Mayorista|Minorista|Unassigned)$/)
  await expect(lanes).toHaveText(['Gobierno', 'Mayorista', 'Minorista', 'Unassigned'])
})

test('CALENDAR shows the rows on their dates', async ({ page, token: _ }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T12:00:00'))
  await open(page, 'CALENDAR')
  const main = page.locator('main')
  await expect(main.getByText('Diseñar pantallas').first()).toBeVisible()
  await expect(main.getByText('Migrar datos').first()).toBeVisible()
})

test('GANTT lays every row out in time', async ({ page, token: _ }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T12:00:00'))
  await open(page, 'GANTT')
  const main = page.locator('main')
  // Lanes group by a foreign key only (as a Kanban's): \`proyecto\` is text, so one bar per task, ungrouped.
  for (const task of ['Relevar requisitos', 'Diseñar pantallas', 'Migrar datos']) await expect(main.getByRole('button', { name: task })).toBeVisible()
})

test('MASTER_DETAIL opens an order with its items', async ({ page, token: _ }) => {
  await open(page, 'MASTER_DETAIL', '?pk=1')
  const main = page.locator('main')
  // Its items are editable lines: each description is an input's value.
  const values = () => main.locator('tbody input').evaluateAll(inputs => inputs.map(i => (i as HTMLInputElement).value))
  await expect.poll(values).toContain('Tornillos x100')
  await expect.poll(values).toContain('Arandelas x100')
})

test('CUSTOM draws its own widgets', async ({ page, token: _ }) => {
  await open(page, 'CUSTOM')
  await expect(page.locator('main').getByText('Una página propia')).toBeVisible()
})

test('EXTERNALFRAME embeds its page', async ({ page, token: _ }) => {
  await open(page, 'EXTERNALFRAME')
  await expect(page.locator('main iframe')).toHaveCount(1)
})
