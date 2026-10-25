import { createHmac } from 'node:crypto'
import type { Page } from '@playwright/test'
import { adminSession, api, expect, test } from './fixtures.js'
import { BASE_URL } from '../helpers'

/**
 * Dashboard embeds (Dashboards.md §9.5), end to end: an
 * administrator designs an embed in the editor's Embed drawer with a live
 * preview and creates a public link; another site frames it with the
 * locked value bound and the embed's look; a signed embed for a portal;
 * only the embed's sites may frame it; the dashboard's id never in an
 * address; a publish that would break an embed is flagged first.
 */
// Another origin than the instance's (BASE_URL's localhost): local and http like the dev server - Chrome refuses a public
// site framing localhost, and an https page an http frame. Its page is answered by page.route, never by the server.
const HOST = BASE_URL.replace('localhost', '127.0.0.1')
const SECRET_KEY = 'e2e-embed-secret'
const SECRET = 'e2e-embed-secret-value-0123456789'
const NAME = 'V1 Embed Ventas'
let dashboardId = ''

// The partner page is answered by page.route, which Chrome treats as a public site framing the local dev server - its
// Local Network Access check (a guard for local networks, not something TotalBase decides) is off for this file.
test.use({ launchOptions: { args: ['--disable-features=LocalNetworkAccessChecks'] } })
test.describe.configure({ mode: 'serial' })

