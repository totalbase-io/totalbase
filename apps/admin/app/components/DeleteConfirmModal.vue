<script setup lang="ts">
/**
 * The admin's delete confirmation modal (Admin_UI.md §6.6): the body says what goes - a sentence, the list of
 * targets, anything extra in the default slot (a Cascade switch) - and the footer row has the "Confirm" checkbox on
 * the left, Cancel/Delete on the right. Delete enables only once it's checked, unless `requireConfirm` is false
 * (a grid's single row). The checkbox resets on every open: a new delete is confirmed anew.
 */
withDefaults(defineProps<{
  title: string
  /** The sentence under the title - what is deleted, that it can't be undone. */
  description?: string
  /** The targets listed in the body, one per line. */
  items?: string[]
  /** Items in monospace - keys and qualified names. */
  mono?: boolean
  loading?: boolean
  requireConfirm?: boolean
  /** The action's label, when it isn't Delete (Drop, Remove). */
  confirmLabel?: string
}>(), { description: undefined, items: undefined, mono: false, loading: false, requireConfirm: true, confirmLabel: undefined })
const emit = defineEmits<{ confirm: [] }>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()

const confirmed = ref(false)
watch(open, (isOpen) => {
  if (isOpen) confirmed.value = false
}, { immediate: true })
</script>

<template>
  <UModal
    v-model:open="open"
    :title="title"
  >
    <template
      v-if="description || items?.length || $slots.default"
      #body
    >
      <div class="flex flex-col gap-4">
        <p
          v-if="description"
          class="text-sm text-muted"
        >
          {{ description }}
        </p>
        <ul
          v-if="items?.length"
          class="flex flex-col gap-1 max-h-48 overflow-y-auto border border-default rounded-lg p-2"
        >
          <li
            v-for="(item, index) in items"
            :key="index"
            class="text-sm truncate"
            :class="{ 'font-mono': mono }"
          >
            {{ item }}
          </li>
        </ul>
        <slot />
      </div>
    </template>
    <template #footer>
      <div
        class="flex w-full items-center gap-2"
        :class="requireConfirm ? 'justify-between' : 'justify-end'"
      >
        <UCheckbox
          v-if="requireConfirm"
          v-model="confirmed"
          :label="t('common.confirm')"
        />
        <div class="flex gap-2">
          <UButton
            :label="t('common.cancel')"
            color="neutral"
            variant="ghost"
            :disabled="loading"
            @click="open = false"
          />
          <UButton
            :label="confirmLabel ?? t('common.delete')"
            color="error"
            :disabled="requireConfirm && !confirmed"
            :loading="loading"
            @click="emit('confirm')"
          />
        </div>
      </div>
    </template>
  </UModal>
</template>
