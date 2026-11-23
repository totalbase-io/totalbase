import { createHmac } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { code, rest, tool, toolError, seedLab, type Lab } from './lab.js'

/**
 * Dashboards, widget SQL and embeds, attacked as a viewer, an outsider and an embed holder (Dashboards.md §2, §3,
 * §9.5; Security.md §7): a viewer runs only published widgets by id with bound variables, access is per dashboard
 * and role, embeds are signed and locked, widget SQL runs read-only - and under `dashboards.query_role`, as that role.
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
let sessions: { prosecutor1: string, prosecutor2: string, expert1: string, integration: string }
let widgetId: string
const restore: (() => Promise<unknown>)[] = []

test.beforeAll(async () => {
  lab = await seedLab('dash')
  sessions = {
    prosecutor1: await lab.session('prosecutor1'), prosecutor2: await lab.session('prosecutor2'),
    expert1: await lab.session('expert1'), integration: await lab.session('integration')
  }
  widgetId = (await rest('GET', `/app/api/dashboards/${lab.dashboard.slug}/widgets`, sessions.prosecutor1)).data[0].id
})
test.afterAll(async () => {
  for (const undo of restore.reverse()) await undo().catch(() => {})
  await lab?.cleanup()
})

const T = (name: string, args: unknown) => tool(lab.admin.mcpToken, name, args)
const firstId = (value: unknown) => JSON.stringify(value).match(/"id":"([0-9a-f-]{36})"/)![1]!
const numbers = (response: { data: any }) => (response.data?.rows ?? []).map((row: any) => row.number).sort().join(',')
const run = (token: string | null, slug: string, widget: string, data: unknown = {}, headers?: Record<string, string>) =>
  rest('POST', `/app/api/dashboards/${slug}/widgets/${widget}/data`, token, data, { allowFail: true, headers })

/** A dashboard of this copy: a STATIC `restricted` variable, its widget filtered by it; published to `roles`. */
async function variableDashboard(suffix: string, roles: string[], extra: Record<string, unknown> = {}) {
  const slug = `${lab.dashboard.slug}-${suffix}`
  const id = firstId(await T('create_dashboard', { name: slug, slug }))
  await T('update_dashboard', { id, ...extra, variables: [
    { name: 'restricted', label: 'R', type: 'SELECT', options: { source: 'STATIC', values: [{ value: 'true' }, { value: 'false' }] } },
    { name: 'q', label: 'Q', type: 'SELECT', options: { source: 'QUERY', query: `SELECT number AS value, number AS label FROM public.${lab.t.cases}` } }
  ] })
  const widget = firstId(await T('save_widget', { dashboard_id: id, type: 'TABLE', label: 'Cases', query: `SELECT number, restricted FROM public.${lab.t.cases} WHERE ($VAR.restricted IS NULL OR restricted = $VAR.restricted::boolean) ORDER BY number` }))
  await T('publish_dashboard', { id, role_ids: roles })
  return { id, slug, widget }
}

test('a viewer runs published widgets by id, never their SQL, only their own rows', async () => {
  const widgets = (await rest('GET', `/app/api/dashboards/${lab.dashboard.slug}/widgets`, sessions.prosecutor1)).data
  expect(Object.keys(widgets[0]).filter(key => /quer|sql/i.test(key))).toEqual([])
  expect(widgets[0].configured).toBe(true)
  // $USER.id scoping, the second viewer on the cached path: the cache is keyed per user.
  expect(numbers(await run(sessions.prosecutor1, lab.dashboard.slug, widgetId))).toBe('C1,C2')
  expect(numbers(await run(sessions.prosecutor2, lab.dashboard.slug, widgetId))).toBe('C3,C4')
  // A body can't carry SQL of its own.
  const smuggled = await run(sessions.prosecutor1, lab.dashboard.slug, widgetId, { query: `SELECT * FROM public.${lab.t.experts}`, sql: 'SELECT 1' })
  expect(numbers(smuggled)).toBe('C1,C2')
  // A widget added after publishing isn't served until published again.
  const draft = firstId(await T('save_widget', { dashboard_id: lab.dashboard.id, type: 'TABLE', label: 'Draft', query: `SELECT tax_id FROM public.${lab.t.experts}` }))
  expect(code(await run(sessions.prosecutor1, lab.dashboard.slug, draft))).toBe('DASHBOARD_WIDGET_NOT_FOUND')
})

