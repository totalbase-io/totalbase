import type { ComputedRef } from 'vue'
import type { ColPref, DataViewField, SavedViewConfig } from '~/types/dataview'

/** A row of the Columns panel - display order + checkbox state, kept in sync with `colPrefs.prefs`. */
export interface ColItem { key: string, label: string, visible: boolean }

/**
 * A grid's column visibility/order (DataViewGrid.vue) - part of the viewer's
 * auto-saved user prefs (useGridUserPrefs.ts), seeded from them and kept in
 * sync going forward by the grid's autosave watch. Owns the ordered visible
 * fields every layout reads and the Columns panel's own list (All / None /
 * Default, move up/down, toggle).
 *
 * An embed's own columns (`fixedColumns`) win over the viewer's prefs and are
 * never saved as theirs.
 */
export function useGridColumnPrefs(options: {
  /** The columns as they show (resolved presentation). */
  fields: ComputedRef<DataViewField[]>
  /** The DataView's raw fields - `fixedColPrefs` lists the rest after the fixed ones. */
  rawFields: () => DataViewField[]
  fixedColumns: () => string[] | undefined
  initial: Record<string, ColPref> | undefined
  /** The DataView-wide `default_state` (see "Set as default for everyone") - the Columns panel's "Default". */
  defaultState: () => Record<string, unknown> | undefined
}) {
  /** An embed's own columns, as prefs: the listed ones shown in its order, the rest hidden after them. */
  function fixedColPrefs(): Record<string, ColPref> {
    const list = options.fixedColumns() ?? []
    const rest = options.rawFields().filter(f => f.columnName && !list.includes(f.columnName)).map(f => f.columnName!)
    return Object.fromEntries([...list.map((name, order) => [name, { visible: true, order }]), ...rest.map((name, i) => [name, { visible: false, order: list.length + i }])])
  }
  const colPrefs = reactive({ prefs: (options.fixedColumns()?.length ? fixedColPrefs() : { ...(options.initial ?? {}) }) as Record<string, ColPref> })

  function ensureColPrefs() {
    const current = { ...colPrefs.prefs }
    let changed = false
    // A column with no stored place (one Add columns just brought in) goes at the end, after every ordered one.
    let next = Math.max(-1, ...Object.values(current).map(p => p.order ?? -1)) + 1
    options.fields.value.forEach((field) => {
      if (!field.columnName) return
      if (!(field.columnName in current)) {
        current[field.columnName] = { visible: field.visible, order: next++ }
        changed = true
      }
    })
    if (changed) colPrefs.prefs = current
  }
  ensureColPrefs()
  watch(options.fields, ensureColPrefs)

  const orderedFields = computed(() =>
    options.fields.value
      .filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName)
      .slice()
      .sort((a, b) => (colPrefs.prefs[a.columnName!]?.order ?? 0) - (colPrefs.prefs[b.columnName!]?.order ?? 0))
      .filter(f => colPrefs.prefs[f.columnName!]?.visible !== false)
  )

  // --- The Columns panel ---
  const colsOpen = ref(false)
  const listItems = ref<ColItem[]>([])
  // Shared by the initial open, and by "All"/"None"/"Default" below - keeps
  // `listItems` (display order + checkbox state) in sync with `colPrefs.prefs`
  // (the actual persisted order/visibility) after any of those rewrite it.
  function rebuildListItems() {
    listItems.value = options.fields.value
      .filter(f => f.columnName)
      .map(f => f.columnName!)
      .sort((a, b) => (colPrefs.prefs[a]?.order ?? 0) - (colPrefs.prefs[b]?.order ?? 0))
      .map(key => ({
        key,
        label: options.fields.value.find(f => f.columnName === key)?.label ?? key,
        visible: colPrefs.prefs[key]?.visible !== false
      }))
  }
  watch(colsOpen, (open) => {
    if (open) rebuildListItems()
  })
  // "All"/"None" - bulk-toggle every column's visibility, leaving order
  // untouched. "Default" reapplies the DataView-wide `default_state`'s own
  // columnPrefs - same source "Load default view" uses, just scoped to
  // columns only; hidden when no such default exists yet (`hasDefaultColsState`).
  function setAllColsVisible(visible: boolean) {
    const next = { ...colPrefs.prefs }
    for (const item of listItems.value) {
      next[item.key] = { ...(next[item.key] ?? { order: 0 }), visible }
    }
    colPrefs.prefs = next
    rebuildListItems()
  }
  const hasDefaultColsState = computed(() => !!(options.defaultState() as SavedViewConfig | undefined)?.columnPrefs)
  function selectDefaultCols() {
    const defaultCols = options.fixedColumns()?.length ? fixedColPrefs() : (options.defaultState() as SavedViewConfig | undefined)?.columnPrefs
    if (!defaultCols) return
    colPrefs.prefs = { ...defaultCols }
    rebuildListItems()
  }
  function toggleColVisible(key: string) {
    const item = listItems.value.find(i => i.key === key)
    if (item) item.visible = !item.visible
    if (colPrefs.prefs[key]) {
      colPrefs.prefs = { ...colPrefs.prefs, [key]: { ...colPrefs.prefs[key]!, visible: !colPrefs.prefs[key]!.visible } }
    }
  }
  function commitOrder(list: ColItem[]) {
    const next = { ...colPrefs.prefs }
    list.forEach((item, idx) => {
      if (next[item.key]) next[item.key] = { ...next[item.key]!, order: idx }
    })
    colPrefs.prefs = next
  }
  function moveUp(i: number) {
    if (i === 0) return
    const list = [...listItems.value]
    ;[list[i - 1], list[i]] = [list[i]!, list[i - 1]!]
    listItems.value = list
    commitOrder(list)
  }
  function moveDown(i: number) {
    if (i === listItems.value.length - 1) return
    const list = [...listItems.value]
    ;[list[i], list[i + 1]] = [list[i + 1]!, list[i]!]
    listItems.value = list
    commitOrder(list)
  }

  // --- A column header's menu (DataViews.md §5.2) - the same prefs, one column at a time.
  function hideColumn(key: string) {
    if (colPrefs.prefs[key]) colPrefs.prefs = { ...colPrefs.prefs, [key]: { ...colPrefs.prefs[key]!, visible: false } }
  }
  /** The viewer's own text fit or alignment for a column; picking the DataView's own again drops theirs. */
  function setCellPref<K extends 'textWrap' | 'align'>(key: string, pref: K, value: NonNullable<ColPref[K]>, columnDefault: ColPref[K]) {
    const current = colPrefs.prefs[key]
    if (!current) return
    const { [pref]: _previous, ...rest } = current
    colPrefs.prefs = { ...colPrefs.prefs, [key]: (value === columnDefault ? rest : { ...rest, [pref]: value }) as ColPref }
  }
  const cellPrefOf = (key: string) => ({ textWrap: colPrefs.prefs[key]?.textWrap, align: colPrefs.prefs[key]?.align })
  /**
   * Puts column `key` just before `before` - a shown column - or, null, after the last shown one (dragged by its
   * header, DataViews.md §5.2): every column's place renumbered, the hidden ones keeping theirs among them.
   */
  function placeColumn(key: string, before: string | null) {
    if (!colPrefs.prefs[key] || before === key) return
    const keys = Object.keys(colPrefs.prefs)
      .sort((a, b) => (colPrefs.prefs[a]!.order ?? 0) - (colPrefs.prefs[b]!.order ?? 0))
      .filter(k => k !== key)
    const lastShown = orderedFields.value.map(f => f.columnName!).filter(k => k !== key).at(-1)
    const at = before !== null ? keys.indexOf(before) : lastShown ? keys.indexOf(lastShown) + 1 : keys.length
    if (at < 0) return
    keys.splice(at, 0, key)
    const next = { ...colPrefs.prefs }
    keys.forEach((k, order) => {
      next[k] = { ...next[k]!, order }
    })
    colPrefs.prefs = next
  }
  /** The viewer's own width for a column (dragged at its header's edge); undefined: back to the DataView's. */
  function setWidth(key: string, width: number | undefined) {
    const current = colPrefs.prefs[key]
    if (!current) return
    const { width: _previous, ...rest } = current
    colPrefs.prefs = { ...colPrefs.prefs, [key]: width === undefined ? rest : { ...rest, width: Math.round(width) } }
  }

  const hiddenColCount = computed(() => Object.values(colPrefs.prefs).filter(p => !p.visible).length)

  return { colPrefs, orderedFields, colsOpen, listItems, setAllColsVisible, hasDefaultColsState, selectDefaultCols, toggleColVisible, moveUp, moveDown, hideColumn, setCellPref, cellPrefOf, setWidth, placeColumn, hiddenColCount }
}
