import { describe, expect, it } from 'vitest'
import { DATAVIEW_FEATURE_KEYS } from '@totalbase/tb-catalog'
import { DATAVIEW_FEATURES, DATAVIEW_TYPES, LIST_DATAVIEW_TYPES, isListCommonFeature, resolveCalendarLayout, resolveFeatures, resolveListFeatures, resolveTreeLayout, type DataViewField } from '~/types/dataview'

const column = (columnName: string, visible: boolean) => ({ id: columnName, kind: 'COLUMN', columnName, visible, widget: 'UInput', config: {} }) as unknown as DataViewField

// DataViews.md §4: a hidden column is read, not shown - a layout may use it.
describe('layouts take the DataView\'s hidden columns', () => {
  it('keeps a Calendar\'s date column though the grid doesn\'t show it, and titles events by the first shown one', () => {
    const layout = resolveCalendarLayout({ calendar_layout: { dateColumn: 'starts_at' } }, [column('starts_at', false), column('title', true)])
    expect(layout.dateColumn).toBe('starts_at')
    expect(layout.titleFormula).toBe('{{title}}')
  })

  it('keeps a Tree\'s hidden parent column and titles by the first shown one that isn\'t it', () => {
    const layout = resolveTreeLayout({ tree_layout: { parentColumn: 'parent' } }, [column('parent', false), column('name', true)])
    expect(layout).toMatchObject({ parentColumn: 'parent', titleFormula: '{{name}}', defaultDisplay: 'tree', expandLevel: 1 })
  })

  it('drops a column that isn\'t in the DataView', () => {
    expect(resolveCalendarLayout({ calendar_layout: { dateColumn: 'gone' } }, [column('title', true)]).dateColumn).toBeNull()
  })
})

// The server accepts exactly these feature keys (@totalbase/tb-catalog, DataViews.md §5.1).
describe('feature catalog', () => {
  it('offers, per type, exactly the keys the server accepts', () => {
    for (const type of DATAVIEW_TYPES) {
      expect((DATAVIEW_FEATURES[type] ?? []).map(f => f.key).sort(), type).toEqual([...(DATAVIEW_FEATURE_KEYS[type] ?? [])].sort())
    }
  })
})

// DataViews.md §5.13: a list's toolbar is common to its views; a view's own controls have their own keys.
describe('list views\' features', () => {
  it('shares the common toolbar between every list view', () => {
    const common = (type: typeof LIST_DATAVIEW_TYPES[number]) => (DATAVIEW_FEATURES[type] ?? []).filter(isListCommonFeature).map(f => f.key).sort()
    for (const type of LIST_DATAVIEW_TYPES) expect(common(type), type).toEqual(common('TABLE'))
  })

  it('keeps a table\'s row density apart from the cards\' size', () => {
    const features = resolveListFeatures({ features: { density: false } })
    expect(features.density).toBe(false)
    expect(features.cardDensity).toBe(true)
    expect(resolveFeatures('CARDS', { features: { density: false } }).cardDensity).toBe(true)
  })
})
