import { expect, test, type Page } from '@playwright/test'
import { login } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Every admin screen, opened as an administrator: no uncaught error, no API
 * call answering 4xx/5xx. The net under API contract changes - a screen
 * still reading an old response shape fails here even when nothing else
 * covers it. Detail screens open the first entity of each kind found.
 */

const STATIC_PAGES = [
  '/',
  '/account',
  '/users',
  '/users/insights/activity',
  '/users/insights/sign-ins',
  '/roles',
  '/sessions',
  '/tokens',
  '/resources',
  '/dataviews',
  '/dashboards',
  '/workflows',
  '/templates',
  '/files',
  '/logs',
  '/sql-console',
  '/docs/endpoints',
  '/docs/openapi',
  '/app',
  ...[
    'system', 'connector', 'maintenance', 'smtp', 'auth', 'auth-providers', 'api-tokens', 'network', 'secrets', 'audit',
    'api', 'transactions', 'async-executions', 'openapi', 'dataviews', 'dashboards', 'files', 'workflows', 'sql-console'
  ].map(group => `/settings/${group}`)
]

const API = /\/(admin\/api|app\/api|api)\//

interface Problem { page: string, problem: string }

async function detailPages(page: Page, token: string): Promise<string[]> {
  const get = async <T>(path: string): Promise<T[]> => {
    const response = await page.request.get(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok()) throw new Error(`${path} -> ${response.status()}`)
    const body = await response.json()
    return Array.isArray(body.data) ? body.data : []
  }
  const first = async <T>(path: string) => (await get<T>(path))[0]

  const pages: string[] = []
  const user = await first<{ id: string }>('/api/totalbase/table/users?limit=1&fields=id')
  if (user) pages.push(`/users/${user.id}`)
  const role = await first<{ id: string }>('/api/totalbase/table/roles?limit=1&fields=id')
  if (role) pages.push(`/roles/${role.id}`)
  const template = await first<{ id: string }>('/api/totalbase/table/templates?limit=1&fields=id')
  if (template) pages.push(`/templates/${template.id}`)
  pages.push('/templates/system/user_invitation')

  const resources = await get<{ id: string, postgres_oid: number, type: string, status: string }>(
    '/api/totalbase/table/resources?fields=id,postgres_oid,type,status&where[status][_eq]=ACTIVE&where[schema][_eq]=public&limit=200'
  )
  const ofType = (type: string) => resources.find(r => r.type === type)
  const table = ofType('TABLE')
  if (table) pages.push(`/resources/${table.id}`, `/resources/${table.id}/data`, `/database/tables/${table.postgres_oid}`, `/database/tables/${table.postgres_oid}/data`)
  const view = ofType('VIEW')
  if (view) pages.push(`/database/views/${view.postgres_oid}`)
  const fn = ofType('FUNCTION')
  if (fn) pages.push(`/database/functions/${fn.postgres_oid}`)

  const dataview = await first<{ id: string }>('/admin/api/dataviews')
  if (dataview) pages.push(`/dataviews/${dataview.id}/design`, `/dataviews/${dataview.id}/settings`)
  const dashboard = await first<{ id: string }>('/admin/api/dashboards')
  if (dashboard) pages.push(`/dashboards/${dashboard.id}`)
  const workflow = await first<{ id: string }>('/admin/api/workflows')
  if (workflow) pages.push(`/workflows/${workflow.id}`)

  // The app portal: a published DataView and dashboard.
  const appDataview = await first<{ slug: string }>('/app/api/dataviews')
  if (appDataview) pages.push(`/app/dataviews/${appDataview.slug}`)
  const appDashboard = await first<{ slug: string }>('/app/api/dashboards')
  if (appDashboard) pages.push(`/app/dashboards/${appDashboard.slug}`)
  return pages
}

test('every admin screen opens without errors', async ({ page }) => {
  test.setTimeout(10 * 60_000)
  const token = await login(page)

  const problems: Problem[] = []
  let current = ''
  page.on('pageerror', error => problems.push({ page: current, problem: `uncaught: ${error.message}` }))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (!API.test(url.pathname) || response.status() < 400) return
    problems.push({ page: current, problem: `${response.request().method()} ${url.pathname}${url.search} -> ${response.status()}` })
  })

  for (const path of [...STATIC_PAGES, ...await detailPages(page, token)]) {
    current = path
    await page.goto(path)
    await page.waitForLoadState('networkidle')
    // An error boundary/toast counts too.
    const errorToast = page.getByRole('alert').filter({ hasText: /error|failed|not found/i })
    if (await errorToast.count()) problems.push({ page: path, problem: `alert: ${await errorToast.first().innerText()}` })
  }

  expect(problems, problems.map(p => `${p.page}: ${p.problem}`).join('\n')).toEqual([])
})
