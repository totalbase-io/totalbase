import { expect, test, type Browser, type Page } from '@playwright/test'
import { apiRequest, BASE_URL, login } from './helpers.js'

/**
 * The GraphQL API as people use it (Data_API.md §17): an administrator turns GraphQL on from Settings and exposes a
 * table from its screen; two App users with different roles - Salta's and Jujuy's branches - sign in with the login
 * form, and their pages call /api/graphql with the session cookie, as a screen's script would: queries, a mutation,
 * and a subscription over the graphql-transport-ws WebSocket. Each one's schema and rows are what their role allows.
 * Runs after the parallel project (playwright.config.ts): realtime.spec.ts turns Realtime off when it ends.
 */
const TABLE = 'graphql_e2e_clients'
const SALTA_ROLE = 'GraphQL E2E Salta'
const JUJUY_ROLE = 'GraphQL E2E Jujuy'
const SALTA_EMAIL = 'graphql-e2e-salta@example.com'
const JUJUY_EMAIL = 'graphql-e2e-jujuy@example.com'
const PASSWORD = 'graphql-e2e-password'

interface Role { id: string, name: string }
interface User { id: string, email: string }
interface GraphQLBody { data?: Record<string, unknown> | null, errors?: { message: string, extensions?: { code?: string } }[] }
type Message = { type: string, id?: string, payload?: GraphQLBody }

async function put(page: Page, token: string, path: string, data: unknown) {
  const response = await page.request.fetch(`${BASE_URL}${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, data: { data } })
  if (!response.ok()) throw new Error(`PUT ${path} -> ${response.status()}: ${await response.text()}`)
}

/** A person signing in with the login form, in a browser of their own; an App user lands in the App. */
async function signIn(browser: Browser, email: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  await page.waitForURL(/\/app$/)
  return page
}

/** The page's own script posts to /api/graphql - same origin, so the browser sends the session cookie by itself. */
async function graphql(page: Page, query: string): Promise<{ status: number, body: GraphQLBody }> {
  return page.evaluate(async (q) => {
    const response = await fetch('/api/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
    return { status: response.status, body: await response.json() }
  }, query)
}

/** The page opens the GraphQL WebSocket: the cookie at the upgrade is the credential, connection_init needs no payload. */
async function openSocket(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const w = window as unknown as { socket: WebSocket, received: unknown[] }
    w.received = []
    w.socket = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/graphql`, 'graphql-transport-ws')
    w.socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string }
      w.received.push(message)
      if (message.type === 'connection_ack') resolve()
    }
    w.socket.onopen = () => w.socket.send(JSON.stringify({ type: 'connection_init' }))
    w.socket.onerror = () => reject(new Error('the GraphQL socket failed'))
    w.socket.onclose = event => reject(new Error(`the GraphQL socket closed: ${event.code} ${event.reason}`))
  }))
}

async function send(page: Page, message: unknown): Promise<void> {
  await page.evaluate(m => (window as unknown as { socket: WebSocket }).socket.send(JSON.stringify(m)), message)
}

async function received(page: Page): Promise<Message[]> {
  return page.evaluate(() => (window as unknown as { received: Message[] }).received)
}

async function waitFor(page: Page, match: (m: Message) => boolean, from = 0): Promise<Message> {
  let found: Message | undefined
  await expect.poll(async () => {
    found = (await received(page)).slice(from).find(match)
    return found !== undefined
  }, { timeout: 15_000 }).toBe(true)
  return found!
}

/** The event of a subscription message, when it is one. */
function eventOf(message: Message): string | undefined {
  return (message.payload?.data?.[TABLE] as { event?: string } | undefined)?.event
}

