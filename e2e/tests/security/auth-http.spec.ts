import { expect, test } from '@playwright/test'
import { BASE_URL } from '../helpers.js'
import { code, rest, seedLab, signIn, USER_PASSWORD, type Lab } from './lab.js'

/**
 * Authentication, tokens, sessions and HTTP hardening, attacked from outside (Security.md §2, §3; Foundations.md §4):
 * one answer for every refused sign-in, the account lockout, every reason a token stops working - taking effect on
 * the next request -, what a token can't do that a session can, the cookie, the headers, CORS, cross-site writes, the
 * Host header and error bodies.
 *
 * The run shares one address, and every 4xx of a sign-in route counts toward its per-IP limit
 * (security.rate_limit_sign_in_per_minute, 10): this file fails 7 sign-ins in all (the lockout lowered to 2 for its
 * test, then restored) and never trips the limit - tripped, it refuses correct passwords from that address for the
 * rest of its window (Security.md §2.4), and the files after this one couldn't sign in. hardening.test.ts covers the
 * limit in the integration suite, on addresses of its own. Run it twice a minute apart.
 */
test.describe.configure({ mode: 'serial' })

let lab: Lab
let lockoutBefore: unknown
test.beforeAll(async () => {
  lab = await seedLab('auth')
  lockoutBefore = (await rest('GET', '/admin/api/settings/auth', lab.admin.session)).data?.['auth.lockout_max_attempts']
})
test.afterAll(async () => {
  if (!lab) return
  await rest('PATCH', '/admin/api/settings/auth', lab.admin.session, { 'auth.lockout_max_attempts': typeof lockoutBefore === 'number' ? lockoutBefore : 5 }, { allowFail: true })
  await lab.cleanup()
})

const login = (email: unknown, password?: unknown, headers: Record<string, string> = {}) =>
  rest('POST', '/api/auth/login', null, { email, ...(password !== undefined && { password }) }, { raw: true, allowFail: true, headers })
const get = (token: string, path: string, headers: Record<string, string> = {}) => rest('GET', path, token, undefined, { allowFail: true, headers })
/** A fresh API token for a profile; `options` are the creation body's (allowedIps, ttlDays). */
async function newToken(userId: string, suffix: string, options: Record<string, unknown> = {}) {
  const { data } = await rest('POST', '/admin/api/tokens', lab.admin.session, { userId, name: `${lab.prefix}-${suffix}`, plane: 'API', ttlDays: 1, ...options })
  return { id: data.id as string, key: data.key as string }
}

