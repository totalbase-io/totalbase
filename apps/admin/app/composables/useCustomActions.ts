import CustomActionConfirmModal from '~/components/CustomActionConfirmModal.vue'
import { actionInput, fillText, type RunnableAction } from '~/utils/custom-actions'

interface WorkflowRun { status: string, error: { message: string } | null }

/**
 * Runs a DataView's custom action (DataViews.md §3.7) on a row, a record or a selection: asked first
 * when it says so, then the same call any client makes - the function's route, the workflow's run - under the
 * viewer's own permissions. A success says so and `onDone` reloads what shows; a failure shows the call's message.
 */
export function useCustomActions(options: { primaryKey: () => string | null, onDone: () => void }) {
  const dataApi = useDataApi()
  const toast = useToast()
  const { t } = useI18n()
  const notifyError = useErrorToast()
  const modal = useOverlay().create(CustomActionConfirmModal)
  const running = ref(false)

  async function run({ action, target }: RunnableAction, rows: readonly Record<string, unknown>[]): Promise<void> {
    const primaryKey = options.primaryKey()
    if (!primaryKey || rows.length === 0 || running.value) return
    if (action.confirm) {
      const ok = await modal.open({ title: action.label, text: fillText(action.confirm.text, rows[0]), confirmLabel: action.label, danger: action.confirm.danger }).result
      if (ok !== true) return
    }
    running.value = true
    try {
      const body = { data: actionInput(action, rows, primaryKey) }
      if (target.kind === 'FUNCTION') {
        await dataApi.post(`/${target.schema}/function/${target.name}`, body)
      } else {
        const { data } = await dataApi.post<WorkflowRun>(`/workflows/${encodeURIComponent(target.slug)}/run`, body)
        if (data.status === 'FAILED') throw new Error(data.error?.message ?? t('dataviews.customActions.workflowFailed'))
      }
      toast.add({ title: t('dataviews.customActions.done', { label: action.label }), color: 'success' })
      options.onDone()
    } catch (error) {
      notifyError(error, t('dataviews.customActions.failed', { label: action.label }))
    } finally {
      running.value = false
    }
  }

  return { run, running }
}
