import { expect, test } from '@playwright/test'
import { code, rest, seedLab, type Lab } from './lab.js'

/**
 * Data API permissions and row filters, attacked as the app's least-privileged profiles (Security.md §6, §10;
 * Data_API.md §3-§8): row filters across profiles, denied fields as oracles, OLD and NEW on UPDATE, bulk atomicity,
 * TotalBase's own tables, function EXECUTE - and the advice a grant that reaches past a row filter returns (PERM-01).
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
test.beforeAll(async () => { lab = await seedLab('perm') })
test.afterAll(async () => { await lab?.cleanup() })

const get = (token: string, path: string) => rest('GET', path, token, undefined, { allowFail: true })

test('a row filter holds: by key, by where, through relations, in counts', async () => {
  const p1 = lab.users.prosecutor1.token
  expect((await get(p1, `${lab.path.cases}/${lab.rows.cases.C3}`)).status).toBe(404)
  expect((await get(p1, `${lab.path.cases}?where[prosecutor][_eq]=${lab.users.prosecutor2.id}`)).data).toEqual([])
  expect((await get(p1, `${lab.path.evidence}?where[case][_eq]=${lab.rows.cases.C3}`)).data).toEqual([])
  // A relation path the grant doesn't list is no way to filter by it.
  expect(code(await get(p1, `${lab.path.custody}?where[evidence.case][_eq]=${lab.rows.cases.C3}`))).toBe('FIELD_PERMISSION_DENIED')
  expect((await get(p1, `${lab.path.cases}?count=true`)).body.meta.count).toBe(2)
  expect((await get(lab.users.expert1.token, `${lab.path.cases}?count=true`)).body.meta.count).toBe(2)
  expect((await get(lab.users.expert1.token, `${lab.path.cases}/${lab.rows.cases.C2}`)).status).toBe(404)
})

test('a denied field is no oracle: not in fields, where, order, aggregates, group or relations', async () => {
  const p1 = lab.users.prosecutor1.token
  const denied = [
    `${lab.path.experts}?fields=tax_id`, `${lab.path.experts}?where[tax_id][_eq]=20-11111111-1`, `${lab.path.experts}?order_by=fee`,
    `${lab.path.experts}?_sum[fee]=total`, `${lab.path.experts}?_max[tax_id]=top`, `${lab.path.evidence}?fields=expert.tax_id`,
    `${lab.path.evidence}?fields=expert.fee`
  ]
  for (const path of denied) expect(code(await get(p1, path)), path).toBe('FIELD_PERMISSION_DENIED')
  const e1 = lab.users.expert1.token
  for (const path of [`${lab.path.cases}?fields=description`, `${lab.path.cases}?where[description][_like]=%25RESTRICTED%25`, `${lab.path.cases}?order_by=description`, `${lab.path.reports}?fields=case.description`]) {
    expect(code(await get(e1, path)), path).toBe('FIELD_PERMISSION_DENIED')
  }
  const integration = lab.users.integration.token
  for (const path of [`${lab.path.summary}?fields=prosecutor`, `${lab.path.summary}?where[prosecutor][_null]=false`, `${lab.path.summary}?order_by=prosecutor`, `${lab.path.summary}?_count[*]=n&group_by=prosecutor`]) {
    expect(code(await get(integration, path)), path).toBe('FIELD_PERMISSION_DENIED')
  }
  // A search over a denied column skips it: no boolean oracle.
  expect((await get(e1, `${lab.path.cases}?search=witness&fields=number`)).data ?? []).toEqual([])
  // A record read by key projects the same fields.
  const expert = (await get(p1, `${lab.path.experts}/${lab.rows.experts.expert1}`)).data
  expect(expert).not.toHaveProperty('tax_id')
  expect(expert).not.toHaveProperty('fee')
  // A reverse relation isn't a way around the allowlist.
  expect(code(await get(p1, `${lab.path.cases}?fields=reports.body`))).toMatch(/FIELD_PERMISSION_DENIED|INVALID_QUERY/)
  // Unknown query parameters are refused, not ignored.
  expect((await get(p1, `${lab.path.cases}?distinct=description`)).status).toBe(400)
})

test('an UPDATE is authorized on OLD and NEW; a CREATE on NEW; a refused bulk item rolls the batch back', async () => {
  const p1 = lab.users.prosecutor1.token
  const handOver = await rest('PATCH', `${lab.path.cases}/${lab.rows.cases.C1}`, p1, { prosecutor: lab.users.prosecutor2.id }, { allowFail: true })
  expect(code(handOver)).toBe('ACTION_DENIED')
  expect((await rest('PATCH', `${lab.path.cases}/${lab.rows.cases.C3}`, p1, { status: 'CLOSED' }, { allowFail: true })).status).toBe(404)
  const evidence = { description: 'Planted', sha256: 'a'.repeat(64) }
  expect(code(await rest('POST', lab.path.evidence, p1, { ...evidence, case: lab.rows.cases.C3 }, { allowFail: true }))).toBe('ACTION_DENIED')

  const before = (await lab.sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${lab.t.evidence}`))[0]!.n
  const bulk = await rest('POST', `${lab.path.evidence}?bulk=true`, p1, [{ ...evidence, case: lab.rows.cases.C1 }, { ...evidence, case: lab.rows.cases.C3 }], { allowFail: true })
  expect(bulk.status).toBe(403)
  expect((await lab.sql<{ n: number }>(`SELECT count(*)::int AS n FROM public.${lab.t.evidence}`))[0]!.n).toBe(before)

  const e1 = lab.users.expert1.token
  const draft = (await get(e1, `${lab.path.reports}?where[status][_eq]=DRAFT&limit=1`)).data[0]
  expect(code(await rest('PATCH', `${lab.path.reports}/${draft.id}`, e1, { status: 'DELIVERED' }, { allowFail: true }))).toBe('ACTION_DENIED')
  expect(code(await rest('PATCH', `${lab.path.reports}/${draft.id}`, e1, { expert: lab.rows.experts.expert2 }, { allowFail: true }))).toBe('ACTION_DENIED')
  expect(code(await rest('POST', lab.path.cases, p1, { number: 'X', office: lab.rows.cases.C1 }, { allowFail: true }))).toBe('ACTION_DENIED')
})

test("TotalBase's own tables: protected columns, fixed exposure, no way up", async () => {
  const p1 = lab.users.prosecutor1.token
  expect(code(await get(p1, '/api/totalbase/table/users?fields=password_hash'))).toBe('FIELD_PERMISSION_DENIED')
  expect((await get(p1, `/api/totalbase/table/users?where[id][_eq]=${lab.users.prosecutor2.id}`)).data).toEqual([])
  for (const table of ['tokens', 'permissions']) expect(code(await get(p1, `/api/totalbase/table/${table}`)), table).toBe('ACTION_DENIED')
  for (const table of ['settings', 'secrets', 'audit']) expect((await get(p1, `/api/totalbase/table/${table}`)).status, table).toBe(404)

  const writes: [string, string, unknown][] = [
    ['POST', '/api/totalbase/table/users_roles', { user: lab.users.prosecutor1.id, role: lab.roles.coordination }],
    ['POST', '/api/totalbase/table/roles', { name: `${lab.prefix}-mine`, admin_access: true }],
    ['PATCH', `/api/totalbase/table/roles/${lab.roles.prosecutor}`, { admin_access: true }],
    ['POST', '/api/totalbase/table/permissions', { role: lab.roles.prosecutor, resource: lab.resources.experts, action: 'READ', effect: 'ALLOW' }],
    ['POST', '/api/totalbase/table/users', { email: `${lab.prefix}-new@example.com` }],
    ['PATCH', `/api/totalbase/table/users/${lab.users.prosecutor2.id}`, { name: 'Taken over' }]
  ]
  for (const [method, path, data] of writes) {
    const response = await rest(method, path, p1, data, { allowFail: true })
    expect([403, 404], `${method} ${path} -> ${response.status}`).toContain(response.status)
  }
})

test('a function runs only with EXECUTE, and transactions only with their capability', async () => {
  for (const profile of ['prosecutor1', 'expert1', 'integration'] as const) {
    const response = await rest('POST', lab.path.closeCase, lab.users[profile].token, { case_id: lab.rows.cases.C1 }, { allowFail: true })
    expect(code(response), profile).toBe('FUNCTION_EXECUTION_DENIED')
  }
  const transaction = await rest('POST', '/api/transactions', lab.users.prosecutor1.token, { operations: [{ key: 'a', operation: 'update', schema: 'public', table: lab.t.cases, id: lab.rows.cases.C1, data: { status: 'CLOSED' } }] }, { allowFail: true })
  expect(code(transaction)).toBe('TRANSACTION_EXECUTION_DENIED')
})

test('PERM-01: a grant that reaches rows past the role\'s row filter says so', async () => {
  // The expert's CREATE on reports doesn't name "case": it may point a report at a restricted case it can't read.
  const restricted = await rest('POST', lab.path.reports, lab.users.expert1.token, { case: lab.rows.cases.C4, expert: lab.rows.experts.expert1, body: 'probe' }, { allowFail: true })
  expect(restricted.status).toBe(201)
  expect(restricted.data).not.toHaveProperty('case.description')
  const grant = (data: unknown) => rest('PUT', `/admin/api/roles/${lab.roles.expert}/resources/${lab.resources.reports}/permissions/CREATE`, lab.admin.session, data)
  const fields = ['case', 'expert', 'body'].map(field => ({ field, effect: 'ALLOW' }))
  const advised = await grant({ effect: 'ALLOW', fields, where: { 'expert.user': { _eq: '$USER.id' } } })
  expect(advised.body.meta.warnings.join('\n')).toContain(`${lab.t.reports}.case may point at any ${lab.t.cases} row`)
  // Naming the column in the grant's filter keeps it among the readable ones: no advice, and the write is refused.
  const scoped = await grant({ effect: 'ALLOW', fields, where: { _and: [{ 'expert.user': { _eq: '$USER.id' } }, { 'case.restricted': { _eq: false } }] } })
  expect(scoped.body.meta).toBeUndefined()
  const refused = await rest('POST', lab.path.reports, lab.users.expert1.token, { case: lab.rows.cases.C4, expert: lab.rows.experts.expert1, body: 'probe' }, { allowFail: true })
  expect(code(refused)).toBe('ACTION_DENIED')
})
