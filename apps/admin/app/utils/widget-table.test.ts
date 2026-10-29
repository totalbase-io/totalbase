import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { VNode } from 'vue'
import { loadFormulaFunctions } from '~/utils/formula-engine'
import { evaluateWidgetFormula } from '~/utils/widget-formula'
import { createPageFormat } from '~/utils/page-format'
import { setRegionalLocale } from '~/utils/regional-locale'
import { computedRows, designOptions, designTable, effectiveColumnSettings, formatResourceCell, resourceTableColumns, searchEnterPayload, withRelatedPresentation, type RowFormula } from '~/utils/widget-table'

const format = createPageFormat(() => ({ timezone: 'UTC' }))

describe('formatResourceCell()', () => {
  it('reads a number by its type: a numeric\'s scale, an integer without decimals', () => {
    expect(formatResourceCell('10.50', 'numeric(5,2)', {}, format)).toBe(format.number(10.5, 2))
    expect(formatResourceCell(1234, 'integer', {}, format)).toBe(format.number(1234, 0))
    expect(formatResourceCell('2.125', 'numeric', {}, format)).toBe(format.number(2.125, 3))
  })
  it('formats dates and times in the viewer\'s regional format, and leaves other types as they came', () => {
    setRegionalLocale('es-AR')
    expect(formatResourceCell('2026-10-01', 'date', {}, format)).toBe('01/10/2026')
    setRegionalLocale(undefined)
    expect(formatResourceCell('10,5%', 'text', {}, format)).toBe('10,5%')
    expect(formatResourceCell(null, 'numeric(5,2)', {}, format)).toBe('')
    expect(formatResourceCell({ a: 1 }, 'jsonb', {}, format)).toBe('{"a":1}')
  })
  it('applies its settings: Format, Empty text, true/false labels, a value\'s label', () => {
    expect(formatResourceCell('2026-10-01', 'date', { displayFormat: 'yyyy' }, format)).toBe('2026')
    expect(formatResourceCell(1234.5, 'numeric', { displayFormat: '"$ "#,##0.00' }, format)).toBe(format.number(1234.5, '"$ "#,##0.00'))
    expect(formatResourceCell(null, 'text', { emptyText: 'n/a' }, format)).toBe('n/a')
    expect(formatResourceCell(true, 'boolean', { booleanLabels: { true: 'Activo' } }, format)).toBe('Activo')
    expect(formatResourceCell('A', 'text', { options: { A: { label: 'Abierto' } } }, format)).toBe('Abierto')
  })
})

describe('effectiveColumnSettings()', () => {
  it('takes the Table\'s own over its resource column\'s - never a form-only key', () => {
    expect(effectiveColumnSettings({ label: 'Precio' }, { label: 'Precio unitario', displayFormat: '#,##0.00', help: 'Sin IVA', bold: true }))
      .toEqual({ label: 'Precio', displayFormat: '#,##0.00', bold: true })
  })

  it('keeps the column\'s short label for the header - unless the Table titles it itself', () => {
    expect(effectiveColumnSettings(undefined, { label: 'Precio unitario', shortLabel: 'P. unit.' })).toEqual({ label: 'Precio unitario', shortLabel: 'P. unit.' })
    expect(effectiveColumnSettings({ label: 'Precio' }, { shortLabel: 'P. unit.' })).toEqual({ label: 'Precio' })
  })
})

describe('resourceTableColumns()', () => {
  const types = { descripcion: 'text', porcentaje: 'numeric(5,2)', id: 'integer' }
  it('one column per field, in its order, humanized titles, numbers right-aligned', () => {
    const columns = resourceTableColumns(['descripcion', 'porcentaje', 'id'], types, format)!
    expect(columns.map(c => (c as { accessorKey: string }).accessorKey)).toEqual(['descripcion', 'porcentaje', 'id'])
    expect(columns.map(c => c.header)).toEqual(['Descripcion', 'Porcentaje', 'Id'])
    expect(columns[0]!.meta?.class?.th).toBe('text-left')
    expect(columns[1]!.meta?.class).toEqual({ th: 'text-right', td: 'text-right text-sm tabular-nums' })
  })
  it('titles and hides from its settings and its resource column\'s', () => {
    const columns = resourceTableColumns(['descripcion', 'porcentaje', 'id'], types, format, {
      settings: { id: { hidden: true }, porcentaje: { bold: true } },
      inherited: { porcentaje: { label: 'Alícuota' } }
    })!
    expect(columns.map(c => c.header)).toEqual(['Descripcion', 'Alícuota'])
    expect(columns[1]!.meta?.class?.td).toContain('font-semibold')
  })
  it('leaves the Table its own columns without types or fields', () => {
    expect(resourceTableColumns(['id'], undefined, format)).toBeUndefined()
    expect(resourceTableColumns([], types, format)).toBeUndefined()
  })
})

