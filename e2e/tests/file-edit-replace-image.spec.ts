import { test, expect } from '@playwright/test'
import { decodeImage, deleteFile, drawPng, login, quadrantsPng, uploadFile } from './helpers'

let cleanup: (() => Promise<void>) | undefined
test.afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test('Replace image swaps the file content for a completely different picture', async ({ page }) => {
  const token = await login(page)
  const fileId = await uploadFile(page, token, 'replace-target.png', await quadrantsPng(page))
  cleanup = () => deleteFile(page, token, fileId)
  const solidPurple = await drawPng(page, 100, 100, [{ color: '#a020f0', x: 0, y: 0, w: 100, h: 100 }])

  await page.goto('/admin/files')
  await page.getByText('replace-target.png').last().click()
  await page.getByRole('button', { name: 'Edit' }).last().click()
  await expect(page.getByRole('heading', { name: 'Edit replace-target.png' })).toBeVisible()

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: 'Replace image' }).click()
  ])
  await chooser.setFiles({ name: 'solid-purple.png', mimeType: 'image/png', buffer: solidPurple })

  await expect(page.getByText('Replace image?')).toBeVisible()
  await expect(page.getByText('solid-purple.png')).toBeVisible()
  await page.getByLabel('Confirm').check()
  await page.getByRole('button', { name: 'Replace', exact: true }).click()

  await expect(page.getByText('File replaced', { exact: true })).toBeVisible()

  const contentResponse = await page.request.fetch(
    `http://localhost:3050/api/totalbase/table/files/${fileId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  expect(contentResponse.ok()).toBeTruthy()
  const image = await decodeImage(page, Buffer.from(await contentResponse.body()), contentResponse.headers()['content-type'])

  // The original quadrants image was 400x300; the replacement is a
  // distinctly different solid-color 100x100 image - a size or color
  // match here would mean the replace never actually took effect.
  expect(image.width).toBe(100)
  expect(image.height).toBe(100)
  expect(image.r).toBeGreaterThan(100)
  expect(image.b).toBeGreaterThan(100)
  expect(image.g).toBeLessThan(60)
})
