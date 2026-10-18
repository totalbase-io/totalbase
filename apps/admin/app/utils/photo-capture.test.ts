import { describe, expect, it } from 'vitest'
import { aspectRatio, cropGeometry, outputSize, photoFileName } from './photo-capture'

describe('photo capture', () => {
  it('reads a crop shape', () => {
    expect(aspectRatio('3:4')).toBe(0.75)
    expect(aspectRatio('1:1')).toBe(1)
    expect(aspectRatio('original')).toBeNull()
  })

  it('covers the frame and crops the part it shows', () => {
    // A 4000x3000 landscape photo behind a 300x400 portrait frame: scaled to the frame's height, centered.
    const image = { width: 4000, height: 3000 }
    const frame = { width: 300, height: 400 }
    const scale = 400 / 3000
    const centered = cropGeometry(image, frame, 1, { x: (300 - 4000 * scale) / 2, y: 0 })
    expect(centered.scale).toBeCloseTo(scale)
    expect(centered.source.height).toBeCloseTo(3000)
    expect(centered.source.width).toBeCloseTo(2250)
    expect(centered.source.x).toBeCloseTo(875)
  })

  it('never leaves the frame uncovered, however far it is dragged', () => {
    const geometry = cropGeometry({ width: 1000, height: 1000 }, { width: 200, height: 200 }, 2, { x: 500, y: -5000 })
    expect(geometry.offset.x).toBe(0)
    expect(geometry.offset.y).toBe(200 - 1000 * 0.4)
  })

  it('scales down to the largest side, never up', () => {
    expect(outputSize({ width: 3000, height: 4000 }, 1600)).toEqual({ width: 1200, height: 1600 })
    expect(outputSize({ width: 600, height: 800 }, 1600)).toEqual({ width: 600, height: 800 })
  })

  it('names the file after when it was taken', () => {
    expect(photoFileName(new Date(2026, 9, 5, 14, 30, 12))).toBe('photo-20261005-143012.jpg')
  })
})
