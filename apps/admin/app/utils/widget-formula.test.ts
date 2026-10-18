import { beforeAll, describe, expect, it } from 'vitest'
import { loadFormulaFunctions } from '~/utils/formula-engine'
import { evaluateWidgetFormula } from '~/utils/widget-formula'

const scope = {
  vars: {
    total: { kind: 'VALUE', value: 1500 },
    cliente: { kind: 'RESOURCE', data: { razon_social: 'ACME SA' } },
    estado: { kind: 'VALUE', value: 'late' }
  },
  slot: { item: { label: 'General' }, index: 2 }
}

describe('evaluateWidgetFormula()', () => {
  beforeAll(() => loadFormulaFunctions())

  it('reads dotted variable and slot tokens as plain values', () => {
    expect(evaluateWidgetFormula('{{vars.total.value}} * 2', scope, 'number')).toBe(3000)
    expect(evaluateWidgetFormula('CONCATENATE("Cliente: ", {{vars.cliente.data.razon_social}})', scope, 'string')).toBe('Cliente: ACME SA')
    expect(evaluateWidgetFormula('{{slot.item.label}}', scope, 'string')).toBe('General')
    expect(evaluateWidgetFormula('{{slot.index}} + 1', scope, 'number')).toBe(3)
  })

  it('reads a variable alone as what it holds', () => {
    expect(evaluateWidgetFormula('{{vars.total}} > 1000', scope, 'boolean')).toBe(true)
  })

  it('gives undefined for a formula that does not evaluate, null for a missing variable', () => {
    expect(evaluateWidgetFormula('{{vars.total.value}} *', scope, 'number')).toBeUndefined()
    expect(evaluateWidgetFormula('{{vars.nada.value}} == null', scope, 'boolean')).toBe(true)
  })
})

// An option list's field bound to a formula (PropBinding "option"): once per option, its fields as {{campo}}.
describe('evaluateWidgetFormula() over an option\'s row', () => {
  it('reads the option\'s fields as plain tokens, and the page as vars', () => {
    const vars = { cliente: { data: { cuenta: false } } }
    expect(evaluateWidgetFormula('{{saldo}} < 0 ? "error" : "success"', { vars, row: { saldo: -5 } }, 'string')).toBe('error')
    expect(evaluateWidgetFormula('CONCATENATE({{codigo}}, " - ", {{descripcion}})', { vars, row: { codigo: 'ACE-9', descripcion: 'Aceite' } }, 'string')).toBe('ACE-9 - Aceite')
    expect(evaluateWidgetFormula('AND({{id}} == 5, NOT({{vars.cliente.data.cuenta}}))', { vars, row: { id: 5 } }, 'boolean')).toBe(true)
    expect(evaluateWidgetFormula('AND({{id}} == 5, NOT({{vars.cliente.data.cuenta}}))', { vars, row: { id: 1 } }, 'boolean')).toBe(false)
  })
})

// Another widget's state (Specification_DataViews.md §9.1): {{controls.<name>.*}}.
describe('evaluateWidgetFormula() over the page\'s widgets', () => {
  it('reads a widget\'s state by its name - {{controls.x}} alone its value', () => {
    const controls = { selectCliente: { value: 7, item: { id: 7, numero_documento: '30-71234567-9' } }, tabla: { row: null } }
    expect(evaluateWidgetFormula('{{controls.selectCliente.item.numero_documento}}', { vars: {}, controls }, 'string')).toBe('30-71234567-9')
    expect(evaluateWidgetFormula('{{controls.selectCliente}} == 7', { vars: {}, controls }, 'boolean')).toBe(true)
    expect(evaluateWidgetFormula('{{controls.tabla.row.id}} == null', { vars: {}, controls }, 'boolean')).toBe(true)
    expect(evaluateWidgetFormula('{{controls.nada.item.id}} == null', { vars: {}, controls }, 'boolean')).toBe(true)
  })
})
