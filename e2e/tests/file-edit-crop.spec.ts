import { test, expect } from '@playwright/test'
import { BASE_URL, decodeImage, deleteFile, login, quadrantsPng, uploadFile } from './helpers'

/**
 * Verifies the FileEditDrawer crop fix (see the chat): dragging a
 * selection over the cropper actually produces crop coordinates
 * matching what's visually selected. Two bugs were found and fixed
 * here in sequence:
 *   1. cropper-canvas has no explicit size by default and collapsed to
 *      a ~200x100 box (fixed with a global CSS rule sizing it before
 *      cropperjs's one-time layout pass).
 *   2. CropperSelection.x/y/width/height are in the canvas's own
 *      (letterboxed) screen-pixel space, not natural image pixels -
 *      applyCrop() now converts using the actual rendered <cropper-
 *      image> rect rather than trusting those numbers directly.
 *
 * The test image has four distinct color quadrants (red top-left,
 * green top-right, blue bottom-left, yellow bottom-right), so a crop
 * is verified by checking which color comes back - proof the backend
 * actually received the region the user visually selected, not just
 * that some numbers were produced.
 */
async function dragCropSelection(page: import('@playwright/test').Page, xFraction: number, yFraction: number) {
  const canvas = page.locator('cropper-canvas')
  await expect(canvas).toBeVisible()
  const canvasBox = await canvas.boundingBox()
  if (!canvasBox) throw new Error('cropper-canvas has no bounding box')

  // The fix's first bug, guarded here: the canvas must fill real space,
  // not collapse to cropperjs's bare 200x100 default minimum.
  expect(canvasBox.width).toBeGreaterThan(250)
  expect(canvasBox.height).toBeGreaterThan(150)

  const selection = page.locator('cropper-selection')
  const selectionBox = await selection.boundingBox()
  if (!selectionBox) throw new Error('cropper-selection has no bounding box')

  const fromX = selectionBox.x + selectionBox.width / 2
  const fromY = selectionBox.y + selectionBox.height / 2
  const toX = canvasBox.x + canvasBox.width * xFraction
  const toY = canvasBox.y + canvasBox.height * yFraction

  await page.mouse.move(fromX, fromY)
  await page.mouse.down()
  await page.mouse.move(toX, toY, { steps: 10 })
  await page.mouse.up()

  await page.getByRole('button', { name: 'Apply crop' }).click()
}

async function fetchCroppedTopLeftPixel(page: import('@playwright/test').Page, token: string, fileId: string) {
  const urlInput = page.locator('input[readonly]')
  const url = await urlInput.inputValue()
  const params = new URLSearchParams(new URL(url).search)
  const crop = {
    left: Number(params.get('cropLeft')),
    top: Number(params.get('cropTop')),
    width: Number(params.get('cropWidth')),
    height: Number(params.get('cropHeight'))
  }
  expect(crop.left).toBeGreaterThanOrEqual(0)
  expect(crop.top).toBeGreaterThanOrEqual(0)
  expect(crop.width).toBeGreaterThan(10)
  expect(crop.height).toBeGreaterThan(10)
  expect(crop.left + crop.width).toBeLessThanOrEqual(400)
  expect(crop.top + crop.height).toBeLessThanOrEqual(300)

  const contentResponse = await page.request.fetch(
    `${BASE_URL}/api/totalbase/table/files/${fileId}?${params.toString()}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  expect(contentResponse.ok()).toBeTruthy()
  const buffer = Buffer.from(await contentResponse.body())
  const { r, g, b } = await decodeImage(page, buffer, contentResponse.headers()['content-type'])
  return { r, g, b, crop }
}

let cleanup: (() => Promise<void>) | undefined
test.afterEach(async () => {
  await cleanup?.()
  cleanup = undefined
})

test('dragging toward the top-left crops the red quadrant', async ({ page }) => {
  const token = await login(page)
  const fileId = await uploadFile(page, token, 'quadrants-tl.png', await quadrantsPng(page))
  cleanup = () => deleteFile(page, token, fileId)

  await page.goto('/admin/files')
  await page.getByText('quadrants-tl.png').last().click()
  await page.getByRole('button', { name: 'Edit' }).last().click()
  await expect(page.getByRole('heading', { name: 'Edit quadrants-tl.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Crop', exact: true }).click()

  await dragCropSelection(page, 0.15, 0.15)

  const { r, g, b, crop } = await fetchCroppedTopLeftPixel(page, token, fileId)
  console.log('top-left drag ->', crop, { r, g, b })
  expect(crop.left).toBeLessThan(200)
  expect(crop.top).toBeLessThan(150)
  expect(r).toBeGreaterThan(180)
  expect(g).toBeLessThan(80)
  expect(b).toBeLessThan(80)
})

test('dragging toward the bottom-right crops the yellow quadrant', async ({ page }) => {
  const token = await login(page)
  const fileId = await uploadFile(page, token, 'quadrants-br.png', await quadrantsPng(page))
  cleanup = () => deleteFile(page, token, fileId)

  await page.goto('/admin/files')
  await page.getByText('quadrants-br.png').last().click()
  await page.getByRole('button', { name: 'Edit' }).last().click()
  await expect(page.getByRole('heading', { name: 'Edit quadrants-br.png' })).toBeVisible()
  await page.getByRole('button', { name: 'Crop', exact: true }).click()

  await dragCropSelection(page, 0.85, 0.85)

  const { r, g, b, crop } = await fetchCroppedTopLeftPixel(page, token, fileId)
  console.log('bottom-right drag ->', crop, { r, g, b })
  expect(crop.left).toBeGreaterThan(100)
  expect(crop.top).toBeGreaterThan(75)
  expect(r).toBeGreaterThan(180)
  expect(g).toBeGreaterThan(180)
  expect(b).toBeLessThan(80)
})
