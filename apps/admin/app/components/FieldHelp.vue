<script setup lang="ts">
/**
 * A field's help in its UFormField's `hint` - at the end of the label's line (AGENTS.md section 25): a "?" that opens
 * its text in a popover (a toggletip) - by a click, a tap, Enter or Space; outside or Esc closes it. For a row of
 * fields that must stay level, where help under each label would push its control down.
 */
defineProps<{
  /** The help. */
  text: string
  /** The field it explains - the button's accessible name. */
  label: string
}>()
const { t } = useI18n()
</script>

<template>
  <UPopover :content="{ side: 'top', align: 'start' }">
    <UButton
      icon="i-lucide-circle-help"
      color="neutral"
      variant="link"
      size="xs"
      class="p-0 align-middle"
      :aria-label="t('common.helpFor', { label })"
    />
    <template #content>
      <p class="max-w-72 p-3 text-sm text-default">
        {{ text }}
      </p>
    </template>
  </UPopover>
</template>
