import { describe, expect, it } from 'vitest'
import { reshare, shareField, shareSum } from './widget-item-shares'

describe('widget item shares', () => {
  const span = shareField(['span'])!
  const size = shareField(['size', 'minSize'])!

  it('knows which field carries the share', () => {
    expect(shareField(['icon'])).toBeNull()
    expect(span).toMatchObject({ key: 'span', total: 12 })
    expect(size).toMatchObject({ key: 'defaultSize', total: 100 })
  })

  it('reshares a Columns row to 12, in proportion, never under one column', () => {
    const items = [{ value: 'a', span: 4 }, { value: 'b', span: 4 }, { value: 'c', span: 4 }]
    expect(reshare(items, 0, 6, span).map(i => i.span)).toEqual([6, 3, 3])
    expect(reshare(items, 0, 12, span).map(i => i.span)).toEqual([10, 1, 1])
    expect(reshare(items, 2, 0, span).map(i => i.span)).toEqual([6, 5, 1])
    expect(shareSum(reshare(items, 1, 7, span), span)).toBe(12)
  })

  it('gives a new column an even share and the remainder to the last other', () => {
    const items = [{ value: 'a', span: 6 }, { value: 'b', span: 6 }, { value: 'c' }]
    const next = reshare(items, 2, Math.round(12 / 3), span)
    expect(next.map(i => i.span)).toEqual([4, 4, 4])
    expect(reshare([...next, { value: 'd' }], 3, 3, span).map(i => i.span)).toEqual([3, 3, 3, 3])
  })

  it('keeps a Splitter panel above its minimum', () => {
    const items = [{ value: 'l', defaultSize: 40, minSize: 20 }, { value: 'r', defaultSize: 60, minSize: 20 }]
    expect(reshare(items, 0, 90, size).map(i => i.defaultSize)).toEqual([80, 20])
    expect(reshare(items, 0, 5, size).map(i => i.defaultSize)).toEqual([20, 80])
  })

  it('leaves the items as they are when the index is out of range', () => {
    expect(reshare([{ value: 'a', span: 12 }], 3, 4, span)).toEqual([{ value: 'a', span: 12 }])
  })
})
