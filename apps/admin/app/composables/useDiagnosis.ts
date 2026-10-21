/**
 * What stops a DataView or a dashboard from working, and for whom (DataViews.md §18) - the server's
 * one check, read by the header's warnings and the publish dialog. `refresh` after a change that may fix one.
 */
export interface DiagnosisIssue {
  code: 'NOT_PUBLISHED' | 'NO_ROLES' | 'BROKEN_REFERENCE' | 'CONSTRAINT_WITHOUT_MESSAGE' | 'ROLE_CANNOT_READ' | 'ROLE_FIELDS_HIDDEN' | 'ROLE_SEES_KEY' | 'ROLE_VARIABLE_REFUSED' | 'ROLE_CANNOT_WRITE'
  severity: 'warning' | 'info'
  message: string
  role: { id: string, name: string } | null
  resource: { id: string, name: string } | null
  actions: ('CREATE' | 'UPDATE' | 'DELETE')[] | null
  columns: string[] | null
  variable: string | null
}

export function useDiagnosis(kind: () => 'dataview' | 'dashboard', id: () => string | undefined) {
  const api = useAdminApi()
  const issues = ref<DiagnosisIssue[]>([])
  const loading = ref(false)
  async function refresh() {
    const objectId = id()
    if (!objectId) return
    loading.value = true
    try {
      issues.value = (await api.get<DiagnosisIssue[]>(`/${kind()}s/${objectId}/diagnosis`)).data
    } catch {
      // A diagnosis that can't be read hides nothing the page itself shows - it stays as it was.
    } finally {
      loading.value = false
    }
  }
  const warnings = computed(() => issues.value.filter(i => i.severity === 'warning'))
  return { issues, warnings, loading, refresh }
}
