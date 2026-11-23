import { createServer, type Server } from 'node:http'
import { expect, test } from '@playwright/test'
import { code, mcp, rest, tool, seedLab, type Lab } from './lab.js'

/**
 * Workflows, attacked through what a published workflow exposes (Workflows.md §4.3, §6.5, §9; Security.md §7): a
 * template in a filter never becomes filter grammar (WF-01), a public webhook with no secret is advised on (WF-L1),
 * history redacts credentials (WF-L2), and the run-as user's permissions, WORKFLOW_INVOKE, the template paths and
 * the SSRF guard hold.
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
let listener: Server
let listenerHits = 0
let listenerPort = 0
test.beforeAll(async () => {
  lab = await seedLab('wf')
  // A local listener of our own: the SSRF guard must keep every loopback spelling from reaching it.
  listener = createServer((_, res) => { listenerHits++; res.end('{"ok":true}') })
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  listenerPort = (listener.address() as { port: number }).port
})
test.afterAll(async () => {
  listener?.close()
  await lab?.cleanup()
})

let serial = 0
interface Built { id: string, slug: string, warnings?: string[] }

/** Creates, saves and publishes a workflow (slug under the lab's prefix); `publish: false` leaves it a draft. */
async function build(start: Record<string, unknown>, steps: Record<string, unknown>[], options: { roles?: string[], history?: 'SUMMARY' | 'DETAILED', publish?: boolean } = {}): Promise<Built> {
  const T = (name: string, args: unknown) => tool(lab.admin.mcpToken, name, args)
  const slug = `${lab.prefix.replace(/_/g, '-')}-${++serial}`
  const created = await T('create_workflow', { name: slug, slug, start, history_level: options.history ?? 'SUMMARY' })
  const id = (created.id ?? created.workflow?.id) as string
  const current = await T('get_workflow', { id })
  const operations = [{ type: 'totalbase.start', key: 'start', configuration: start }, ...steps]
  const connections = operations.slice(1).map((op, index) => ({ source: operations[index]!.key, target: op.key, output: 'next' }))
  const saved = await T('save_workflow', { id, revision: current.revision ?? current.workflow?.revision, operations, connections })
  if (options.publish === false) return { id, slug }
  const published = await T('publish_workflow', { id, revision: saved.revision ?? saved.workflow?.revision, enabled: true, ...(options.roles && { role_ids: options.roles }) })
  return { id, slug, warnings: published.warnings }
}

/** Same as build, expecting publish to be refused: what it said. */
async function refusedPublish(start: Record<string, unknown>, steps: Record<string, unknown>[]): Promise<string> {
  try { await build(start, steps) } catch (error) { return (error as Error).message }
  throw new Error('published')
}

const testRun = (id: string, input: unknown) => tool(lab.admin.mcpToken, 'run_workflow', { id, mode: 'test', input, full: true })
const webhook = (slug: string, data: unknown) => rest('POST', `/api/workflows/${slug}/webhook`, null, { data }, { raw: true, allowFail: true })
const descriptions = async () => Object.fromEntries((await lab.sql<{ number: string, description: string }>(`SELECT number, description FROM public.${lab.t.cases}`)).map(row => [row.number, row.description]))

test('WF-01: a template in a filter is a value, never the grammar - refused at publish, failed at run', async () => {
  const start = { trigger: 'WEBHOOK', method: 'POST', access: 'PUBLIC', response_mode: 'SYNC', execute_as: lab.users.coord.id }
  for (const type of ['totalbase.update-records', 'totalbase.delete-records']) {
    const configuration = { resource: lab.resources.cases, where: '{{start.data.body.data.where}}', ...(type.includes('update') && { set: { description: 'INJECTED' } }) }
    expect(await refusedPublish(start, [{ type, key: 'write', configuration }]), type).toMatch(/WORKFLOW_NOT_PUBLISHABLE|filter/i)
  }
  // A field whose whole value is a template: a caller's object there is refused when the run resolves it.
  const draft = await build({ trigger: 'MANUAL' }, [
    { type: 'totalbase.update-records', key: 'write', configuration: { resource: lab.resources.cases, where: { id: '{{start.data.where}}' }, set: { description: 'INJECTED' } } }
  ], { publish: false })
  const run = JSON.stringify(await testRun(draft.id, { where: { _neq: '00000000-0000-0000-0000-000000000000' } }).catch(error => (error as Error).message))
  expect(run).toMatch(/WORKFLOW_INVALID_DESIGN|resolves to an object/)
  expect(Object.values(await descriptions())).not.toContain('INJECTED')
})

