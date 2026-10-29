import { expect as baseExpect, test, type Page } from '@playwright/test'
import { login, sessionToken, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * Every write action of the Settings area, driven through the real UI:
 * settings groups (save a value, restore it), secrets, auth providers,
 * system emails, templates and My account (as a fixture administrator,
 * never the real admin). The API is only used to set up, re-read and
 * clean up fixtures.
 */

// The dev server compiles a route on its first visit, and other specs share it.
const expect = baseExpect.configure({ timeout: 15_000 })
test.describe.configure({ timeout: 90_000 })

const SUFFIX = Math.random().toString(36).slice(2, 8)
const BASE = BASE_URL

/** One API call with a bearer token - PUT included, the status kept. */
async function api<T = unknown>(page: Page, token: string, method: string, path: string, data?: unknown): Promise<T> {
  const response = await page.request.fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(data !== undefined && { data: { data } })
  })
  if (!response.ok()) throw new Error(`${method} ${path} -> ${response.status()}: ${await response.text()}`)
  const text = await response.text()
  return (text ? JSON.parse(text).data : undefined) as T
}

async function toast(page: Page, title: string) {
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible()
}

// --- Settings groups ---------------------------------------------------

/** A settings page's one Save, in its footer while edits are pending. */
const saveButton = (page: Page) => page.getByRole('button', { name: 'Save', exact: true })

interface SettingCase { route: string, group: string, key: string }
const NUMBER_SETTINGS: SettingCase[] = [
  { route: 'auth', group: 'auth', key: 'auth.lockout_duration_minutes' },
  { route: 'api', group: 'api', key: 'api.max_offset' },
  { route: 'dashboards', group: 'dashboards', key: 'dashboards.query_timeout_ms' },
  { route: 'dataviews', group: 'dataviews', key: 'dataviews.gantt_max_bars' },
  { route: 'workflows', group: 'workflows', key: 'workflows.history_detailed_retention_days' },
  { route: 'workflows', group: 'workflows', key: 'workflows.max_chain_depth' },
  { route: 'sql-console', group: 'sql_console', key: 'sql_console.history_retention_days' }
]

interface SchemaField { key: string, label: string, default?: unknown }

for (const setting of NUMBER_SETTINGS) {
  test(`settings: change and restore ${setting.key}`, async ({ page }) => {
    const token = await login(page)
    const failures = watchApiFailures(page)
    const shortKey = setting.key.slice(setting.group.length + 1)
    const original = (await api<Record<string, number>>(page, token, 'GET', `/admin/api/settings/${setting.group}`))[setting.key]!
    const schema = await api<{ fields: SchemaField[] }>(page, token, 'GET', `/admin/api/settings/${setting.group}/schema`)
    const field = schema.fields.find(f => f.key === setting.key)!
    const changed = original + 1

    try {
      await page.goto(`/settings/${setting.route}`)
      const row = page.locator(`#setting-${setting.key.replaceAll('.', '-')}`)
      const input = row.getByRole('spinbutton', { name: field.label })
      await expect(input).toHaveValue(String(original))
      await input.fill(String(changed))
      await expect(row.getByText('Unsaved')).toBeVisible()
      await saveButton(page).click()
      await toast(page, 'Setting saved')
      expect((await api<Record<string, number>>(page, token, 'GET', `/admin/api/settings/${setting.group}`))[setting.key]).toBe(changed)
      await expect(row.getByText('Modified')).toBeVisible()

      // Back to what it was: Restore default when it was the default,
      // the original value typed back otherwise.
      if (original === field.default) {
        await row.getByRole('button', { name: 'Restore default' }).click()
        await expect(input).toHaveValue(String(original))
      } else {
        await input.fill(String(original))
      }
      await saveButton(page).click()
      await expect(saveButton(page)).toHaveCount(0)
      expect((await api<Record<string, number>>(page, token, 'GET', `/admin/api/settings/${setting.group}`))[setting.key]).toBe(original)
    } finally {
      const now = (await api<Record<string, number>>(page, token, 'GET', `/admin/api/settings/${setting.group}`))[setting.key]
      if (now !== original) {
        if (original === field.default) await api(page, token, 'DELETE', `/admin/api/settings/${setting.group}/${shortKey}`)
        else await api(page, token, 'PATCH', `/admin/api/settings/${setting.group}`, { [shortKey]: original })
      }
    }
    expect(failures).toEqual([])
  })
}

