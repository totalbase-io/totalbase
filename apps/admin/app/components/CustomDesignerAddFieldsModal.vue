<script setup lang="ts">
/**
 * Add fields… (CustomDesigner.vue): the record's columns not on the page yet,
 * several at once - each a form field with its input, with the label it will
 * show. The modal owns the ticks and labels; the designer places them
 * (`confirm`).
 */

/** A column the page has no field for yet, with the title its field would show. */
export interface AddFieldCandidate { column: string, dataType: string, label: string }

const props = defineProps<{
  candidates: AddFieldCandidate[]
  /** Where the fields go - "in <form>", or the page. */
  description: string
  saving: boolean
}>()
const emit = defineEmits<{
  confirm: [rows: { column: string, label: string }[]]
}>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()

const rows = ref<(AddFieldCandidate & { checked: boolean })[]>([])
// The candidates as they are when it opens - nothing ticked yet.
watch(open, (isOpen) => {
  if (isOpen) rows.value = props.candidates.map(c => ({ ...c, checked: false }))
})
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('designer.customDesigner.addFields.title')"
    :description="description"
  >
    <template #body>
      <UEmpty
        v-if="rows.length === 0"
        icon="i-lucide-check-check"
        :title="t('designer.customDesigner.addFields.allOnPage')"
        variant="naked"
      />
      <div
        v-else
        class="flex flex-col gap-2"
      >
        <div
          v-for="row in rows"
          :key="row.column"
          class="flex items-center gap-3"
        >
          <UCheckbox
            v-model="row.checked"
            :aria-label="t('designer.customDesigner.addFields.addColumn', { column: row.column })"
          />
          <span class="w-40 shrink-0 truncate font-mono text-sm">{{ row.column }}</span>
          <UInput
            v-model="row.label"
            size="sm"
            class="min-w-0 flex-1"
            :aria-label="t('designer.customDesigner.addFields.labelOf', { column: row.column })"
          />
          <span class="w-28 shrink-0 truncate text-xs text-muted">{{ row.dataType }}</span>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('common.add')"
          :loading="saving"
          :disabled="!rows.some(r => r.checked)"
          @click="emit('confirm', rows.filter(r => r.checked).map(r => ({ column: r.column, label: r.label })))"
        />
      </div>
    </template>
  </UModal>
</template>
