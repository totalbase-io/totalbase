import { describe, expect, it } from 'vitest'
import { columnStyleClass, valueLinkHref } from './table-column-style'

describe('valueLinkHref', () => {
  it('builds mailto/tel links and defaults a bare host to https', () => {
    expect(valueLinkHref('email', 'a@b.test')).toBe('mailto:a@b.test')
    expect(valueLinkHref('tel', '+54 11')).toBe('tel:+54 11')
    expect(valueLinkHref('url', 'example.com')).toBe('https://example.com')
    expect(valueLinkHref('url', 'http://example.com')).toBe('http://example.com')
  })
})

describe('column style', () => {
  it('maps font and weight to classes', () => {
    expect(columnStyleClass({ fontSize: 'lg', bold: true, mono: true }, false)).toBe('text-lg font-semibold tabular-nums font-mono')
    expect(columnStyleClass({}, true)).toBe('text-sm tabular-nums')
  })
})
