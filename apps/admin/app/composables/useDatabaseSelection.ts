import type { Resource, ResourceType } from '~/types/resource'

export interface DatabaseSelection {
  schema: string
  type: ResourceType
  /** Set only on a leaf click - the full Resource, so the reader can open its drawer without a second fetch/lookup. Cleared back to null on a category click (filter only, no drawer). */
  openResource: Resource | null
  /**
   * False only for the untouched initial state - lets database/index.vue
   * tell "nothing picked in the tree yet" apart from "a real click landed
   * on the same schema/type the default happens to start on" (both would
   * otherwise look identical: schema 'all', type 'TABLE'). Set true by
   * every DatabaseTree.vue onSelect (category or VIEW/FUNCTION leaf -
   * TABLE leaves navigate away entirely and never touch this state).
   */
  touched: boolean
}

/**
 * Bridges DatabaseTree.vue (rendered in layouts/default.vue's aside, the
 * Database rail group's own nav panel) and database/index.vue (rendered via
 * the layout's <slot />) - useState, not props/emits, because the two are
 * siblings under the layout, not parent/child; same reason useAppsNav.ts
 * already uses useState for the rail's "App" group <-> database/dataviews.vue.
 */
export function useDatabaseSelection() {
  return useState<DatabaseSelection>('database-tree-selection', () => ({
    schema: 'all',
    type: 'TABLE',
    openResource: null,
    touched: false
  }))
}
