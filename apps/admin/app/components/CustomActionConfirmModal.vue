<script setup lang="ts">
/**
 * A custom action's confirmation (DataViews.md §3.7): its text, the row's values in it, and the
 * action's own button - red when it reads as destructive. Opened through Nuxt UI's useOverlay; closes with whether
 * to run it.
 */
defineProps<{
  title: string
  text: string
  confirmLabel: string
  danger?: boolean
}>()
const emit = defineEmits<{ close: [run: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    :title="title"
    :description="text"
    @update:open="(open: boolean) => { if (!open) emit('close', false) }"
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="outline"
          @click="emit('close', false)"
        />
        <UButton
          :label="confirmLabel"
          :color="danger ? 'error' : 'primary'"
          @click="emit('close', true)"
        />
      </div>
    </template>
  </UModal>
</template>
