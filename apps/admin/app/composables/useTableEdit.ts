import type { EditOperationBody } from '~/types/schema'

/**
 * A structured change to a table (Administration.md §3.11), run once its SQL has been seen - TableEditSqlPreview
 * shows it as it is edited, from the same operations this sends. One transaction: all apply, or none.
 */
export function useTableEdit(table: () => { schema: string, name: string }) {
  const api = useAdminApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()
  const saving = ref(false)

  /** Runs `operations` - true once they ran. */
  async function apply(operations: EditOperationBody[]): Promise<boolean> {
    if (operations.length === 0) return false
    saving.value = true
    try {
      await api.post(`/schema/${table().schema}/tables/${table().name}/edit`, { data: { operations } })
      toast.add({ title: t('database.tableEdit.saved'), color: 'success' })
      return true
    } catch (err) {
      notifyError(err, t('database.tableEdit.saveError'))
      return false
    } finally {
      saving.value = false
    }
  }

  return { saving, apply }
}