test("the run-as user's permissions bound a webhook's writes; WF-L1: a public webhook with no secret is advised on", async () => {
  const start = { trigger: 'WEBHOOK', method: 'POST', access: 'PUBLIC', response_mode: 'SYNC', execute_as: lab.users.prosecutor1.id }
  const steps = [
    { type: 'totalbase.update-records', key: 'write', configuration: { resource: lab.resources.cases, where: { id: { _eq: '{{start.data.body.data.id}}' } }, set: { description: 'BY WEBHOOK' } } },
    { type: 'totalbase.finish-result', key: 'finish', configuration: { result: { updated: '{{write.data}}' } } }
  ]
  const open = await build(start, steps)
  expect(open.warnings?.join('\n')).toContain('public with no secret and no allowed addresses')
  // With allowed addresses, nothing to advise.
  expect((await build({ ...start, allowed_ips: ['127.0.0.1/32'] }, steps)).warnings ?? []).toEqual([])

  // Another prosecutor's case, and a caller-chosen operator instead of an id: no row touched.
  expect((await webhook(open.slug, { id: lab.rows.cases.C3 })).status).toBeLessThan(500)
  expect((await webhook(open.slug, { id: { _neq: lab.rows.cases.C1 } })).status).toBeLessThan(500)
  const after = await descriptions()
  expect(after.C3).toBe('Robbery')
  expect(after.C2).not.toBe('BY WEBHOOK')
  // Its own case: written.
  expect((await webhook(open.slug, { id: lab.rows.cases.C1 })).status).toBe(200)
  expect((await descriptions()).C1).toBe('BY WEBHOOK')
  // The caller can't pick another identity: an Authorization header is ignored by a public webhook.
  const asCoord = await rest('POST', `/api/workflows/${open.slug}/webhook`, lab.users.coord.token, { data: { id: lab.rows.cases.C3 } }, { raw: true, allowFail: true })
  expect(asCoord.status).toBeLessThan(500)
  expect((await descriptions()).C3).toBe('Robbery')
})

test('WORKFLOW_INVOKE decides who runs a workflow on demand', async () => {
  const manual = await build({ trigger: 'MANUAL' }, [{ type: 'totalbase.finish-result', key: 'finish', configuration: { result: { ok: true } } }], { roles: [lab.roles.coordination] })
  const run = (token: string | null) => rest('POST', `/api/workflows/${manual.slug}/run`, token, {}, { allowFail: true })
  for (const profile of ['prosecutor1', 'expert1', 'integration'] as const) {
    const response = await run(lab.users[profile].token)
    expect(response.status, profile).toBe(403)
    expect(code(response), profile).toBe('ACTION_DENIED')
  }
  expect((await run(null)).status).toBe(401)
  expect((await run(lab.users.coord.token)).status).toBe(200)
})

test('templates read own paths only: no prototype root, no pollution', async () => {
  for (const expression of ['{{constructor.name}}', '{{__proto__.x}}']) {
    expect(await refusedPublish({ trigger: 'MANUAL' }, [{ type: 'totalbase.finish-result', key: 'finish', configuration: { result: { v: expression } } }]), expression).toMatch(/names no step|WORKFLOW_NOT_PUBLISHABLE/)
  }
  const probe = await build({ trigger: 'WEBHOOK', method: 'POST', access: 'PUBLIC', response_mode: 'SYNC' }, [
    { type: 'totalbase.finish-result', key: 'finish', configuration: { result: { proto: '{{start.data.body.__proto__}}', polluted: '{{start.data.body.polluted}}', ctor: '{{start.constructor.name}}' } } }
  ])
  // A body that carries __proto__ is refused before anything reads it, on the webhook and on MCP.
  const polluting = JSON.parse('{"__proto__":{"polluted":"PWN"},"a":1}')
  expect((await rest('POST', `/api/workflows/${probe.slug}/webhook`, null, polluting, { raw: true, allowFail: true })).status).toBe(400)
  expect((await mcp(lab.admin.mcpToken, 'tools/call', { name: 'run_workflow', arguments: { id: probe.id, mode: 'test', input: polluting } })).httpStatus).toBe(400)
  // Inherited paths resolve to nothing.
  const result = JSON.stringify((await webhook(probe.slug, { a: 1 })).body)
  expect(result).not.toContain('PWN')
  expect(result).not.toContain('Object')
  expect(({} as Record<string, unknown>).polluted).toBeUndefined()
})

test('an HTTP request step never reaches a private address, however it is spelled', async () => {
  const probe = await build({ trigger: 'MANUAL' }, [
    { type: 'totalbase.http-request', key: 'http', configuration: { method: 'GET', url: '{{start.data.url}}' } },
    { type: 'totalbase.finish-result', key: 'finish', configuration: { result: { status: '{{http.data.status}}' } } }
  ])
  const p = listenerPort
  const targets = [
    `http://127.0.0.1:${p}/x`, `http://127.1:${p}/x`, `http://0.0.0.0:${p}/x`, `http://localhost:${p}/x`, `http://[::1]:${p}/x`,
    `http://2130706433:${p}/x`, `http://0x7f000001:${p}/x`, `http://[::ffff:127.0.0.1]:${p}/x`,
    'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.1/', 'http://192.168.0.1/'
  ]
  for (const url of targets) {
    const run = JSON.stringify(await testRun(probe.id, { url }).catch(error => (error as Error).message))
    expect(run, url).toContain('WORKFLOW_HTTP_DESTINATION_BLOCKED')
  }
  expect(listenerHits).toBe(0)
})

test('WF-L2: history redacts credentials, whatever key carries them', async () => {
  const probe = await build({ trigger: 'MANUAL' }, [
    { type: 'totalbase.finish-result', key: 'finish', configuration: { result: { note: '{{start.data.note}}', api_key: '{{start.data.api_key}}', x_custom_auth: '{{start.data.api_key}}', plain: '{{start.data.plain}}' } } }
  ], { history: 'DETAILED' })
  const secrets = { note: 'Bearer abcdefgh12345678secret', api_key: 'plain-credential-value-77' }
  const run = await testRun(probe.id, { ...secrets, plain: 'visible-value' })
  const runId = JSON.stringify(run).match(/"(?:id|run|runId)":"([0-9a-f-]{36})"/)![1]
  const history = JSON.stringify(await tool(lab.admin.mcpToken, 'get_workflow_runs', { run_id: runId, full: true }))
  expect(history).toContain('visible-value')
  for (const secret of Object.values(secrets)) expect(history).not.toContain(secret)
})
