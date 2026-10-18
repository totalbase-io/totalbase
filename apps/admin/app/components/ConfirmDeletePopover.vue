<script setup lang="ts">
/**
 * Lightweight delete confirm for row-level actions (a column, an index, a
 * constraint) - deliberately NOT the big Danger Zone modal ([oid].vue's own
 * "Delete this table" flow with its Cascade checkbox and typed confirm):
 * those exist for destructive, hard-to-undo table-level drops, this is for
 * routine schema editing where a two-click popover is enough friction.
 */
defineProps<{ title: string, description?: string }>()
const emit = defineEmits<{ confirm: [] }>()
const { t } = useI18n()

const open = ref(false)
function confirm() {
  open.value = false
  emit('confirm')
}
</script>

<template>
  <UPopover v-model:open="open">
    <slot />
    <template #content>
      <div class="p-3 flex flex-col gap-2 max-w-64">
        <p class="text-sm font-medium">
          {{ title }}
        </p>
        <p
          v-if="description"
          class="text-xs text-muted"
        >
          {{ description }}
        </p>
        <div class="flex justify-end gap-2 pt-1">
          <UButton
            :label="t('common.cancel')"
            size="xs"
            color="neutral"
            variant="ghost"
            @click="open = false"
          />
          <UButton
            :label="t('common.delete')"
            size="xs"
            color="error"
            @click="confirm"
          />
        </div>
      </div>
    </template>
  </UPopover>
</template>
