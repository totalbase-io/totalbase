<script setup lang="ts">
/**
 * DataViewGrid.vue's delete confirmations - one row (from its "⋮") and the
 * selected rows (the page header's bulk Delete). The bulk one requires the
 * "Confirm" checkbox before Delete enables (AGENTS.md §25 - several targets,
 * so a deliberate click, not just a click); the single one doesn't.
 */
defineProps<{
  title: string
  body: string
  loading: boolean
  /** Delete enables only once the Confirm checkbox is checked - the bulk delete. */
  requireConfirm?: boolean
}>()
const emit = defineEmits<{
  confirm: []
}>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()
/** Reset on every open: a new delete is confirmed anew. */
const confirmed = ref(false)
watch(open, (isOpen) => {
  if (isOpen) confirmed.value = false
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
  >
    <template #body>
      <p class="text-sm text-muted">
        {{ body }}
      </p>
    </template>
    <template #footer>
      <div
        class="flex w-full items-center gap-2"
        :class="requireConfirm ? 'justify-between' : 'justify-end'"
      >
        <label
          v-if="requireConfirm"
          class="flex cursor-pointer items-center gap-2"
        >
          <UCheckbox v-model="confirmed" />
          <span class="text-sm">{{ t('common.confirm') }}</span>
        </label>
        <div class="flex gap-2">
          <UButton
            variant="ghost"
            color="neutral"
            @click="open = false"
          >
            {{ t('common.cancel') }}
          </UButton>
          <UButton
            color="error"
            :disabled="requireConfirm && !confirmed"
            :loading="loading"
            @click="emit('confirm')"
          >
            {{ t('common.delete') }}
          </UButton>
        </div>
      </div>
    </template>
  </UModal>
</template>
