import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from '../helpers.js'

/**
 * The security suite's fixture (Foundations.md §21.3, §21.5): a small forensic-case app seeded through the product's
 * own API, the way a new user's agent would build it, and attacked as its least-privileged profiles. Every spec file
 * seeds its own copy under its own prefix (tables, roles, users, dashboard), so the files share nothing but the
 * instance; `cleanup()` removes it.
 *
 * The app:
 * - `<p>_offices`; `<p>_cases` (`prosecutor` -> totalbase.users, `restricted`, `description`); `<p>_experts` (`user`,
 *   `tax_id` and `fee` - sensitive); `<p>_evidence`; `<p>_custody`; `<p>_reports` (`"case"`, `expert`, `status`
 *   DRAFT/DELIVERED); the view `<p>_cases_summary`; the function `<p>_close_case(case_id uuid)`. `case` is a reserved
 *   word: quote it in SQL.
 * - roles: `prosecutor` (own cases only, experts without tax_id/fee), `expert` (unrestricted cases without
 *   description, own reports, editable while DRAFT), `coordination` (full CRUD on the app, MANAGE_ROLES, parent of
 *   prosecutor and expert), `integration` (API only, the summary view without `prosecutor`).
 * - users: coord, prosecutor1, prosecutor2, expert1, expert2, integration - each with a Data API token.
 * - a dashboard published to prosecutor, its widget filtered by `$USER.id`.
 */

export const USER_PASSWORD = 'Sec-Suite-User-Pass-2026!'

export interface Response<T = any> { status: number, body: any, data: T, headers: Headers }

