import { describe, expect, it } from 'vitest'
import { TOOLTIP_TEXT_MAX, tooltipText } from './tooltip-text'

describe('tooltipText()', () => {
  it('keeps a short text and cuts a long one with …', () => {
    expect(tooltipText('Artículo 1')).toBe('Artículo 1')
    expect(tooltipText(null)).toBe('')
    const long = tooltipText('x'.repeat(5000))
    expect(long).toHaveLength(TOOLTIP_TEXT_MAX + 1)
    expect(long.endsWith('…')).toBe(true)
  })
})
