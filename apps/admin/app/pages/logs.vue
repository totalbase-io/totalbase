<script setup lang="ts">
/**
 * The audit log. Filters come from the route query, set by the Logs panel
 * (LogsPanel.vue) through useLogsFilters - time range, status, principal,
 * action - plus pivots set from a row's entry (its principal, event or
 * resource), shown as chips. The grid itself is AuditLogGrid, the same as
 * every other place that shows the log: an administrator reads it through
 * the Admin API (events, security views, SQL), anyone else through the
 * Data API under their grants (Security.md §9) - never SQL.
 */
const { t } = useI18n()
const filters = useLogsFilters()
const directory = useUserDirectory()
const display = useAuditLogDisplay()

// Page size is a per-viewer preference (usePagePreferences).
const prefs = usePagePreferences('audit-logs', { pageSize: 50 })
const query = computed(() => filters.apiParams())
const grid = useTemplateRef('grid')

// Refresh starts over: back to the default view (last 24 hours, no
// filters), newest entries first. With filters set, leaving them changes
// the query, which refetches both the page and the panel's counts on its
// own; already unfiltered, both are refetched explicitly.
async function refreshAll() {
  if (filters.hasFilters.value) {
    await navigateTo('/logs')
    return
  }
  await Promise.all([grid.value?.refresh(), refreshNuxtData('audit-logs-summary')])
}

// Pivot filters - set from a row, not from the panel - shown as chips so
// they can be cleared. The panel's own filters show as its active items.
const pivotChips = computed(() => {
  const chips: Array<{ key: 'principal' | 'event' | 'request_id' | 'workflow_run' | 'resource', label: string, name: string, mono?: boolean }> = []
  if (filters.principalId.value) chips.push({ key: 'principal', name: t('content.logs.chips.principal'), label: directory.label(filters.principalId.value) })
  // A security view shows in the panel - only a raw event pivot needs a chip.
  if (filters.event.value && !filters.securityView.value) chips.push({ key: 'event', name: t('content.logs.chips.event'), label: filters.event.value, mono: true })
  if (filters.requestId.value) chips.push({ key: 'request_id', name: t('content.logs.chips.request'), label: filters.requestId.value.slice(0, 8), mono: true })
  if (filters.workflowRun.value) chips.push({ key: 'workflow_run', name: t('content.logs.chips.workflowRun'), label: filters.workflowRun.value.slice(0, 8), mono: true })
  if (filters.resource.value) {
    chips.push({ key: 'resource', name: t('content.logs.chips.resource'), label: filters.resourceLabel.value ?? display.resourceName(filters.resource.value) ?? t('content.logs.chips.oneResource') })
  }
  return chips
})
</script>

<template>
  <AuditLogGrid
    ref="grid"
    v-model:page-size="prefs.pageSize"
    :query="query"
    :pivot-link="filters.linkWith"
    :empty-title="filters.hasFilters.value ? t('content.logs.page.emptyFiltered', { range: filters.rangeLabel.value.toLowerCase() }) : t('content.logs.page.empty', { range: filters.rangeLabel.value.toLowerCase() })"
  >
    <template #header>
      <PageHeader
        icon="i-lucide-scroll-text"
        :title="t('content.logs.page.title')"
        :description="t('content.logs.page.description', { range: filters.rangeLabel.value })"
        :actions="[{ label: t('content.logs.page.refresh'), icon: 'i-lucide-refresh-cw', iconOnly: true, loading: grid?.pending ?? false, onSelect: refreshAll }]"
      />
    </template>

    <template
      v-if="pivotChips.length"
      #toolbar
    >
      <div class="flex flex-wrap items-center gap-2">
        <UBadge
          v-for="chip in pivotChips"
          :key="chip.key"
          color="primary"
          variant="subtle"
          class="gap-1"
        >
          <span class="text-muted">{{ chip.name }}:</span>
          <span :class="chip.mono && 'font-mono'">{{ chip.label }}</span>
          <UButton
            icon="i-lucide-x"
            size="xs"
            color="neutral"
            variant="link"
            class="p-0"
            :aria-label="t('content.logs.chips.clear', { name: chip.name.toLowerCase() })"
            :to="filters.linkWith({ [chip.key]: undefined })"
          />
        </UBadge>
      </div>
    </template>
  </AuditLogGrid>
</template>
