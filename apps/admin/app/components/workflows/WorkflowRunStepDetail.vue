<script setup lang="ts">
/**
 * One run step in full - type, timings, the output it took, and its input,
 * result and error. The Logs slideover's step screen and each expanded step
 * of the editor's Test run / Run modal render this same block.
 */
defineProps<{ step: WorkflowRunStep }>()

const dates = useDateTimeFormat()
function formatDate(value: string | null): string {
  return value ? dates.dateTime(value) : '—'
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-muted">
        {{ $t('common.type') }}
      </dt><dd class="font-mono">
        {{ step.operationType }}
      </dd>
      <dt class="text-muted">
        {{ $t('workflows.workflowRunStepDetail.started') }}
      </dt><dd>{{ formatDate(step.startedAt) }}</dd>
      <dt class="text-muted">
        {{ $t('workflows.workflowRunStepDetail.finished') }}
      </dt><dd>{{ formatDate(step.finishedAt) }}</dd>
      <template v-if="step.selectedOutput">
        <dt class="text-muted">
          {{ $t('workflows.workflowRunStepDetail.output') }}
        </dt><dd>{{ step.selectedOutput }}</dd>
      </template>
    </dl>
    <template v-if="hasPayload(step.input) && !inputIsRedundant(step)">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
        {{ $t('workflows.workflowRunStepDetail.input') }}
      </h3>
      <pre class="max-h-80 overflow-auto rounded-md bg-elevated p-2 text-xs">{{ JSON.stringify(step.input, null, 2) }}</pre>
    </template>
    <template v-if="hasPayload(step.result)">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
        {{ $t('workflows.workflowRunStepDetail.result') }}
      </h3>
      <pre class="max-h-80 overflow-auto rounded-md bg-elevated p-2 text-xs">{{ JSON.stringify(step.result, null, 2) }}</pre>
    </template>
    <template v-if="step.error">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-error">
        {{ $t('workflows.workflowRunStepDetail.error') }}
      </h3>
      <pre class="max-h-80 overflow-auto rounded-md bg-error-50 dark:bg-error-950/40 p-2 text-xs text-error">{{ JSON.stringify(step.error, null, 2) }}</pre>
    </template>
  </div>
</template>
