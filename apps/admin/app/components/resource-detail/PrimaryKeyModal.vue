<script setup lang="ts">
import type { EditOperationBody, RelationDetail } from '~/types/schema'

/** A table's primary key (Administration.md §3.6): its columns, replaced as a whole - its SQL shown before Apply. */
const props = defineProps<{
  schema: string
  table: string
  detail: RelationDetail
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [] }>()
const { t } = useI18n()

const edit = useTableEdit(() => ({ schema: props.schema, name: props.table }))
const columns = ref<string[]>([])
watch(open, (isOpen) => {
  if (isOpen) columns.value = [...props.detail.primaryKey]
}, { immediate: true })

const operations = computed<EditOperationBody[]>(() => {
  const unchanged = [...columns.value].sort().join('\u0000') === [...props.detail.primaryKey].sort().join('\u0000')
  return unchanged || columns.value.length === 0 ? [] : [{ kind: 'set_primary_key', columns: columns.value }]
})

async function apply() {
  if (await edit.apply(operations.value)) {
    open.value = false
    emit('saved')
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('database.tableEdit.primaryKeyTitle', { table })"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          :label="t('database.tableEdit.primaryKey')"
          :description="t('database.tableEdit.primaryKeyHelp')"
        >
          <USelectMenu
            v-model="columns"
            :items="detail.columns.map(c => c.name)"
            multiple
            class="w-full"
          />
        </UFormField>
        <TableEditSqlPreview
          :schema="schema"
          :table="table"
          :operations="operations"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex justify-end gap-2 w-full">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('database.tableEdit.apply')"
          :loading="edit.saving.value"
          :disabled="operations.length === 0"
          @click="apply"
        />
      </div>
    </template>
  </UModal>
</template>
