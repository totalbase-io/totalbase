import { expect, test } from '@playwright/test'
import { BASE_URL } from '../helpers.js'
import { code, rest, seedLab, type Lab } from './lab.js'

/**
 * The Data API as a hostile client (Data_API.md §3, §9, §11, §12, §14; Security.md §6.10): injection through every
 * input that reaches SQL, the request limits refused before SQL, regular expressions, function arguments, hidden
 * resources, OpenAPI and GraphQL seen per principal - and the advice a related field across a row filter returns
 * (API-2). Row filters and denied fields on plain reads are data-permissions.spec.ts's.
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
let graphqlWas: Record<string, unknown> = {}
test.beforeAll(async () => {
  lab = await seedLab('api')
  const settings = (await rest('GET', '/admin/api/settings/graphql', lab.admin.session)).data ?? {}
  graphqlWas = { 'graphql.enabled': settings['graphql.enabled'] ?? false, 'graphql.max_depth': settings['graphql.max_depth'] ?? 8 }
})
test.afterAll(async () => {
  if (!lab) return
  await rest('PATCH', '/admin/api/settings/graphql', lab.admin.session, graphqlWas, { allowFail: true })
  await lab.cleanup()
})

const get = (token: string, path: string) => rest('GET', path, token, undefined, { allowFail: true })
const tableCount = async () => (await lab.sql<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname LIKE '${lab.prefix}%'`))[0]!.n

test('injection through aliases, order, group, fields and values reaches no SQL', async () => {
  const p1 = lab.users.prosecutor1.token
  const tables = await tableCount()
  // An alias is a quoted output key, never SQL.
  const alias = 'x"); DROP TABLE x;--'
  const aliased = await get(p1, `${lab.path.cases}?${new URLSearchParams({ 'fields[number]': alias })}`)
  expect(aliased.status).toBe(200)
  expect(Object.keys(aliased.data[0])).toEqual([alias])
  // An identifier is a field path the catalog resolves, or a refusal.
  for (const path of [
    `${lab.path.cases}?order_by=${encodeURIComponent(`number; DROP TABLE ${lab.t.cases}`)}`,
    `${lab.path.cases}?group_by=${encodeURIComponent('number)--')}&_count[*]=n`,
    `${lab.path.cases}?fields=${encodeURIComponent('pg_sleep(1)')}`,
    `${lab.path.cases}?_max[${encodeURIComponent('number) FROM pg_shadow --')}]=m`
  ]) {
    const response = await get(p1, path)
    expect([400, 403], `${path} -> ${response.status}`).toContain(response.status)
    expect(JSON.stringify(response.body)).not.toMatch(/\bSELECT\b[\s\S]*\bFROM\b|"public"\./)
  }
  // A value is a bind parameter: inert, and a type error says nothing of the generated SQL.
  expect((await get(p1, `${lab.path.cases}?where[number][_eq]=${encodeURIComponent("C1' OR '1'='1")}`)).data).toEqual([])
  expect((await get(p1, `${lab.path.cases}?where[number][_in]=${encodeURIComponent("C3','C4")}`)).data).toEqual([])
  expect((await get(p1, `${lab.path.cases}?where[number][_like]=%25`)).data.length).toBe(2)
  const typeError = await get(p1, `${lab.path.cases}?where[id][_eq]=not-a-uuid`)
  expect(typeError.status).toBe(400)
  expect(JSON.stringify(typeError.body)).not.toMatch(/SELECT|WHERE|\$1/)
  expect(await tableCount()).toBe(tables)
})

test('variables resolve to the caller only, and never to a protected or denied field', async () => {
  const p1 = lab.users.prosecutor1.token
  expect((await get(p1, `${lab.path.cases}?where[prosecutor][_eq]=${encodeURIComponent('$USER.id')}`)).data.length).toBe(2)
  expect(code(await get(p1, `${lab.path.cases}?where[number][_eq]=${encodeURIComponent('$USER.password_hash')}`))).toBe('INVALID_QUERY')
  // $ROW is a column like any other: a denied one is refused, never compared in the dark.
  expect(code(await get(lab.users.expert1.token, `${lab.path.cases}?where[status][_eq]=${encodeURIComponent('$ROW.description')}`))).toBe('FIELD_PERMISSION_DENIED')
  // A flag over a denied field is no oracle either.
  expect(code(await get(lab.users.integration.token, `${lab.path.summary}?flags[f][prosecutor][_nnull]=true`))).toBe('FIELD_PERMISSION_DENIED')
})

test('the request limits refuse an abusive request before SQL', async () => {
  const p1 = lab.users.prosecutor1.token
  expect(code(await get(p1, `${lab.path.custody}?fields=${encodeURIComponent('evidence.case.office.name.x')}`))).toMatch(/QUERY_DEPTH_LIMIT_EXCEEDED|FIELD_PERMISSION_DENIED/)
  const params = Array.from({ length: 250 }, (_, i) => `p${i}=1`).join('&')
  expect(code(await get(p1, `${lab.path.cases}?${params}`))).toBe('QUERY_PARAMETER_LIMIT_EXCEEDED')
  expect(code(await get(p1, `${lab.path.cases}?where${'[_and][0]'.repeat(20)}[number][_eq]=C1`))).toBe('QUERY_DEPTH_LIMIT_EXCEEDED')
  const huge = await get(p1, `${lab.path.cases}?where[number][_eq]=${'x'.repeat(40_000)}`)
  expect([400, 414, 431]).toContain(huge.status)
  if (huge.status === 400) expect(code(huge)).toBe('QUERY_STRING_TOO_LARGE')
  // An over-large limit is capped, never an unbounded read.
  expect((await get(p1, `${lab.path.cases}?limit=99999999`)).status).toBe(200)
  // A catastrophic regular expression ends quickly - refused, or bounded by the statement timeout.
  for (const pattern of ['(a|a|a)*(a|a|a)*(a|a|a)*c', '(.*.*.*.*.*.*.*.*.*.*)*z', '((']) {
    const started = Date.now()
    const response = await get(lab.users.expert1.token, `${lab.path.cases}?where[status][_regex]=${encodeURIComponent(pattern)}`)
    expect(response.status, pattern).toBeLessThan(500)
    expect(Date.now() - started, pattern).toBeLessThan(10_000)
  }
})

test('a function takes its own arguments only, as bind parameters', async () => {
  const coord = lab.users.coord.token
  const call = (data: unknown) => rest('POST', lab.path.closeCase, coord, data, { allowFail: true })
  // An unknown argument, a positional array: no matching signature. A wrong type or an SQL-ish value: a cast error.
  for (const data of [{ case_id: lab.rows.cases.C1, evil: 'x' }, [lab.rows.cases.C1], { case_id: 12345 }, { case_id: "1' OR '1'='1" }]) {
    const response = await call(data)
    expect([400, 404], `${JSON.stringify(data)} -> ${response.status}`).toContain(response.status)
  }
  const open = async () => (await lab.sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${lab.t.cases} WHERE status <> 'CLOSED'`))[0]!.n
  expect(await open()).toBe(4)
  // The one well-formed call closes the one case it names.
  expect((await call({ case_id: lab.rows.cases.C1 })).status).toBe(200)
  expect(await open()).toBe(3)
})

test('a hidden or missing resource answers alike; OpenAPI lists only what the caller may use', async () => {
  const integration = lab.users.integration.token
  const hidden = await get(integration, lab.path.experts)
  const missing = await get(integration, `/api/public/table/${lab.prefix}_nothing_here`)
  const invisible = await get(integration, '/api/totalbase/table/secrets')
  expect(code(missing)).toBe('RESOURCE_NOT_FOUND')
  expect(code(invisible)).toBe('RESOURCE_NOT_FOUND')
  // Not exposed to the role at all: refused, without telling its columns.
  expect([403, 404]).toContain(hidden.status)
  expect(JSON.stringify(hidden.body)).not.toMatch(/tax_id|fee/)

  const openapi = async (token: string) => {
    const body = (await get(token, '/api/openapi.json')).body
    return { paths: Object.keys(body.paths ?? {}).filter(path => path.includes(lab.prefix)), text: JSON.stringify(body) }
  }
  const forIntegration = await openapi(integration)
  expect(forIntegration.paths.length).toBeGreaterThan(0)
  expect(forIntegration.paths.every(path => path.includes(lab.t.summary)), forIntegration.paths.join(', ')).toBe(true)
  for (const word of ['tax_id', '"prosecutor"']) expect(forIntegration.text, word).not.toContain(word)
  const forProsecutor = await openapi(lab.users.prosecutor1.token)
  expect(forProsecutor.paths.some(path => path.endsWith(lab.t.experts))).toBe(true)
  expect(forProsecutor.text).not.toContain('tax_id')
})

test('an uploaded page never runs, and a private file needs READ on it', async () => {
  const upload = (token: string) => {
    const form = new FormData()
    form.append('file', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'page.html')
    form.append('visibility', 'PRIVATE')
    return fetch(`${BASE_URL}/api/totalbase/table/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
  }
  // An API-only role without the default grants uploads nothing.
  expect([403, 404]).toContain((await upload(lab.users.integration.token)).status)
  // An app user's own upload (the default grants): a download, sandboxed, never sniffed.
  const p1 = lab.users.prosecutor1.token
  const created = await upload(p1)
  expect(created.status).toBe(201)
  const id = (await created.json()).data.id as string
  try {
    const own = await fetch(`${BASE_URL}/api/totalbase/table/files/${id}`, { headers: { authorization: `Bearer ${p1}` } })
    expect(own.status).toBe(200)
    expect(own.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(own.headers.get('content-security-policy')).toMatch(/^sandbox/)
    expect(own.headers.get('x-content-type-options')).toBe('nosniff')
    // PRIVATE is its uploader's only (Administration.md §10.6): no grant goes past it - not the default READ every App
    // user holds on files (another prosecutor, the coordinator), not a role without READ, not an anonymous caller.
    for (const token of [lab.users.prosecutor2.token, lab.users.coord.token, lab.users.integration.token, null]) {
      const other = await fetch(`${BASE_URL}/api/totalbase/table/files/${id}`, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      expect([401, 403, 404], `${other.status}`).toContain(other.status)
    }
  } finally {
    await rest('DELETE', `/api/totalbase/table/files/${id}`, p1, undefined, { allowFail: true })
  }
})

test('a LINKED file follows its record: whoever reads the row reaches it, nobody else; no list hands out another\'s file', async () => {
  // A photo column on the evidence, as an agent would add one (a uuid foreign key to totalbase.files).
  await lab.sql(`ALTER TABLE public.${lab.t.evidence} ADD COLUMN photo uuid REFERENCES totalbase.files`)
  const upload = async (token: string, visibility: string) => {
    const form = new FormData()
    form.append('visibility', visibility)
    form.append('file', new Blob(['photo'], { type: 'text/plain' }), `${visibility}.txt`)
    const response = await fetch(`${BASE_URL}/api/totalbase/table/files`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form })
    expect(response.status).toBe(201)
    return (await response.json()).data.id as string
  }
  const p1 = lab.users.prosecutor1.token
  const grantEvidence = (role: string, data: unknown) => rest('PUT', `/admin/api/roles/${role}/resources/${lab.resources.evidence}/permissions/READ`, lab.admin.session, data)
  const restore: { role: string, grant: { where_clause: unknown, field_overrides: unknown[] } }[] = []
  const ids = { openCase: await upload(p1, 'LINKED'), restrictedCase: await upload(p1, 'LINKED'), privateOne: await upload(p1, 'PRIVATE') }
  try {
    // C1 is unrestricted, C2 restricted - both prosecutor1's; the PRIVATE file is put on a row too.
    await lab.sql(`UPDATE public.${lab.t.evidence} e SET photo = CASE c.number WHEN 'C1' THEN '${ids.openCase}'::uuid WHEN 'C2' THEN '${ids.restrictedCase}'::uuid WHEN 'C3' THEN '${ids.privateOne}'::uuid END FROM public.${lab.t.cases} c WHERE c.id = e."case"`)
    // The new column needs its field grant, as any column added after a grant does (a file column a role can't read
    // links nothing for it): added to the coordinator's and the expert's grants, put back after. The coordinator is
    // the prosecutors' parent - its grant is their ceiling - so it keeps every field it had.
    for (const role of [lab.roles.coordination, lab.roles.expert]) {
      const [grant] = await lab.sql<{ where_clause: unknown, field_overrides: { field: string, effect: string }[] }>(`SELECT where_clause, field_overrides FROM totalbase.permissions WHERE role = '${role}' AND resource = '${lab.resources.evidence}' AND action = 'READ'`)
      restore.push({ role, grant: grant! })
      await grantEvidence(role, { effect: 'ALLOW', where: grant!.where_clause, fields: [...grant!.field_overrides, { field: 'photo', effect: 'ALLOW' }] })
    }
    const content = async (token: string, id: string) => (await fetch(`${BASE_URL}/api/totalbase/table/files/${id}`, { headers: { authorization: `Bearer ${token}` } })).status
    const listed = async (token: string) => ((await rest('GET', '/api/totalbase/table/files?fields=id&limit=500', token)).data as { id: string }[]).map(file => file.id)
    // The coordinator reads every evidence row; the expert only those of unrestricted cases; prosecutor2 none of these.
    expect(await content(lab.users.coord.token, ids.openCase)).toBe(200)
    expect(await content(lab.users.coord.token, ids.restrictedCase)).toBe(200)
    expect(await content(lab.users.expert1.token, ids.openCase)).toBe(200)
    expect(await content(lab.users.expert1.token, ids.restrictedCase)).toBe(403)
    expect(await content(lab.users.prosecutor2.token, ids.openCase)).toBe(403)
    // A PRIVATE file stays its uploader's, whatever row points at it.
    expect(await content(lab.users.coord.token, ids.privateOne)).toBe(403)
    const expertList = await listed(lab.users.expert1.token)
    expect(expertList).toContain(ids.openCase)
    expect(expertList).not.toContain(ids.restrictedCase)
    expect(expertList).not.toContain(ids.privateOne)
    expect(await listed(lab.users.prosecutor2.token)).not.toEqual(expect.arrayContaining([ids.openCase]))
    // Another user can't take a file out of its readers' reach, nor touch a PRIVATE one.
    const patch = (token: string, id: string, data: unknown) => rest('PATCH', `/api/totalbase/table/files/${id}`, token, data, { allowFail: true })
    expect((await patch(lab.users.prosecutor2.token, ids.privateOne, { visibility: 'PUBLIC' })).status).toBe(403)
  } finally {
    for (const { role, grant } of restore) await grantEvidence(role, { effect: 'ALLOW', where: grant.where_clause, fields: grant.field_overrides })
    await lab.sql(`ALTER TABLE public.${lab.t.evidence} DROP COLUMN photo`)
    for (const id of Object.values(ids)) await rest('DELETE', `/api/totalbase/table/files/${id}`, p1, undefined, { allowFail: true })
  }
})

test('GraphQL shows each principal its own schema, with the same row filters and limits', async () => {
  await rest('PATCH', '/admin/api/settings/graphql', lab.admin.session, { 'graphql.enabled': true })
  const gql = async (token: string, query: string) => (await fetch(`${BASE_URL}/api/graphql`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ query })
  })).json()

  const schema = JSON.stringify(await gql(lab.users.integration.token, '{ __schema { types { name fields { name } } } }'))
  expect(schema).toContain(lab.t.summary)
  for (const word of [`"${lab.t.experts}"`, 'tax_id', '"prosecutor"']) expect(schema, word).not.toContain(word)

  const p1 = lab.users.prosecutor1.token
  const errorText = (result: { errors?: { message: string, extensions?: { code?: string } }[] }) => JSON.stringify(result.errors ?? [])
  // A denied field isn't in the caller's type, directly or through a relation.
  expect(errorText(await gql(p1, `{ ${lab.t.experts} { specialty tax_id fee } }`))).toContain('Cannot query field \\"tax_id\\"')
  const related = await gql(p1, `{ ${lab.t.evidence} { description expert_row { specialty } } }`)
  expect(related.errors).toBeUndefined()
  expect(errorText(await gql(p1, `{ ${lab.t.evidence} { description expert_row { tax_id } } }`))).toContain('Cannot query field \\"tax_id\\"')
  // The row filter holds, at the root and through a one-to-many field.
  const cases = await gql(p1, `{ ${lab.t.cases} { number ${lab.t.evidence}_by_case { case_row { number } } } }`)
  expect(cases.errors).toBeUndefined()
  expect(cases.data[lab.t.cases].map((row: { number: string }) => row.number).sort()).toEqual(['C1', 'C2'])

  // Depth and calls are limited before anything runs.
  const deep = `{ ${lab.t.cases} { number ${lab.t.evidence}_by_case { ${lab.t.custody}_by_evidence { signature } } } }`
  expect((await gql(p1, deep)).errors).toBeUndefined()
  await rest('PATCH', '/admin/api/settings/graphql', lab.admin.session, { 'graphql.max_depth': 2 })
  expect(errorText(await gql(p1, deep)), 'depth').toMatch(/QUERY_(DEPTH|COMPLEXITY)_LIMIT_EXCEEDED/)
  await rest('PATCH', '/admin/api/settings/graphql', lab.admin.session, { 'graphql.max_depth': graphqlWas['graphql.max_depth'] })
  const aliased = `{ ${Array.from({ length: 40 }, (_, i) => `a${i}: ${lab.t.cases} { number }`).join(' ')} }`
  expect(errorText(await gql(p1, aliased)), 'aliases').toContain('QUERY_COMPLEXITY_LIMIT_EXCEEDED')
})

test('API-2: a related field read across the target\'s row filter says so', async () => {
  const fields = ['id', 'description', 'expert', 'expert.specialty'].map(field => ({ field, effect: 'ALLOW' }))
  const grant = await rest('PUT', `/admin/api/roles/${lab.roles.expert}/resources/${lab.resources.evidence}/permissions/READ`, lab.admin.session, { effect: 'ALLOW', fields })
  expect(grant.body.meta.warnings.join('\n')).toContain(`"expert.specialty" reads ${lab.t.experts} through expert without this role's row filter`)
  // The documented contract the advice is about: expert2 sees expert1's specialty through the evidence.
  const rows = (await get(lab.users.expert2.token, `${lab.path.evidence}?fields=id,expert.specialty`)).data
  expect(rows.length).toBeGreaterThan(0)
})

// Realtime (/api/realtime) needs wal_level=logical and realtime.enabled; tests/realtime.spec.ts covers its access.