test('access is per dashboard and role: denied looks missing, no App access or a token gets nothing', async () => {
  const denied = await rest('GET', `/app/api/dashboards/${lab.dashboard.slug}`, sessions.expert1, undefined, { allowFail: true })
  const missing = await rest('GET', `/app/api/dashboards/${lab.dashboard.slug}-nope`, sessions.expert1, undefined, { allowFail: true })
  expect([denied.status, missing.status]).toEqual([404, 404])
  expect(code(denied)).toBe(code(missing))
  expect((await run(sessions.expert1, lab.dashboard.slug, widgetId)).status).toBe(404)
  // The dashboard's id in place of its slug is checked the same way.
  expect((await run(sessions.expert1, lab.dashboard.id, widgetId)).status).toBe(404)
  expect((await run(sessions.integration, lab.dashboard.slug, widgetId)).status).toBe(403)
  expect((await rest('GET', '/app/api/dashboards', lab.users.prosecutor1.token, undefined, { allowFail: true })).status).toBe(401)
  // Another dashboard's widget under this slug.
  const other = await variableDashboard('other', [lab.roles.expert])
  expect(code(await run(sessions.prosecutor1, lab.dashboard.slug, other.widget))).toBe('DASHBOARD_WIDGET_NOT_FOUND')
})

test('variables are bound values from their options: no injection, no SQL of the options query', async () => {
  const board = await variableDashboard('vars', [lab.roles.prosecutor])
  const withValues = (variables: unknown) => run(sessions.prosecutor1, board.slug, board.widget, { variables, fresh: true })
  expect(numbers(await withValues({ restricted: 'false' }))).toBe('C1,C3')
  for (const value of ['maybe', "true' OR '1'='1", ['true', 'false'], 1]) {
    expect(code(await withValues({ restricted: value })), JSON.stringify(value)).toBe('DASHBOARD_VARIABLE_INVALID')
  }
  const ghost = await withValues({ ghost: `x'; DROP TABLE public.${lab.t.cases} --` })
  expect(ghost.status).toBe(200)
  expect(numbers(ghost)).toBe('C1,C2,C3,C4')
  const variables = (await rest('GET', `/app/api/dashboards/${board.slug}/variables`, sessions.prosecutor1)).data
  expect(variables.find((variable: any) => variable.name === 'q').options.query).toBe('')
})

test('widget SQL runs in a read-only transaction, even for its author', async () => {
  const preview = (query: string) => toolError(lab.admin.mcpToken, 'preview_query', { dashboard_id: lab.dashboard.id, query, rows: 3 })
  const refused = [
    `WITH x AS (INSERT INTO public.${lab.t.offices} (name) VALUES ('h') RETURNING id) SELECT * FROM x`,
    `SELECT 1; DROP TABLE public.${lab.t.custody}`,
    `SELECT set_config('role', 'postgres', false)`,
    `SELECT pg_read_file('/etc/hostname')`,
    `COPY (SELECT 1) TO PROGRAM 'id'`,
    `SELECT nextval(pg_get_serial_sequence('totalbase.audit', 'id'))`,
    `CREATE TEMP TABLE x AS SELECT 1`
  ]
  for (const query of refused) expect(await preview(query), query).toBeTruthy()
  expect((await lab.sql(`SELECT 1 FROM public.${lab.t.offices} WHERE name = 'h'`)).length).toBe(0)
  expect((await lab.sql(`SELECT to_regclass('public.${lab.t.custody}') IS NOT NULL AS present`))[0].present).toBe(true)
})

