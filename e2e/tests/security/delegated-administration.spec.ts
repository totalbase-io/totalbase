import { expect, test } from '@playwright/test'
import { code, rest, seedLab, type Lab } from './lab.js'

/**
 * Delegated administration, attacked as the manager of a branch (Security.md §6.11, §9.5-§9.7, §10.2): coord holds
 * MANAGE_ROLES and is the parent of prosecutor and expert. A grant stays ALLOW-only, within the parent's ceiling, for a
 * role below theirs; unknown keys are refused, never dropped (DELEG-01); the privilege tables keep their guardrails
 * whatever the Data API grants say.
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
let coord: string
test.beforeAll(async () => {
  lab = await seedLab('deleg')
  coord = await lab.session('coord')
})
test.afterAll(async () => { await lab?.cleanup() })

const put = (path: string, data: unknown) => rest('PUT', path, coord, data, { allowFail: true })
const grantPath = (role: string, resource: string, action: string) => `/app/api/roles/${role}/resources/${resource}/permissions/${action}`

/** A TotalBase table's resource id. */
async function totalbaseResource(name: string) {
  return (await lab.sql<{ id: string }>(`SELECT id FROM totalbase.resources WHERE "schema" = 'totalbase' AND name = '${name}' AND status = 'ACTIVE'`))[0]!.id
}

test('DELEG-01: an unknown key in a grant is refused by name, on every grant route', async () => {
  const body = { effect: 'ALLOW', deny_fields: ['tax_id', 'fee'] }
  const single = await put(grantPath(lab.roles.prosecutor, lab.resources.experts, 'UPDATE'), body)
  expect(single.status).toBe(400)
  expect(single.body.errors[0].message).toContain('deny_fields')
  const shared = await put(`/app/api/resources/${lab.resources.experts}/permissions/UPDATE`, { ...body, roleIds: [lab.roles.prosecutor] })
  expect(shared.status).toBe(400)
  expect(shared.body.errors[0].message).toContain('deny_fields')
  const admin = await rest('PUT', `/admin/api/roles/${lab.roles.prosecutor}/resources/${lab.resources.experts}/permissions/UPDATE`, lab.admin.session, body, { allowFail: true })
  expect(admin.status).toBe(400)
  expect(admin.body.errors[0].message).toContain('deny_fields')
  // Nothing was written.
  const stored = await lab.sql(`SELECT 1 FROM totalbase.permissions WHERE role = '${lab.roles.prosecutor}' AND resource = '${lab.resources.experts}' AND action = 'UPDATE'`)
  expect(stored).toEqual([])
})

test('a delegated grant stays ALLOW-only and within the ceiling', async () => {
  const P = lab.roles.prosecutor
  // An action the parent lacks (coord only READs the summary view and offices).
  expect(code(await put(grantPath(P, lab.resources.summary, 'CREATE'), { effect: 'ALLOW' }))).toBe('PERMISSION_EXCEEDS_CEILING')
  expect(code(await put(grantPath(P, lab.resources.offices, 'DELETE'), { effect: 'ALLOW' }))).toBe('PERMISSION_EXCEEDS_CEILING')
  // TotalBase tables the parent has no write on.
  for (const table of ['permissions', 'users_roles', 'roles']) {
    const response = await put(grantPath(P, await totalbaseResource(table), 'CREATE'), { effect: 'ALLOW' })
    expect([403, 404], `${table} -> ${response.status}`).toContain(response.status)
  }
  // DENY is the administrator's.
  expect(code(await put(grantPath(P, lab.resources.cases, 'READ'), { effect: 'DENY' }))).toBe('PERMISSION_DENIED')
  // A row filter through a relation the parent can't read, or a protected column, or nothing at all.
  for (const where of [{ 'prosecutor.email': { _like: '%a%' } }, { 'prosecutor.password_hash': { _eq: 'x' } }, { nonexistent: { _eq: 1 } }, { 'office.bogus': { _eq: 1 } }]) {
    expect(code(await put(grantPath(P, lab.resources.cases, 'READ'), { effect: 'ALLOW', where })), JSON.stringify(where)).toBe('PERMISSION_EXCEEDS_CEILING')
  }
  expect(code(await put(grantPath(P, lab.resources.cases, 'READ'), { effect: 'ALLOW', where: { number: { _bogusop: 1 } } }))).toBe('INVALID_OPERATOR')
})

test('only roles below the manager: not their own, not a sibling, and a shared grant is all or none', async () => {
  for (const role of [lab.roles.coordination, lab.roles.integration]) {
    expect((await put(grantPath(role, lab.resources.cases, 'READ'), { effect: 'ALLOW' })).status).toBe(404)
  }
  const mixed = await put(`/app/api/resources/${lab.resources.offices}/permissions/READ`, { effect: 'ALLOW', roleIds: [lab.roles.expert, lab.roles.integration] })
  expect(mixed.status).toBe(404)
  expect(await lab.sql(`SELECT 1 FROM totalbase.permissions WHERE role = '${lab.roles.integration}' AND resource = '${lab.resources.offices}'`)).toEqual([])
  for (const role of [lab.roles.coordination, lab.roles.integration]) {
    expect((await rest('POST', `/app/api/roles/${role}/duplicate`, coord, { name: `${lab.prefix.replace(/_/g, '-')}-copy` }, { allowFail: true })).status).toBe(404)
  }
  // A dashboard that isn't delegable can't be shared down.
  expect((await rest('PUT', `/app/api/roles/${lab.roles.expert}/objects/dashboards/${lab.dashboard.id}`, coord, undefined, { allowFail: true })).status).toBe(404)
})

