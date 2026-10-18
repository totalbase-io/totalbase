import type { MaybeRefOrGetter } from 'vue'
import type { RelationDetail } from '~/types/schema'

/** The shared key of a relation's detail - `refreshNuxtData(relationDetailKey('table', id))` from a place that doesn't hold it. */
export function relationDetailKey(kind: 'table' | 'view', id: string | number): string {
  return `catalog-${kind}-${id}`
}

/**
 * A table's or a view's structure (`GET /catalog/{table|view}/{id}` -
 * columns, keys, constraints), one request per relation shared by every
 * panel of its page: Columns, Check constraints, Indexes' column picker, its
 * Data grid. A column change calls `refresh()` once and every panel sees
 * it - with a fetch per panel, constraints and indexes went stale.
 * (useResourcesList's shared-data convention.)
 */
export function useRelationDetail(kind: MaybeRefOrGetter<'table' | 'view'>, id: MaybeRefOrGetter<string | number>) {
  const api = useAdminApi()
  const { data: detail, pending, error, refresh } = useAsyncData(
    () => relationDetailKey(toValue(kind), toValue(id)),
    () => api.get<RelationDetail>(`/catalog/${toValue(kind)}/${toValue(id)}`).then(r => r.data),
    { watch: [() => toValue(kind), () => toValue(id)] }
  )
  return { detail, pending, error, refresh }
}

/** A table's structure - `useRelationDetail('table', id)`. */
export function useTableDetail(id: MaybeRefOrGetter<string | number>) {
  return useRelationDetail('table', id)
}
