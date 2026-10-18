<script setup lang="ts">
/**
 * Landing state for the Workflows group - the list and "New workflow"
 * creation moved into WorkflowsTree.vue (the group's sidebar panel), same
 * split resources/index.vue uses for Database. This page is only ever
 * reached with nothing picked yet.
 */
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
    <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
      <UIcon
        name="i-lucide-workflow"
        class="size-5 text-muted"
      />
    </div>
    <h1 class="mt-4 text-base font-semibold text-highlighted">
      {{ $t('workflows.index.title') }}
    </h1>
    <p class="mt-1 max-w-sm text-sm text-muted">
      {{ $t('workflows.index.description') }}
    </p>
  </div>
</template>
