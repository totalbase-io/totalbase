<script setup lang="ts">
/**
 * A run step's one-line summary - status, the operation's label and key
 * (when the definition the run used is at hand; its type otherwise) and its
 * duration. The row content of a run's step list, in the Logs slideover and
 * in the editor's Test run / Run modal alike.
 */
defineProps<{ step: WorkflowRunStep, name?: WorkflowRunStepName }>()
</script>

<template>
  <div class="flex min-w-0 flex-1 items-center gap-2">
    <UBadge
      :color="runStatusColor(step.status)"
      variant="subtle"
      size="sm"
    >
      {{ step.status }}
    </UBadge>
    <template v-if="name">
      <span class="truncate text-sm">{{ name.label }}</span>
      <span class="truncate font-mono text-xs text-muted">{{ name.key }}</span>
    </template>
    <span
      v-else
      class="truncate font-mono text-xs"
    >{{ step.operationType }}</span>
    <span class="ms-auto shrink-0 text-xs text-dimmed">{{ runDuration(step) }}</span>
  </div>
</template>
