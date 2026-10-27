import { expect, test, type Browser, type Page } from '@playwright/test'
import { apiRequest, BASE_URL, login } from './helpers.js'

/**
 * Realtime subscriptions as people use them (Data_API.md §16): an administrator turns Realtime on and exposes a
 * table from the admin's own screens; two App users with different roles - Salta's and Jujuy's branches - sign in
 * with the login form, and their pages open /api/realtime with the session cookie, as a screen's script would.
 * Each receives only what their role shows: the rows of their branch, the columns their role reads.
 */
const TABLE = 'realtime_e2e_clients'
const SALTA_ROLE = 'Realtime E2E Salta'
const JUJUY_ROLE = 'Realtime E2E Jujuy'
const SALTA_EMAIL = 'realtime-e2e-salta@example.com'
const JUJUY_EMAIL = 'realtime-e2e-jujuy@example.com'
const PASSWORD = 'realtime-e2e-password'

interface Role { id: string, name: string }
interface User { id: string, email: string }
type Message = { type: string, uid?: string, event?: string, data?: Record<string, unknown>[], errors?: { code: string }[] }

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

/** The page's own script opens /api/realtime - same origin, so the browser sends the session cookie by itself. */
async function openRealtime(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const w = window as unknown as { realtime: WebSocket, received: unknown[] }
    w.received = []
    w.realtime = new WebSocket(`${location.origin.replace(/^http/, 'ws')}/api/realtime`)
    w.realtime.onmessage = event => w.received.push(JSON.parse(String(event.data)))
    w.realtime.onopen = () => resolve()
    w.realtime.onerror = () => reject(new Error('the realtime socket failed'))
  }))
}

async function send(page: Page, message: unknown): Promise<void> {
  await page.evaluate(m => (window as unknown as { realtime: WebSocket }).realtime.send(JSON.stringify(m)), message)
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

async function subscribe(page: Page, uid: string, data: Record<string, unknown>): Promise<Message> {
  const from = (await received(page)).length
  await send(page, { type: 'subscribe', uid, data })
  return waitFor(page, m => m.uid === uid && (m.event === 'init' || m.type === 'error'), from)
}

/** Every row a subscription received since `from`, for one event. */
async function rows(page: Page, uid: string, event: string, from: number) {
  return (await received(page)).slice(from).filter(m => m.uid === uid && m.event === event).flatMap(m => m.data ?? [])
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

test('two users with different roles follow the same table, each seeing only what their role shows', async ({ page, browser }) => {
  test.setTimeout(180_000)
  const token = await login(page)
  await cleanUp(page, token)

  // --- The administrator: a table, Realtime on, the table exposed for it - from the admin's screens. ---
  await apiRequest(page, token, 'POST', '/admin/api/sql/execute', {
    data: { sql: `CREATE TABLE public.${TABLE} (id serial PRIMARY KEY, city text NOT NULL, name text NOT NULL, notes text)` }
  })
  const [resource] = await apiRequest<{ id: string, postgres_oid: number }[]>(page, token, 'GET',
    `/api/totalbase/table/resources?fields=id,postgres_oid&where[schema][_eq]=public&where[name][_eq]=${TABLE}`)
  expect(resource).toBeTruthy()

  await page.goto('/settings/realtime')
  await expect(page.getByText('Requirements')).toBeVisible()
  await expect(page.getByText('Not ready')).toHaveCount(0)
  await page.getByRole('switch', { name: 'Enable Realtime' }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await expect(page.getByText('Ready', { exact: true })).toBeVisible()

  await page.goto(`/database/tables/${resource!.postgres_oid}`)
  for (const method of ['GET', 'POST', 'REALTIME']) {
    const toggle = page.getByRole('switch', { name: `Expose ${method}` })
    await toggle.scrollIntoViewIfNeeded()
    await toggle.click()
    await expect(toggle).toBeChecked()
  }

  // Salta's branch: its rows, without the notes. Jujuy's: its rows, every column, and it creates clients.
  // A field no grant names is denied (Security.md §6), so each role lists the columns it reads.
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

  try {
    // --- Two people, each in their own browser. ---
    const salta = await signIn(browser, SALTA_EMAIL)
    const jujuy = await signIn(browser, JUJUY_EMAIL)
    await openRealtime(salta)
    await openRealtime(jujuy)

    // A subscription is checked as a read: Salta's role can't ask for the notes.
    expect((await subscribe(salta, 'notes', { resource: `public.${TABLE}`, query: { fields: 'id,notes' } })).errors?.[0]?.code).toBe('FIELD_PERMISSION_DENIED')
    expect(await subscribe(salta, 'clients', { resource: `public.${TABLE}` })).toMatchObject({ event: 'init' })
    expect(await subscribe(jujuy, 'clients', { resource: `public.${TABLE}` })).toMatchObject({ event: 'init' })

    // The administrator loads clients of both branches and another one.
    let [fromSalta, fromJujuy] = [(await received(salta)).length, (await received(jujuy)).length]
    await apiRequest(page, token, 'POST', `/api/public/table/${TABLE}?bulk=true`, {
      data: [
        { city: 'Salta', name: 'Ana', notes: 'pays late' },
        { city: 'Jujuy', name: 'Bruno', notes: 'VIP' },
        { city: 'Tucumán', name: 'Carla', notes: null }
      ]
    })
    await waitFor(salta, m => m.uid === 'clients' && m.event === 'create', fromSalta)
    await waitFor(jujuy, m => m.uid === 'clients' && m.event === 'create', fromJujuy)
    await salta.waitForTimeout(500)
    const saltaRows = await rows(salta, 'clients', 'create', fromSalta)
    const jujuyRows = await rows(jujuy, 'clients', 'create', fromJujuy)
    expect(saltaRows.map(r => r.name)).toEqual(['Ana'])
    expect(saltaRows[0]).not.toHaveProperty('notes')
    expect(jujuyRows.map(r => r.name)).toEqual(['Bruno'])
    expect(jujuyRows[0]).toMatchObject({ city: 'Jujuy', notes: 'VIP' })

    // Jujuy's user creates a client from their own page: it reaches them, never Salta.
    ;[fromSalta, fromJujuy] = [(await received(salta)).length, (await received(jujuy)).length]
    const created = await jujuy.evaluate(async (table) => {
      const response = await fetch(`/api/public/table/${table}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: { city: 'Jujuy', name: 'Dario' } })
      })
      return { status: response.status, body: await response.text() }
    }, TABLE)
    expect(created.status, created.body).toBe(201)
    await waitFor(jujuy, m => m.uid === 'clients' && m.event === 'create' && m.data?.[0]?.name === 'Dario', fromJujuy)
    await salta.waitForTimeout(1_000)
    expect(await rows(salta, 'clients', 'create', fromSalta)).toEqual([])

    // A role taken away ends the subscription at the next change.
    fromSalta = (await received(salta)).length
    const saltaUser = (await apiRequest<User[]>(page, token, 'GET', '/admin/api/users')).find(u => u.email === SALTA_EMAIL)!
    await put(page, token, `/admin/api/users/${saltaUser.id}/roles`, { roleIds: [] })
    await apiRequest(page, token, 'POST', `/api/public/table/${TABLE}`, { data: { city: 'Salta', name: 'Eva' } })
    await waitFor(salta, m => m.type === 'error' && m.uid === 'clients', fromSalta)
    expect(await rows(salta, 'clients', 'create', fromSalta)).toEqual([])
  } finally {
    await apiRequest(page, token, 'PATCH', '/admin/api/settings/realtime', { data: { 'realtime.enabled': false } }).catch(() => undefined)
    await cleanUp(page, token)
  }
})
