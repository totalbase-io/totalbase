import { describe, expect, it } from 'vitest'
import { computed } from 'vue'
import { evaluateFormula, loadFormulaFunctions } from '~/utils/formula-engine'

// Order matters: the first tests run before formula.js has ever loaded.
describe('formula functions load on first use', () => {
  it('evaluates templates, arithmetic and comparisons without loading formula.js', () => {
    expect(evaluateFormula('{{price}} * 2', { values: { price: 21 } })).toEqual({ ok: true, value: 42 })
    expect(evaluateFormula('{{qty}} > 3', { values: { qty: 5 } })).toEqual({ ok: true, value: true })
  })

  it('refuses an unknown function at once - no load needed to know it', () => {
    const result = evaluateFormula('NOPE(1)', { values: {} })
    expect(result.ok).toBe(false)
  })

  it('answers pending for a function call until formula.js arrives, then re-evaluates reactively', async () => {
    const rounded = computed(() => evaluateFormula('ROUND({{price}}, 1)', { values: { price: 3.14159 } }))
    expect(rounded.value).toEqual({ ok: true, value: null, pending: true })
    await loadFormulaFunctions()
    expect(rounded.value).toEqual({ ok: true, value: 3.1 })
  })

  it('works synchronously once loaded', () => {
    expect(evaluateFormula('IF({{n}} > 1, "many", "one")', { values: { n: 2 } })).toEqual({ ok: true, value: 'many' })
    expect(evaluateFormula('SUM(1, 2, 3)', { values: {} })).toEqual({ ok: true, value: 6 })
  })
})

describe('text from numbers and dates (T52)', () => {
  it('formats with a column displayFormat engine - no formula.js, the raw token untouched', () => {
    expect(evaluateFormula('FORMAT_NUMBER({{p}}, 2)', { values: { p: 18805.69 } })).toMatchObject({ ok: true, value: expect.stringMatching(/^18[.,]805[.,]69$/) })
    expect(evaluateFormula('FORMAT_NUMBER({{n}}, "0")', { values: { n: 3000 } })).toEqual({ ok: true, value: '3000' })
    expect(evaluateFormula('CURRENCY({{p}}, "usd")', { values: { p: 12.5 } })).toMatchObject({ ok: true, value: expect.stringMatching(/12[.,]50/) })
    expect(evaluateFormula('FORMAT_DATE({{d}}, "dd/MM/yyyy")', { values: { d: '2026-10-07' }, columnKinds: { d: 'date' } })).toEqual({ ok: true, value: '07/10/2026' })
    expect(evaluateFormula('FORMAT_NUMBER({{p}}, 2)', { values: { p: null } })).toEqual({ ok: true, value: '' })
    expect(evaluateFormula('{{p}}', { values: { p: 18805.69 } })).toEqual({ ok: true, value: 18805.69 })
    expect(evaluateFormula('CURRENCY({{p}})', { values: { p: 1 } }).ok).toBe(false)
  })
})

describe('a foreign key in a formula (Specification_DataViews.md §15.5)', () => {
  const values = { work_order: 'a1b2', technician: null }
  const foreignKeyText = { work_order: 'WO-1042' }
  const run = (source: string, returnType?: 'string' | 'boolean') => evaluateFormula(source, { values, foreignKeyText, returnType })

  it('shows as its row - alone, joined to text, in a function and in a format', () => {
    expect(run('{{work_order}}', 'string')).toEqual({ ok: true, value: 'WO-1042' })
    expect(run('"Order " + {{work_order}}', 'string')).toEqual({ ok: true, value: 'Order WO-1042' })
    expect(run('LOWER({{work_order}})', 'string')).toEqual({ ok: true, value: 'wo-1042' })
    expect(run('BOLD({{work_order}})', 'string')).toMatchObject({ ok: true, value: 'WO-1042' })
    expect(run('IF(true, {{work_order}}, "")', 'string')).toEqual({ ok: true, value: 'WO-1042' })
  })

  it('compares as its key', () => {
    expect(run('{{work_order}} == "a1b2"', 'boolean')).toEqual({ ok: true, value: true })
    expect(run('{{work_order}} == "WO-1042"', 'boolean')).toEqual({ ok: true, value: false })
  })

  it('an empty key stays empty, and a key with no text shows as itself', () => {
    expect(run('ISBLANK({{technician}})', 'boolean')).toMatchObject({ ok: true })
    expect(evaluateFormula('{{work_order}}', { values, returnType: 'string' })).toEqual({ ok: true, value: 'a1b2' })
  })
})
