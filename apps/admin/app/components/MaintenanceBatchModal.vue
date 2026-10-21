<script setup lang="ts">
/**
 * A maintenance batch (Administration.md §6.5) in three stages:
 *
 * - preview: the exact list it will run, what's skipped and why - Start or
 *   Cancel. Opened by setting `plan`.
 * - running: progress, the table in hand with PostgreSQL's own phase, each
 *   item's state. Can't be dismissed - only stopped. The batch runs on the
 *   server either way; this page reopens it after a reload
 *   (useMaintenanceBatch reads it back from PostgreSQL).
 * - finished: a summary, and Close.
 */
import { useApiErrorMessage } from '~/utils/api-error-message'
import type { MaintenanceBatch, MaintenanceBatchItemStatus, MaintenanceBatchPlan, MaintenanceOperation } from '~/types/maintenance'

const plan = defineModel<MaintenanceBatchPlan | null>('plan', { default: null })
const emit = defineEmits<{ finished: [] }>()

const api = useAdminApi()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const { batch, follow, clear } = useMaintenanceBatch()

type Stage = 'preview' | 'running' | 'finished'
const stage = computed<Stage | null>(() => {
  if (batch.value) return batch.value.active ? 'running' : 'finished'
  return plan.value ? 'preview' : null
})
const open = computed({
  get: () => stage.value !== null,
  set: (value: boolean) => {
    if (value || stage.value === 'running') return
    if (stage.value === 'finished') clear()
    plan.value = null
  }
})

// The page refreshes its numbers when a batch ends.
watch(() => batch.value?.active, (active, was) => {
  if (was && !active) emit('finished')
})

const VERB: Record<MaintenanceOperation, string> = { VACUUM: 'Vacuum', ANALYZE: 'Analyze', REINDEX: 'Reindex' }
const title = computed(() => {
  if (stage.value === 'preview') return plan.value!.title
  if (!batch.value) return ''
  const operation = VERB[batch.value.operation]
  if (stage.value === 'running') return t('settings.maintenanceBatch.inProgress', { operation })
  return batch.value.cancelled ? t('settings.maintenanceBatch.stopped', { operation }) : t('settings.maintenanceBatch.finished', { operation })
})

// --- Preview ---
const starting = ref(false)
const startError = ref<string | null>(null)
watch(plan, () => {
  startError.value = null
})
async function start() {
  if (!plan.value) return
  starting.value = true
  startError.value = null
  try {
    const { data } = await api.post<MaintenanceBatch>('/maintenance/batches', {
      data: {
        operation: plan.value.operation.toLowerCase(),
        targets: plan.value.targets.map(target => ({ table: target.table, ...(target.index ? { index: target.index } : {}) }))
      }
    })
    plan.value = null
    follow(data)
  } catch (err) {
    startError.value = errorMessage(err, t('settings.maintenanceBatch.startError'))
  } finally {
    starting.value = false
  }
}

// --- Running ---
const finishedCount = computed(() => (batch.value ? batch.value.done + batch.value.failed + batch.value.cancelled : 0))
const percent = computed(() => (batch.value?.total ? Math.round((finishedCount.value / batch.value.total) * 100) : 0))
const stopOpen = ref(false)
const stopping = ref(false)
async function stopBatch() {
  if (!batch.value) return
  stopping.value = true
  try {
    follow((await api.post<MaintenanceBatch>(`/maintenance/batches/${batch.value.id}/stop`)).data)
    stopOpen.value = false
  } catch (err) {
    notifyError(err, t('settings.maintenanceBatch.stopError'))
  } finally {
    stopping.value = false
  }
}

const summary = computed(() => {
  if (!batch.value) return ''
  const parts = [t('settings.maintenanceBatch.summaryDone', { n: batch.value.done })]
  if (batch.value.failed) parts.push(t('settings.maintenanceBatch.summaryFailed', { n: batch.value.failed }))
  if (batch.value.cancelled) parts.push(t('settings.maintenanceBatch.summaryCancelled', { n: batch.value.cancelled }))
  return `${parts.join(', ')}.`
})

/** The running item shows PostgreSQL's own phase and percent instead of "Running". */
function itemText(item: MaintenanceBatch['items'][number]): string {
  const progress = item.status === 'RUNNING' ? batch.value?.current?.progress : null
  if (progress) return `${progress.phase}${progress.percent !== null ? ` · ${progress.percent}%` : ''}`
  return t(`settings.maintenanceBatch.status.${item.status.toLowerCase()}`)
}

