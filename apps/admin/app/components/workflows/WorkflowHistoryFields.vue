<script setup lang="ts">
/**
 * A workflow's history policy (Workflows.md §9.1) - the
 * Auditing step of both the creation and the Settings wizard. History off
 * keeps a run only 24 hours after it finishes (§9.4), so the level is
 * disabled while it is off.
 */
const enabled = defineModel<boolean>('enabled', { required: true })
const level = defineModel<'SUMMARY' | 'DETAILED'>('level', { required: true })
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField
      :label="$t('workflows.workflowHistoryFields.executionHistory')"
      :description="$t('workflows.workflowHistoryFields.offARunIsKept')"
    >
      <USwitch
        v-model="enabled"
        :label="$t('workflows.workflowHistoryFields.keepExecutionHistory')"
      />
    </UFormField>
    <UFormField
      :label="$t('workflows.workflowHistoryFields.historyLevel')"
      :description="$t('workflows.workflowHistoryFields.summaryRecordsExecutedStepsDetailed')"
    >
      <USelect
        v-model="level"
        :aria-label="$t('workflows.workflowHistoryFields.historyLevel')"
        :items="[{ label: $t('workflows.workflowHistoryFields.levels.summary'), value: 'SUMMARY' }, { label: $t('workflows.workflowHistoryFields.levels.detailed'), value: 'DETAILED' }]"
        :disabled="!enabled"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
