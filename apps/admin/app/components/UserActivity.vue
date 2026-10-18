<script setup lang="ts">
/**
 * What a user has done - the audit log's grid (AuditLogGrid) filtered to
 * that user as the acting principal; "Open in Logs" has the filters. The
 * Activity tab of pages/users/[id].vue - its own PageShell nested in that
 * page's body, so the pager sits at its foot.
 */
const props = defineProps<{ userId: string }>()

const { t } = useI18n()
const query = computed(() => ({ principal: props.userId }))
const grid = useTemplateRef('grid')
</script>

<template>
  <AuditLogGrid
    ref="grid"
    :query="query"
    :empty-title="t('users.activity.empty')"
  >
    <template #toolbar>
      <div class="flex items-center gap-3">
        <p class="flex-1 text-sm text-muted">
          {{ t('users.activity.intro') }}
        </p>
        <UButton
          :label="t('users.activity.insights')"
          icon="i-lucide-chart-column"
          color="neutral"
          variant="outline"
          :to="`/users/insights/activity?user=${userId}`"
        />
        <UButton
          :label="t('users.activity.openInLogs')"
          icon="i-lucide-scroll-text"
          color="neutral"
          variant="outline"
          :to="`/logs?principal=${userId}&range=all`"
        />
        <UTooltip :text="t('common.refresh')">
          <UButton
            :aria-label="t('common.refresh')"
            icon="i-lucide-refresh-cw"
            color="neutral"
            variant="outline"
            square
            :loading="grid?.pending ?? false"
            @click="grid?.refresh()"
          />
        </UTooltip>
      </div>
    </template>
  </AuditLogGrid>
</template>
