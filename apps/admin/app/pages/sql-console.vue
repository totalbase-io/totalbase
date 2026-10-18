<script setup lang="ts">
// The real SQL Console lives entirely in SqlConsolePanel - this page just
// gives it a normal page's worth of space, no drawer/overlay involved.
// Resources' New Resource/Edit flows reach the same panel through
// SqlConsoleDrawer instead; one implementation either way.
const sqlConsolePrefill = useSqlConsolePrefill()
const { t } = useI18n()
</script>

<template>
  <PageShell :scroll="false">
    <template #header>
      <PageHeader
        :title="t('database.sqlConsolePage.title')"
        icon="i-lucide-square-terminal"
      />
    </template>

    <SqlConsolePanel
      :initial-sql="sqlConsolePrefill?.sql ?? ''"
      default-orientation="vertical"
      splitter-storage-key="sql-console-page-columns"
      class="flex-1 min-h-0"
    />
  </PageShell>
</template>
