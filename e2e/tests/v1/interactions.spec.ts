import { adminSession, api, createDataView, deleteDataViewsNamed, expect, publish, resetSchema, resourceId, test, type DataViewRef } from './fixtures.js'

/**
 * Editing by dragging, as a planning or sales board is used: a Gantt bar's
 * end dragged later reschedules its row; a Kanban card dragged to another
 * lane changes its group column. Both through the Data API, as any edit.
 */
const GANTT = 'V1 Drag Gantt'
const KANBAN = 'V1 Drag Kanban'
let gantt: DataViewRef
let kanban: DataViewRef

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [GANTT, KANBAN])
  await resetSchema(page, token)
  gantt = await createDataView(page, token, {
    name: GANTT,
    viewType: 'GANTT',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_tareas'),
    viewConfig: { gantt_layout: { startDateColumn: 'inicio', endDateColumn: 'fin', groupColumn: null, titleFormula: '{{titulo}}', descriptionFormula: null, colorFormula: null, defaultColor: 'blue', laneOrder: [], defaultZoom: 'day' } }
  })
  kanban = await createDataView(page, token, {
    name: KANBAN,
    viewType: 'KANBAN',
    sourceResourceId: await resourceId(page, token, 'e2e_v1_clientes'),
    viewConfig: { kanban_layout: { groupColumn: 'categoria', titleFormula: '{{nombre}}', descriptionFormula: null, imageFormula: null, laneOrder: ['1', '2', '3'] } }
  })
  await publish(page, token, gantt.id)
  await publish(page, token, kanban.id)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  await deleteDataViewsNamed(page, token, [GANTT, KANBAN])
  await context.close()
})

test('a Gantt bar\'s end dragged three days later reschedules its row', async ({ page, token }) => {
  await page.clock.setFixedTime(new Date('2026-10-08T12:00:00'))
  await page.goto(`/app/dataviews/${gantt.slug}`)
  // The bar is named by its title (and its progress) - a short bar's title beside it is its second, hidden handle.
  const bar = page.getByRole('button', { name: /^Diseñar pantallas/ })
  await bar.scrollIntoViewIfNeeded()
  const box = (await bar.boundingBox())!
  // The day's width, from the day columns' header - not assumed.
  const pxPerDay = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('main *')].filter(e => /^\d{1,2}$/.test((e.textContent ?? '').trim()) && e.children.length === 0)
    const xs = cells.map(e => e.getBoundingClientRect().x).sort((a, b) => a - b)
    const gaps = xs.slice(1).map((x, i) => x - xs[i]!).filter(g => g > 4)
    return gaps.length ? Math.min(...gaps) : 32
  })
  const x = box.x + box.width - 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + pxPerDay * 3, y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(async () => {
    const [row] = await api<{ fin: string }[]>(page, token, 'GET', '/api/public/table/e2e_v1_tareas?fields=fin&where[titulo][_eq]=Diseñar pantallas')
    return row?.fin
  }).toBe('2026-10-15')
})

test('a Kanban card dragged to another lane changes its category', async ({ page, token }) => {
  await page.goto(`/app/dataviews/${kanban.slug}`)
  const card = page.locator('main').getByText('Delta y Asociados', { exact: true })
  await expect(card).toBeVisible()
  const target = page.locator('main').getByText('Gobierno', { exact: true }).first()
  const from = (await card.boundingBox())!
  const to = (await target.boundingBox())!
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2)
  await page.mouse.down()
  await page.mouse.move(to.x + to.width / 2, to.y + 80, { steps: 15 })
  await page.mouse.up()
  await expect.poll(async () => {
    const [row] = await api<{ categoria: number }[]>(page, token, 'GET', '/api/public/table/e2e_v1_clientes?fields=categoria&where[nombre][_eq]=Delta y Asociados')
    return row?.categoria
  }).toBe(3)
})