async function cleanUp(page: Page, token: string) {
  for (const user of (await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')).filter(u => u.email === SALTA_EMAIL || u.email === JUJUY_EMAIL)) {
    await apiRequest(page, token, 'DELETE', `/admin/api/users/${user.id}`)
  }
  for (const role of (await apiRequest<Role[]>(page, token, 'GET', '/api/totalbase/table/roles?fields=id,name&limit=500')).filter(r => r.name === SALTA_ROLE || r.name === JUJUY_ROLE)) {
    await apiRequest(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)
  }
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', { data: { sql: `DROP TABLE IF EXISTS public.${TABLE}` } })
}

test('two users with different roles query, write and follow a table over GraphQL, each within their role', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const token = await login(page)
  await cleanUp(page, token)

  // --- The administrator: a table, GraphQL on, the table exposed - from the admin's screens. ---
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: { sql: `CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, city text NOT NULL, name text NOT NULL, notes text)` }
  })
  const [resource] = await apiRequest<{ id: string, postgres_oid: number }[]>(page, token, 'GET',
    `/api/totalbase/table/resources?fields=id,postgres_oid&where[schema][_eq]=public&where[name][_eq]=${TABLE}`)
  expect(resource).toBeTruthy()

  await page.goto('/settings/graphql')
  await page.getByRole('switch', { name: 'Enable GraphQL' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByRole('switch', { name: 'Enable GraphQL' })).toBeChecked()
  // Subscriptions are Realtime's (Data_API.md §17.7).
  await apiRequest(page, token, 'PATCH', '/admin/api/settings/realtime', { data: { 'realtime.enabled': true } })

  await page.goto(`/database/tables/${resource!.postgres_oid}`)
  for (const method of ['GET', 'POST', 'REALTIME']) {
    const toggle = page.getByRole('switch', { name: `Expose ${method}` })
    await toggle.scrollIntoViewIfNeeded()
    await toggle.click()
    await expect(toggle).toBeChecked()
  }

  // Salta's branch: its rows, without the notes. Jujuy's: its rows, every column, and it creates clients.
  const saltaRole = await apiRequest<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: SALTA_ROLE, app_access: true } })
  const jujuyRole = await apiRequest<Role>(page, token, 'POST', '/api/totalbase/table/roles', { data: { name: JUJUY_ROLE, app_access: true } })
  await put(page, token, `/admin/api/roles/${saltaRole.id}/resources/${resource!.id}/permissions/READ`, {
    effect: 'ALLOW', where: { city: { _eq: 'Salta' } }, fields: ['id', 'city', 'name'].map(field => ({ field, effect: 'ALLOW' }))
  })
  await put(page, token, `/admin/api/roles/${jujuyRole.id}/resources/${resource!.id}/permissions/READ`, {
    effect: 'ALLOW', where: { city: { _eq: 'Jujuy' } }, fields: ['id', 'city', 'name', 'notes'].map(field => ({ field, effect: 'ALLOW' }))
  })
  await put(page, token, `/admin/api/roles/${jujuyRole.id}/resources/${resource!.id}/permissions/CREATE`, {
    effect: 'ALLOW', fields: ['city', 'name'].map(field => ({ field, effect: 'ALLOW' }))
  })
  await apiRequest(page, token, 'POST', '/admin/api/users', { data: { email: SALTA_EMAIL, name: 'Salta E2E', password: PASSWORD, roleIds: [saltaRole.id] } })
  await apiRequest(page, token, 'POST', '/admin/api/users', { data: { email: JUJUY_EMAIL, name: 'Jujuy E2E', password: PASSWORD, roleIds: [jujuyRole.id] } })
  await apiRequest(page, token, 'POST', `/api/public/table/${TABLE}?bulk=true`, {
    data: [
      { city: 'Salta', name: 'Ana', notes: 'pays late' },
      { city: 'Jujuy', name: 'Bruno', notes: 'VIP' },
      { city: 'Tucumán', name: 'Carla', notes: null }
    ]
  })

  try {
    // --- Two people, each in their own browser. ---
    const salta = await signIn(browser, SALTA_EMAIL)
    const jujuy = await signIn(browser, JUJUY_EMAIL)

    // Each reads their branch's rows; the notes aren't in Salta's schema at all.
    expect(await graphql(salta, `{ ${TABLE}(order_by: [{ name: ASC }]) { name city } }`)).toEqual({
      status: 200, body: { data: { [TABLE]: [{ name: 'Ana', city: 'Salta' }] } }
    })
    const notes = await graphql(salta, `{ ${TABLE} { notes } }`)
    expect(notes.status).toBe(400)
    expect(notes.body.errors?.[0]?.extensions?.code).toBe('INVALID_QUERY')
    expect(await graphql(jujuy, `{ ${TABLE} { name notes } ${TABLE}_count }`)).toEqual({
      status: 200, body: { data: { [TABLE]: [{ name: 'Bruno', notes: 'VIP' }], [`${TABLE}_count`]: 1 } }
    })

    // Jujuy's user creates a client; Salta's role has no CREATE, so its schema has no mutation for it.
    const created = await graphql(jujuy, `mutation { ${TABLE}_insert_one(data: { city: "Jujuy", name: "Dario" }) { name city } }`)
    expect(created, JSON.stringify(created.body)).toEqual({ status: 200, body: { data: { [`${TABLE}_insert_one`]: { name: 'Dario', city: 'Jujuy' } } } })
    expect((await graphql(salta, `mutation { ${TABLE}_insert_one(data: { city: "Salta", name: "Eva" }) { name } }`)).status).toBe(400)

    // Salta follows the table over the WebSocket: only Salta's rows arrive.
    await openSocket(salta)
    await send(salta, { type: 'subscribe', id: 'clients', payload: { query: `subscription { ${TABLE} { event rows { name city } } }` } })
    await waitFor(salta, m => m.id === 'clients' && eventOf(m) === 'INIT')
    const from = (await received(salta)).length
    await apiRequest(page, token, 'POST', `/api/public/table/${TABLE}?bulk=true`, {
      data: [{ city: 'Jujuy', name: 'Fede' }, { city: 'Salta', name: 'Gabi' }]
    })
    const change = await waitFor(salta, m => m.id === 'clients' && eventOf(m) === 'CREATE', from)
    expect(change.payload).toEqual({ data: { [TABLE]: { event: 'CREATE', rows: [{ name: 'Gabi', city: 'Salta' }] } } })
  } finally {
    await apiRequest(page, token, 'PATCH', '/admin/api/settings/graphql', { data: { 'graphql.enabled': false } }).catch(() => undefined)
    await apiRequest(page, token, 'PATCH', '/admin/api/settings/realtime', { data: { 'realtime.enabled': false } }).catch(() => undefined)
    await cleanUp(page, token)
  }
})
