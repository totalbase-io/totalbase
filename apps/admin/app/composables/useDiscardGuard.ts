import DiscardChangesModal from '~/components/DiscardChangesModal.vue'

/**
 * Asks before unsaved edits are dropped - moving to another record, a new
 * one, another page (onBeforeRouteLeave/Update), or reloading/closing the tab
 * (the browser's own prompt: that one can't be awaited). `isDirty` says
 * whether there's anything to lose; nothing is asked otherwise.
 */
export function useDiscardGuard(isDirty: () => boolean) {
  const overlay = useOverlay()
  const modal = overlay.create(DiscardChangesModal)

  /** Resolves true when there's nothing to lose, or the viewer chose to discard it. */
  async function confirmDiscard(): Promise<boolean> {
    if (!isDirty()) return true
    return (await modal.open().result) === true
  }

  // Leaving the page - or staying on it with other params (another DataView's
  // /app/dataviews/:slug is the same route: an update, not a leave).
  onBeforeRouteLeave(async () => ((await confirmDiscard()) ? undefined : false))
  onBeforeRouteUpdate(async () => ((await confirmDiscard()) ? undefined : false))

  function onBeforeUnload(event: BeforeUnloadEvent) {
    if (!isDirty()) return
    event.preventDefault()
    event.returnValue = ''
  }
  onMounted(() => window.addEventListener('beforeunload', onBeforeUnload))
  onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload))

  return { confirmDiscard }
}
