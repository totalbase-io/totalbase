<script setup lang="ts">
/**
 * The "Show in the App menu" switch of a DataView or a Dashboard - its
 * `scope` (Specification_Security.md §8.1): on is LISTED, off is
 * EMBEDDED_ONLY - only mounted inside a DataView page (a Detail widget, a
 * `TDashboard` widget), never listed. The same field in the DataView settings
 * and in the Dashboard create/edit modals.
 */
const scope = defineModel<'LISTED' | 'EMBEDDED_ONLY'>({ required: true })
const shown = computed({
  get: () => scope.value === 'LISTED',
  set: (value: boolean) => { scope.value = value ? 'LISTED' : 'EMBEDDED_ONLY' }
})
defineProps<{ kind: 'DataView' | 'Dashboard' }>()
const { t } = useI18n()
</script>

<template>
  <!-- A primary border: whether the App menu lists it is one of the few settings a viewer notices. -->
  <label class="flex items-center gap-3 rounded-lg border border-primary/50 px-3 py-2.5">
    <div class="flex-1">
      <p class="text-sm font-medium text-highlighted">{{ t('shell.showInAppMenu.label') }}</p>
      <p class="text-xs text-muted">
        {{ t('shell.showInAppMenu.description', { kind }) }}
      </p>
    </div>
    <USwitch v-model="shown" />
  </label>
</template>
