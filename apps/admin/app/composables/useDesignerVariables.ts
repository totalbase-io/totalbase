import type { VariableDefinition } from '@totalbase/tb-catalog'
import type { DataView } from '~/types/dataview'

/**
 * A designed page's variables (`view_config.variables`) and its record's
 * settings (`view_config.record`), saved together a moment after a change
 * (CustomDesigner.vue's Variables tab) - and which roles can't read what a
 * Resource asks for, as a warning on each.
 */
export function useDesignerVariables(options: {
  dataview: DataView
  /** A failed save, reported with its title. */
  failed: (title: string, error: unknown) => void
}) {
  const api = useAdminApi()
  const { t } = useI18n()
  const variables = ref<VariableDefinition[]>([...((options.dataview.viewConfig.variables ?? []) as VariableDefinition[])])

  /**
   * Which roles opening the page can't read what a Resource asks for - its
   * table, or a column its query reads: the Data API refuses the whole query
   * for them (Specification_DataViews.md §8.3, "All or nothing"). Read again
   * a moment after the variables change - they're saved by then. A warning
   * only; it never grants anything.
   */
  const resourceAccess = ref<Record<string, { role: string, columns: string[] | null }[]>>({})
  const { data: allRoles } = useRoles()
  let accessTimer: ReturnType<typeof setTimeout> | undefined
  function loadResourceAccess() {
    clearTimeout(accessTimer)
    accessTimer = setTimeout(async () => {
      try {
        resourceAccess.value = (await api.get<typeof resourceAccess.value>(`/dataviews/${options.dataview.id}/resource-access`)).data
      } catch {
        resourceAccess.value = {}
      }
    }, 1500)
  }
  watch(variables, loadResourceAccess, { deep: true, immediate: true })
  onBeforeUnmount(() => clearTimeout(accessTimer))
  function accessWarning(name: string): string | undefined {
    const lacking = resourceAccess.value[name] ?? []
    if (lacking.length === 0) return undefined
    const roleName = (id: string) => allRoles.value.find(r => r.id === id)?.name ?? id
    const reasons = lacking.map(l => `${roleName(l.role)} (${l.columns ? l.columns.join(', ') : t('designer.customDesigner.accessItsTable')})`)
    return t('designer.customDesigner.accessWarning', { reasons: reasons.join('; ') })
  }

  const selectedVariable = ref<string | null>(variables.value[0]?.name ?? null)
  /** The record's settings (`view_config.record`) - saved with the variables. */
  const recordConfig = ref<{ emits?: Record<string, string> } | undefined>(options.dataview.viewConfig.record as { emits?: Record<string, string> } | undefined)
  const variablesAutosave = useAutosave(async () => {
    try {
      await api.patch(`/dataviews/${options.dataview.id}`, { data: { viewConfig: { variables: variables.value, ...(recordConfig.value ? { record: recordConfig.value } : {}) } } })
    } catch (error) {
      options.failed(t('designer.customDesigner.saveVariablesError'), error)
      throw error
    }
  }, { delay: 600 })
  watch([variables, recordConfig], () => variablesAutosave.schedule(), { deep: true })

  return { variables, selectedVariable, recordConfig, variablesAutosave, accessWarning }
}
