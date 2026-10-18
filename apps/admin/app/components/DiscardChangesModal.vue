<script setup lang="ts">
/**
 * "Discard changes?" - asked before an action would drop a record's
 * unsaved edits (useDiscardGuard.ts). Opened through Nuxt UI's
 * useOverlay; closes with whether to discard.
 */
const emit = defineEmits<{ close: [discard: boolean] }>()
const { t } = useI18n()
</script>

<template>
  <UModal
    :title="t('shell.discardChanges.title')"
    :description="t('shell.discardChanges.description')"
    @update:open="(open: boolean) => { if (!open) emit('close', false) }"
  >
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.keepEditing')"
          color="neutral"
          variant="outline"
          @click="emit('close', false)"
        />
        <UButton
          :label="t('common.discard')"
          color="error"
          @click="emit('close', true)"
        />
      </div>
    </template>
  </UModal>
</template>