test('a refused sign-in answers alike, whatever was wrong', async () => {
  const answers = [
    await login(lab.users.expert1.email, 'not-the-password'),
    await login(`${lab.prefix}-nobody@example.com`, 'not-the-password'),
    await login(lab.users.expert1.email)
  ]
  for (const answer of answers) {
    expect(answer.status).toBe(401)
    expect(answer.body.errors).toEqual([expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED', message: 'Invalid email or password.' })])
  }
  // Those wrong passwords went back once the right one came.
  expect((await login(lab.users.expert1.email, USER_PASSWORD)).status).toBe(200)
})

test('wrong passwords lock the account from this address, whatever the email\'s case; the right one is refused too', async () => {
  await rest('PATCH', '/admin/api/settings/auth', lab.admin.session, { 'auth.lockout_max_attempts': 2 })
  const email = lab.users.expert2.email
  for (const variant of [email, email.toUpperCase()]) expect((await login(variant, 'not-the-password')).status).toBe(401)
  expect(code(await login(email, USER_PASSWORD))).toBe('AUTHENTICATION_REQUIRED')
  // Another account from the same address is untouched.
  expect((await login(lab.users.prosecutor2.email, USER_PASSWORD)).status).toBe(200)
})

test('a token stops on the next request once revoked, deactivated, expired, its user deactivated or its roles gone', async () => {
  const admin = lab.admin.session
  const tokens = '/api/totalbase/table/tokens'
  const works = async (key: string) => (await get(key, lab.path.cases)).status

  const deactivated = await newToken(lab.users.prosecutor1.id, 'deactivated')
  expect(await works(deactivated.key)).toBe(200)
  await rest('PATCH', `${tokens}/${deactivated.id}`, admin, { active: false })
  expect(await works(deactivated.key)).toBe(401)

  const revoked = await newToken(lab.users.prosecutor1.id, 'revoked')
  await rest('PATCH', `${tokens}/${revoked.id}`, admin, { revoked_at: new Date().toISOString() })
  expect(await works(revoked.key)).toBe(401)

  // Expiry is time passing: set where only PostgreSQL's clock can be moved.
  const expired = await newToken(lab.users.prosecutor1.id, 'expired')
  await lab.sql(`UPDATE totalbase.tokens SET expires_at = now() - interval '1 minute' WHERE id = '${expired.id}'`)
  expect(await works(expired.key)).toBe(401)

  // Roles taken away, then given back: the same token, re-checked live.
  const p2 = lab.users.prosecutor2
  await rest('PUT', `/admin/api/users/${p2.id}/roles`, admin, { roleIds: [] })
  expect(await works(p2.token)).toBe(401)
  await rest('PUT', `/admin/api/users/${p2.id}/roles`, admin, { roleIds: [lab.roles.prosecutor] })
  expect(await works(p2.token)).toBe(200)

  // Its user deactivated: the token and the session both end.
  const e1Session = await signIn(lab.users.expert1.email, USER_PASSWORD)
  await rest('PATCH', `/api/totalbase/table/users/${lab.users.expert1.id}`, admin, { active: false })
  expect(await works(lab.users.expert1.token)).toBe(401)
  expect((await get(e1Session, '/api/auth/me')).status).toBe(401)
  await rest('PATCH', `/api/totalbase/table/users/${lab.users.expert1.id}`, admin, { active: true })
})

test('a token limited to an address is refused from any other, forwarded headers or not', async () => {
  const pinned = await newToken(lab.users.prosecutor1.id, 'pinned', { allowedIps: ['203.0.113.9'] })
  for (const headers of [{}, { 'x-forwarded-for': '203.0.113.9' }, { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, { 'x-real-ip': '203.0.113.9' }]) {
    expect(code(await get(pinned.key, lab.path.cases, headers)), JSON.stringify(headers)).toBe('TOKEN_IP_NOT_ALLOWED')
  }
  // An API token can't become an administrator's.
  const session = await lab.session('prosecutor1')
  expect(code(await rest('POST', '/api/tokens', session, { name: `${lab.prefix}-up`, plane: 'ADMIN', ttlDays: 1 }, { allowFail: true }))).toBe('PERMISSION_DENIED')
})

test('a token is a program: no password, email or token changes, no admin routes', async () => {
  const token = lab.users.coord.token
  const refused: [string, string, unknown, boolean?][] = [
    ['POST', '/api/auth/password/change', { currentPassword: USER_PASSWORD, newPassword: 'Another-Pass-2026!' }, true],
    ['PUT', '/app/api/me/email', { email: `${lab.prefix}-moved@example.com`, currentPassword: USER_PASSWORD }],
    ['PUT', '/app/api/me/password', { currentPassword: USER_PASSWORD, password: 'Another-Pass-2026!' }],
    ['POST', '/api/tokens', { name: `${lab.prefix}-more`, ttlDays: 1 }],
    ['POST', '/app/api/me/sessions/revoke-others', undefined]
  ]
  for (const [method, path, data, raw] of refused) {
    const response = await rest(method, path, token, data, { allowFail: true, raw })
    expect([401, 403], `${method} ${path} -> ${response.status}`).toContain(response.status)
  }
  for (const path of ['/admin/api/audit/logs', '/admin/api/sessions', '/admin/api/users']) expect((await get(token, path)).status, path).toBe(401)
  // The password still is what it was.
  expect((await login(lab.users.coord.email, USER_PASSWORD)).status).toBe(200)
})

test('the portal cookie: HttpOnly, SameSite=Lax, only from the same site; logout ends it', async () => {
  const sameSite = { 'sec-fetch-site': 'same-origin' }
  // A cookie session only for a request that says it's from this site: no login CSRF.
  const unsigned = await rest('POST', '/api/auth/login', null, { email: lab.users.prosecutor1.email, password: USER_PASSWORD, mode: 'session' }, { raw: true, allowFail: true })
  expect(code(unsigned)).toBe('CROSS_SITE_REQUEST_REFUSED')
  const signed = await rest('POST', '/api/auth/login', null, { email: lab.users.prosecutor1.email, password: USER_PASSWORD, mode: 'session' }, { raw: true, headers: sameSite })
  const cookie = signed.headers.get('set-cookie') ?? ''
  expect(cookie).toMatch(/tb_session=/)
  expect(cookie).toMatch(/HttpOnly/i)
  expect(cookie).toMatch(/SameSite=Lax/i)
  const jar = { cookie: cookie.split(';')[0]! }
  expect((await rest('GET', '/api/auth/me', null, undefined, { headers: jar })).status).toBe(200)
  // A write with the cookie from another site, or with no sign of where it came from, is refused.
  for (const headers of [{ ...jar }, { ...jar, origin: 'https://evil.example.com', 'sec-fetch-site': 'cross-site' }]) {
    const forged = await rest('PATCH', '/app/api/me', null, { name: 'x' }, { allowFail: true, headers })
    expect(code(forged)).toBe('CROSS_SITE_REQUEST_REFUSED')
  }
  expect((await rest('POST', '/api/auth/logout', null, undefined, { allowFail: true, headers: { ...jar, ...sameSite } })).status).toBeLessThan(300)
  expect((await rest('GET', '/api/auth/me', null, undefined, { allowFail: true, headers: jar })).status).toBe(401)
})

test('every answer carries the security headers; CORS never answers *; errors leak no SQL or stack', async () => {
  const answer = await fetch(`${BASE_URL}/api/auth/me`, { headers: { origin: 'https://evil.example.com' } })
  const headers = answer.headers
  expect(headers.get('x-content-type-options')).toBe('nosniff')
  expect(headers.get('referrer-policy')).toBeTruthy()
  expect(headers.get('cross-origin-opener-policy')).toBe('same-origin')
  expect(headers.get('cache-control')).toBe('no-store')
  expect(headers.get('access-control-allow-origin')).toBeNull()
  const preflight = await fetch(`${BASE_URL}${lab.path.cases}`, { method: 'OPTIONS', headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'GET' } })
  expect(preflight.headers.get('access-control-allow-origin')).not.toBe('*')
  expect(preflight.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com')

  const token = lab.users.prosecutor1.token
  const broken = [
    await fetch(`${BASE_URL}${lab.path.cases}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{"data": {' }),
    await fetch(`${BASE_URL}${lab.path.cases}?where[number][_eq]=x'%3B%20DROP%20TABLE%20x--`, { headers: { authorization: `Bearer ${token}` } }),
    await fetch(`${BASE_URL}${lab.path.cases}/not-a-uuid`, { headers: { authorization: `Bearer ${token}` } }),
    await fetch(`${BASE_URL}/api/public/table/no_such_table`, { headers: { authorization: `Bearer ${token}` } })
  ]
  for (const response of broken) {
    const text = await response.text()
    expect(text, text).not.toMatch(/\bSELECT\b|\bFROM\s+"|\bat\s+\S+\.(js|ts):\d+|node_modules|stack/i)
  }
  for (const path of ['/files/../../etc/passwd', '/files/..%2f..%2fetc%2fpasswd', '/assets/../../etc/passwd']) {
    const response = await fetch(`${BASE_URL}${path}`)
    expect(await response.text(), path).not.toContain('root:')
  }
  expect((await fetch(`${BASE_URL}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'x'.repeat(6 * 1024 * 1024) }) })).status).toBe(413)
})

test('links never come from the Host header; OAuth refuses an unknown provider and a forged state', async () => {
  const forgot = await fetch(`${BASE_URL}/api/auth/password/forgot`, { method: 'POST', headers: { 'content-type': 'application/json', host: 'evil.example.com', 'x-forwarded-host': 'evil.example.com' }, body: JSON.stringify({ email: lab.users.prosecutor1.email }) })
  expect(forgot.status).toBe(204)
  expect(forgot.headers.get('location')).toBeNull()
  const unknown = await fetch(`${BASE_URL}/api/auth/oauth/no-such-provider?redirect_to=https://evil.example.com/`, { redirect: 'manual' })
  expect(unknown.status).toBe(404)
  expect(unknown.headers.get('location')).toBeNull()
  const callback = await fetch(`${BASE_URL}/api/auth/oauth/no-such-provider/callback?state=forged&code=x`, { redirect: 'manual' })
  expect(callback.headers.get('location') ?? '').not.toContain('evil.example.com')
  expect(callback.status).toBeGreaterThanOrEqual(400)
})
