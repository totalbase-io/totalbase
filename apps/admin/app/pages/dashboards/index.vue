<script setup lang="ts">
/**
 * Landing state for the Dashboards group - the list and "New Dashboard"
 * creation live in DashboardsTree.vue (the group's sidebar panel), same
 * split Workflows uses (pages/workflows/index.vue). This page is
 * only ever reached with nothing picked yet: it offers the two ways to
 * start one (D29) - the same modals the sidebar's New opens.
 */
const blankOpen = useState('dashboards-new-blank', () => false)
const fromTableOpen = useState('dashboards-new-from-table', () => false)
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center">
    <div class="flex size-12 items-center justify-center rounded-xl bg-elevated ring-1 ring-default">
      <UIcon
        name="i-lucide-layout-dashboard"
        class="size-5 text-muted"
      />
    </div>
    <h1 class="mt-4 text-base font-semibold text-highlighted">
      {{ $t('dashboards.index.title') }}
    </h1>
    <p class="mt-1 max-w-sm text-sm text-muted">
      {{ $t('dashboards.index.description') }}
    </p>
    <div class="mt-8 grid w-full max-w-xl grid-cols-1 gap-3 sm:grid-cols-2">
      <button
        type="button"
        class="flex flex-col items-start gap-2 rounded-lg p-4 text-start ring-1 ring-default hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary"
        @click="blankOpen = true"
      >
        <UIcon
          name="i-lucide-square-dashed"
          class="size-5 text-primary"
        />
        <span class="font-medium text-highlighted">{{ $t('dashboards.fromTable.blank') }}</span>
        <span class="text-sm text-muted">{{ $t('dashboards.index.blankDescription') }}</span>
      </button>
      <button
        type="button"
        class="flex flex-col items-start gap-2 rounded-lg p-4 text-start ring-1 ring-default hover:bg-elevated/50 focus-visible:outline-2 focus-visible:outline-primary"
        @click="fromTableOpen = true"
      >
        <UIcon
          name="i-lucide-table"
          class="size-5 text-primary"
        />
        <span class="font-medium text-highlighted">{{ $t('dashboards.fromTable.menu') }}</span>
        <span class="text-sm text-muted">{{ $t('dashboards.index.fromTableDescription') }}</span>
      </button>
    </div>
  </div>
</template>