test('diagnosis warns of a widget that ignores the row filter or shows a denied field', async () => {
  const board = firstId(await T('create_dashboard', { name: `${lab.dashboard.slug}-diag`, slug: `${lab.dashboard.slug}-diag` }))
  await T('save_widget', { dashboard_id: board, type: 'TABLE', label: 'All cases', query: `SELECT number FROM public.${lab.t.cases}` })
  await T('save_widget', { dashboard_id: board, type: 'TABLE', label: 'Fees', query: `SELECT specialty, tax_id FROM public.${lab.t.experts}` })
  await T('publish_dashboard', { id: board, role_ids: [lab.roles.prosecutor] })
  const issues = JSON.stringify((await rest('GET', `/admin/api/dashboards/${board}/diagnosis`, lab.admin.session)).data)
  expect(issues).toContain(lab.t.cases)
  expect(issues).toContain('tax_id')
  // The $USER-scoped dashboard has nothing to say about cases.
  expect(JSON.stringify((await rest('GET', `/admin/api/dashboards/${lab.dashboard.id}/diagnosis`, lab.admin.session)).data)).not.toContain(lab.t.cases)
})

test('embeds: signed, locked, revocable, and scoped to their own dashboard', async () => {
  const settings = (await rest('GET', '/admin/api/settings/dashboards', lab.admin.session)).data
  const previous = settings['dashboards.embed_secret_key'] ?? ''
  const secretKey = `${lab.prefix}_embed`
  const secret = `embed-secret-${lab.prefix}-0123456789abcdef`
  await rest('PUT', `/admin/api/secrets/${secretKey}`, lab.admin.session, { value: secret, scope: 'DASHBOARD_EMBEDS' })
  restore.push(() => rest('DELETE', `/admin/api/secrets/${secretKey}`, lab.admin.session, undefined, { allowFail: true }))
  await rest('PATCH', '/admin/api/settings/dashboards', lab.admin.session, { 'dashboards.embed_secret_key': secretKey })
  restore.push(() => previous
    ? rest('PATCH', '/admin/api/settings/dashboards', lab.admin.session, { 'dashboards.embed_secret_key': previous })
    : rest('DELETE', '/admin/api/settings/dashboards/embed_secret_key', lab.admin.session, undefined, { allowFail: true }))

  const board = await variableDashboard('embed', [], { embedding_enabled: true })
  const signedEmbed = await T('create_embed', { dashboard_id: board.id, name: 's', type: 'SIGNED', variables: { restricted: { mode: 'LOCKED', value: 'false' } } })
  const linkEmbed = await T('create_embed', { dashboard_id: board.id, name: 'l', type: 'LINK', variables: { restricted: { mode: 'LOCKED', value: 'false' } } })
  const b64 = (value: string) => Buffer.from(value).toString('base64url')
  const sign = (payload: unknown, key: string, alg = 'HS256') => {
    const head = `${b64(JSON.stringify({ alg, typ: 'JWT' }))}.${b64(JSON.stringify(payload))}`
    return alg === 'none' ? `${head}.` : `${head}.${b64(createHmac('sha256', key).update(head).digest())}`
  }
  const exp = Math.floor(Date.now() / 1000) + 600
  const embedRun = (token: string, widget = board.widget, data: unknown = {}) =>
    rest('POST', `/embed/api/dashboard/widgets/${widget}/data`, null, data, { allowFail: true, headers: { 'x-totalbase-embed-token': token } })

  expect(numbers(await embedRun(linkEmbed.link))).toBe('C1,C3')
  // A locked variable can't be overridden by the body.
  expect(numbers(await embedRun(linkEmbed.link, board.widget, { variables: { restricted: 'true' }, fresh: true }))).toBe('C1,C3')
  expect(numbers(await embedRun(sign({ resource: { embed: signedEmbed.id }, params: {}, exp }, secret)))).toBe('C1,C3')
  const forgeries = {
    'wrong secret': sign({ resource: { embed: signedEmbed.id }, params: {}, exp }, 'wrong-secret-of-at-least-32-characters!!'),
    'alg none': sign({ resource: { embed: signedEmbed.id }, params: {}, exp }, '', 'none'),
    expired: sign({ resource: { embed: signedEmbed.id }, params: {}, exp: Math.floor(Date.now() / 1000) - 60 }, secret),
    'beyond the max TTL': sign({ resource: { embed: signedEmbed.id }, params: {}, exp: exp + 365 * 86_400 }, secret),
    'a param it takes from no token': sign({ resource: { embed: signedEmbed.id }, params: { restricted: 'true' }, exp }, secret)
  }
  for (const [label, token] of Object.entries(forgeries)) expect((await embedRun(token)).status, label).toBe(401)
  // Another dashboard's widget through this embed.
  expect((await embedRun(linkEmbed.link, widgetId)).status).toBe(404)
  // Embedding off, then a revoked link: not available.
  await T('update_dashboard', { id: board.id, embedding_enabled: false })
  expect((await embedRun(linkEmbed.link)).status).toBe(404)
  await T('update_dashboard', { id: board.id, embedding_enabled: true })
  await T('revoke_embed', { dashboard_id: board.id, embed_id: linkEmbed.id, confirm: true })
  expect((await embedRun(linkEmbed.link)).status).toBe(404)
})

