<script setup lang="ts">
/**
 * Edit the rows the viewer chose together (DataViews.md §5.15) - by their keys, from any page; never
 * a set resolved by a filter or a search: only the fields added here - each with the control its column takes
 * (RecordValueInput), Leave empty where it may be null. One transaction: a row PostgreSQL refuses (a CHECK, the
 * viewer's row filter, one gone) and none changes. Audited row by row.
 */
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ColumnPresentation } from '@totalbase/tb-catalog'
import type { DataViewField } from '~/types/dataview'
import { formEditableColumns } from '~/utils/form-editable-columns'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import { recordColumns, type RecordCatalog, type RecordColumn } from '~/utils/record-engine'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { AdminApiError } from '~/utils/admin-api-error'

const open = defineModel<boolean>('open', { required: true })
const props = defineProps<{
  dataviewId: string
  schema: string
  table: string
  primaryKey: string
  fields: DataViewField[]
  /** The rows chosen - from any page. */
  rows: Record<string, unknown>[]
  /** Its columns' presentation (the DataView's `columnPresentation` for its table) - their titles. */
  presentation?: Record<string, ColumnPresentation>
}>()
const emit = defineEmits<{ applied: [] }>()

const { t } = useI18n()
const appApi = useAppApi()
const toast = useToast()
const apiError = useApiErrorMessage()

const columns = ref<Record<string, RecordColumn>>({})
onMounted(async () => {
  try {
    columns.value = recordColumns((await appApi.get<RecordCatalog>(`/dataviews/${props.dataviewId}/record`)).data)
  } catch {
    columns.value = {}
  }
})
const fieldOf = (name: string) => props.fields.find(f => f.columnName === name)
/**
 * What may be changed: the fields its record form lets a viewer edit, in the form's order and titled as there
 * (form-editable-columns.ts) - each a column this viewer may update, never the key. A page without such a form: every
 * column they may update, titled by its presentation.
 */
const formColumns = computed(() => formEditableColumns(props.fields, props.presentation))
const editable = computed(() => {
  const updatable = (name: string) => columns.value[name]?.updatable && name !== props.primaryKey
  if (formColumns.value.length) return formColumns.value.filter(f => updatable(f.column))
  return Object.keys(columns.value).filter(updatable).map(column => ({ column, label: props.presentation?.[column]?.label ?? humanizeColumnName(column) }))
})
const labelOf = (name: string) => editable.value.find(f => f.column === name)?.label ?? props.presentation?.[name]?.label ?? humanizeColumnName(name)

/** The fields added, in order - each its value, or emptied. */
const chosen = ref<{ name: string, value: unknown, empty: boolean }[]>([])
const addItems = computed<DropdownMenuItem[][]>(() => [editable.value
  .filter(c => !chosen.value.some(f => f.name === c.column))
  .map(c => ({ label: c.label, onSelect: () => chosen.value.push({ name: c.column, value: columns.value[c.column]?.literalDefault ?? null, empty: false }) }))])
const remove = (name: string) => (chosen.value = chosen.value.filter(f => f.name !== name))

const target = computed(() => props.rows.length)
const applying = ref(false)

async function apply() {
  if (chosen.value.length === 0) return
  const data = Object.fromEntries(chosen.value.map(f => [f.name, f.empty ? null : f.value]))
  applying.value = true
  const notice = toast.add({ title: t('dataviews.bulkEdit.applying', { n: target.value }), color: 'neutral', duration: 0 })
  try {
    // Exactly the rows chosen, by their keys - the server writes those, as the viewer, or none.
    const keys = props.rows.map(row => row[props.primaryKey])
    const { data: result } = await appApi.post<{ updated: number }>(`/dataviews/${props.dataviewId}/bulk-update`, { data: { set: data, keys } })
    toast.add({ title: t('dataviews.bulkEdit.done', { n: result.updated }), color: 'success' })
    open.value = false
    emit('applied')
  } catch (error) {
    // A row gone or outside what the viewer may edit - which one isn't said (a hidden row's existence never is).
    const gone = error instanceof AdminApiError && error.code === 'ROW_NOT_FOUND'
    toast.add({ title: t('dataviews.bulkEdit.failed'), description: gone ? t('dataviews.bulkEdit.rowGone') : apiError(error, t('common.unknownError')), color: 'error' })
  } finally {
    toast.remove(notice.id)
    applying.value = false
  }
}
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('dataviews.bulkEdit.title', { n: target })"
    :description="t('dataviews.bulkEdit.description')"
    :ui="{ content: 'max-w-lg' }"
  >
    <template #body>
      <div class="flex flex-col gap-5">
        <p class="text-sm text-muted">
          {{ t('dataviews.bulkEdit.chosen', { n: target }) }}
        </p>
        <UEmpty
          v-if="chosen.length === 0"
          icon="i-lucide-pencil-line"
          :title="t('dataviews.bulkEdit.emptyTitle')"
          :description="t('dataviews.bulkEdit.emptyDescription')"
          variant="naked"
        />
        <div
          v-for="item in chosen"
          :key="item.name"
          class="flex flex-col gap-2 rounded-md border border-default p-3"
        >
          <div class="flex items-center justify-between gap-2">
            <p class="text-sm font-medium">
              {{ labelOf(item.name) }}
            </p>
            <UButton
              icon="i-lucide-trash-2"
              color="neutral"
              variant="ghost"
              size="xs"
              :aria-label="t('dataviews.bulkEdit.removeField', { name: labelOf(item.name) })"
              @click="remove(item.name)"
            />
          </div>
          <RecordValueInput
            v-if="!item.empty && columns[item.name]"
            v-model="item.value"
            :meta="columns[item.name]!"
            :field="fieldOf(item.name)"
            :label="labelOf(item.name)"
          />
          <UCheckbox
            v-if="columns[item.name]?.nullable"
            v-model="item.empty"
            :label="t('dataviews.bulkEdit.leaveEmpty')"
          />
        </div>
        <div>
          <UDropdownMenu
            :items="addItems"
            :content="{ align: 'start' }"
          >
            <UButton
              icon="i-lucide-plus"
              :label="t('dataviews.bulkEdit.addField')"
              color="neutral"
              variant="outline"
              :disabled="addItems[0]!.length === 0"
            />
          </UDropdownMenu>
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
          :label="t('dataviews.bulkEdit.applyTo', { n: target })"
          :disabled="chosen.length === 0 || target === 0"
          :loading="applying"
          @click="apply"
        />
      </div>
    </template>
  </USlideover>
</template>
