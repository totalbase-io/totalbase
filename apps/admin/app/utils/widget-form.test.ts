import { describe, expect, it } from 'vitest'
import type { DataViewField } from '~/types/dataview'
import { boundErrors, columnDecimals, fieldName, formFields, inputColumn, patternErrors, requiredErrors, toFieldErrors } from '~/utils/widget-form'

let y = 0
const widget = (id: string, name: string, parent: string | null, config: Record<string, unknown> = {}): DataViewField =>
  ({ id, kind: 'WIDGET', widget: name, parent, config: parent ? { slot: 'default', ...config } : config, gridX: 0, gridY: y++, gridW: 12, gridH: 1 }) as unknown as DataViewField

describe('form fields', () => {
  const fields = [
    widget('form', 'UForm', null),
    widget('card', 'UCard', 'form'),
    widget('f1', 'UFormField', 'card', { props: { label: 'Cliente' } }),
    widget('i1', 'USelectMenu', 'f1', { bindings: { modelValue: { kind: 'variable', variable: 'cliente' } } }),
    widget('f2', 'UFormField', 'form', { props: { name: 'fecha_emision' } }),
    widget('i2', 'UInputDate', 'f2', { bindings: { modelValue: { kind: 'variable', variable: 'fecha' } } }),
    widget('inner', 'UForm', 'form'),
    widget('f3', 'UFormField', 'inner'),
    widget('free', 'UFormField', null)
  ]

  it('finds a form\'s fields at any depth, never those of a nested form', () => {
    expect(formFields(fields, 'form').map(f => f.id)).toEqual(['f1', 'f2'])
  })

  it('names a field by its Name, else its input\'s variable', () => {
    expect(fieldName(fields, fields[2]!)).toBe('cliente')
    expect(fieldName(fields, fields[4]!)).toBe('fecha_emision')
    expect(fieldName(fields, fields[8]!)).toBeNull()
  })

  it('binds a field to the record\'s column: its input edits it, and it names the field unless a Name does', () => {
    const bound = [
      widget('f', 'UFormField', null, { props: { column: 'razon_social' } }),
      widget('i', 'UInput', 'f'),
      widget('g', 'UFormField', null, { props: { column: 'cuit', name: 'documento' } })
    ]
    expect(inputColumn(bound, bound[1]!)).toBe('razon_social')
    expect(inputColumn(fields, fields[3]!)).toBeNull()
    expect(fieldName(bound, bound[0]!)).toBe('razon_social')
    expect(fieldName(bound, bound[2]!)).toBe('documento')
  })
})

describe('requiredErrors()', () => {
  it('flags required fields with no value - null, empty text, an empty list', () => {
    const required = [{ name: 'a', required: true }, { name: 'b', required: true }, { name: 'c', required: true }, { name: 'd', required: false }, { name: 'e', required: true }]
    expect(requiredErrors(required, { a: null, b: '  ', c: [], d: null, e: 0 })).toEqual([
      { field: 'a', message: 'Required' },
      { field: 'b', message: 'Required' },
      { field: 'c', message: 'Required' }
    ])
  })
})

describe('patternErrors()', () => {
  it('checks the whole value against the Pattern, with its message', () => {
    const fields = [{ name: 'cuit', pattern: '[0-9]{11}', patternMessage: 'Eleven digits.', column: [] }]
    expect(patternErrors(fields, { cuit: '20123456789' })).toEqual([])
    expect(patternErrors(fields, { cuit: '20-12345678-9' })).toEqual([{ field: 'cuit', message: 'Eleven digits.' }])
    expect(patternErrors(fields, { cuit: 'x20123456789' })).toEqual([{ field: 'cuit', message: 'Eleven digits.' }])
  })

  it('checks the column\'s CHECK patterns anywhere in the value, with the constraint\'s message', () => {
    const fields = [{ name: 'code', column: [{ source: '[0-9]', flags: 's', message: null }, { source: '^[A-Z]', flags: 's', message: 'Starts with a capital.' }] }]
    expect(patternErrors(fields, { code: 'Ab1' })).toEqual([])
    expect(patternErrors(fields, { code: 'Abc' })).toEqual([{ field: 'code', message: 'Invalid format' }])
    expect(patternErrors(fields, { code: 'ab1' })).toEqual([{ field: 'code', message: 'Starts with a capital.' }])
  })

  it('leaves empty and non-text values alone', () => {
    const fields = [{ name: 'a', pattern: '[0-9]+', column: [] }, { name: 'b', pattern: '[0-9]+', column: [] }, { name: 'c', pattern: '[0-9]+', column: [] }]
    expect(patternErrors(fields, { a: '', b: null, c: 12 })).toEqual([])
  })
})

describe('toFieldErrors()', () => {
  it('reads the API envelope, a bare list, or nothing', () => {
    expect(toFieldErrors({ errors: [{ field: 'cuit', message: 'Ya existe' }] })).toEqual([{ field: 'cuit', message: 'Ya existe' }])
    expect(toFieldErrors([{ field: 'x', message: 'y' }, { message: 'form-level' }])).toEqual([{ field: 'x', message: 'y' }, { field: '', message: 'form-level' }])
    expect(toFieldErrors(undefined)).toEqual([])
    expect(toFieldErrors({ ok: true })).toEqual([])
  })
})

describe('columnDecimals()', () => {
  it('keeps the decimals a numeric column holds', () => {
    expect(columnDecimals('numeric(12,2)')).toBe(2)
    expect(columnDecimals('numeric(10)')).toBe(0)
    expect(columnDecimals('integer')).toBe(0)
    expect(columnDecimals('numeric')).toBe(20)
    expect(columnDecimals('double precision')).toBe(20)
  })
})

// A column's CHECK ranges, as a form anticipates them (DataViews.md §15).
describe('boundErrors()', () => {
  const fields = [
    { name: 'precio', column: [], bounds: [{ kind: 'value' as const, op: '>=' as const, value: 0, message: null }] },
    { name: 'codigo', column: [], bounds: [{ kind: 'length' as const, op: '<=' as const, value: 3, message: 'Hasta 3 letras' }] }
  ]
  it('one error per field out of range - its CHECK\'s message, else its own words', () => {
    expect(boundErrors(fields, { precio: -1, codigo: 'ABCD' })).toEqual([
      { field: 'precio', message: 'At least 0' },
      { field: 'codigo', message: 'Hasta 3 letras' }
    ])
  })
  it('leaves an empty value to Required, and reads numeric text as a number', () => {
    expect(boundErrors(fields, { precio: '', codigo: null })).toEqual([])
    expect(boundErrors(fields, { precio: '10.50', codigo: 'ABC' })).toEqual([])
    expect(boundErrors(fields, { precio: '-0.01' })).toEqual([{ field: 'precio', message: 'At least 0' }])
  })
})