test('under dashboards.query_role, widget SQL runs as that role and cannot leave it', async () => {
  // A NOLOGIN role TotalBase's own PostgreSQL user creates (CREATEROLE, never superuser) and is a member of.
  const role = `${lab.prefix}_viewer`
  const pgUser = (await lab.sql<{ u: string }>('SELECT current_user AS u'))[0]!.u
  await lab.sql(`CREATE ROLE ${role} NOLOGIN; GRANT USAGE ON SCHEMA public TO ${role}; GRANT SELECT ON public.${lab.t.cases}, public.${lab.t.offices} TO ${role}; GRANT ${role} TO ${pgUser}`)
  // Once used, the role owns totalbase.dashboards_query: hand it back before dropping the role, or DROP OWNED drops it.
  restore.push(() => lab.sql(`REASSIGN OWNED BY ${role} TO ${pgUser}; DROP OWNED BY ${role}; DROP ROLE IF EXISTS ${role}`))
  const previous = (await rest('GET', '/admin/api/settings/dashboards', lab.admin.session)).data['dashboards.query_role'] ?? ''
  await rest('PATCH', '/admin/api/settings/dashboards', lab.admin.session, { 'dashboards.query_role': role })
  restore.push(() => rest('PATCH', '/admin/api/settings/dashboards', lab.admin.session, { 'dashboards.query_role': previous }))

  const preview = (query: string) => T('preview_query', { dashboard_id: lab.dashboard.id, query, rows: 3 })
  expect(JSON.stringify(await preview('SELECT current_user AS who'))).toContain(role)
  expect(JSON.stringify(await preview(`SELECT number FROM public.${lab.t.cases} ORDER BY number LIMIT 1`))).toContain('C1')
  const denied = [
    'SELECT email FROM totalbase.users LIMIT 1', 'SELECT * FROM totalbase.secrets LIMIT 1',
    `SELECT tax_id FROM public.${lab.t.experts} LIMIT 1`, 'SELECT rolname FROM pg_authid LIMIT 1',
    `SELECT set_config('role', '${pgUser}', true)`
  ]
  for (const query of denied) expect(await toolError(lab.admin.mcpToken, 'preview_query', { dashboard_id: lab.dashboard.id, query, rows: 3 }), query).toBeTruthy()
  // The viewer's published widget still runs, as the role.
  expect(numbers(await run(sessions.prosecutor1, lab.dashboard.slug, widgetId, { fresh: true }))).toBe('C1,C2')
  // The function behind it isn't a way to run as another role.
  expect(await toolError(lab.admin.mcpToken, 'preview_query', { dashboard_id: lab.dashboard.id, query: `SELECT * FROM totalbase.dashboards_query('${pgUser}', 'SELECT 1', '[]'::jsonb)` })).toBeTruthy()
})
