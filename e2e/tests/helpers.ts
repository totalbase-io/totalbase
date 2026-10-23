import type { Page } from '@playwright/test'

/** Shared across every ad-hoc repro/verification spec in this scratch project - see the chat: schema-drift fix, then the wide-fields widget survey. */
/** The instance under test - the dev server, or another one (the lab) with E2E_BASE_URL. */
export const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3050'
export const ADMIN_EMAIL = process.env.TOTALBASE_ADMIN_EMAIL ?? 'admin@totalbase.local'
export const ADMIN_PASSWORD = process.env.TOTALBASE_ADMIN_PASSWORD ?? '1234567'

export async function login(page: Page) {
  await page.goto('/admin/login')
  await page.getByLabel('Email').fill(ADMIN_EMAIL)
  await page.getByLabel('Password', { exact: true }).fill(ADMIN_PASSWORD)
  await page.getByRole('button', { name: 'Sign in' }).click()
  // The token, not the page's `load` event: a busy dev server can hold
  // `load` (every module of the home page) long after the sign-in worked.
  // An administrator lands on Status (/admin/status), an App user on /admin/app.
  await page.waitForURL(/\/admin\/(status|app)?\/?$/, { waitUntil: 'commit' })
  const handle = await page.waitForFunction(() => localStorage.getItem('totalbase_admin_token'), undefined, { timeout: 30_000 })
  const token = await handle.jsonValue()
  if (!token) throw new Error('Login did not produce a bearer token')
  return token
}

export async function apiRequest<T>(
  page: Page,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<T> {
  const send = () => page.request.fetch(`${BASE_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    data: body
  })
  // The dev server's rate limit (security.rate_limit_per_minute, a fixed
  // one-minute window per IP) is shared by the whole run: a 429 on a
  // fixture call waits for the window to roll over instead of failing.
  let response = await send()
  for (let attempt = 0; response.status() === 429 && attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 5_000))
    response = await send()
  }
  if (!response.ok()) {
    throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`)
  }
  const text = await response.text()
  if (!text) return undefined as T
  return JSON.parse(text).data as T
}

/**
 * DataViews are drafts until explicitly published (Foundations.md §13.1)
 * - the consumer pages (`/admin/dataviews/:slug`, `/new`, `/:pk/edit`)
 * render the live version, so publish whatever the test just set up first.
 */
export async function publishDataView(page: Page, token: string, dataviewId: string) {
  await apiRequest(page, token, 'POST', `/admin/api/dataviews/${dataviewId}/publish`)
}

/**
 * Collects what a UI flow must never produce: an uncaught page error, or an
 * API call answering 4xx/5xx. `expected` lists the failures a flow provokes
 * on purpose (a validation 400), as "<METHOD> <path regex>".
 */
export function watchApiFailures(page: Page, expected: RegExp[] = []) {
  const failures: string[] = []
  page.on('pageerror', (error) => { failures.push(`uncaught: ${error.message}`) })
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (!/\/(admin\/api|app\/api|api)\//.test(url.pathname) || response.status() < 400) return
    const line = `${response.request().method()} ${url.pathname}`
    if (expected.some(pattern => pattern.test(line))) return
    failures.push(`${line} -> ${response.status()}`)
  })
  return failures
}

/**
 * A PNG drawn on a canvas in the page: `fills` are rectangles painted in
 * order over a `width` x `height` image. Self-contained test images, no
 * fixture file on disk.
 */
export async function drawPng(
  page: Page,
  width: number,
  height: number,
  fills: { color: string, x: number, y: number, w: number, h: number }[]
): Promise<Buffer> {
  const base64 = await page.evaluate(({ width, height, fills }) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    for (const fill of fills) {
      context.fillStyle = fill.color
      context.fillRect(fill.x, fill.y, fill.w, fill.h)
    }
    return canvas.toDataURL('image/png').split(',')[1]!
  }, { width, height, fills })
  return Buffer.from(base64, 'base64')
}

/** 400x300, red top-left, green top-right, blue bottom-left, yellow bottom-right. */
export function quadrantsPng(page: Page) {
  return drawPng(page, 400, 300, [
    { color: '#ff0000', x: 0, y: 0, w: 200, h: 150 },
    { color: '#00ff00', x: 200, y: 0, w: 200, h: 150 },
    { color: '#0000ff', x: 0, y: 150, w: 200, h: 150 },
    { color: '#ffff00', x: 200, y: 150, w: 200, h: 150 }
  ])
}

/** An image's size and its top-left pixel, decoded by the page's own browser. */
export async function decodeImage(page: Page, image: Buffer, mimeType = 'image/png') {
  return page.evaluate(async ({ base64, mimeType }) => {
    const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }))
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return { width: bitmap.width, height: bitmap.height, r: r!, g: g!, b: b! }
  }, { base64: image.toString('base64'), mimeType })
}

/** Uploads a file through the Data API's files table; returns its id. */
export async function uploadFile(page: Page, token: string, name: string, buffer: Buffer, mimeType = 'image/png') {
  const response = await page.request.fetch(`${BASE_URL}/api/totalbase/table/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    multipart: { file: { name, mimeType, buffer }, visibility: 'PUBLIC' }
  })
  if (response.status() !== 201) throw new Error(`upload ${name} -> ${response.status()}: ${await response.text()}`)
  return ((await response.json()).data as { id: string }).id
}

export async function deleteFile(page: Page, token: string, id: string) {
  await page.request.fetch(`${BASE_URL}/api/totalbase/table/files/${id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` }
  })
}