test('the privilege tables refuse a manager, even one granted to write them', async () => {
  const api = (method: string, path: string, data?: unknown) => rest(method, path, lab.users.coord.token, data, { allowFail: true })
  const refused = async (method: string, path: string, data?: unknown) => {
    const response = await api(method, path, data)
    expect([403, 404, 422], `${method} ${path} ${JSON.stringify(data)} -> ${response.status} ${code(response)}`).toContain(response.status)
    return response
  }
  // With the seeded READ-only defaults, the permission layer refuses first.
  await refused('POST', '/api/totalbase/table/roles', { name: `${lab.prefix}-x`, admin_access: true })
  await refused('POST', '/api/totalbase/table/users_roles', { user: lab.users.coord.id, role: lab.roles.expert })

  // The documented delegated administrator (Security.md §9.4): the administrator grants coordination writes on the
  // identity tables - the guardrails still hold.
  for (const table of ['roles', 'users_roles', 'users']) {
    const resource = await totalbaseResource(table)
    for (const action of ['CREATE', 'UPDATE', 'DELETE']) {
      await rest('PUT', `/admin/api/roles/${lab.roles.coordination}/resources/${resource}/permissions/${action}`, lab.admin.session, { effect: 'ALLOW' })
    }
  }
  const administrators = (await lab.sql<{ id: string }>(`SELECT id FROM totalbase.roles WHERE admin_access AND reserved ORDER BY name LIMIT 1`))[0]?.id
    ?? (await lab.sql<{ id: string }>(`SELECT id FROM totalbase.roles WHERE admin_access LIMIT 1`))[0]!.id
  const reserved = await lab.sql<{ id: string }>(`SELECT id FROM totalbase.roles WHERE reserved AND NOT admin_access`)

  expect(code(await refused('POST', '/api/totalbase/table/roles', { name: `${lab.prefix}-a`, admin_access: true }))).toBe('PERMISSION_DENIED')
  await refused('POST', '/api/totalbase/table/roles', { name: `${lab.prefix}-r`, reserved: true })
  await refused('PATCH', `/api/totalbase/table/roles/${lab.roles.prosecutor}`, { admin_access: true })
  await refused('PATCH', `/api/totalbase/table/roles/${lab.roles.integration}`, { parent: lab.roles.expert })
  await refused('PATCH', `/api/totalbase/table/roles/${lab.roles.coordination}`, { parent: lab.roles.prosecutor })
  await refused('PATCH', `/api/totalbase/table/roles/${lab.roles.prosecutor}`, { parent: null })
  // Administrators and the reserved roles are never assignable, to oneself or anyone.
  for (const role of [administrators, ...reserved.map(row => row.id)]) {
    await refused('POST', '/api/totalbase/table/users_roles', { user: lab.users.coord.id, role })
    await refused('POST', '/api/totalbase/table/users_roles', { user: lab.users.prosecutor1.id, role })
  }
  const adminAssignment = (await lab.sql<{ id: string }>(`SELECT id FROM totalbase.users_roles WHERE "user" = '${lab.admin.id}' AND role = '${administrators}'`))[0]!.id
  await refused('DELETE', `/api/totalbase/table/users_roles/${adminAssignment}`)
  // The admin-only tables.
  await refused('POST', '/api/totalbase/table/roles_capabilities', { role: lab.roles.prosecutor, capability: 'MANAGE_ROLES', effect: 'ALLOW' })
  await refused('POST', '/api/totalbase/table/roles_managers', { role: lab.roles.integration, manager: lab.roles.coordination })
  await refused('POST', '/api/totalbase/table/dashboards_roles', { dashboard: lab.dashboard.id, role: lab.roles.expert })
  expect(await lab.sql(`SELECT 1 FROM totalbase.users_roles WHERE "user" = '${lab.users.coord.id}' AND role <> '${lab.roles.coordination}'`)).toEqual([])

  // Accounts: the administrator's is the administrator's; protected and account columns stay out of reach.
  await refused('PATCH', `/api/totalbase/table/users/${lab.admin.id}`, { name: 'Taken over' })
  const removed = await rest('DELETE', `/app/api/users/${lab.admin.id}`, coord, undefined, { allowFail: true })
  expect([403, 404], `remove the administrator -> ${removed.status}`).toContain(removed.status)
  await refused('PATCH', `/api/totalbase/table/users/${lab.users.prosecutor1.id}`, { email: `${lab.prefix}-new@example.com` })
  await refused('PATCH', `/api/totalbase/table/users/${lab.users.prosecutor1.id}`, { password_hash: 'x' })
  await refused('PATCH', `/api/totalbase/table/users/${lab.users.prosecutor1.id}`, { owner: true })
  const adminRow = (await api('GET', `/api/totalbase/table/users/${lab.admin.id}`)).data
  expect(adminRow ?? {}).not.toHaveProperty('password_hash')
})
