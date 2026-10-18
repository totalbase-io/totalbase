<script setup lang="ts">
/**
 * Landing state for the Roles group - the list and "New role" creation
 * live in RolesTree.vue (the group's sidebar panel), same split
 * pages/templates/index.vue uses. This page is only ever reached with
 * nothing picked yet.
 */
const { t } = useI18n()
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
    <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
      <UIcon
        name="i-lucide-shield"
        class="size-5 text-muted"
      />
    </div>
    <h1 class="mt-4 text-base font-semibold text-highlighted">
      {{ t('users.pages.roles.selectTitle') }}
    </h1>
    <p class="mt-1 max-w-sm text-sm text-muted">
      {{ t('users.pages.roles.selectDescription') }}
    </p>
  </div>
</template>
