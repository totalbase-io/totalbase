import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { evaluateFormula } from '~/utils/formula-engine'
import { temporalColumnKinds } from './formula-column-kinds'

const field = (columnName: string, displayFormatKind?: string) =>
  ({ kind: 'COLUMN', columnName, config: displayFormatKind ? { displayFormatKind } : {} }) as unknown as DataViewField

describe('temporalColumnKinds()', () => {
  it('keeps date/time/datetime columns only - never numeric ones', () => {
    const fields = [field('placed_at', 'datetime'), field('birth_date', 'date'), field('opens_at', 'time'), field('price', 'number'), field('name')]
    expect(temporalColumnKinds(fields)).toEqual({ placed_at: 'datetime', birth_date: 'date', opens_at: 'time' })
  })

  it('lets a layout formula read a numeric column (regression: "$" + {{price}} rendered just "$")', () => {
    const fields = [field('price', 'number')]
    const result = evaluateFormula('"$" + {{price}}', { values: { price: '129.00' }, columnKinds: temporalColumnKinds(fields), returnType: 'string' })
    expect(result).toEqual({ ok: true, value: '$129.00' })
  })
})
