<script setup lang="ts">
import { h } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import { UIcon } from '#components'
import type { Resource } from '~/types/resource'
import type { CatalogColumn } from '~/types/permission'
import type { DataApiResult } from '~/composables/useDataApi'
import { sortableHeader, type SortDirection } from '~/utils/sortable-header'

type Row = Record<string, unknown>
/** The "Add row" line: a sentinel first row of the UTable while adding. */
const NEW_ROW: Row = Object.freeze({}) as Row
const NEW_ROW_KEY = '__new_row__'

const props = defineProps<{ resource: Resource }>()
// Every action goes through the Data API, so each follows the method the
// resource exposes (Endpoints): no Add row without POST, no cell editing
// without PATCH, no selection or delete without DELETE.
const canCreate = computed(() => props.resource.exposedMethods.includes('POST'))
const canUpdate = computed(() => props.resource.exposedMethods.includes('PATCH'))
const canDelete = computed(() => props.resource.exposedMethods.includes('DELETE'))
const dataApi = useDataApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const page = ref(1)
const pageSize = ref(25)
const search = ref('')
const sort = ref('')
const filterColumn = ref('')
const filterValue = ref('')
const filterOpen = ref(false)
const selectedKeys = ref(new Set<string>())
const activeCell = ref<{ row: string, column: string } | null>(null)
const draft = ref('')
const saving = ref(false)
const addingRow = ref(false)
const newRow = ref<Record<string, string>>({})
// Columns with a DEFAULT or identity are left to PostgreSQL on a new row;
// clicking one opens its input to set it explicitly.
const overriddenDefaults = ref(new Set<string>())
const hasDefault = (column: CatalogColumn) => column.isIdentity || column.defaultExpression !== null
const asksValue = (column: CatalogColumn) => !hasDefault(column) || overriddenDefaults.value.has(column.name)
function overrideDefault(column: CatalogColumn) {
  overriddenDefaults.value = new Set([...overriddenDefaults.value, column.name])
}
const adding = ref(false)
const deleteOpen = ref(false)
const deleteConfirmed = ref(false)
const deleting = ref(false)
const columnWidths = ref<Record<string, number>>({})
const visibleColumnNames = ref<string[]>([])

const { detail, pending: detailPending, error: detailError } = useTableDetail(() => props.resource.id)
const columns = computed(() => detail.value?.columns ?? [])
const displayedColumns = computed(() => columns.value.filter(column => visibleColumnNames.value.includes(column.name)))
watch(columns, (value) => {
  if (!visibleColumnNames.value.length) visibleColumnNames.value = value.map(column => column.name)
}, { immediate: true })
const query = computed(() => ({
  limit: pageSize.value,
  offset: (page.value - 1) * pageSize.value,
  count: true,
  ...(search.value.trim() ? { search: search.value.trim() } : {}),
  ...(sort.value ? { order_by: sort.value } : {}),
  ...(filterColumn.value && filterValue.value ? { [`where[${filterColumn.value}][_ilike]`]: `%${filterValue.value}%` } : {})
}))
const { data: result, pending, error, refresh } = await useAsyncData(
  () => `resource-data-${props.resource.id}-${page.value}-${pageSize.value}-${search.value}-${sort.value}-${filterColumn.value}-${filterValue.value}`,
  () => dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(props.resource.schema, props.resource.name, props.resource.type === 'VIEW' ? 'view' : 'table'), query.value),
  { watch: [query], default: () => ({ data: [], meta: { count: 0 } } as DataApiResult<Record<string, unknown>[]>) }
)
const rows = computed(() => result.value?.data ?? [])
const total = computed(() => result.value?.meta?.count ?? rows.value.length)
const pageCount = computed(() => Math.max(1, Math.ceil(total.value / pageSize.value)))
const primaryKey = computed(() => detail.value?.primaryKey[0])
const loading = computed(() => detailPending.value || pending.value)
watch([search, pageSize, filterColumn, filterValue], () => {
  page.value = 1
})
watch(pageCount, (count) => {
  if (page.value > count) page.value = count
})

