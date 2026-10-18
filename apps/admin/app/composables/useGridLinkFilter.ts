import type { ComputedRef } from 'vue'
import type { DataViewField } from '~/types/dataview'
import { formatCondition, parseConditions, serializeConditions, type Condition } from '~/utils/filterConditions'
import { humanizeColumnName } from '~/utils/humanize-column-name'

/**
 * A link's filter on a DataView's grid (`?filter=<json>`, a dashboard's click -
 * Specification_DataViews.md §4.10): the where grammar, taken once on load and
 * applied on top of the DataView's filters and the viewer's permissions - even
 * where its Filter is off (it only narrows). Shown as chips with ✕, each
 * condition by its column's title and a foreign key by its row's presentation;
 * one the Data API refuses shows its error, never the rows unfiltered
 * (`linkFilterError` - the fetch rejects with it).
 */
export function useGridLinkFilter(options: {
  linkFilter: string | undefined
  dataviewId: () => string
  fields: ComputedRef<DataViewField[]>
  /** The filter was taken (valid or not) - the host drops `?filter=`. */
  onApplied: () => void
}) {
  const { t } = useI18n()
  const appApi = useAppApi()
  const dataApi = useDataApi()
  const linkWhere = ref<Record<string, unknown> | null>(null)
  const linkFilterError = ref<string | null>(null)
  if (options.linkFilter) {
    try {
      const parsed: unknown = JSON.parse(options.linkFilter)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
      linkWhere.value = parsed as Record<string, unknown>
    } catch {
      linkFilterError.value = t('dataviews.grid.linkFilterInvalid')
    }
    onMounted(() => options.onApplied())
  }

  /** The link filter's conditions as chips - null when the filter is too complex to break apart. */
  const linkGroup = computed(() => (linkWhere.value ? parseConditions(JSON.stringify(linkWhere.value)) : null))
  const linkRowLabels = ref<Record<string, string>>({})
  watch(linkGroup, async (group) => {
    for (const condition of group?.conditions ?? []) {
      if (condition.operator !== '_eq' || typeof condition.value !== 'string') continue
      const field = options.fields.value.find(f => f.kind === 'COLUMN' && f.columnName === condition.field)
      const config = (field?.config ?? {}) as { display_field?: string, display_field_target?: { schema: string, table: string, column: string } }
      // A column the DataView doesn't show, or a view's (DB26): what it points at, from its origin - asked of the server.
      let reference = config.display_field && config.display_field_target ? { ...config.display_field_target, displayField: config.display_field } : null
      if (!reference) {
        reference = await appApi.get<{ schema: string, table: string, column: string, displayField: string } | null>(`/dataviews/${options.dataviewId()}/columns/${encodeURIComponent(condition.field)}/reference`)
          .then(r => r.data)
          .catch(() => null)
      }
      if (!reference) continue
      const target = reference
      try {
        const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(target.schema, target.table, 'table'), {
          fields: target.displayField,
          [`where[${target.column}][_eq]`]: condition.value,
          limit: 1
        } as unknown as Record<string, unknown>)
        const shown = data[0]?.[target.displayField]
        if (shown !== undefined && shown !== null) linkRowLabels.value = { ...linkRowLabels.value, [`${condition.field}=${condition.value}`]: String(shown) }
      } catch {
        // Unreadable: the key shows.
      }
    }
  }, { immediate: true })

  function linkChipText(condition: { field: string, operator: string, value: unknown }): string {
    const field = options.fields.value.find(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName === condition.field)
    const shown = typeof condition.value === 'string' ? linkRowLabels.value[`${condition.field}=${condition.value}`] : undefined
    const text = formatCondition({ ...(condition as Condition), field: field?.label ?? humanizeColumnName(condition.field), ...(shown !== undefined && { value: shown }) })
    // An operator the grammar doesn't have reads as itself, never "undefined" - the Data API refuses it (DB26).
    return text.includes('undefined') ? `${field?.label ?? humanizeColumnName(condition.field)} ${condition.operator} ${String(condition.value ?? '')}`.trim() : text
  }

  function removeLinkCondition(index: number) {
    const group = linkGroup.value
    if (!group) {
      linkWhere.value = null
      return
    }
    const rest = group.conditions.filter((_, i) => i !== index)
    linkWhere.value = rest.length ? JSON.parse(serializeConditions(rest, group.join)) as Record<string, unknown> : null
  }

  function clearLinkFilter() {
    linkWhere.value = null
  }

  return { linkWhere, linkFilterError, linkGroup, linkChipText, removeLinkCondition, clearLinkFilter }
}
