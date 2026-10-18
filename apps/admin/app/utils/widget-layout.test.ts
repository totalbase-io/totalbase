import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { areaWidgets, dropIndex, sizableHeight, slotHasWidgets, widgetCellStyle } from '~/utils/widget-layout'

const field = (id: string, parent: string | null, slot: string | undefined, order: number, width = 12, height = 1): DataViewField =>
  ({ id, kind: 'WIDGET', parent, config: slot ? { slot } : {}, gridX: 0, gridY: order, gridW: width, gridH: height }) as unknown as DataViewField

describe('areaWidgets()', () => {
  it('gives an area its own widgets in order', () => {
    const fields = [field('b', null, undefined, 1), field('a', null, undefined, 0), field('c', 'card', 'footer', 0), field('d', 'card', 'header', 0), field('h', null, 'header', 0)]
    expect(areaWidgets(fields, null, undefined).map(f => f.id)).toEqual(['a', 'b'])
    // The page's header is an area of its own.
    expect(areaWidgets(fields, null, 'header').map(f => f.id)).toEqual(['h'])
    expect(areaWidgets(fields, 'card', 'footer').map(f => f.id)).toEqual(['c'])
  })
})

describe('slotHasWidgets()', () => {
  it('counts a per-item slot\'s items', () => {
    const fields = [field('x', 'tabs', 'content:general', 0)]
    expect(slotHasWidgets(fields, 'tabs', 'content', true)).toBe(true)
    expect(slotHasWidgets(fields, 'tabs', 'content', false)).toBe(false)
  })
})

describe('layout', () => {
  it('gives a widget its width in columns, and a sizable one its height in rows', () => {
    expect(widgetCellStyle(field('a', null, undefined, 0, 6))).toEqual({ 'grid-column': 'span 6 / span 6' })
    expect(sizableHeight(field('m', null, undefined, 0, 12, 8))).toBe(320)
    expect(sizableHeight(field('m', null, undefined, 0, 12, 1))).toBe(240)
  })
})

describe('dropIndex()', () => {
  // Two widgets side by side (6/12 each) on the first row, one full width below.
  const boxes = [
    { left: 0, top: 0, width: 100, height: 40 },
    { left: 110, top: 0, width: 100, height: 40 },
    { left: 0, top: 50, width: 210, height: 40 }
  ]
  it('lands before a widget in its left half, after it in its right half', () => {
    expect(dropIndex(boxes, 20, 20)).toBe(0)
    expect(dropIndex(boxes, 80, 20)).toBe(1)
    expect(dropIndex(boxes, 190, 20)).toBe(2)
  })
  it('lands before a row the pointer is above, and at the end below them all', () => {
    expect(dropIndex(boxes, 190, 45)).toBe(2)
    expect(dropIndex(boxes, 20, 200)).toBe(3)
    expect(dropIndex([], 0, 0)).toBe(0)
  })
})