/** One REST call in the envelope (`{ data }`); a status >= 400 throws unless `allowFail`. */
export async function rest<T = any>(method: string, path: string, token: string | null, data?: unknown, options: { allowFail?: boolean, raw?: boolean, headers?: Record<string, string> } = {}): Promise<Response<T>> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(BASE_URL + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }), ...options.headers },
      body: data === undefined ? undefined : JSON.stringify(options.raw ? data : { data })
    })
    const text = await response.text()
    // The run shares one address: a 429 on the way waits for the window instead of failing the fixture.
    if (response.status === 429 && !options.allowFail && attempt < 12) { await new Promise(resolve => setTimeout(resolve, 5_000)); continue }
    let body: any
    try { body = text ? JSON.parse(text) : null } catch { body = text }
    if (response.status >= 400 && !options.allowFail) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 600)}`)
    return { status: response.status, body, data: body?.data, headers: response.headers }
  }
}

/** The first error's code of a refused call. */
export const code = (response: Response) => response.body?.errors?.[0]?.code as string | undefined

let rpcId = 0
/** One stateless JSON-RPC call on POST /mcp. */
export async function mcp(token: string, method: string, params: unknown = {}, headers: Record<string, string> = {}) {
  const response = await fetch(BASE_URL + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  })
  const text = await response.text()
  let json: any = {}
  try {
      json = text.startsWith('event:') || text.includes('\ndata:')
        ? JSON.parse(text.split('\n').find(line => line.startsWith('data:'))!.slice(5))
        : text ? JSON.parse(text) : {}
    } catch { json = { text } }
    return { httpStatus: response.status, ...json }
  }

  /** A tools/call through MCP: its structured result, or a thrown error with what the tool said. */
  export async function tool(token: string, name: string, args: unknown): Promise<any> {
    const result = await mcp(token, 'tools/call', { name, arguments: args })
    if (result.error || result.result?.isError) throw new Error(`${name}: ${JSON.stringify(result.error ?? result.result.content).slice(0, 1500)}`)
    if (!result.result) throw new Error(`${name}: /mcp answered ${result.httpStatus} with no result: ${JSON.stringify(result).slice(0, 600)}`)
    return result.result.structuredContent ?? result.result.content
  }

  /** A tools/call expected to fail: the text it failed with. */
  export async function toolError(token: string, name: string, args: unknown): Promise<string> {
    const result = await mcp(token, 'tools/call', { name, arguments: args })
    if (!result.error && !result.result?.isError) throw new Error(`${name} succeeded: ${JSON.stringify(result.result).slice(0, 600)}`)
    return JSON.stringify(result.error ?? result.result.content)
  }

  /** A session token for an email and password. */
  export async function signIn(email: string, password: string): Promise<string> {
    return (await rest('POST', '/api/auth/login', null, { email, password }, { raw: true })).data.token
  }

  export const firstId = (value: unknown) => JSON.stringify(value).match(/"id":"([0-9a-f-]{36})"/)![1]!

  export interface LabUser { id: string, email: string, password: string, token: string }
  export type Profile = 'coord' | 'prosecutor1' | 'prosecutor2' | 'expert1' | 'expert2' | 'integration'
  type Key = 'offices' | 'cases' | 'experts' | 'evidence' | 'custody' | 'reports' | 'summary' | 'closeCase'

  export interface Lab {
    /** The prefix of everything this copy created (`sec_<area>_<run>`; `-` instead of `_` in role names, emails, slugs). */
    prefix: string
    /** Table, view and function names (schema public). */
    t: Record<Key, string>
    /** Data API paths: `/api/public/table/<name>`, `/api/public/view/<summary>`, `/api/public/function/<close_case>`. */
    path: Record<Key, string>
    admin: { id: string, session: string, mcpToken: string }
    roles: { coordination: string, prosecutor: string, expert: string, integration: string }
    users: Record<Profile, LabUser>
    /** Resource ids (totalbase.resources). */
    resources: Record<Key, string>
    /** Row ids: cases C1-C4 (C1, C2 prosecutor1's, C2 restricted; C3, C4 prosecutor2's, C4 restricted), experts. */
    rows: { cases: Record<'C1' | 'C2' | 'C3' | 'C4', string>, experts: Record<'expert1' | 'expert2', string> }
    dashboard: { id: string, slug: string }
    /** SQL as the signed-in administrator (the SQL Console), for setup and to observe state - never to attack. */
    sql<T = any>(sql: string): Promise<T[]>
    /** A fresh session for a profile. */
    session(profile: Profile | 'admin'): Promise<string>
    cleanup(): Promise<void>
  }

  /** Seeds one copy of the app; `area` names it (`perm`, `deleg`, ...). */
  export async function seedLab(area: string): Promise<Lab> {
    const prefix = `sec_${area}_${Date.now().toString(36).slice(-5)}`
    const dashed = prefix.replace(/_/g, '-')
    const name = (suffix: string) => `${prefix}_${suffix}`
    const t: Record<Key, string> = {
      offices: name('offices'), cases: name('cases'), experts: name('experts'), evidence: name('evidence'),
      custody: name('custody'), reports: name('reports'), summary: name('cases_summary'), closeCase: name('close_case')
    }
    const path = Object.fromEntries(Object.entries(t).map(([key, resource]) => [key,
      key === 'summary' ? `/api/public/view/${resource}` : key === 'closeCase' ? `/api/public/function/${resource}` : `/api/public/table/${resource}`
    ])) as Record<Key, string>

    const session = await signIn(ADMIN_EMAIL, ADMIN_PASSWORD)
    const adminId = (await rest('GET', '/admin/api/auth/me', session)).data.id as string
    await rest('PATCH', '/admin/api/settings/mcp', session, { 'mcp.enabled': true })
    const mcpToken = (await rest('POST', '/api/tokens', session, { name: `${prefix}-mcp`, plane: 'ADMIN', ttlDays: 1 })).data.key as string
    const T = (toolName: string, args: unknown) => tool(mcpToken, toolName, args)
    const sql = async <R>(statement: string) => ((await rest('POST', '/admin/api/sql/execute', session, { sql: statement, transactional: true })).data?.rows ?? []) as R[]

    // What this copy created, whatever got that far: also run when the seed fails halfway.
    const cleanup = async () => {
      await sql(`
        DROP FUNCTION IF EXISTS public.${t.closeCase}(uuid);
        DROP VIEW IF EXISTS public.${t.summary};
        DROP TABLE IF EXISTS public.${t.custody}, public.${t.evidence}, public.${t.reports}, public.${t.experts}, public.${t.cases}, public.${t.offices} CASCADE;
      `)
      await T('sync_catalog', {}).catch(() => {})
      await sql(`
        DELETE FROM totalbase.dashboards WHERE slug LIKE '${dashed}%';
        DELETE FROM totalbase.workflows WHERE slug LIKE '${dashed}%';
        DELETE FROM totalbase.tokens WHERE name LIKE '${prefix}%';
        DELETE FROM totalbase.users WHERE email LIKE '${dashed}%';
        DELETE FROM totalbase.roles WHERE name LIKE '${dashed}%';
      `)
    }

    try {
    await sql(`
      CREATE TABLE public.${t.offices} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
      CREATE TABLE public.${t.cases} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), number text NOT NULL UNIQUE, office uuid NOT NULL REFERENCES public.${t.offices},
        prosecutor uuid REFERENCES totalbase.users, status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_REVIEW','CLOSED')),
        restricted boolean NOT NULL DEFAULT false, description text);
      CREATE TABLE public.${t.experts} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "user" uuid NOT NULL UNIQUE REFERENCES totalbase.users,
        specialty text NOT NULL, tax_id text NOT NULL, fee numeric(12,2) NOT NULL);
      CREATE TABLE public.${t.evidence} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "case" uuid NOT NULL REFERENCES public.${t.cases} ON DELETE CASCADE,
        description text NOT NULL, sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'), location text, expert uuid REFERENCES public.${t.experts});
      CREATE TABLE public.${t.custody} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), evidence uuid NOT NULL REFERENCES public.${t.evidence} ON DELETE CASCADE,
        handed_by text NOT NULL, received_by text NOT NULL, at timestamptz NOT NULL DEFAULT now(), signature text NOT NULL);
      CREATE TABLE public.${t.reports} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "case" uuid NOT NULL REFERENCES public.${t.cases},
        expert uuid NOT NULL REFERENCES public.${t.experts}, body text NOT NULL, status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','DELIVERED')));
      CREATE VIEW public.${t.summary} AS SELECT c.number, c.status, o.name AS office, c.prosecutor FROM public.${t.cases} c JOIN public.${t.offices} o ON o.id = c.office;
      CREATE FUNCTION public.${t.closeCase}(case_id uuid) RETURNS text LANGUAGE sql AS $$ UPDATE public.${t.cases} SET status = 'CLOSED' WHERE id = case_id RETURNING number $$;
    `)
    await T('sync_catalog', {})
    const exposure: [Key, string[]][] = [
      ['offices', ['GET']], ['cases', ['GET', 'POST', 'PATCH', 'DELETE']], ['experts', ['GET', 'PATCH']],
      ['evidence', ['GET', 'POST', 'PATCH', 'DELETE']], ['custody', ['GET', 'POST']], ['reports', ['GET', 'POST', 'PATCH', 'DELETE']],
      ['summary', ['GET']], ['closeCase', ['POST']]
    ]
    for (const [key, methods] of exposure) await T('expose_resource', { name: t[key], expose_methods: methods })
    const resourceRows = await sql<{ id: string, name: string }>(`SELECT id, name FROM totalbase.resources WHERE status = 'ACTIVE' AND name LIKE '${prefix}%'`)
    const resources = Object.fromEntries(Object.entries(t).map(([key, resource]) => [key, resourceRows.find(row => row.name === resource)!.id])) as Record<Key, string>

    const role = async (suffix: string, data: Record<string, unknown>) =>
      firstId(await T('write_records', { schema: 'totalbase', name: 'roles', operation: 'create', data: { name: `${dashed}-${suffix}`, ...data } }))
    const roles = {
      coordination: await role('coordination', { description: 'Manages prosecutors and experts', app_access: true, api_access: true }),
      prosecutor: await role('prosecutor', { description: 'Their own cases', app_access: true, api_access: true }),
      expert: await role('expert', { description: 'Unrestricted cases', app_access: true, api_access: true }),
      integration: await role('integration', { description: 'External system, the summary only', app_access: false, api_access: true })
    }
    for (const key of ['prosecutor', 'expert'] as const) {
      await T('write_records', { schema: 'totalbase', name: 'roles', operation: 'update', id: roles[key], data: { parent: roles.coordination } })
    }
    for (const key of ['coordination', 'prosecutor', 'expert'] as const) await T('apply_default_permissions', { role_id: roles[key] })
    await T('set_capability', { role_id: roles.coordination, capability: 'MANAGE_ROLES', effect: 'ALLOW' })

    const profiles: [Profile, keyof typeof roles][] = [
      ['coord', 'coordination'], ['prosecutor1', 'prosecutor'], ['prosecutor2', 'prosecutor'],
      ['expert1', 'expert'], ['expert2', 'expert'], ['integration', 'integration']
    ]
    const users = {} as Record<Profile, LabUser>
    for (const [profile, roleKey] of profiles) {
      const email = `${dashed}-${profile}@example.com`
      const id = firstId(await T('create_user', { email, name: profile, password: USER_PASSWORD, role_ids: [roles[roleKey]] }))
      const token = (await rest('POST', '/admin/api/tokens', session, { userId: id, name: `${prefix}-api`, plane: 'API', ttlDays: 1 })).data.key as string
      users[profile] = { id, email, password: USER_PASSWORD, token }
    }

    const u = (profile: Profile) => users[profile].id
    await sql(`
      INSERT INTO public.${t.offices} (name) VALUES ('North'), ('South');
      INSERT INTO public.${t.experts} ("user", specialty, tax_id, fee) VALUES ('${u('expert1')}', 'Forensic IT', '20-11111111-1', 150000), ('${u('expert2')}', 'Ballistics', '27-22222222-2', 180000);
      INSERT INTO public.${t.cases} (number, office, prosecutor, status, restricted, description) VALUES
        ('C1', (SELECT id FROM public.${t.offices} WHERE name = 'North'), '${u('prosecutor1')}', 'OPEN', false, 'Bank fraud'),
        ('C2', (SELECT id FROM public.${t.offices} WHERE name = 'North'), '${u('prosecutor1')}', 'IN_REVIEW', true, 'RESTRICTED: protected witness'),
        ('C3', (SELECT id FROM public.${t.offices} WHERE name = 'South'), '${u('prosecutor2')}', 'OPEN', false, 'Robbery'),
        ('C4', (SELECT id FROM public.${t.offices} WHERE name = 'South'), '${u('prosecutor2')}', 'OPEN', true, 'RESTRICTED: internal inquiry');
      INSERT INTO public.${t.evidence} ("case", description, sha256, location, expert)
        SELECT c.id, 'Disk of ' || c.number, encode(sha256(c.number::bytea), 'hex'), 'Store A', (SELECT id FROM public.${t.experts} WHERE "user" = '${u('expert1')}') FROM public.${t.cases} c;
      INSERT INTO public.${t.custody} (evidence, handed_by, received_by, signature) SELECT id, 'Police', 'Store', 'sig-' || left(sha256, 8) FROM public.${t.evidence};
      INSERT INTO public.${t.reports} ("case", expert, body) SELECT c.id, e.id, 'Draft of ' || c.number FROM public.${t.cases} c, public.${t.experts} e
        WHERE c.number IN ('C1', 'C3') AND e."user" = '${u('expert1')}';
    `)
    const caseRows = await sql<{ id: string, number: 'C1' | 'C2' | 'C3' | 'C4' }>(`SELECT id, number FROM public.${t.cases}`)
    const expertRows = await sql<{ id: string, user: string }>(`SELECT id, "user" FROM public.${t.experts}`)
    const rows: Lab['rows'] = {
      cases: Object.fromEntries(caseRows.map(row => [row.number, row.id])) as Lab['rows']['cases'],
      experts: { expert1: expertRows.find(row => row.user === u('expert1'))!.id, expert2: expertRows.find(row => row.user === u('expert2'))!.id }
    }

    await T('grant_permissions', { role_ids: [roles.prosecutor], grants: [
      { name: t.cases, actions: ['READ', 'UPDATE'], where: { prosecutor: { _eq: '$USER.id' } } },
      { name: t.evidence, actions: ['READ', 'CREATE'], where: { 'case.prosecutor': { _eq: '$USER.id' } } },
      { name: t.custody, actions: ['READ', 'CREATE'], where: { 'evidence.case.prosecutor': { _eq: '$USER.id' } } },
      { name: t.experts, actions: ['READ'], deny_fields: ['tax_id', 'fee'] },
      { name: t.offices, actions: ['READ'] },
      { name: t.reports, actions: ['READ'], where: { 'case.prosecutor': { _eq: '$USER.id' } } },
      { name: t.summary, actions: ['READ'], where: { prosecutor: { _eq: '$USER.id' } } }
    ] })
    await T('grant_permissions', { role_ids: [roles.expert], grants: [
      { name: t.cases, actions: ['READ'], where: { restricted: { _eq: false } }, deny_fields: ['description'] },
      { name: t.evidence, actions: ['READ'], where: { 'case.restricted': { _eq: false } } },
      { name: t.reports, actions: ['READ', 'CREATE'], where: { 'expert.user': { _eq: '$USER.id' } } },
      { name: t.reports, actions: ['UPDATE'], where: { _and: [{ 'expert.user': { _eq: '$USER.id' } }, { status: { _eq: 'DRAFT' } }] } },
      { name: t.experts, actions: ['READ'], where: { user: { _eq: '$USER.id' } } },
      { name: t.offices, actions: ['READ'] }
    ] })
    await T('grant_permissions', { role_ids: [roles.coordination], grants: [
      ...[t.cases, t.evidence, t.custody, t.reports, t.experts].map(resource => ({ name: resource, actions: ['CREATE', 'READ', 'UPDATE', 'DELETE'] })),
      { name: t.offices, actions: ['READ'] }, { name: t.summary, actions: ['READ'] }, { name: t.closeCase, actions: ['EXECUTE'] }
    ] })
    await T('grant_permissions', { role_ids: [roles.integration], grants: [{ name: t.summary, actions: ['READ'], deny_fields: ['prosecutor'] }] })

    const dashboardId = firstId(await T('create_dashboard', { name: dashed, slug: dashed }))
    await T('save_widget', { dashboard_id: dashboardId, type: 'TABLE', label: 'My cases', query: `SELECT number, status, restricted FROM public.${t.cases} WHERE prosecutor = $USER.id ORDER BY number` })
    await T('publish_dashboard', { id: dashboardId, role_ids: [roles.prosecutor] })

    return {
      prefix, t, path, resources, roles, users, rows,
      admin: { id: adminId, session, mcpToken },
      dashboard: { id: dashboardId, slug: dashed },
      sql,
      session: profile => profile === 'admin' ? signIn(ADMIN_EMAIL, ADMIN_PASSWORD) : signIn(users[profile].email, USER_PASSWORD),
      cleanup
    }
  } catch (error) {
    await cleanup().catch(() => {})
    throw error
  }
}