function rowKey(row: Row) {
  if (row === NEW_ROW) return NEW_ROW_KEY
  return String(row[primaryKey.value ?? ''] ?? '')
}
function display(value: unknown) {
  if (value === null || value === undefined) return 'NULL'
  return typeof value === 'object' ? JSON.stringify(value) : String(value)
}
function typeIcon(column: CatalogColumn) {
  const type = column.dataType.toLowerCase()
  if (type.includes('uuid')) return 'i-lucide-fingerprint'
  if (type.includes('json')) return 'i-lucide-braces'
  if (type.endsWith('[]')) return 'i-lucide-list'
  if (type.includes('bool')) return 'i-lucide-toggle-left'
  if (type.includes('date') || type.includes('time')) return 'i-lucide-calendar'
  if (/int|numeric|decimal|real|double|money/.test(type)) return 'i-lucide-hash'
  return 'i-lucide-type'
}
function columnWidth(column: CatalogColumn): number {
  return columnWidths.value[column.name] ?? (column.name === primaryKey.value ? 220 : 160)
}
function startColumnResize(event: PointerEvent, column: CatalogColumn) {
  event.preventDefault()
  const startX = event.clientX
  const startWidth = columnWidth(column)
  function onMove(moveEvent: PointerEvent) {
    columnWidths.value[column.name] = Math.max(96, startWidth + moveEvent.clientX - startX)
  }
  function onUp() {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
function startEdit(row: Record<string, unknown>, column: CatalogColumn) {
  if (!canUpdate.value || !primaryKey.value || column.name === primaryKey.value || column.isGenerated) return
  activeCell.value = { row: rowKey(row), column: column.name }
  draft.value = row[column.name] == null ? '' : display(row[column.name])
}
function cancelEdit() {
  activeCell.value = null
  draft.value = ''
}
function typedValue(value: string, column: CatalogColumn): unknown {
  if (!value && column.nullable) return null
  if (/^(boolean|bool)$/i.test(column.dataType)) return value === 'true'
  if (/^(json|jsonb)/i.test(column.dataType)) return JSON.parse(value)
  return value
}
async function saveCell(row: Record<string, unknown>, column: CatalogColumn) {
  if (!activeCell.value || saving.value || !primaryKey.value) return
  let value: unknown
  try {
    value = typedValue(draft.value, column)
  } catch {
    toast.add({ title: t('database.resourceDataGrid.invalidValue'), color: 'error' })
    return
  }
  saving.value = true
  try {
    await dataApi.patch(dataApi.resourcePath(props.resource.schema, props.resource.name, 'table', String(row[primaryKey.value])), { data: { [column.name]: value } })
    row[column.name] = value
    cancelEdit()
  } catch (err) {
    notifyError(err, t('database.resourceDataGrid.updateCellError'))
  } finally { saving.value = false }
}
function openAdd() {
  if (!canCreate.value) return
  newRow.value = Object.fromEntries(columns.value.filter(column => !column.isGenerated).map(column => [column.name, '']))
  overriddenDefaults.value = new Set()
  addingRow.value = true
}
function cancelAdd() {
  addingRow.value = false
  newRow.value = {}
}
async function addRow() {
  adding.value = true
  try {
    // An empty field is left out: PostgreSQL then applies the column's
    // DEFAULT (identity included), or NULL when it has none. Only a NOT NULL
    // column without a default still gets '' - its own constraint decides.
    const data = Object.fromEntries(Object.entries(newRow.value).flatMap(([key, value]) => {
      const column = columns.value.find(item => item.name === key)
      if (!column) return [[key, value]]
      if (value === '' && (hasDefault(column) || column.nullable)) return []
      return [[key, typedValue(String(value), column)]]
    }))
    await dataApi.post(dataApi.resourcePath(props.resource.schema, props.resource.name), { data })
    toast.add({ title: t('database.resourceDataGrid.rowAdded'), color: 'success' })
    cancelAdd()
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceDataGrid.addRowError'))
  } finally { adding.value = false }
}
function toggleRow(row: Record<string, unknown>) {
  const next = new Set(selectedKeys.value)
  const key = rowKey(row)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  selectedKeys.value = next
}
const allSelected = computed(() => rows.value.length > 0 && rows.value.every(row => selectedKeys.value.has(rowKey(row))))
function toggleAll() {
  const next = new Set(selectedKeys.value)
  if (allSelected.value) rows.value.forEach(row => next.delete(rowKey(row)))
  else rows.value.forEach(row => next.add(rowKey(row)))
  selectedKeys.value = next
}
function sortDirection(column: CatalogColumn): SortDirection {
  if (sort.value === column.name) return 'asc'
  if (sort.value === `-${column.name}`) return 'desc'
  return false
}
/** Ascending -> descending -> unsorted. */
function toggleSort(column: CatalogColumn) {
  if (sort.value === column.name) sort.value = `-${column.name}`
  else if (sort.value === `-${column.name}`) sort.value = ''
  else sort.value = column.name
}
function copyRow(row: Record<string, unknown>) {
  navigator.clipboard?.writeText(JSON.stringify(row, null, 2))
  toast.add({ title: t('database.resourceDataGrid.rowCopied'), color: 'success' })
}
function rowActions(row: Record<string, unknown>) {
  return [[
    { label: t('database.resourceDataGrid.copyRow'), icon: 'i-lucide-copy', onSelect: () => copyRow(row) },
    { label: t('database.resourceDataGrid.selectRow'), icon: 'i-lucide-check', onSelect: () => {
      selectedKeys.value = new Set([...selectedKeys.value, rowKey(row)])
    } }
  ]]
}
async function confirmDelete() {
  if (!primaryKey.value) return
  deleting.value = true
  try {
    await dataApi.del(dataApi.resourcePath(props.resource.schema, props.resource.name), { bulk: true }, { data: rows.value.filter(row => selectedKeys.value.has(rowKey(row))).map(row => ({ [primaryKey.value!]: row[primaryKey.value!] })) })
    toast.add({ title: t('database.resourceDataGrid.rowsDeleted'), color: 'success' })
    selectedKeys.value = new Set()
    deleteOpen.value = false
    deleteConfirmed.value = false
    await refresh()
  } catch (err) {
    notifyError(err, t('database.resourceDataGrid.deleteRowsError'))
  } finally { deleting.value = false }
}
const isMobile = useIsMobile()

const tableData = computed<Row[]>(() => (addingRow.value ? [NEW_ROW, ...rows.value] : rows.value))
/** UTable's own selected-row look follows the selection kept here. */
const rowSelection = computed(() => Object.fromEntries([...selectedKeys.value].map(key => [key, true])))
const SELECT_COLUMN = '__select'
const ACTIONS_COLUMN = '__actions'
/**
 * One column per visible PostgreSQL column: its type icon beside the
 * shared sortable header (server-side sort), and a drag handle on the
 * header's right edge that resizes it. Cells are the `#<name>-cell` slots.
 */
const tableColumns = computed<TableColumn<Row>[]>(() => [
  ...(canDelete.value ? [{ id: SELECT_COLUMN }] : []),
  ...displayedColumns.value.map((column): TableColumn<Row> => ({
    id: column.name,
    accessorFn: row => row[column.name],
    meta: { class: { th: 'relative' } },
    header: () => h('div', { class: 'flex items-center gap-1', style: { width: `${columnWidth(column)}px` } }, [
      h(UIcon, { name: typeIcon(column), class: 'size-3.5 shrink-0 text-muted' }),
      sortableHeader(column.name, sortDirection(column), () => toggleSort(column)),
      h('span', {
        'class': 'absolute inset-y-0 right-0 w-1 cursor-col-resize hover:bg-primary/40',
        'aria-hidden': 'true',
        'onPointerdown': (event: PointerEvent) => {
          event.stopPropagation()
          startColumnResize(event, column)
        }
      })
    ])
  })),
  { id: ACTIONS_COLUMN }
])
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-0">
    <UAlert
      v-if="detailError || error"
      color="error"
      variant="subtle"
      :title="(detailError ?? error)?.message"
    />
    <!-- A phone: one row - Filter, Columns and Delete selected icon-only,
    the search taking the rest of the width. -->
    <div
      class="flex items-center gap-2 px-2 py-2 shrink-0"
      :class="isMobile ? undefined : 'flex-wrap'"
    >
      <!-- The span carries the tooltip: a disabled button gets no pointer events. -->
      <UTooltip
        :text="t('database.resourceDataGrid.addRowNeedsPost')"
        :disabled="canCreate"
      >
        <span class="inline-flex">
          <UButton
            :label="t('database.resourceDataGrid.addRow')"
            icon="i-lucide-plus"
            color="primary"
            :disabled="!canCreate"
            @click="openAdd"
          />
        </span>
      </UTooltip>
      <UButton
        v-if="canDelete && selectedKeys.size"
        :label="isMobile ? undefined : t('database.resourceDataGrid.deleteSelected')"
        :aria-label="t('database.resourceDataGrid.deleteSelected')"
        icon="i-lucide-trash-2"
        color="error"
        variant="soft"
        :square="isMobile"
        @click="deleteOpen = true"
      />
      <UPopover v-model:open="filterOpen">
        <UButton
          :label="isMobile ? undefined : t('database.resourceDataGrid.filter')"
          :aria-label="t('database.resourceDataGrid.filter')"
          icon="i-lucide-list-filter"
          color="neutral"
          variant="subtle"
          :square="isMobile"
        />
        <template #content>
          <div class="flex w-72 flex-col gap-3 p-3">
            <UFormField :label="t('database.resourceDataGrid.column')">
              <USelect
                v-model="filterColumn"
                :items="columns.map(column => ({ label: column.name, value: column.name }))"
                class="w-full"
              />
            </UFormField>
            <UFormField
              :label="t('common.value')"
              :description="t('database.resourceDataGrid.valueHelp')"
            >
              <UInput
                v-model="filterValue"
                class="w-full"
              />
            </UFormField>
            <UButton
              :label="t('database.resourceDataGrid.clearFilter')"
              color="neutral"
              variant="ghost"
              :disabled="!filterColumn && !filterValue"
              @click="filterColumn = ''; filterValue = ''; filterOpen = false"
            />
          </div>
        </template>
      </UPopover>
      <UPopover>
        <UButton
          :label="isMobile ? undefined : t('database.resourceDataGrid.columns')"
          :aria-label="t('database.resourceDataGrid.columns')"
          icon="i-lucide-columns-3"
          color="neutral"
          variant="subtle"
          :square="isMobile"
        />
        <template #content>
          <div class="flex w-56 flex-col gap-2 p-3">
            <UCheckbox
              v-for="column in columns"
              :key="column.name"
              v-model="visibleColumnNames"
              :value="column.name"
              :label="column.name"
            />
          </div>
        </template>
      </UPopover>
      <div
        v-if="!isMobile"
        class="flex-1"
      />
      <UInput
        v-model="search"
        icon="i-lucide-search"
        :aria-label="t('database.resourceDataGrid.searchRows')"
        :class="isMobile ? 'min-w-0 flex-1' : 'w-64'"
      />
      <UButton
        icon="i-lucide-refresh-cw"
        color="neutral"
        variant="outline"
        square
        :aria-label="t('common.refresh')"
        :loading="pending"
        @click="() => refresh()"
      />
    </div>
    <p
      v-if="addingRow"
      class="shrink-0 px-2 pb-2 text-xs text-muted"
    >
      {{ t('database.resourceDataGrid.newRowHelp') }}
    </p>
    <UTable
      sticky
      :data="tableData"
      :columns="tableColumns"
      :row-selection="rowSelection"
      :get-row-id="(row: Row, index: number) => primaryKey ? rowKey(row) : String(index)"
      :loading="loading"
      class="min-h-0 flex-1"
    >
      <template #__select-header>
        <UCheckbox
          :model-value="allSelected"
          :aria-label="t('database.resourceDataGrid.selectVisibleRows')"
          @update:model-value="toggleAll"
        />
      </template>
      <template #__select-cell="{ row }">
        <UIcon
          v-if="row.original === NEW_ROW"
          name="i-lucide-plus"
          class="size-4 text-primary"
        />
        <UCheckbox
          v-else
          :model-value="selectedKeys.has(rowKey(row.original))"
          :aria-label="t('database.resourceDataGrid.selectRowAria', { key: rowKey(row.original) })"
          @update:model-value="toggleRow(row.original)"
        />
      </template>
      <template
        v-for="column in displayedColumns"
        :key="column.name"
        #[`${column.name}-cell`]="{ row }"
      >
        <div :style="{ width: `${columnWidth(column)}px` }">
          <template v-if="row.original === NEW_ROW">
            <span
              v-if="column.isGenerated"
              class="text-xs italic"
            >{{ t('database.resourceDataGrid.generated') }}</span>
            <UInput
              v-else-if="asksValue(column)"
              v-model="newRow[column.name]"
              size="sm"
              class="w-full"
              :aria-label="column.name"
              :autofocus="!overriddenDefaults.has(column.name) || undefined"
            />
            <UTooltip
              v-else
              :text="t('database.resourceDataGrid.setDefaultColumn')"
            >
              <button
                type="button"
                class="max-w-full truncate rounded px-1 text-left font-mono text-xs italic text-muted hover:bg-elevated hover:text-default"
                :aria-label="t('database.resourceDataGrid.setColumnValue', { column: column.name })"
                @click="overrideDefault(column)"
              >
                {{ column.isIdentity ? t('database.resourceDataGrid.identity') : column.defaultExpression }}
              </button>
            </UTooltip>
          </template>
          <UInput
            v-else-if="activeCell?.row === rowKey(row.original) && activeCell.column === column.name"
            v-model="draft"
            size="sm"
            class="w-full"
            :aria-label="column.name"
            autofocus
            :disabled="saving"
            @keydown.enter.prevent="saveCell(row.original, column)"
            @keydown.esc="cancelEdit"
            @blur="saveCell(row.original, column)"
          />
          <span
            v-else
            class="block truncate"
            :class="[row.original[column.name] === null ? 'italic' : 'text-default', canUpdate ? 'cursor-text' : undefined]"
            :title="display(row.original[column.name])"
            @dblclick="startEdit(row.original, column)"
          >{{ display(row.original[column.name]) }}</span>
        </div>
      </template>
      <template #__actions-cell="{ row }">
        <div
          v-if="row.original === NEW_ROW"
          class="flex justify-end"
        >
          <UButton
            icon="i-lucide-check"
            color="primary"
            size="xs"
            square
            :aria-label="t('database.resourceDataGrid.saveRow')"
            :loading="adding"
            @click="addRow"
          />
          <UButton
            icon="i-lucide-x"
            color="neutral"
            variant="ghost"
            size="xs"
            square
            :aria-label="t('database.resourceDataGrid.cancelRow')"
            :disabled="adding"
            @click="cancelAdd"
          />
        </div>
        <div
          v-else
          class="flex justify-end"
        >
          <UDropdownMenu :items="rowActions(row.original)">
            <UButton
              icon="i-lucide-ellipsis-vertical"
              color="neutral"
              variant="ghost"
              size="xs"
              square
              :aria-label="t('database.resourceDataGrid.rowActions')"
            />
          </UDropdownMenu>
        </div>
      </template>
      <template #empty>
        <UEmpty
          v-if="loading"
          loading
          variant="naked"
          size="sm"
        />
        <UEmpty
          v-else
          variant="naked"
          icon="i-lucide-table-2"
          :title="t('database.resourceDataGrid.empty')"
          :actions="canCreate ? [{ label: t('database.resourceDataGrid.addRow'), icon: 'i-lucide-plus', onClick: openAdd }] : []"
        />
      </template>
    </UTable>
    <TablePager
      v-model:page="page"
      v-model:page-size="pageSize"
      :total="total"
      :noun="t('database.resourceDataGrid.nounRecord')"
      :plural="t('database.resourceDataGrid.nounRecords')"
      :page-size-options="[25, 50, 100]"
      class="shrink-0 px-2"
    />
    <UModal
      v-model:open="deleteOpen"
      :title="t('database.resourceDataGrid.deleteTitle')"
    >
      <template #body>
        <p class="text-sm text-muted">
          {{ t('database.resourceDataGrid.deleteBody', { n: selectedKeys.size }) }}
        </p>
      </template><template #footer>
        <div class="flex w-full items-center justify-between gap-3">
          <label class="flex items-center gap-2 cursor-pointer text-sm"><UCheckbox v-model="deleteConfirmed" /> {{ t('common.confirm') }}</label><div class="flex gap-2">
            <UButton
              :label="t('common.cancel')"
              color="neutral"
              variant="ghost"
              @click="deleteOpen = false"
            /><UButton
              :label="t('common.delete')"
              color="error"
              :disabled="!deleteConfirmed"
              :loading="deleting"
              @click="confirmDelete"
            />
          </div>
        </div>
      </template>
    </UModal>
  </div>
</template>