// A page Table's columns computed per row, and its cells' Color formula (DataViews.md §15).
describe('resourceTableColumns() with formulas per row', () => {
  beforeAll(() => loadFormulaFunctions())
  const vars = { iva: { kind: 'VALUE', value: 0.21 } }
  const evaluate: RowFormula = (formula, row, returnType) => evaluateWidgetFormula(formula, { vars, row }, returnType)
  const types = { cantidad: 'integer', precio: 'numeric(12,2)', saldo: 'numeric' }
  const computed = [
    { key: 'total', label: 'Total', type: 'number' as const, formula: '{{cantidad}} * {{precio}}' },
    { key: 'con_iva', type: 'number' as const, formula: '{{total}} * (1 + {{vars.iva.value}})' }
  ]
  const cell = (column: unknown, original: Record<string, unknown>) =>
    (column as { cell: (ctx: { row: { original: Record<string, unknown> } }) => string | VNode }).cell({ row: { original } })

  it('adds its computed columns after the Resource\'s fields, each read from the ones before it', () => {
    const columns = resourceTableColumns(['cantidad', 'precio'], types, format, { computed, evaluate })!
    expect(columns.map(c => c.header)).toEqual(['Cantidad', 'Precio', 'Total', 'Con Iva'])
    expect(columns[2]!.meta?.class?.th).toBe('text-right')
    const row = { cantidad: 3, precio: '10.00' }
    expect(cell(columns[2], row)).toBe(format.number(30, 0))
    expect(cell(columns[3], row)).toBe(format.number(36.3, 1))
  })

  it('computes a row once, however many cells read it', () => {
    const spy = vi.fn(evaluate)
    const rowOf = computedRows(computed, spy)
    const row = { cantidad: 1, precio: 2 }
    rowOf(row)
    rowOf(row)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('colors a cell from its row with its Color formula, over the column\'s own', () => {
    const columns = resourceTableColumns(['saldo'], types, format, {
      settings: { saldo: { colorFormula: '{{saldo}} < 0 ? "red" : ""' } },
      evaluate,
      shade: color => `shade-${color}`
    })!
    expect((cell(columns[0], { saldo: -5 }) as VNode).props?.style).toEqual({ color: 'shade-red' })
    expect(typeof cell(columns[0], { saldo: 5 })).toBe('string')
  })

  it('draws its computed columns on the canvas too - its shape, nothing evaluated', () => {
    expect(designTable(['cantidad'], types, { computed }).columns.map(c => c.header)).toEqual(['Cantidad', 'Total', 'Con Iva'])
  })
})

describe('designTable()', () => {
  it('the fields as columns over three empty rows, numbers right-aligned, the hidden ones left out', () => {
    const { data, columns } = designTable(['descripcion', 'porcentaje', 'id'], { porcentaje: 'numeric(5,2)' }, { settings: { id: { hidden: true } } })
    expect(data).toEqual([{ descripcion: '', porcentaje: '' }, { descripcion: '', porcentaje: '' }, { descripcion: '', porcentaje: '' }])
    expect(columns.map(c => c.header)).toEqual(['Descripcion', 'Porcentaje'])
    expect(columns[1]!.meta?.class).toEqual({ th: 'text-right', td: 'text-right' })
  })
})

describe('designOptions()', () => {
  it('draws three sample options under the list\'s own fields', () => {
    const options = designOptions({ valueKey: 'id', labelKey: 'descripcion', descriptionKey: 'detalle', iconKey: 'icono', colorKey: 'color' })
    expect(options).toHaveLength(3)
    expect(options[0]).toEqual({ id: 1, descripcion: 'Option 1', detalle: 'Its description', icono: 'i-lucide-square-dashed', color: 'neutral' })
    // Nuxt UI's own keys when none is set.
    expect(designOptions({})[1]).toEqual({ value: 2, label: 'Option 2' })
  })
})

describe('searchEnterPayload()', () => {
  const resource = (search: string | null, data: unknown[]) => {
    const handle = {
      search,
      data,
      setSearch: vi.fn(async (text: string) => {
        handle.search = text || null
        handle.data = [{ id: 3, descripcion: 'Aceite girasol' }, { id: 7, descripcion: 'Aceite oliva' }]
      })
    }
    return handle
  }

  it('searches what was typed before taking its rows - Enter doesn\'t wait for the box', async () => {
    const r = resource('az', [{ id: 2, descripcion: 'Azúcar' }])
    expect(await searchEnterPayload(r, ' aceite ')).toEqual({
      search: 'aceite',
      rows: [{ id: 3, descripcion: 'Aceite girasol' }, { id: 7, descripcion: 'Aceite oliva' }],
      row: { id: 3, descripcion: 'Aceite girasol' }
    })
    expect(r.setSearch).toHaveBeenCalledWith('aceite')
  })

  it('takes the rows as they are when that is what it searched already, and no row when none', async () => {
    const r = resource('aceite', [{ id: 3 }])
    expect((await searchEnterPayload(r, 'aceite')).row).toEqual({ id: 3 })
    expect(r.setSearch).not.toHaveBeenCalled()
    expect(await searchEnterPayload(resource(null, []), '')).toEqual({ search: '', rows: [], row: null })
    expect(await searchEnterPayload(undefined, 'x')).toEqual({ search: 'x', rows: [], row: null })
  })
})

describe('withRelatedPresentation', () => {
  it('titles a related column "<foreign key> › <target column>" and formats it as the target (T64)', () => {
    const own = { cliente: { label: 'Cliente' } }
    const all = { 'res-clientes': { razon_social: { label: 'Razón social', bold: true } } }
    const out = withRelatedPresentation(own, ['id', 'cliente', 'cliente.razon_social', 'categoria.nombre'], { cliente: 'res-clientes' }, all)
    expect(out?.['cliente.razon_social']).toEqual({ label: 'Cliente › Razón social', bold: true })
    // No presentation on either side: both names humanized.
    expect(out?.['categoria.nombre']?.label).toBe('Categoria › Nombre')
    expect(withRelatedPresentation(own, ['id', 'cliente'], undefined, all)).toBe(own)
  })
})

describe('formatResourceCell - a code', () => {
  it('shows a monospaced whole number without a thousands separator (T63)', () => {
    const format = createPageFormat({ locale: 'es-AR' } as never)
    expect(formatResourceCell(3002, 'integer', { mono: true }, format)).toBe('3002')
  })
})
