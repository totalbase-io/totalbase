import { describe, expect, it } from 'vitest'
import { previewableType } from './previewable-type'

// Security regression (DataViews.md §8.4): openFile framed anything `image/*` but the exact `image/svg+xml` - a type
// with parameters (`image/svg+xml; charset=utf-8`) or another case framed an SVG, running its scripts on this origin.
describe('previewableType', () => {
  it('previews PDFs and raster pictures by their essence, and nothing else', () => {
    expect(previewableType('application/pdf')).toBe('application/pdf')
    expect(previewableType('IMAGE/PNG; name=x')).toBe('image/png')
    for (const type of ['image/svg+xml', 'image/svg+xml; charset=utf-8', 'Image/SVG+XML', 'text/html', 'image/x-icon', '']) {
      expect(previewableType(type), type).toBeNull()
    }
  })
})