function sign(payload: object): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const body = `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}`
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`
}

/** The embedding site: a page of its own that frames TotalBase, listening for the embed's height. */
async function openHost(page: Page, path: string) {
  await page.route(`${HOST}/partner/**`, route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><title>Partner</title><output id="height"></output>
      <script>addEventListener('message', e => { if (e.data && e.data.type === 'totalbase:embed:resize') document.getElementById('height').textContent = String(e.data.height) })</script>
      <iframe title="Sales" style="width:1000px;height:600px" src="${BASE_URL}${path}"></iframe>`
  }))
  await page.goto(`${HOST}/partner/report`)
  return page.frameLocator('iframe[title="Sales"]')
}

interface Embed { id: string, name: string, type: string, link: string | null }
const embeds = (page: Page, token: string) => api<Embed[]>(page, token, 'GET', `/admin/api/dashboards/${dashboardId}/embeds`)

test.beforeAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  for (const d of (await api<{ id: string, name: string }[]>(page, token, 'GET', '/admin/api/dashboards')).filter(d => d.name === NAME)) {
    await api(page, token, 'DELETE', `/admin/api/dashboards/${d.id}`)
  }
  await api(page, token, 'PUT', `/admin/api/secrets/${SECRET_KEY}`, { data: { value: SECRET } })
  await api(page, token, 'PATCH', '/admin/api/settings/dashboards', { data: { embed_secret_key: SECRET_KEY, embed_allowed_origins: [HOST] } })
  dashboardId = (await api<{ id: string }>(page, token, 'POST', '/admin/api/dashboards', { data: { name: NAME, description: 'Ventas por cliente' } })).id
  await api(page, token, 'PATCH', `/admin/api/dashboards/${dashboardId}`, { data: { variables: [
    { name: 'customer', label: 'Customer', type: 'TEXT' },
    { name: 'region', label: 'Region', type: 'SELECT', options: { source: 'STATIC', values: ['Norte', 'Sur'] } }
  ] } })
  const widget = await api<{ id: string }>(page, token, 'POST', `/admin/api/dashboards/${dashboardId}/widgets`, { data: { type: 'TABLE', label: 'Embedded values', gridX: 0, gridY: 0, gridW: 6, gridH: 4 } })
  await api(page, token, 'PATCH', `/admin/api/dashboards/${dashboardId}/widgets/${widget.id}`, { data: { query: `SELECT 'Cliente ' || coalesce($VAR.customer, '-') || ' / ' || coalesce($VAR.region, 'todas') AS cliente` } })
  await api(page, token, 'POST', `/admin/api/dashboards/${dashboardId}/publish`)
  await context.close()
})

test.afterAll(async ({ browser }) => {
  const { context, page, token } = await adminSession(browser)
  if (dashboardId) await api(page, token, 'DELETE', `/admin/api/dashboards/${dashboardId}`)
  await api(page, token, 'PATCH', '/admin/api/settings/dashboards', { data: { embed_secret_key: '', embed_allowed_origins: [] } })
  await api(page, token, 'DELETE', `/admin/api/secrets/${SECRET_KEY}`)
  await context.close()
})

test('Settings › Share: a live preview of the design, then a public link', async ({ page, token }) => {
  await page.goto(`/dashboards/${dashboardId}`)
  const main = page.locator('main')
  // Share, a section of its settings (D26).
  await main.getByRole('button', { name: 'Settings', exact: true }).click()
  await main.getByRole('link', { name: 'Share', exact: true }).click()
  await page.waitForURL(/section=share/)
  // Only the Share section shows; the hidden General keeps its own Name.
  const drawer = main.locator('section').filter({ has: page.getByRole('switch', { name: 'Allow embedding' }) })
  await drawer.getByRole('switch', { name: 'Allow embedding' }).click()
  await drawer.getByLabel('Name').fill('Sitio web')
  await drawer.getByLabel('Customer value').fill('Acme')
  await drawer.getByLabel('Customer mode').click()
  await page.getByRole('option', { name: /Locked/ }).click()
  await drawer.getByLabel('Show the title and description').check()
  // The preview is the real embed page, on what is being designed.
  const preview = drawer.frameLocator('iframe[title="Embed preview"]')
  await expect(preview.getByText('Cliente Acme / todas')).toBeVisible({ timeout: 15_000 })
  await expect(preview.getByRole('heading', { name: NAME })).toBeVisible()
  await drawer.getByRole('button', { name: 'Create link' }).click()
  await expect(drawer.getByText('Sitio web', { exact: true })).toBeVisible()
  const [link] = (await embeds(page, token)).filter(e => e.name === 'Sitio web')
  expect(link!.link).toMatch(/^tbe_/)
  // Right where it was created: the link to paste, ready to copy.
  await expect(drawer.getByText('Link to paste in the page')).toBeVisible()
  await expect(drawer.getByText(`/embed/${link!.link}`).first()).toBeVisible()
  await expect(drawer.getByRole('button', { name: 'Copy link' }).first()).toBeVisible()
})

test('another site frames the public link - the locked value bound, the embed\'s look, never the dashboard\'s id', async ({ browser, page, token }) => {
  const [link] = (await embeds(page, token)).filter(e => e.name === 'Sitio web')
  const context = await browser.newContext()
  const visitor = await context.newPage()
  const requests: string[] = []
  visitor.on('request', r => requests.push(r.url()))
  const frame = await openHost(visitor, `/embed/${link!.link}?var-region=Sur&var-customer=Evil`)
  await expect(frame.getByText('Cliente Acme / Sur')).toBeVisible({ timeout: 15_000 })
  await expect(frame.getByRole('heading', { name: NAME })).toBeVisible()
  await expect.poll(async () => Number(await visitor.locator('#height').textContent())).toBeGreaterThan(100)
  expect(requests.filter(url => url.includes(dashboardId))).toEqual([])
  await context.close()
})

test('a signed embed for a portal: the token names the embed and gives the visitor\'s value', async ({ browser, page, token }) => {
  const signed = await api<Embed>(page, token, 'POST', `/admin/api/dashboards/${dashboardId}/embeds`, { data: { name: 'Portal', type: 'SIGNED', variables: { customer: { mode: 'LOCKED' } } } })
  const context = await browser.newContext()
  const visitor = await context.newPage()
  const jwt = sign({ resource: { embed: signed.id }, params: { customer: 'Globex' }, exp: Math.floor(Date.now() / 1000) + 600 })
  const frame = await openHost(visitor, `/embed/${signed.id}#${jwt}`)
  await expect(frame.getByText('Cliente Globex / todas')).toBeVisible({ timeout: 15_000 })
  // An expired token shows nothing.
  const stale = sign({ resource: { embed: signed.id }, params: { customer: 'Globex' }, exp: Math.floor(Date.now() / 1000) - 10 })
  const staleFrame = await openHost(visitor, `/embed/${signed.id}#${stale}`)
  await expect(staleFrame.getByText('Dashboard not available')).toBeVisible({ timeout: 15_000 })
  await context.close()
})

test('only the embed\'s sites may frame it; opened on its own, a public link says so', async ({ browser, page, token }) => {
  const [link] = (await embeds(page, token)).filter(e => e.name === 'Sitio web')
  const res = await page.request.get(`${BASE_URL}/embed/${link!.link}`)
  expect(res.headers()['content-security-policy']).toContain(`frame-ancestors 'self' ${HOST}`)
  const other = await page.request.get(`${BASE_URL}/`)
  expect(other.headers()['content-security-policy']).toMatch(/frame-ancestors 'self'$/)

  const context = await browser.newContext()
  const visitor = await context.newPage()
  await visitor.goto(`/embed/${link!.link}`)
  await expect(visitor.getByText('Only available embedded')).toBeVisible()
  await context.close()
})

test('a publish that would stop an embed says so first', async ({ page, token }) => {
  await api(page, token, 'PATCH', `/admin/api/dashboards/${dashboardId}`, { data: { variables: [
    { name: 'region', label: 'Region', type: 'SELECT', options: { source: 'STATIC', values: ['Norte', 'Sur'] } }
  ] } })
  await page.goto(`/dashboards/${dashboardId}`)
  await page.locator('main').getByRole('button', { name: 'Publish', exact: true }).first().click()
  await expect(page.getByText(/Stops 2 embeds "Sitio web", "Portal": they lock customer/)).toBeVisible()
})