test('settings: a toggled boolean saves with the page and toggles back', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const key = 'auth.email_changed_email_enabled'
  const read = async () => (await api<Record<string, boolean>>(page, token, 'GET', '/admin/api/settings/auth'))[key]
  const original = await read()
  try {
    await page.goto('/settings/auth')
    const toggle = page.locator(`#setting-${key.replaceAll('.', '-')}`).getByRole('switch', { name: 'Email changed notice' })
    await toggle.click()
    await saveButton(page).click()
    await toast(page, 'Setting saved')
    await expect.poll(read).toBe(!original)
    await toggle.click()
    await saveButton(page).click()
    await expect.poll(read).toBe(original)
  } finally {
    if (await read() !== original) await api(page, token, 'PATCH', '/admin/api/settings/auth', { email_changed_email_enabled: original })
  }
  expect(failures).toEqual([])
})

test('settings: an invalid value shows the server message under the field', async ({ page }) => {
  await login(page)
  const failures = watchApiFailures(page, [/^PATCH \/admin\/api\/settings\/sql_console$/])
  await page.goto('/settings/sql-console')
  const row = page.locator('#setting-sql_console-history_retention_days')
  const input = row.getByRole('spinbutton')
  const before = await input.inputValue()
  await input.fill('-5')
  await saveButton(page).click()
  await expect(row.locator('p.text-error')).toBeVisible()
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(input).toHaveValue(before)
  expect(failures).toEqual([])
})

test('settings: several edits save together with one Save, and Cancel drops them', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const keys = ['workflows.history_detailed_retention_days', 'workflows.max_chain_depth'] as const
  const read = () => api<Record<string, number>>(page, token, 'GET', '/admin/api/settings/workflows')
  const original = await read()
  const patches: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && request.url().includes('/admin/api/settings/')) patches.push(request.url())
  })
  try {
    await page.goto('/settings/workflows')
    const inputs = keys.map(key => page.locator(`#setting-${key.replaceAll('.', '-')}`).getByRole('spinbutton'))
    for (const [i, key] of keys.entries()) await inputs[i]!.fill(String(original[key]! + 1))
    await expect(page.getByText('2 unsaved changes')).toBeVisible()
    // Nothing is written before Save.
    expect(patches).toEqual([])

    await saveButton(page).click()
    await toast(page, '2 settings saved')
    expect(patches).toHaveLength(1)
    const saved = await read()
    for (const key of keys) expect(saved[key]).toBe(original[key]! + 1)

    // Cancel puts back the saved value without writing anything.
    await inputs[0]!.fill('7')
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(inputs[0]!).toHaveValue(String(original[keys[0]]! + 1))
    await expect(saveButton(page)).toHaveCount(0)
    expect(patches).toHaveLength(1)
  } finally {
    await api(page, token, 'PATCH', '/admin/api/settings/workflows', Object.fromEntries(keys.map(key => [key.slice('workflows.'.length), original[key]])))
  }
  expect(failures).toEqual([])
})

test('settings: the default role for self-registration is picked from the roles it accepts', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const key = 'auth.registration_default_role'
  const read = async () => (await api<Record<string, string>>(page, token, 'GET', '/admin/api/settings/auth'))[key]
  const original = await read()
  // It depends on self-registration: held until that switch is on.
  const registration = (await api<Record<string, unknown>>(page, token, 'GET', '/admin/api/settings/auth'))['auth.registration_enabled']
  if (!registration) await api(page, token, 'PATCH', '/admin/api/settings/auth', { registration_enabled: true })
  const role = await api<{ id: string, name: string }>(page, token, 'POST', '/api/totalbase/table/roles', { name: `ui-settings ${SUFFIX}`, api_access: true })
  try {
    await page.goto('/settings/auth')
    const row = page.locator(`#setting-${key.replaceAll('.', '-')}`)
    const picker = row.getByRole('button', { name: 'Default role for self-registration' })
    await picker.click()
    // Administrators is reserved: never offered.
    await expect(page.getByRole('option', { name: 'Administrators' })).toHaveCount(0)
    await page.getByRole('option', { name: role.name }).click()
    await saveButton(page).click()
    await toast(page, 'Setting saved')
    await expect.poll(read).toBe(role.id)

    await picker.click()
    await page.getByRole('option', { name: 'None', exact: true }).click()
    await saveButton(page).click()
    await expect.poll(read).toBe('')
  } finally {
    if (await read() !== original) {
      if (original) await api(page, token, 'PATCH', '/admin/api/settings/auth', { registration_default_role: original })
      else await api(page, token, 'DELETE', '/admin/api/settings/auth/registration_default_role')
    }
    if (!registration) await api(page, token, 'DELETE', '/admin/api/settings/auth/registration_enabled')
    await api(page, token, 'DELETE', `/api/totalbase/table/roles/${role.id}`)
  }
  expect(failures).toEqual([])
})

