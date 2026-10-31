import { describe, expect, it } from 'vitest'
import { computed, effectScope, ref } from 'vue'
import type { DataViewField } from '~/types/dataview'
import { useGridColumnPrefs } from './useGridColumnPrefs'

const field = (columnName: string, visible = true) => ({ id: columnName, kind: 'COLUMN', columnName, label: columnName, visible, config: {} }) as unknown as DataViewField

function setup(fields: DataViewField[], options: { initial?: Parameters<typeof useGridColumnPrefs>[0]['initial'], fixedColumns?: string[], defaultState?: Record<string, unknown> } = {}) {
  const scope = effectScope()
  const source = ref(fields)
  const prefs = scope.run(() => useGridColumnPrefs({
    fields: computed(() => source.value),
    rawFields: () => source.value,
    fixedColumns: () => options.fixedColumns,
    initial: options.initial,
    defaultState: () => options.defaultState
  }))!
  return { prefs, shown: () => prefs.orderedFields.value.map(f => f.columnName) }
}

// A grid's columns, shown or hidden (DataViews.md §4.1): the DataView's `visible` is the default of the viewer's
// own preference, which the Columns panel and a header's menu change - what every layout then reads is
// `orderedFields`, so no consumer filters by `visible` again.
describe('useGridColumnPrefs', () => {
  it('shows exactly the DataView\'s visible columns when the viewer has no preferences', () => {
    const { shown, prefs } = setup([field('a'), field('b', false), field('c')])
    expect(shown()).toEqual(['a', 'c'])
    expect(prefs.hiddenColCount.value).toBe(1)
  })

  it('shows a column the DataView hides once the viewer shows it from the Columns panel', () => {
    const { shown, prefs } = setup([field('a'), field('b', false), field('c')])
    prefs.colsOpen.value = true
    prefs.toggleColVisible('b')
    expect(shown()).toEqual(['a', 'b', 'c'])
    expect(prefs.colPrefs.prefs.b).toMatchObject({ visible: true })
  })

  it('shows every column on "All", a hidden one included', () => {
    const { shown, prefs } = setup([field('a'), field('b', false)])
    prefs.colsOpen.value = true
    prefs.listItems.value = [{ key: 'a', label: 'a', visible: true }, { key: 'b', label: 'b', visible: false }]
    prefs.setAllColsVisible(true)
    expect(shown()).toEqual(['a', 'b'])
  })

  it('leaves out a visible column the viewer hid, and reads a saved preference over the DataView\'s default', () => {
    const { shown } = setup([field('a'), field('b', false), field('c')], { initial: { a: { visible: false, order: 0 }, b: { visible: true, order: 1 }, c: { visible: true, order: 2 } } })
    expect(shown()).toEqual(['b', 'c'])
  })

  it('an embed\'s own columns win: a listed hidden column is shown, an unlisted visible one is not', () => {
    const { shown } = setup([field('a'), field('b', false), field('c')], { fixedColumns: ['c', 'b'] })
    expect(shown()).toEqual(['c', 'b'])
  })

  it('"Default" reapplies the DataView-wide default state\'s own column preferences', () => {
    const { shown, prefs } = setup([field('a'), field('b', false)], { defaultState: { columnPrefs: { a: { visible: false, order: 0 }, b: { visible: true, order: 1 } } } })
    expect(shown()).toEqual(['a'])
    prefs.selectDefaultCols()
    expect(shown()).toEqual(['b'])
  })
})
