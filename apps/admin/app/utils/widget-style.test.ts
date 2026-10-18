import { describe, expect, it } from 'vitest'
import { COMMON_STYLE_PROPS, WIDGET_COLORS } from '@totalbase/tb-catalog'
import { optionGridClass, optionIconColor, widgetStyleClasses } from '~/utils/widget-style'

describe('widgetStyleClasses()', () => {
  it('turns each Style value into its classes, none for unset', () => {
    expect(widgetStyleClasses({ marginTop: 'm', border: 'muted', background: 'primary', align: 'center' }))
      .toEqual(['mt-4', 'border border-default', 'bg-primary/10', 'text-center'])
    expect(widgetStyleClasses({})).toEqual([])
    expect(widgetStyleClasses({ marginTop: 'huge', padding: 3 })).toEqual([])
  })
  it('has classes for every value the catalog offers', () => {
    for (const [prop, meta] of Object.entries(COMMON_STYLE_PROPS)) {
      for (const option of meta.options) expect(widgetStyleClasses({ [prop]: option }), `${prop}=${option}`).toHaveLength(1)
    }
  })
})

describe('optionIconColor()', () => {
  it('gives every theme color a class, and nothing for anything else', () => {
    for (const color of WIDGET_COLORS) expect(optionIconColor(color)).toMatch(/^text-/)
    expect(optionIconColor('purple')).toBeUndefined()
    expect(optionIconColor(null)).toBeUndefined()
  })
})

describe('optionGridClass()', () => {
  it('gives 1 to 6 columns a grid, two per row on a phone from 2 up', () => {
    expect(optionGridClass('3')).toBe('grid gap-2 grid-cols-2 md:grid-cols-3')
    expect(optionGridClass('1')).toBe('grid gap-2 grid-cols-1')
    expect(optionGridClass('7')).toBeUndefined()
    expect(optionGridClass(undefined)).toBeUndefined()
  })
})