test('settings: SMTP\'s tests wait for a saved host and sender', async ({ page }) => {
  const token = await login(page)
  const smtp = await api<Record<string, unknown>>(page, token, 'GET', '/admin/api/settings/smtp')
  // Configured, they're enabled: the next test presses one.
  test.skip(!!smtp['smtp.host'] && !!smtp['smtp.from'], 'SMTP is configured on this instance')
  // Without them the server would answer 409 SMTP_NOT_CONFIGURED: the buttons don't offer it.
  await page.goto('/settings/smtp')
  await expect(page.getByRole('button', { name: 'Send test email' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Test connection' })).toBeDisabled()
})

test('settings: SMTP "Test connection" reports the relay without sending', async ({ page }) => {
  const token = await login(page)
  const smtp = await api<Record<string, unknown>>(page, token, 'GET', '/admin/api/settings/smtp')
  test.skip(!smtp['smtp.host'] || !smtp['smtp.from'], 'SMTP is not configured on this instance')
  // The dev relay may or may not be reachable (502 SMTP_CONNECTION_FAILED) -
  // both answers are what the button is there to show.
  const failures = watchApiFailures(page, [/^POST \/admin\/api\/settings\/mail\/verify$/])
  await page.goto('/settings/smtp')
  const verify = page.waitForResponse(r => r.url().endsWith('/admin/api/settings/mail/verify') && r.request().method() === 'POST')
  await page.getByRole('button', { name: 'Test connection' }).click()
  const response = await verify
  expect([204, 502]).toContain(response.status())
  await toast(page, response.status() === 204 ? 'Connection works' : 'Connection failed')
  expect(failures).toEqual([])
})

// --- Secrets -----------------------------------------------------------

interface SecretMetadata { key: string, createdAt: string, updatedAt: string }

test('secrets: create, replace the value, delete', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const key = `ui-settings.secret-${SUFFIX}`
  const find = async () => (await api<SecretMetadata[]>(page, token, 'GET', '/admin/api/secrets')).find(s => s.key === key)
  try {
    await page.goto('/settings/secrets')
    // The header's, and on an instance with no secret yet the empty state's too - both open the same form.
    await page.getByRole('button', { name: 'New secret' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Key').fill(key)
    await dialog.getByRole('textbox', { name: 'Value' }).fill('first-value')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await toast(page, 'Secret created')
    await expect(page.getByText(key, { exact: true })).toBeVisible()
    const created = await find()
    expect(created).toBeDefined()

    await page.waitForTimeout(20)
    await page.getByRole('button', { name: `Actions for ${key}` }).click()
    await page.getByRole('menuitem', { name: 'Replace' }).click()
    await expect(page.getByRole('dialog')).toContainText(`Replace secret: ${key}`)
    await page.getByRole('dialog').getByRole('textbox', { name: 'Value' }).fill('second-value')
    await page.getByRole('dialog').getByRole('button', { name: 'Save' }).click()
    await toast(page, 'Secret replaced')
    await expect.poll(async () => (await find())?.updatedAt).not.toBe(created!.updatedAt)

    await page.getByRole('button', { name: `Actions for ${key}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const del = page.getByRole('dialog')
    await expect(del.getByRole('button', { name: 'Delete' })).toBeDisabled()
    await del.getByRole('checkbox').click()
    await del.getByRole('button', { name: 'Delete' }).click()
    await toast(page, 'Secret deleted')
    await expect(page.getByText(key, { exact: true })).toHaveCount(0)
    expect(await find()).toBeUndefined()
  } finally {
    if (await find()) await api(page, token, 'DELETE', `/admin/api/secrets/${encodeURIComponent(key)}`)
  }
  expect(failures).toEqual([])
})

// --- Auth providers ----------------------------------------------------

interface AuthProvider { id: string, name: string, enabled: boolean, configuration: { client_id: string, client_secret_key: string, allowed_redirect_urls: string[] } }

test('auth providers: create, edit, disable/enable, copy redirect URI, delete', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write'])
  const token = await login(page)
  const failures = watchApiFailures(page)
  const secretKey = `ui-settings.oauth-${SUFFIX}`
  const name = `UI Settings GH ${SUFFIX}`
  const renamed = `UI Settings GH2 ${SUFFIX}`
  const providers = () => api<AuthProvider[]>(page, token, 'GET', '/admin/api/auth-providers')
  const mine = async () => (await providers()).find(p => p.name === name || p.name === renamed)
  await api(page, token, 'PUT', `/admin/api/secrets/${encodeURIComponent(secretKey)}`, { value: 'client-secret-value' })
  let providerId: string | undefined
  try {
    await page.goto('/settings/auth-providers')
    await page.getByRole('button', { name: 'New provider' }).first().click()
    const wizard = page.getByRole('dialog')
    await wizard.getByRole('button', { name: 'GitHub' }).click()
    // Step 2 - Configuration.
    await wizard.getByLabel('Name').fill(name)
    await wizard.getByRole('button', { name: 'Next' }).click()
    // Step 3 - Credentials & access.
    await wizard.getByLabel('Client ID').fill(`client-${SUFFIX}`)
    await wizard.getByLabel('Client secret').click()
    await page.getByRole('option', { name: secretKey }).click()
    const redirects = wizard.getByLabel('Allowed redirect URLs')
    await redirects.fill('https://app.example.com/callback')
    await redirects.press('Enter')
    await wizard.getByRole('button', { name: 'Save' }).click()
    await toast(page, 'Provider created')

    const created = await mine()
    expect(created).toMatchObject({ name, enabled: true })
    expect(created!.configuration).toMatchObject({ client_id: `client-${SUFFIX}`, client_secret_key: secretKey, allowed_redirect_urls: ['https://app.example.com/callback'] })
    providerId = created!.id

    // Edit: rename, open from the row.
    await page.getByText(name, { exact: true }).click()
    const edit = page.getByRole('dialog')
    await expect(edit).toContainText('Edit provider')
    const uri = edit.getByRole('textbox', { name: 'Redirect URI', exact: true })
    await expect(uri).toHaveValue(/\/api\/auth\/oauth\/.+\/callback$/)
    await edit.getByRole('button', { name: 'Copy redirect URI' }).click()
    await toast(page, 'Copied')
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await uri.inputValue())
    await edit.getByLabel('Name').fill(renamed)
    await edit.getByRole('button', { name: 'Save' }).click()
    await toast(page, 'Provider updated')
    expect((await mine())!.name).toBe(renamed)

    // Disable from the card's switch, enable from its menu.
    await page.getByRole('switch', { name: `Disable ${renamed}` }).click()
    await toast(page, 'Provider disabled')
    await expect.poll(async () => (await mine())!.enabled).toBe(false)
    await page.getByRole('button', { name: `Actions for ${renamed}` }).click()
    await page.getByRole('menuitem', { name: 'Enable' }).click()
    await toast(page, 'Provider enabled')
    await expect.poll(async () => (await mine())!.enabled).toBe(true)

    // Delete from the menu.
    await page.getByRole('button', { name: `Actions for ${renamed}` }).click()
    await page.getByRole('menuitem', { name: 'Delete' }).click()
    const del = page.getByRole('dialog')
    await del.getByRole('checkbox').click()
    await del.getByRole('button', { name: 'Delete' }).click()
    await toast(page, 'Provider deleted')
    expect((await providers()).some(p => p.id === providerId)).toBe(false)
    providerId = undefined
  } finally {
    if (providerId) await api(page, token, 'DELETE', `/admin/api/auth-providers/${providerId}`).catch(() => undefined)
    await api(page, token, 'DELETE', `/admin/api/secrets/${encodeURIComponent(secretKey)}`)
  }
  expect(failures).toEqual([])
})

// --- System emails -----------------------------------------------------

interface SystemEmail { overridden: boolean, enabled: boolean | null, template: { subject: string, html: string, text: string } }

test('system emails: edit, preview, save, toggle sending, restore default', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const slot = 'email_changed'
  const read = () => api<SystemEmail>(page, token, 'GET', `/admin/api/system-emails/${slot}`)
  const before = await read()
  test.skip(before.overridden, 'This email is already customized - restoring it would drop real content.')
  const subject = `UI Settings ${SUFFIX} - {{instance.name}} email changed`
  try {
    await page.goto(`/templates/system/${slot}`)
    const subjectInput = page.getByLabel('Subject')
    await expect(subjectInput).toHaveValue(before.template.subject)
    await subjectInput.fill(subject)
    await expect(page.getByText('Unsaved')).toBeVisible()

    // Preview renders the unsaved draft, sends nothing.
    await page.getByRole('button', { name: 'Preview' }).click()
    const preview = page.getByRole('dialog')
    await expect(preview).toContainText(`UI Settings ${SUFFIX} -`)
    await expect(preview.locator('iframe[title="Email preview"]')).toBeVisible()
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await toast(page, 'Email saved')
    const saved = await read()
    expect(saved.overridden).toBe(true)
    expect(saved.template.subject).toBe(subject)

    // Sending on/off (auth.email_changed_email_enabled), and back.
    if (before.enabled !== null) {
      await page.getByRole('button', { name: before.enabled ? 'Sending' : 'Off', exact: true }).click()
      await expect.poll(async () => (await read()).enabled).toBe(!before.enabled)
      await page.getByRole('button', { name: before.enabled ? 'Off' : 'Sending', exact: true }).click()
      await expect.poll(async () => (await read()).enabled).toBe(before.enabled)
    }

    await page.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: 'Restore default…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Restore default' }).click()
    await toast(page, 'Default restored')
    await expect(subjectInput).toHaveValue(before.template.subject)
    expect((await read()).overridden).toBe(false)
  } finally {
    if ((await read()).overridden) await api(page, token, 'DELETE', `/admin/api/system-emails/${slot}`)
    const enabled = (await read()).enabled
    if (before.enabled !== null && enabled !== before.enabled) {
      await api(page, token, 'PATCH', '/admin/api/settings/auth', { email_changed_email_enabled: before.enabled })
    }
  }
  expect(failures).toEqual([])
})

// --- Templates ---------------------------------------------------------

const TEMPLATES = '/api/totalbase/table/templates'
interface TemplateRow { id: string, name: string, slug: string, kind: string, content: { subject?: string, message?: string } | null }

async function createTemplateThroughUi(page: Page, kind: 'Email' | 'PDF', name: string) {
  await page.goto('/templates')
  await page.getByRole('button', { name: 'New template' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: kind }).click()
  await dialog.getByLabel('Name', { exact: true }).fill(name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await page.waitForURL(/\/templates\/[0-9a-f-]{36}$/)
  return page.url().split('/').pop()!
}

async function deleteTemplateThroughUi(page: Page) {
  await page.getByRole('button', { name: 'Actions' }).click()
  await page.getByRole('menuitem', { name: 'Delete…' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: 'Confirm' }).click()
  await dialog.getByRole('button', { name: 'Delete' }).click()
  await toast(page, 'Template deleted')
  await page.waitForURL(/\/templates$/)
}

test('templates: create an email template, edit details and content, delete', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const name = `UI Settings Mail ${SUFFIX}`
  let id: string | undefined
  try {
    id = await createTemplateThroughUi(page, 'Email', name)
    const row = await api<TemplateRow>(page, token, 'GET', `${TEMPLATES}/${id}`)
    expect(row).toMatchObject({ name, kind: 'MAILING' })

    // Content.
    await page.getByRole('textbox', { name: 'Subject' }).fill(`Hello ${SUFFIX}`)
    const editor = page.locator('[contenteditable="true"]').first()
    await editor.click()
    await page.keyboard.type(`Body ${SUFFIX}`)
    await expect(page.getByText('Unsaved')).toBeVisible()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await toast(page, 'Template saved')
    const saved = await api<TemplateRow>(page, token, 'GET', `${TEMPLATES}/${id}`)
    expect(saved.content?.subject).toBe(`Hello ${SUFFIX}`)
    expect(saved.content?.message).toContain(`Body ${SUFFIX}`)

    // Details (name/description).
    await page.getByRole('button', { name: 'Actions' }).click()
    await page.getByRole('menuitem', { name: 'Details…' }).click()
    const details = page.getByRole('dialog')
    await details.getByLabel('Description').fill('Edited by the UI settings spec')
    await details.getByRole('button', { name: 'Save' }).click()
    await expect(details).toHaveCount(0)
    expect((await api<TemplateRow & { description: string }>(page, token, 'GET', `${TEMPLATES}/${id}`)).description).toBe('Edited by the UI settings spec')

    await deleteTemplateThroughUi(page)
    const left = await page.request.fetch(`${BASE}${TEMPLATES}/${id}`, { headers: { Authorization: `Bearer ${token}` } })
    expect(left.status()).toBe(404)
    id = undefined
  } finally {
    if (id) await api(page, token, 'DELETE', `${TEMPLATES}/${id}`).catch(() => undefined)
  }
  expect(failures).toEqual([])
})

test('templates: create a PDF template, preview it, save, delete', async ({ page }) => {
  test.setTimeout(60_000)
  const token = await login(page)
  const failures = watchApiFailures(page)
  const name = `UI Settings PDF ${SUFFIX}`
  let id: string | undefined
  try {
    id = await createTemplateThroughUi(page, 'PDF', name)
    expect(await api<TemplateRow>(page, token, 'GET', `${TEMPLATES}/${id}`)).toMatchObject({ name, kind: 'PDF' })

    // The designer (pdfme) mounts after the page - Preview reads its template.
    const preview = page.getByRole('dialog')
    await expect(async () => {
      await page.getByRole('button', { name: 'Preview' }).click()
      await expect(preview.locator('iframe[title="PDF preview"]')).toBeVisible({ timeout: 5_000 })
    }).toPass({ timeout: 40_000 })
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await toast(page, 'Template saved')

    await deleteTemplateThroughUi(page)
    id = undefined
  } finally {
    if (id) await api(page, token, 'DELETE', `${TEMPLATES}/${id}`).catch(() => undefined)
  }
  expect(failures).toEqual([])
})

// --- My account (a fixture administrator) -------------------------------

const AVATAR_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nGM4YWREU8QwasGoBaMWjFowasGoBaMWjFowasGoBaMWDBULAA6hsD2HZzNxAAAAAElFTkSuQmCC', 'base64')

test.describe('my account', () => {
  const email = `ui-settings-${SUFFIX}@example.com`
  const password = 'ui-settings-password-1'
  const newPassword = 'ui-settings-password-2'
  let userId: string | undefined

  test('a fixture admin changes name, preferences, avatar, sessions and password', async ({ page, browser }) => {
    test.setTimeout(90_000)
    const adminToken = await login(page)
    const roles = await api<Array<{ id: string, name: string }>>(page, adminToken, 'GET', '/api/totalbase/table/roles?fields=id,name&limit=500')
    const adminRole = roles.find(r => r.name === 'Administrators')!
    userId = (await api<{ id: string }>(page, adminToken, 'POST', '/admin/api/users', { email, name: 'UI Settings Account', password, roleIds: [adminRole.id] })).id

    const userContext = await browser.newContext()
    const me = await userContext.newPage()
    try {
      await me.goto('/login')
      await me.getByLabel('Email').fill(email)
      await me.getByLabel('Password', { exact: true }).fill(password)
      await me.getByRole('button', { name: 'Sign in' }).click()
      await me.waitForURL(/\/(status|app)?\/?$/, { waitUntil: 'commit' })
      const token = await sessionToken(me)
      const failures = watchApiFailures(me)
      const account = () => api<{ name: string, avatarUrl: string | null }>(me, token, 'GET', '/app/api/me')

      // --- Name ---
      await me.goto('/account')
      await me.getByLabel('Name').fill(`UI Settings Renamed ${SUFFIX}`)
      await me.getByRole('button', { name: 'Save', exact: true }).click()
      await toast(me, 'Profile saved')
      expect((await account()).name).toBe(`UI Settings Renamed ${SUFFIX}`)

      // --- Avatar upload and remove ---
      await me.locator('input[type="file"]').setInputFiles({ name: 'avatar.png', mimeType: 'image/png', buffer: AVATAR_PNG })
      await expect.poll(async () => (await account()).avatarUrl).not.toBeNull()
      await me.getByRole('button', { name: 'Remove' }).click()
      await expect.poll(async () => (await account()).avatarUrl).toBeNull()

      // --- Preferences ---
      const prefs = () => api<{ preferences: Record<string, string | null> }>(me, token, 'GET', '/app/api/me/preferences')
      await me.getByRole('tab', { name: 'Preferences' }).click()
      // Found by its country's name.
      await me.getByLabel('Regional format').click()
      await me.keyboard.type('India')
      await me.getByRole('option', { name: /^India ·/ }).click()
      await expect.poll(async () => (await prefs()).preferences.regionalFormat).toBe('en-IN')
      const timezone = me.getByLabel('Timezone')
      if (await timezone.isEnabled()) {
        await timezone.click()
        await me.keyboard.type('Asia/Tokyo')
        await me.getByRole('option', { name: 'Asia/Tokyo' }).click()
        await expect.poll(async () => (await prefs()).preferences.timezone).toBe('Asia/Tokyo')
      }
      await me.getByLabel('Regional format').click()
      await me.getByRole('option', { name: /^Instance default/ }).click()
      await expect.poll(async () => (await prefs()).preferences.regionalFormat ?? null).toBeNull()

      // --- Sessions: revoke one, then every other ---
      const other1 = await me.request.post(`${BASE}/api/auth/login`, { data: { email, password } })
      const other2 = await me.request.post(`${BASE}/api/auth/login`, { data: { email, password } })
      const tokenOf = async (r: typeof other1) => { const b = await r.json(); return (b.token ?? b.data?.token) as string }
      const [token1, token2] = [await tokenOf(other1), await tokenOf(other2)]
      const alive = async (t: string) => (await me.request.get(`${BASE}/app/api/me`, { headers: { Authorization: `Bearer ${t}` } })).status() === 200
      expect(await alive(token1)).toBe(true)
      await me.getByRole('tab', { name: 'Sessions' }).click()
      const otherRow = me.getByRole('row').filter({ has: me.getByRole('button', { name: 'Session actions' }) }).filter({ hasNotText: 'This session' }).first()
      await otherRow.getByRole('button', { name: 'Session actions' }).click()
      await me.getByRole('menuitem', { name: 'Revoke' }).click()
      await toast(me, 'Session revoked')
      expect([await alive(token1), await alive(token2)].filter(Boolean)).toHaveLength(1)
      await me.getByRole('button', { name: 'Sign out other sessions' }).click()
      await toast(me, 'Signed out of your other sessions')
      expect(await alive(token1)).toBe(false)
      expect(await alive(token2)).toBe(false)
      expect(await alive(token)).toBe(true)

      // --- Password ---
      await me.getByRole('tab', { name: 'Profile' }).click()
      await me.getByRole('button', { name: 'Change password' }).click()
      const modal = me.getByRole('dialog')
      await modal.getByLabel('Current password').fill(password)
      await modal.getByLabel('New password').fill(newPassword)
      await modal.getByLabel('Confirm password').fill(newPassword)
      await modal.getByRole('button', { name: 'Save' }).click()
      await expect(modal).toHaveCount(0)
      expect((await me.request.post(`${BASE}/api/auth/login`, { data: { email, password: newPassword } })).ok()).toBe(true)
      expect(await alive(token)).toBe(true)

      expect(failures).toEqual([])
    } finally {
      await userContext.close()
    }
  })

  test.afterAll(async ({ browser }) => {
    if (!userId) return
    const page = await browser.newPage()
    const token = await login(page)
    await api(page, token, 'DELETE', `/admin/api/users/${userId}`)
    await page.close()
  })
})