// Each status's label: settings.maintenanceBatch.status.<status lowercased>.
const STATUS: Record<MaintenanceBatchItemStatus, { icon: string, class: string }> = {
  PENDING: { icon: 'i-lucide-circle-dashed', class: 'text-dimmed' },
  RUNNING: { icon: 'i-lucide-loader-circle', class: 'animate-spin text-primary' },
  DONE: { icon: 'i-lucide-circle-check', class: 'text-success' },
  FAILED: { icon: 'i-lucide-circle-x', class: 'text-error' },
  CANCELLED: { icon: 'i-lucide-circle-slash', class: 'text-dimmed' }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
    :dismissible="stage !== 'running'"
    :close="stage !== 'running'"
    :ui="{ content: 'max-w-xl' }"
  >
    <template #body>
      <!-- Preview -->
      <div
        v-if="stage === 'preview' && plan"
        class="flex flex-col gap-4 text-sm"
      >
        <p>
          <span class="font-medium text-highlighted">{{ plan.targets.length }}</span>
          {{ t('settings.maintenanceBatch.previewTargets', plan.targets.length) }}
        </p>
        <ul class="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-default p-2">
          <li
            v-for="target in plan.targets"
            :key="`${target.table}-${target.index ?? ''}`"
            class="truncate font-mono text-xs"
          >
            {{ target.label }}
          </li>
        </ul>
        <div
          v-if="plan.skipped.length"
          class="flex flex-col gap-1"
        >
          <p class="text-muted">
            {{ t('settings.maintenanceBatch.skipped', plan.skipped.length) }}
          </p>
          <ul class="flex max-h-32 flex-col gap-0.5 overflow-y-auto">
            <li
              v-for="item in plan.skipped"
              :key="item.label"
              class="truncate text-xs text-muted"
            >
              <span class="font-mono">{{ item.label }}</span> · {{ item.reason }}
            </li>
          </ul>
        </div>
        <p
          v-if="plan.note"
          class="text-xs text-muted"
        >
          {{ plan.note }}
        </p>
        <p
          v-if="startError"
          class="text-error"
        >
          {{ startError }}
        </p>
      </div>

      <!-- Running / finished -->
      <div
        v-else-if="batch"
        class="flex flex-col gap-4 text-sm"
      >
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between">
            <span class="font-medium text-highlighted">{{ t('settings.maintenanceBatch.progress', { done: finishedCount, total: batch.total }) }}</span>
            <span class="text-muted tabular-nums">{{ percent }}%</span>
          </div>
          <UProgress
            :model-value="percent"
            :color="stage === 'finished' && (batch.failed || batch.cancelled) ? 'warning' : 'primary'"
          />
        </div>

        <p
          v-if="stage === 'finished'"
          class="text-muted"
        >
          {{ summary }}
        </p>

        <ul class="flex max-h-64 flex-col divide-y divide-default overflow-y-auto rounded-lg border border-default">
          <li
            v-for="item in batch.items"
            :key="item.id"
            class="flex items-center gap-2 px-3 py-1.5"
          >
            <UIcon
              :name="STATUS[item.status].icon"
              class="size-4 shrink-0"
              :class="STATUS[item.status].class"
            />
            <span class="truncate font-mono text-xs">{{ item.label }}</span>
            <span
              class="ml-auto shrink-0 text-xs"
              :class="item.status === 'FAILED' ? 'text-error' : 'text-muted'"
              :title="item.error ?? undefined"
            >{{ itemText(item) }}</span>
          </li>
        </ul>
      </div>
    </template>

    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <template v-if="stage === 'preview'">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="starting"
            @click="open = false"
          />
          <UButton
            :label="t('settings.maintenanceBatch.start', { n: plan?.targets.length ?? 0 })"
            :loading="starting"
            :disabled="!plan?.targets.length"
            @click="start"
          />
        </template>
        <UPopover
          v-else-if="stage === 'running'"
          v-model:open="stopOpen"
        >
          <UButton
            :label="t('settings.maintenanceBatch.stop')"
            icon="i-lucide-square"
            color="error"
            variant="outline"
          />
          <template #content>
            <div class="flex w-72 flex-col gap-3 p-4 text-sm">
              <p>
                {{ t('settings.maintenanceBatch.stopPending', { n: batch?.pending ?? 0 }) }}
                <template v-if="batch?.operation === 'REINDEX'">
                  {{ t('settings.maintenanceBatch.stopReindex') }}
                </template>
                <template v-else>
                  {{ t('settings.maintenanceBatch.stopTable') }}
                </template>
              </p>
              <div class="flex justify-end">
                <UButton
                  :label="t('settings.maintenanceBatch.stopBatch')"
                  color="error"
                  :loading="stopping"
                  @click="stopBatch"
                />
              </div>
            </div>
          </template>
        </UPopover>
        <UButton
          v-else
          :label="t('common.close')"
          @click="open = false"
        />
      </div>
    </template>
  </UModal>
</template>
