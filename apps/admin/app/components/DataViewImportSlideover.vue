<script setup lang="ts">
/**
 * The grid's Import panel (canWrite only): pick a CSV, map its columns to
 * writable fields (auto-matched by column name or label, else Skip),
 * preview, and bulk-create rows - CREATE only, a CSV row never matches an
 * existing one. The whole file is ONE bulk request, so it is all or
 * nothing (AGENTS.md section 16): one bad row creates none. The server
 * caps a bulk at api.bulk_max_items and api.max_body_bytes, and says so.
 * The grid refreshes and audits on `imported`. Props in, events out
 * (AGENTS.md section 21A).
 */
import type { TableColumn } from '@nuxt/ui'
import type { DataViewField } from '~/types/dataview'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { SELECT_NONE } from '~/utils/select-none'

const props = defineProps<{
  fields: DataViewField[]
  primaryKey?: string | null
  schema: string
  resourceName: string
  /** Above this many rows the panel warns that it can take a while. */
  warningThreshold: number
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ imported: [created: number] }>()

const dataApi = useDataApi()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()

const fileInput = ref<HTMLInputElement | null>(null)
const fileName = ref('')
const headers = ref<string[]>([])
const rawRows = ref<Record<string, string>[]>([])
interface MappingItem { header: string, target: string }
const mapping = ref<MappingItem[]>([])
const importing = ref(false)
const result = ref<{ created: number } | { error: string } | null>(null)

/** Writable target columns - the primary key is excluded (the DB assigns it). */
const importableFields = computed(() => props.fields.filter(f =>
  f.kind === 'COLUMN' && f.columnName && f.columnName !== props.primaryKey && !(f.config as { disabled?: boolean }).disabled
))
const targetItems = computed(() => [
  { label: t('dataviews.import.skip'), value: SELECT_NONE },
  ...importableFields.value.map(f => ({ label: f.label ?? f.columnName!, value: f.columnName! }))
])
const mapped = computed(() => mapping.value.filter(m => m.target))
const previewRows = computed(() => rawRows.value.slice(0, 5))
// accessorFn, not accessorKey: a file's header may contain a dot, which TanStack would read as a nested path.
const previewColumns = computed<TableColumn<Record<string, string>>[]>(() => mapped.value.map(item => ({
  id: item.header,
  header: item.header,
  accessorFn: row => row[item.header]
})))

watch(open, (isOpen) => {
  if (!isOpen) return
  fileName.value = ''
  headers.value = []
  rawRows.value = []
  mapping.value = []
  result.value = null
}, { immediate: true })

async function onFileSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  ;(event.target as HTMLInputElement).value = ''
  if (!file) return
  result.value = null
  fileName.value = file.name
  const XLSX = await import('xlsx')
  const workbook = XLSX.read(await file.text(), { type: 'string' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]!]!
  const headerRow = (XLSX.utils.sheet_to_json(sheet, { header: 1 })[0] ?? []) as string[]
  headers.value = headerRow.filter(h => h && h.trim())
  rawRows.value = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: '' })
  mapping.value = headers.value.map((header) => {
    const match = importableFields.value.find(f =>
      f.columnName!.toLowerCase() === header.toLowerCase() || f.label?.toLowerCase() === header.toLowerCase()
    )
    return { header, target: match?.columnName ?? '' }
  })
}

/** CSV text -> the value a widget expects; an empty cell is null (left unset), not "". */
function coerce(raw: string, field: DataViewField): unknown {
  if (raw === '') return null
  if (field.widget === 'UInputNumber') {
    const n = Number(raw)
    return Number.isNaN(n) ? raw : n
  }
  if (field.widget === 'USwitch') return ['true', '1', 'yes', 'y'].includes(raw.trim().toLowerCase())
  return raw
}

async function runImport() {
  const headerByColumn = new Map(mapped.value.map(m => [m.target, m.header]))
  const fieldByColumn = new Map(importableFields.value.map(f => [f.columnName!, f]))
  const records = rawRows.value.map((row) => {
    const record: Record<string, unknown> = {}
    for (const [column, header] of headerByColumn) record[column] = coerce(row[header] ?? '', fieldByColumn.get(column)!)
    return record
  })
  importing.value = true
  result.value = null
  try {
    await dataApi.post(dataApi.resourcePath(props.schema, props.resourceName), { data: records }, { bulk: true })
    result.value = { created: records.length }
    emit('imported', records.length)
  } catch (err) {
    result.value = { error: errorMessage(err, t('common.unknownError')) }
  } finally {
    importing.value = false
  }
}
</script>

<template>
  <input
    ref="fileInput"
    type="file"
    accept=".csv"
    class="hidden"
    @change="onFileSelected"
  >
  <USlideover
    v-model:open="open"
    :title="t('dataviews.meta.featureLabels.import')"
  >
    <template #body>
      <div class="flex h-full flex-col gap-4">
        <UButton
          :label="fileName || t('dataviews.import.chooseFile')"
          icon="i-lucide-file-up"
          color="neutral"
          variant="outline"
          block
          @click="fileInput?.click()"
        />

        <template v-if="headers.length">
          <UFormField
            :label="t('dataviews.meta.featureLabels.columnsToggle')"
            :description="t('dataviews.import.columnsDescription')"
          >
            <div class="flex max-h-56 flex-col gap-2 overflow-y-auto rounded-lg border border-default p-2">
              <div
                v-for="item in mapping"
                :key="item.header"
                class="flex items-center gap-2"
              >
                <span class="w-1/2 truncate text-sm font-mono">{{ item.header }}</span>
                <UIcon
                  name="i-lucide-arrow-right"
                  class="size-4 shrink-0 text-muted"
                />
                <USelectMenu
                  :model-value="item.target || SELECT_NONE"
                  :items="targetItems"
                  value-key="value"
                  class="flex-1"
                  @update:model-value="(v: string) => item.target = v === SELECT_NONE ? '' : v"
                />
              </div>
            </div>
          </UFormField>

          <UAlert
            v-if="rawRows.length > warningThreshold"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('dataviews.import.slowWarning')"
          />
          <UFormField :label="t('dataviews.import.preview', { count: rawRows.length })">
            <UTable
              sticky
              :data="previewRows"
              :columns="previewColumns"
            />
          </UFormField>

          <UAlert
            v-if="result && 'error' in result"
            color="error"
            variant="subtle"
            :title="t('dataviews.import.nothingImported')"
            :description="result.error"
          />
          <UAlert
            v-else-if="result"
            color="success"
            variant="subtle"
            :title="t('dataviews.import.imported', { count: result.created })"
          />
        </template>
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          class="mt-auto"
          :title="t('dataviews.import.helpTitle')"
          :description="t('dataviews.import.helpDescription')"
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
          :label="t('dataviews.meta.featureLabels.import')"
          icon="i-lucide-upload"
          :disabled="!mapped.length"
          :loading="importing"
          @click="runImport"
        />
      </div>
    </template>
  </USlideover>
</template>
