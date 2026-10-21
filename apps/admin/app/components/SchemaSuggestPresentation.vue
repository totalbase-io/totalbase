<script setup lang="ts">
/**
 * Suggest presentation for every table and view (DataViews.md §15.6) - for whoever installs
 * TotalBase over an existing database: a line per table with what it would fill and what it would change. Fill
 * applies what's missing on the ticked ones; a change is a table's own review (its Columns).
 */
import type { TableColumn } from '@nuxt/ui'

interface Summary { resourceId: string, schema: string, name: string, type: 'TABLE' | 'VIEW', fills: number, changes: number, row: boolean }

const open = defineModel<boolean>('open', { default: false })
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const isCompact = useCompactUi()

const loading = ref(false)
const applying = ref(false)
const summary = ref<Summary[]>([])
const ticked = ref(new Set<string>())
/** Only tables and views with something to fill. */
const fillable = computed(() => summary.value.filter(s => s.fills > 0 || s.row))

watch(open, async (isOpen) => {
  if (!isOpen) return
  loading.value = true
  try {
    summary.value = (await api.get<Summary[]>('/resources/suggested-presentation')).data
    ticked.value = new Set(fillable.value.map(s => s.resourceId))
  } catch (err) {
    open.value = false
    notifyError(err, t('database.resourceSuggestPresentation.loadError'))
  } finally {
    loading.value = false
  }
})
function toggle(id: string, on: boolean) {
  const next = new Set(ticked.value)
  if (on) next.add(id)
  else next.delete(id)
  ticked.value = next
}
async function fill() {
  applying.value = true
  try {
    const { presentedColumns } = (await api.post<{ presentedColumns: number }>('/resources/suggested-presentation', { data: { resourceIds: [...ticked.value] } })).data
    open.value = false
    toast.add({ title: t('database.resourceSuggestPresentation.applied', { count: presentedColumns }), color: 'success' })
    emit('saved')
  } catch (err) {
    notifyError(err, t('database.resourceSuggestPresentation.applyError'))
  } finally {
    applying.value = false
  }
}

const COLUMNS = computed<TableColumn<Summary>[]>(() => [
  { id: 'select', header: '' },
  { id: 'name', header: t('common.name') },
  { accessorKey: 'fills', header: t('database.resourceSuggestPresentation.fills') },
  { accessorKey: 'changes', header: t('database.resourceSuggestPresentation.changes') }
])
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('database.resourceSuggestPresentation.schemaTitle')"
    :description="t('database.resourceSuggestPresentation.schemaDescription')"
    :ui="{ content: 'max-w-2xl' }"
    :fullscreen="isCompact"
  >
    <template #body>
      <UEmpty
        v-if="loading"
        loading
        variant="naked"
        size="sm"
      />
      <UEmpty
        v-else-if="summary.length === 0 || (fillable.length === 0 && summary.every(s => s.changes === 0))"
        icon="i-lucide-check"
        :title="t('database.resourceSuggestPresentation.none')"
        :description="t('database.resourceSuggestPresentation.noneDescription')"
        variant="naked"
      />
      <UTable
        v-else
        :data="summary"
        :columns="COLUMNS"
        sticky
      >
        <template #select-cell="{ row }">
          <UCheckbox
            :model-value="ticked.has(row.original.resourceId)"
            :disabled="row.original.fills === 0 && !row.original.row"
            :aria-label="t('database.resourceSuggestPresentation.accept', { name: `${row.original.schema}.${row.original.name}` })"
            @update:model-value="(on: boolean | 'indeterminate') => toggle(row.original.resourceId, on === true)"
          />
        </template>
        <template #name-cell="{ row }">
          <span class="font-mono text-xs">{{ row.original.schema }}.{{ row.original.name }}</span>
        </template>
        <template #fills-cell="{ row }">
          {{ row.original.fills + (row.original.row ? 1 : 0) }}
        </template>
        <template #changes-cell="{ row }">
          <span :class="row.original.changes ? undefined : 'text-muted'">{{ row.original.changes }}</span>
        </template>
      </UTable>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="applying"
          @click="open = false"
        />
        <UButton
          :label="t('database.resourceSuggestPresentation.fillSelected', { count: ticked.size })"
          :loading="applying"
          :disabled="ticked.size === 0"
          @click="fill"
        />
      </div>
    </template>
  </UModal>
</template>
