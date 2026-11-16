import { computed, ref, type Ref } from 'vue'

/**
 * A list's Delete - one row's action and the bulk Delete land on the same targets (a single row is a one-element
 * list), shown in a `DeleteConfirmModal`. Each target is its own request: one that fails doesn't stop the rest, and
 * the toast says how many went (`common.deletedPartial`) and which didn't.
 */
export function useBulkDelete<T>(options: {
  /** Deletes one target; a throw counts it as failed. */
  remove: (target: T) => Promise<unknown>
  /** Runs once all were tried - refresh the list, clear the selection. */
  after?: (targets: T[]) => unknown
  /** The success toast's title for n deleted. */
  deleted: (n: number) => string
  /** The partial toast's description, given the targets that failed. */
  failed: (failures: T[]) => string
}) {
  const toast = useToast()
  const { t } = useI18n()
  const targets = ref<T[]>([]) as Ref<T[]>
  const deleting = ref(false)
  const open = computed({
    get: () => targets.value.length > 0,
    set: (isOpen: boolean) => {
      if (!isOpen && !deleting.value) targets.value = []
    }
  })

  /** Opens the confirmation for these targets - taken now, so a selection changing behind the modal doesn't move them. */
  function start(list: T[]) {
    targets.value = [...list]
  }

  async function confirm() {
    const list = targets.value
    deleting.value = true
    const failures: T[] = []
    for (const target of list) {
      try {
        await options.remove(target)
      } catch {
        failures.push(target)
      }
    }
    deleting.value = false
    targets.value = []
    await options.after?.(list)
    if (failures.length === 0) {
      toast.add({ title: options.deleted(list.length), color: 'success' })
    } else {
      toast.add({
        title: t('common.deletedPartial', { done: list.length - failures.length, total: list.length }),
        description: options.failed(failures),
        color: 'warning'
      })
    }
  }

  return { targets, open, deleting, start, confirm }
}
