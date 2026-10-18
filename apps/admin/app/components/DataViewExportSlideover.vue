<script setup lang="ts">
/**
 * The grid's Export panel (features.export): a format (CSV/Excel), a
 * scope (this page, or every row the current search/filter matches - up
 * to `cap`), and which columns (the visible ones by default). Exported
 * text is what the grid shows (formatCellPlainText), not the raw value.
 * Props in, events out (AGENTS.md section 21A): the grid owns the query,
 * so it hands over `fetchAll`; `exported` reports what was written, for
 * the grid's bulk audit event.
 */
import type { DisplayFormatDefaults } from '~/composables/useDisplayFormatDefaults'
import type { DataViewField } from '~/types/dataview'
import type { ColumnChecklistItem } from '~/components/DataViewColumnChecklist.vue'
import { formatCellPlainText } from '~/utils/build-dataview-columns'

const props = defineProps<{
  /** Every field, for lookup. */
  fields: DataViewField[]
  /** The fields in the grid's current column order - the checklist's order and default selection. */
  orderedFields: DataViewField[]
  /** The rows on screen ("This page"). */
  rows: Record<string, unknown>[]
  /** How many rows the current search/filter matches. */
  total: number
  /** dataviews.export_max_rows. */
  cap: number
  /** dataviews.export_warning_threshold. */
  warningThreshold: number
  resourceName: string
  displayFormatDefaults: DisplayFormatDefaults
  /** Every matching row, up to `cap` - the grid runs its own query. */
  fetchAll: (cap: number) => Promise<{ rows: Record<string, unknown>[], truncated: boolean }>
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ exported: [rowCount: number, format: 'csv' | 'excel'] }>()

const toast = useToast()
const { t } = useI18n()
const ui = useUiLocale()
const notifyError = useErrorToast()
const format = ref<'csv' | 'excel'>('csv')
const scope = ref<'page' | 'all'>('page')
const columns = ref<ColumnChecklistItem[]>([])
const exporting = ref(false)

function reset() {
  scope.value = 'page'
  columns.value = props.orderedFields
    .filter(f => f.columnName)
    .map(f => ({ key: f.columnName!, label: f.label ?? f.columnName!, selected: true }))
}
watch(open, (isOpen) => {
  if (isOpen) reset()
}, { immediate: true })

function download(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

async function exportRows() {
  // In the checklist's order - the grid's own (orderedFields: the viewer's column order), not the design's.
  const cols = columns.value
    .filter(c => c.selected)
    .map(c => props.fields.find(f => f.columnName === c.key))
    .filter((f): f is DataViewField => !!f)
  if (!cols.length) return
  exporting.value = true
  try {
    let sourceRows = props.rows
    if (scope.value === 'all') {
      const result = await props.fetchAll(props.cap)
      sourceRows = result.rows
      if (result.truncated) {
        toast.add({ title: t('dataviews.export.truncatedTitle', { count: props.cap.toLocaleString(ui.intlLocale.value) }), description: t('dataviews.export.truncatedDescription'), color: 'warning' })
      }
    }
    const headers = cols.map(f => f.label ?? f.columnName!)
    const body = sourceRows.map(row => cols.map(f => formatCellPlainText(f, row[f.columnName!], row, props.displayFormatDefaults)))
    if (format.value === 'csv') {
      const escape = (value: unknown) => `"${String(value ?? '').replace(/"/g, '""')}"`
      const lines = [headers.map(escape).join(','), ...body.map(line => line.map(escape).join(','))]
      download(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }), `${props.resourceName}.csv`)
    } else {
      const XLSX = await import('xlsx')
      const sheet = XLSX.utils.aoa_to_sheet([headers, ...body])
      const workbook = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1')
      XLSX.writeFile(workbook, `${props.resourceName}.xlsx`)
    }
    emit('exported', sourceRows.length, format.value)
    open.value = false
  } catch (err) {
    notifyError(err, t('dataviews.export.error'))
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('dataviews.meta.featureLabels.export')"
  >
    <template #body>
      <div class="flex h-full flex-col gap-4">
        <UFormField :label="t('dataviews.history.format')">
          <URadioGroup
            v-model="format"
            :items="[{ label: 'CSV', value: 'csv' }, { label: t('dataviews.export.excel'), value: 'excel' }]"
            orientation="horizontal"
          />
        </UFormField>
        <UFormField :label="t('dataviews.history.rows')">
          <URadioGroup
            v-model="scope"
            :items="[{ label: t('dataviews.export.thisPage'), value: 'page' }, { label: t('dataviews.export.allRows', { count: cap.toLocaleString(ui.intlLocale.value) }), value: 'all' }]"
          />
        </UFormField>
        <!-- Only "All matching rows" can ever exceed the threshold - "This page" is always bounded by pageSize. -->
        <UAlert
          v-if="scope === 'all' && total > warningThreshold"
          color="warning"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          :title="t('dataviews.export.slowWarning')"
        />
        <UFormField :label="t('dataviews.meta.featureLabels.columnsToggle')">
          <DataViewColumnChecklist v-model="columns" />
        </UFormField>
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          class="mt-auto"
          :title="t('dataviews.export.helpTitle')"
          :description="t('dataviews.export.helpDescription')"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.close')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
        <UButton
          :label="t('dataviews.meta.featureLabels.export')"
          icon="i-lucide-download"
          :disabled="!columns.some(c => c.selected)"
          :loading="exporting"
          @click="exportRows"
        />
      </div>
    </template>
  </USlideover>
</template>
