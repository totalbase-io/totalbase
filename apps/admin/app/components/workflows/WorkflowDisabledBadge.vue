<script setup lang="ts">
/**
 * A workflow that is not enabled says so by its title, on its design and settings screens
 * (Specification_Workflows.md §16.2): Disabled, or Auto-disabled in warning with the failure count; before the first
 * publish the tooltip says to publish first. Enabling is done in Settings › General. Enabled shows nothing.
 */
const props = defineProps<{
  workflow: { enabled: boolean, consecutiveFailures: number, publishedVersion: string | null }
}>()
const { t } = useI18n()
// Only an auto-disable leaves the failure streak at its tripped value; a manual re-enable resets it.
const autoDisabled = computed(() => !props.workflow.enabled && props.workflow.consecutiveFailures > 0)
const tooltip = computed(() => autoDisabled.value
  ? t('workflows.editor.autoDisabledTooltip', { n: props.workflow.consecutiveFailures })
  : !props.workflow.publishedVersion ? t('workflows.editor.publishBeforeEnabling') : t('workflows.editor.disabledHint'))
</script>

<template>
  <UTooltip
    v-if="!workflow.enabled"
    :text="tooltip"
  >
    <UBadge
      :label="autoDisabled ? t('workflows.editor.autoDisabled') : t('common.disabled')"
      :icon="autoDisabled ? 'i-lucide-alert-triangle' : 'i-lucide-power-off'"
      :color="autoDisabled ? 'warning' : 'neutral'"
      variant="subtle"
      class="page-header__tall px-2.5"
    />
  </UTooltip>
</template>
