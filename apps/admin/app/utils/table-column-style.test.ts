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

// Security regression (DataViews.md §15.2): a URL link kept any `scheme://` text - `javascript://...` ran on a click.
describe('a URL link is only ever http(s)', () => {
  it('turns any other scheme, hidden by spaces or control characters or not, into an https address', () => {
    for (const text of ['javascript://x%0Afetch(1)', 'JaVaScRiPt://x', ' javascript://x', '\tjava\nscript://x', 'data://text/html,x', 'vbscript://x']) {
      expect(valueLinkHref('url', text).startsWith('https://'), text).toBe(true)
    }
    expect(valueLinkHref('url', 'https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
  })
})
