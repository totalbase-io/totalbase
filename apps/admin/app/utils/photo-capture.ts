/**
 * What the Camera widget (TCamera, DataViews.md §9.9) does to a
 * photo before storing it: crop it to a shape, scale it down, compress it.
 * The geometry is pure and tested; `renderPhoto` draws it on a canvas.
 */
import type { CAMERA_ASPECTS } from '@totalbase/tb-catalog'

export type CameraAspect = (typeof CAMERA_ASPECTS)[number]

/** `3:4` → 0.75 (width / height); null for `original` - no crop. */
export function aspectRatio(aspect: CameraAspect | string | null | undefined): number | null {
  const match = /^(\d+):(\d+)$/.exec(aspect ?? '')
  return match ? Number(match[1]) / Number(match[2]) : null
}

/**
 * The crop stage: an image of `image` size shown behind a frame of `frame`
 * size, scaled to cover the frame times `zoom` (1 = just covers it) and
 * moved by `offset` (the image's top-left inside the frame, clamped so the
 * frame stays covered). Answers the clamped offset and the part of the
 * image the frame shows, in image pixels.
 */
export function cropGeometry(
  image: { width: number, height: number },
  frame: { width: number, height: number },
  zoom: number,
  offset: { x: number, y: number }
) {
  const scale = Math.max(frame.width / image.width, frame.height / image.height) * Math.max(1, zoom)
  const shown = { width: image.width * scale, height: image.height * scale }
  const clamp = (value: number, min: number) => Math.min(0, Math.max(min, value))
  const x = clamp(offset.x, frame.width - shown.width)
  const y = clamp(offset.y, frame.height - shown.height)
  return {
    scale,
    offset: { x, y },
    source: { x: -x / scale, y: -y / scale, width: frame.width / scale, height: frame.height / scale }
  }
}

/** The output size: `source` scaled down so its longest side is at most `maxSize` - never up. */
export function outputSize(source: { width: number, height: number }, maxSize: number) {
  const factor = Math.min(1, maxSize / Math.max(source.width, source.height))
  return { width: Math.max(1, Math.round(source.width * factor)), height: Math.max(1, Math.round(source.height * factor)) }
}

/** Draws `source` of `image` at most `maxSize` on its longest side, as a JPEG of `quality`. */
export async function renderPhoto(
  image: CanvasImageSource & { width: number, height: number },
  source: { x: number, y: number, width: number, height: number },
  maxSize: number,
  quality: number
): Promise<Blob> {
  const size = outputSize(source, maxSize)
  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No canvas to draw the photo on.')
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, source.x, source.y, source.width, source.height, 0, 0, size.width, size.height)
  const q = Math.min(1, Math.max(0.1, quality))
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The photo could not be encoded.'))), 'image/jpeg', q))
}

/** `photo-20261005-143012.jpg` - the stored file's name. */
export function photoFileName(date = new Date(), stem = 'photo', extension = 'jpg'): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${stem}-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${extension}`
}
