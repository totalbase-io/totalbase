<script setup lang="ts">
/**
 * One run at a glance - status, trigger and mode, timings, its final result
 * or error. Shared by the Logs slideover's run detail and the editor's Test
 * run / Run modal, so a run reads the same wherever it's shown.
 */
defineProps<{ run: WorkflowRunSummary }>()

const dates = useDateTimeFormat()
function formatDate(value: string | null): string {
  return value ? dates.dateTime(value) : '—'
}
</script>

<template>
  <div class="flex flex-col gap-2 rounded-lg border border-default p-3">
    <div class="flex flex-wrap items-center gap-2">
      <UBadge
        :color="runStatusColor(run.status)"
        variant="subtle"
      >
        {{ run.status }}
      </UBadge>
      <span class="text-xs text-muted">{{ run.trigger }} · {{ run.mode }}</span>
      <UBadge
        v-if="run.hasHandledErrors"
        color="warning"
        variant="subtle"
        size="sm"
      >
        {{ $t('workflows.workflowRunSummaryCard.handledErrors') }}
      </UBadge>
      <UBadge
        v-if="run.historyLevel === 'SUMMARY'"
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ $t('workflows.workflowRunSummaryCard.summaryHistory') }}
      </UBadge>
    </div>
    <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
      <dt class="text-muted">
        {{ $t('workflows.workflowRunSummaryCard.started') }}
      </dt><dd>{{ formatDate(run.startedAt) }}</dd>
      <dt class="text-muted">
        {{ $t('workflows.workflowRunSummaryCard.finished') }}
      </dt><dd>{{ formatDate(run.finishedAt) }}</dd>
      <dt class="text-muted">
        {{ $t('workflows.workflowRunSummaryCard.duration') }}
      </dt><dd>{{ runDuration(run) }}</dd>
    </dl>
    <template v-if="hasPayload(run.result)">
      <h3 class="text-xs font-semibold uppercase tracking-wide text-muted">
        {{ $t('workflows.workflowRunSummaryCard.result') }}
      </h3>
      <pre class="max-h-64 overflow-auto rounded-md bg-elevated p-2 text-xs">{{ JSON.stringify(run.result, null, 2) }}</pre>
    </template>
    <div
      v-if="run.error"
      class="rounded-md bg-error-50 dark:bg-error-950/40 p-2"
    >
      <pre class="whitespace-pre-wrap text-xs text-error">{{ JSON.stringify(run.error, null, 2) }}</pre>
    </div>
  </div>
</template>
