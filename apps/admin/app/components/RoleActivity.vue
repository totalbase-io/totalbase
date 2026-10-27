<script setup lang="ts">
/**
 * Who was added to or removed from a role, by whom and when - the audit
 * log's grid (AuditLogGrid) filtered to the role's membership changes
 * (GET /audit/logs?role_change=<id>). A role's Activity tab, as a user's
 * (UserActivity): its own PageShell nested in the role page's body, so the
 * pager sits at its foot.
 */
const props = defineProps<{ roleId: string }>()
const { t } = useI18n()
const query = computed(() => ({ role_change: props.roleId }))
const grid = useTemplateRef('grid')
</script>

<template>
  <AuditLogGrid
    ref="grid"
    :query="query"
    :empty-title="t('users.roleActivity.empty')"
  >
    <template #toolbar>
      <div class="flex items-center gap-3">
        <p class="flex-1 text-sm text-muted">
          {{ t('users.roleActivity.intro') }}
        </p>
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
