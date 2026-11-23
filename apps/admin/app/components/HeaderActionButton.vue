<script setup lang="ts">
/**
 * One HeaderAction as a desktop button (PageHeader.vue) - a dropdown
 * button (with a ▾) when it has `children`, a square icon button when `iconOnly`,
 * with `tooltip` (or, icon-only, the label) on hover - a dropdown's too. Its height follows
 * the header (an editor's are taller - main.css, `.page-header--editor`).
 */
defineProps<{
  action: HeaderAction
}>()
</script>

<template>
  <UDropdownMenu
    v-if="action.children"
    :items="action.children"
    :content="{ align: 'end' }"
  >
    <!-- The tooltip inside the menu's trigger, as SqlConsolePanel.vue's purge popover has it. -->
    <UTooltip
      :text="action.tooltip ?? (action.iconOnly ? action.label : undefined)"
      :disabled="!action.tooltip && !action.iconOnly"
    >
      <UButton
        :icon="action.icon"
        :label="action.iconOnly ? undefined : action.label"
        :aria-label="action.iconOnly ? action.label : undefined"
        :color="action.color ?? 'neutral'"
        variant="outline"
        :trailing-icon="action.iconOnly ? undefined : 'i-lucide-chevron-down'"
        :square="action.iconOnly"
        :disabled="action.disabled"
        :loading="action.loading"
      />
    </UTooltip>
  </UDropdownMenu>
  <UTooltip
    v-else
    :text="action.tooltip ?? (action.iconOnly ? action.label : undefined)"
    :disabled="!action.tooltip && !action.iconOnly"
  >
    <UButton
      :icon="action.icon"
      :label="action.iconOnly ? undefined : action.label"
      :aria-label="action.iconOnly ? action.label : undefined"
      :color="action.color ?? 'neutral'"
      variant="outline"
      :square="action.iconOnly"
      :disabled="action.disabled"
      :loading="action.loading"
      @click="action.onSelect?.()"
    />
  </UTooltip>
</template>
