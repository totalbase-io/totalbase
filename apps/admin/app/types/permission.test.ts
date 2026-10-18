import { describe, expect, it } from 'vitest'
import { isValidColorValue, roleColorShade } from './permission'

describe('item colors', () => {
  it('takes a Nuxt UI semantic color as the theme\'s own - a lane colored info is no longer transparent (B55)', () => {
    expect(isValidColorValue('info')).toBe(true)
    expect(roleColorShade('info', 'light')).toBe('var(--ui-info)')
    expect(roleColorShade('neutral', 'dark')).toBe('var(--ui-color-neutral-400)')
  })
  it('keeps palette names and hex, and refuses anything else', () => {
    expect(isValidColorValue('blue')).toBe(true)
    expect(roleColorShade('#3a7bd5', 'light')).toBe('#3a7bd5')
    expect(isValidColorValue('EN_VIAJE')).toBe(false)
    expect(roleColorShade('EN_VIAJE', 'light')).toBe('transparent')
  })
})
