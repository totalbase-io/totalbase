import type { Ref } from 'vue'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { DataView } from '~/types/dataview'
import type { RecordHandle } from '~/utils/record-engine'
import { actionFlags, actionsAt, CUSTOM_ACTION_ICON, runnableActions } from '~/utils/custom-actions'
import { flattenQueryObject } from '~/utils/flatten-query-object'

/**
 * A record form's own actions (DataViews.md §3.7) - for its "⋮": those this viewer may run, shown
 * where their condition holds for the open record (its row read with their flags - PostgreSQL decides). Done, the
 * record is read again.
 */
export function useRecordCustomActions(dataview: Ref<DataView>, record: Ref<RecordHandle | null | undefined>, onDone?: () => void) {
  const dataApi = useDataApi()
  const runnable = computed(() => runnableActions(dataview.value.viewConfig, dataview.value.actionTargets).filter(r => r.action.places.includes('record')))
  const flags = computed(() => actionFlags(runnable.value, ['record']))
  const met = ref<string[]>([])

  async function readFlags() {
    const current = record.value
    const key = current?.primaryKey
    const pk = current?.pk
    const { sourceResourceSchema: schema, sourceResourceName: name } = dataview.value
    if (!key || pk === null || pk === undefined || !schema || !name || Object.keys(flags.value).length === 0) {
      met.value = []
      return
    }
    try {
      const response = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(schema, name), { fields: key, [`where[${key}][_eq]`]: String(pk), limit: 1, ...flattenQueryObject(flags.value, 'flags') })
      met.value = (response as unknown as { meta?: { flags?: string[][] } }).meta?.flags?.[0] ?? []
    } catch {
      met.value = []
    }
  }
  // Another record, or this one saved: its conditions read again.
  watch([() => record.value?.pk, () => record.value?.mode, () => record.value?.status, () => JSON.stringify(flags.value)], () => void readFlags(), { immediate: true })

  const actions = useCustomActions({
    primaryKey: () => record.value?.primaryKey ?? null,
    onDone: async () => {
      await record.value?.reload()
      onDone?.()
    }
  })

  const items = computed<DropdownMenuItem[]>(() => {
    const current = record.value
    if (!current || current.pk === null || current.pk === undefined) return []
    return actionsAt(runnable.value, 'record', met.value).map(r => ({ label: r.action.label, icon: r.action.icon ?? CUSTOM_ACTION_ICON, color: r.action.color, onSelect: () => void actions.run(r, [current.data]) }))
  })
  return { items }
}
