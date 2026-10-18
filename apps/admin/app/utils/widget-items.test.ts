import { beforeAll, describe, expect, it, vi } from 'vitest'
import { loadFormulaFunctions } from '~/utils/formula-engine'
import { resolveWidgetItems } from '~/utils/widget-items'

const scope = { vars: { pagos: { kind: 'RESOURCE', data: [], count: 3 }, pagada: { kind: 'VALUE', value: true }, admin: { kind: 'VALUE', value: false } } }

describe('resolveWidgetItems()', () => {
  beforeAll(() => loadFormulaFunctions())

  it('evaluates each item\'s label, Disabled and Visible over the page - a hidden one left out', () => {
    const items = [
      { value: 'pagos', label: 'Pagos', formulas: { label: '"Pagos (" + {{vars.pagos.count}} + ")"' } },
      { value: 'anular', label: 'Anular', formulas: { disabled: '{{vars.pagada.value}}' } },
      { value: 'borrar', label: 'Borrar', formulas: { visible: '{{vars.admin.value}}' } }
    ]
    expect(resolveWidgetItems(items, scope, () => undefined)).toEqual([
      { value: 'pagos', label: 'Pagos (3)' },
      { value: 'anular', label: 'Anular', disabled: true }
    ])
  })

  it('runs a menu item\'s Code function when it is picked, with the item', () => {
    const run = vi.fn()
    const [item] = resolveWidgetItems([{ value: 'anular', label: 'Anular', onSelect: 'onAnular' }], scope, run) as { onSelect: () => void }[]
    item!.onSelect()
    expect(run).toHaveBeenCalledWith('onAnular', { item: { value: 'anular', label: 'Anular' } })
  })

  it('draws every item with its literals on the canvas - nothing evaluated, nothing run', () => {
    expect(resolveWidgetItems([{ value: 'borrar', label: 'Borrar', onSelect: 'onBorrar', formulas: { visible: 'false' } }], scope)).toEqual([{ value: 'borrar', label: 'Borrar' }])
  })
})
