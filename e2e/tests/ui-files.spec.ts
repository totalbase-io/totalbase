import { expect, test, type Page } from '@playwright/test'
import { apiRequest, login, watchApiFailures } from './helpers.js'
import { BASE_URL } from './helpers'

/**
 * The Files explorer's rename and move (Administration.md
 * §10.12), driven through the real UI. The API only sets up the fixtures
 * (two folders, two text files) and re-reads what a flow saved; cleanup
 * deletes the files, then the folders, by id.
 */

const SUFFIX = Math.random().toString(36).slice(2, 8)
const FOLDER_A = `ui-files-a-${SUFFIX}`
const FOLDER_B = `ui-files-b-${SUFFIX}`

interface FileRow { id: string, name: string, extension: string, folder: string | null }

const fixture: { folders: string[], files: string[] } = { folders: [], files: [] }

async function uploadText(page: Page, token: string, name: string, folder: string): Promise<string> {
  const response = await page.request.fetch(`${BASE_URL}/api/totalbase/table/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    multipart: { file: { name, mimeType: 'text/plain', buffer: Buffer.from(`content of ${name}`) }, folder }
  })
  if (response.status() !== 201) throw new Error(`upload ${name} -> ${response.status()}: ${await response.text()}`)
  return ((await response.json()).data as { id: string }).id
}

function fileInfo(page: Page, token: string, id: string) {
  return apiRequest<FileRow>(page, token, 'GET', `/api/totalbase/table/files/${id}/info`)
}

async function openFolder(page: Page, name: string) {
  await page.goto('/files')
  await page.locator('aside').getByRole('button', { name, exact: true }).click()
}

test.describe.configure({ mode: 'serial', timeout: 120_000 })

test.beforeAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE_URL })
  const token = await login(page)
  for (const name of [FOLDER_A, FOLDER_B]) {
    const folder = await apiRequest<{ id: string }>(page, token, 'POST', '/api/totalbase/table/folders', { data: { name } })
    fixture.folders.push(folder.id)
  }
  fixture.files.push(await uploadText(page, token, 'draft.txt', fixture.folders[0]!))
  fixture.files.push(await uploadText(page, token, 'second.txt', fixture.folders[0]!))
  await page.close()
})

test.afterAll(async ({ browser }) => {
  const page = await browser.newPage({ baseURL: BASE_URL })
  const token = await login(page)
  for (const id of fixture.files) {
    await apiRequest(page, token, 'DELETE', `/api/totalbase/table/files/${id}`).catch(() => undefined)
  }
  for (const id of fixture.folders) {
    await apiRequest(page, token, 'DELETE', `/api/totalbase/table/folders/${id}`).catch(() => undefined)
  }
  await page.close()
})

test('rename a file and move it to another folder from its details', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)
  const [fileId] = fixture.files as [string]

  await openFolder(page, FOLDER_A)
  const main = page.locator('main')
  await main.getByText('draft.txt', { exact: true }).click()
  const details = page.getByRole('dialog', { name: 'draft.txt' })

  // Rename: a popover with the name; the extension follows it.
  await details.getByRole('button', { name: 'Rename' }).click()
  const name = page.getByLabel('Name', { exact: true })
  await expect(name).toHaveValue('draft.txt')
  await name.fill('final notes.md')
  await page.getByRole('button', { name: 'Rename', exact: true }).last().click()
  await expect.poll(async () => (await fileInfo(page, token, fileId)).name).toBe('final notes.md')
  expect((await fileInfo(page, token, fileId)).extension).toBe('md')
  await expect(main.getByText('final notes.md', { exact: true })).toBeVisible()

  // The metadata PATCH's envelope (regression: the explorer sent a bare
  // body, so a description or tags save changed nothing).
  const renamedDetails = page.getByRole('dialog', { name: 'final notes.md' })
  await renamedDetails.getByLabel('Description').fill('kept')
  await renamedDetails.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(async () => (await apiRequest<{ description: string | null }>(page, token, 'GET', `/api/totalbase/table/files/${fileId}/info`)).description).toBe('kept')

  // Move: a modal with the folders by path. The details now carry the new name.
  await renamedDetails.getByRole('button', { name: 'Move to folder…' }).click()
  const move = page.getByRole('dialog', { name: 'Move to folder' })
  await move.getByLabel('Folder').click()
  await page.getByRole('option', { name: `/${FOLDER_B}`, exact: true }).click()
  await move.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(move).toBeHidden()
  await expect.poll(async () => (await fileInfo(page, token, fileId)).folder).toBe(fixture.folders[1])
  // It left the folder on screen.
  await expect(main.getByText('final notes.md', { exact: true })).toBeHidden()
  expect(failures).toEqual([])
})

test('move several selected files at once', async ({ page }) => {
  const token = await login(page)
  const failures = watchApiFailures(page)

  // folder B now holds the renamed file; bring the other one there first.
  await apiRequest(page, token, 'PATCH', `/api/totalbase/table/files/${fixture.files[1]}`, { data: { folder: fixture.folders[1] } })
  await openFolder(page, FOLDER_B)
  const main = page.locator('main')
  await main.getByRole('checkbox', { name: 'Select final notes.md' }).click()
  await main.getByRole('checkbox', { name: 'Select second.txt' }).click()
  await page.getByRole('button', { name: 'Move to folder…' }).click()
  const move = page.getByRole('dialog', { name: 'Move 2 files' })
  await move.getByLabel('Folder').click()
  await page.getByRole('option', { name: `/${FOLDER_A}`, exact: true }).click()
  await move.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(move).toBeHidden()
  for (const id of fixture.files) {
    await expect.poll(async () => (await fileInfo(page, token, id)).folder).toBe(fixture.folders[0])
  }
  await expect(main.getByText('second.txt', { exact: true })).toBeHidden()
  expect(failures).toEqual([])
})
