<script setup lang="ts">
/**
 * Landing state for the Templates group - the list and "New template"
 * creation live in TemplatesTree.vue (the group's sidebar panel), same
 * split pages/workflows/index.vue uses. This page is only ever reached
 * with nothing picked yet.
 */
const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
    <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
      <UIcon
        name="i-lucide-file-text"
        class="size-5 text-muted"
      />
    </div>
    <h1 class="mt-4 text-base font-semibold text-highlighted">
      {{ t('content.templates.landing.title') }}
    </h1>
    <p class="mt-1 max-w-sm text-sm text-muted">
      {{ t('content.templates.landing.description') }}
    </p>
  </div>
</template>
