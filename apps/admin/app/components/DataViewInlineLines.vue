<script setup lang="ts">
/**
 * A record's lines edited in place (DataViews.md §6.6, §9.7 Edit in the grid) - a master-detail's
 * items: each line a row of inputs, Tab from cell to cell and, past the last one, a new line; a line removed with
 * its ✕. Nothing is written as the viewer types: the changes join the page record's save (`record.attach`), header
 * and lines in one transaction - PostgreSQL decides it whole. Cancel drops them.
 *
 * What a cell offers comes from the table, read live: its type, its CHECK list, its foreign key (shown by the
 * column's display field), whether this viewer may write it on a new line or an existing one.
 */
import { nextTick } from 'vue'
import type { TableColumn } from '@nuxt/ui'
import { recordColumns, type RecordCatalog, type RecordColumn, type RecordHandle, type RecordLines, type RecordWriteOperation } from '~/utils/record-engine'
import { flattenQueryObject } from '~/utils/flatten-query-object'
import { resolveFieldPresentation } from '~/utils/field-presentation'
import { formatCellPlainText } from '~/utils/build-dataview-columns'
import type { TotalKind } from '~/utils/column-totals'
import { foreignKeyDisplay, foreignKeySearch, type ForeignKeyDisplay } from '~/utils/foreign-key-display'
import type { DataViewField } from '~/types/dataview'

const props = defineProps<{
  record: RecordHandle
  /** The lines' DataView - its id, its table. */
  dataviewId: string
  schema: string
  table: string
  fields: DataViewField[]
  primaryKey: string | null
  /** The lines' column pointing at the record. */
  column: string
  /** The record's key - null while it's new (its lines then take the key it gets, in the same save). */
  recordKey: unknown
  /** The lines' own filter AND the record's - which rows are its lines. */
  forcedWhere: Record<string, unknown>
  canCreate: boolean
  canWrite: boolean
  canDelete: boolean
  newLabel?: string
  /** Their order - the DataView's default sort (`default_state.sort`). */
  orderBy?: string
}>()

const { t } = useI18n()
const { defaults: displayFormatDefaults } = useDisplayFormatDefaults()
const appApi = useAppApi()
const dataApi = useDataApi()

/** One line: as read (`original`, null for a new one), as edited, and whether it's on its way out. */
interface Line {
  id: string
  pk: unknown
  original: Record<string, unknown> | null
  values: Record<string, unknown>
  removed: boolean
}
const lines = ref<Line[]>([])
const columnsMeta = ref<Record<string, RecordColumn>>({})
const loading = ref(true)
const failed = ref(false)
let nextId = 0

/** The cells: its shown columns but its key and the one linking it to the record, as the grid titles them. */
const cells = computed(() => props.fields
  .filter(f => f.kind === 'COLUMN' && f.visible && f.columnName && f.columnName !== props.column && f.columnName !== props.primaryKey && columnsMeta.value[f.columnName])
  .map(f => resolveFieldPresentation(f))
  .map(f => ({ field: f, name: f.columnName!, meta: columnsMeta.value[f.columnName!]!, label: f.label ?? f.columnName! })))

/** The table's columns: one per cell - its total at the foot, live over the lines on screen - then the line's ✕. */
const tableColumns = computed<TableColumn<Line>[]>(() => [
  ...cells.value.map(c => (lineTotal(c) === null ? { id: c.name } : { id: c.name, footer: () => lineTotal(c) ?? '' })),
  { id: 'actions', meta: { class: { th: 'w-10', td: 'w-10' } } }
])
/**
 * A column's total (`config.total`, DataViews.md §4.9) over the lines as they are now - the unsaved
 * ones included, a removed one not: an invoice's total as its lines are typed. Formatted as its cells.
 */
function lineTotal(cell: { field: DataViewField, name: string, meta: RecordColumn }): string | null {
  const kind = (cell.field.config as { total?: TotalKind }).total
  if (!kind) return null
  // A column PostgreSQL computes (an amount) has no value on a line not saved yet: its total waits for the save.
  if (cell.meta.generated && lineWrites.pending()) return t('dataviews.totals.whenSaved')
  const values = lines.value.filter(l => !l.removed).map(l => l.values[cell.name]).filter(v => v !== null && v !== undefined && v !== '')
  if (kind === 'count') return t('dataviews.totals.count', { value: values.length })
  const numbers = values.map(Number).filter(Number.isFinite)
  if (numbers.length === 0) return null
  const value = kind === 'sum'
    ? numbers.reduce((a, b) => a + b, 0)
    : kind === 'avg'
      ? numbers.reduce((a, b) => a + b, 0) / numbers.length
      : kind === 'min' ? Math.min(...numbers) : Math.max(...numbers)
  return t(`dataviews.totals.${kind}`, { value: formatCellPlainText(cell.field, value, {}, displayFormatDefaults.value) })
}
/** A line on its way out shows struck through. */
const tableMeta = { class: { tr: (row: { original: Line }) => (row.original.removed ? 'opacity-50 line-through' : '') } }
/** A cell this viewer can't write (an amount PostgreSQL computes): as the grid shows it, a foreign key by its display. */
function shown(line: Line, name: string): string {
  const value = line.values[name]
  if (columnsMeta.value[name]?.foreignKey && value !== null && value !== undefined) return fkLabels[name]?.[String(value)] ?? String(value)
  const cell = cells.value.find(c => c.name === name)
  return cell ? formatCellPlainText(cell.field, value, line.values, displayFormatDefaults.value) : String(value ?? '')
}
/**
 * Where the last save's errors point: a column, and the line - its operation (`line<N>`) when PostgreSQL's failure
 * came from one; else every changed line in that column.
 */
const cellErrors = computed(() => (props.record.error?.errors ?? []).filter(e => e.field).map(e => ({ column: e.field!, line: /^line(\d+)$/.exec(e.operation ?? '')?.[1] })))
function cellError(line: Line, name: string): boolean {
  const index = lines.value.indexOf(line) + 1
  return cellErrors.value.some(e => e.column === name && (e.line !== undefined
    ? Number(e.line) === index
    : line.original === null || JSON.stringify(line.values[name] ?? null) !== JSON.stringify(line.original[name] ?? null)))
}
const editable = (line: Line, meta: RecordColumn) => (line.original === null ? props.canCreate && meta.creatable : props.canWrite && meta.updatable)

async function load() {
  loading.value = true
  failed.value = false
  try {
    if (Object.keys(columnsMeta.value).length === 0) {
      columnsMeta.value = recordColumns((await appApi.get<RecordCatalog>(`/dataviews/${props.dataviewId}/record`)).data)
    }
    const names = [...new Set([props.primaryKey, ...cells.value.map(c => c.name)].filter((n): n is string => !!n))]
    const rows = props.recordKey === null || props.recordKey === undefined
      ? []
      : (await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(props.schema, props.table), {
          fields: names.join(','),
          limit: 500,
          // The DataView's own order (a line number), else its key - a reread never reshuffles them.
          ...(props.orderBy ? { order_by: props.orderBy } : props.primaryKey ? { order_by: props.primaryKey } : {}),
          ...flattenQueryObject(props.forcedWhere, 'where')
        })).data
    lines.value = rows.map(row => ({ id: `l${nextId++}`, pk: props.primaryKey ? row[props.primaryKey] : null, original: { ...row }, values: { ...row }, removed: false }))
    await loadLabels()
  } catch {
    failed.value = true
  } finally {
    loading.value = false
    props.record.linesChanged()
  }
}
watch(() => props.recordKey, () => void load(), { immediate: true })

// --- Foreign keys: each shown by its display field, offered by searching it. ---
/** A foreign key cell's options, by column: the rows found for its search, plus the ones its lines already hold. */
const fkLabels = reactive<Record<string, Record<string, string>>>({})
const fkOptions = reactive<Record<string, { value: unknown, label: string }[]>>({})
/** How a foreign key's row reads - its row presentation (foreign-key-display.ts). */
function displayOf(name: string): ForeignKeyDisplay {
  return foreignKeyDisplay(props.fields.find(f => f.columnName === name), columnsMeta.value[name]?.foreignKey?.column ?? name)
}
async function searchFk(name: string, term = '') {
  const fk = columnsMeta.value[name]?.foreignKey
  if (!fk) return
  const display = displayOf(name)
  // A search finds it by any column its display shows.
  const where = foreignKeySearch(display, term)
  const search = where ? flattenQueryObject(where, 'where') : {}
  try {
    const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(fk.schema, fk.table), {
      fields: [...new Set([fk.column, ...display.columns])].join(','),
      limit: 20,
      order_by: display.columns[0],
      ...search
    })
    const labels = (fkLabels[name] ??= {})
    fkOptions[name] = data.map((row) => {
      labels[String(row[fk.column])] = display.text(row)
      return { value: row[fk.column], label: display.text(row) }
    })
  } catch {
    fkOptions[name] = []
  }
}
/** What the lines already hold, titled - read once per load. */
async function loadLabels() {
  for (const { name, meta } of cells.value) {
    if (!meta.foreignKey) continue
    const keys = [...new Set(lines.value.map(l => l.values[name]).filter(v => v !== null && v !== undefined).map(String))]
    if (keys.length === 0) continue
    const display = displayOf(name)
    try {
      const { data } = await dataApi.get<Record<string, unknown>[]>(dataApi.resourcePath(meta.foreignKey.schema, meta.foreignKey.table), {
        fields: [...new Set([meta.foreignKey.column, ...display.columns])].join(','),
        [`where[${meta.foreignKey.column}][_in]`]: keys.join(','),
        limit: keys.length
      })
      const labels = (fkLabels[name] ??= {})
      for (const row of data) labels[String(row[meta.foreignKey.column])] = display.text(row)
    } catch {
      // Not readable: the key itself shows.
    }
  }
}
function fkItems(name: string, line: Line) {
  const current = line.values[name]
  const found = fkOptions[name] ?? []
  if (current === null || current === undefined || found.some(o => String(o.value) === String(current))) return found
  return [{ value: current, label: fkLabels[name]?.[String(current)] ?? String(current) }, ...found]
}

// --- Editing ---
function set(line: Line, name: string, value: unknown) {
  line.values[name] = value
  props.record.linesChanged()
}
function checkItems(field: DataViewField, meta: RecordColumn) {
  const options = (field.inherited?.options ?? {}) as Record<string, { label?: string }>
  return (meta.values ?? []).map(v => ({ value: v, label: options[String(v)]?.label ?? String(v) }))
}
const isNumber = (type: string) => /^(smallint|integer|bigint|real|double precision|numeric)/.test(type)
const inputType = (type: string) => (type === 'date' ? 'date' : type.startsWith('timestamp') ? 'datetime-local' : isNumber(type) ? 'number' : 'text')
function fromInput(meta: RecordColumn, raw: string | number | null | undefined): unknown {
  if (raw === '' || raw === null || raw === undefined) return null
  if (/^(smallint|integer|real|double precision)$/.test(meta.dataType)) return Number(raw)
  return raw
}

const tableEl = ref<HTMLElement | null>(null)
async function add() {
  const values: Record<string, unknown> = {}
  for (const meta of Object.values(columnsMeta.value)) if (meta.creatable && meta.literalDefault !== undefined) values[meta.name] = meta.literalDefault
  lines.value.push({ id: `l${nextId++}`, pk: null, original: null, values, removed: false })
  props.record.linesChanged()
  await nextTick()
  // The new line's first input, ready to type.
  const rows = tableEl.value?.querySelectorAll<HTMLElement>('tbody tr')
  rows?.[rows.length - 1]?.querySelector<HTMLElement>('input, button[role="combobox"], [role="combobox"]')?.focus()
}
function remove(line: Line) {
  if (line.original === null) lines.value = lines.value.filter(l => l !== line)
  else line.removed = !line.removed
  props.record.linesChanged()
}
/** Tab past the last cell of the last line: a new line. */
function onKeydown(event: KeyboardEvent) {
  if (event.key !== 'Tab' || event.shiftKey || !props.canCreate) return
  const inputs = [...(tableEl.value?.querySelectorAll<HTMLElement>('[data-cell-input]') ?? [])]
  const last = inputs[inputs.length - 1]
  if (last && (last === event.target || last.contains(event.target as Node))) {
    event.preventDefault()
    void add()
  }
}

// --- Its part of the record's save ---
const changed = (line: Line) => Object.fromEntries(Object.entries(line.values).filter(([name, value]) => {
  const meta = columnsMeta.value[name]
  return meta?.updatable && JSON.stringify(value ?? null) !== JSON.stringify(line.original?.[name] ?? null)
}))
const filled = (line: Line) => Object.entries(line.values).some(([name, value]) => value !== null && value !== undefined && value !== '' && columnsMeta.value[name]?.literalDefault !== value)
const lineWrites: RecordLines = {
  pending: () => lines.value.some(l => (l.original === null ? filled(l) : l.removed || Object.keys(changed(l)).length > 0)),
  operations(recordKey): RecordWriteOperation[] {
    const table = { schema: props.schema, table: props.table }
    return lines.value.flatMap((line, index): RecordWriteOperation[] => {
      const key = `line${index + 1}`
      if (line.original === null) {
        if (!filled(line)) return []
        const data = Object.fromEntries(Object.entries(line.values).filter(([name, value]) => columnsMeta.value[name]?.creatable && value !== null && value !== undefined && value !== ''))
        return [{ key, operation: 'insert', ...table, data: { ...data, [props.column]: recordKey } }]
      }
      if (line.removed) return [{ key, operation: 'delete', ...table, id: line.pk }]
      const data = changed(line)
      return Object.keys(data).length ? [{ key, operation: 'update', ...table, id: line.pk, data }] : []
    })
  },
  saved: () => void load(),
  discard() {
    lines.value = lines.value.filter(l => l.original !== null).map(l => ({ ...l, values: { ...l.original! }, removed: false }))
  }
}
const detach = props.record.attach(lineWrites)
onBeforeUnmount(detach)
</script>

<template>
  <UEmpty
    v-if="loading && lines.length === 0"
    loading
    variant="naked"
    size="sm"
  />
  <UEmpty
    v-else-if="failed"
    icon="i-lucide-eye-off"
    :title="t('dataviews.widgetDataView.notAvailableTitle')"
    :description="t('dataviews.widgetDataView.notAvailableDescription')"
    variant="naked"
  />
  <div
    v-else
    ref="tableEl"
    class="flex h-full w-full flex-col gap-2"
    @keydown="onKeydown"
  >
    <UTable
      :data="lines"
      :columns="tableColumns"
      :meta="tableMeta"
      :get-row-id="(line: Line) => line.id"
      sticky
      class="min-h-0"
    >
      <template
        v-for="cell in cells"
        :key="cell.name"
        #[`${cell.name}-header`]
      >
        {{ cell.label }}<span
          v-if="cell.meta.required"
          class="text-error"
          aria-hidden="true"
        >*</span>
      </template>
      <template
        v-for="cell in cells"
        :key="cell.name"
        #[`${cell.name}-cell`]="{ row }"
      >
        <template v-if="editable(row.original, cell.meta) && !row.original.removed">
          <USelectMenu
            v-if="cell.meta.foreignKey"
            data-cell-input
            :model-value="row.original.values[cell.name] as never"
            :color="cellError(row.original, cell.name) ? 'error' : undefined"
            :highlight="cellError(row.original, cell.name)"
            :items="fkItems(cell.name, row.original)"
            value-key="value"
            label-key="label"
            :aria-label="t('dataviews.inlineLines.cell', { column: cell.label, line: row.index + 1 })"
            size="sm"
            class="w-full min-w-32"
            ignore-filter
            :search-input="{ placeholder: t('common.search') }"
            @update:open="(open: boolean) => open && searchFk(cell.name)"
            @update:search-term="(term: string) => searchFk(cell.name, term)"
            @update:model-value="(value: unknown) => set(row.original, cell.name, value)"
          />
          <USelect
            v-else-if="cell.meta.values"
            data-cell-input
            :model-value="row.original.values[cell.name] as never"
            :color="cellError(row.original, cell.name) ? 'error' : undefined"
            :highlight="cellError(row.original, cell.name)"
            :items="checkItems(cell.field, cell.meta)"
            :aria-label="t('dataviews.inlineLines.cell', { column: cell.label, line: row.index + 1 })"
            size="sm"
            class="w-full min-w-28"
            @update:model-value="(value: unknown) => set(row.original, cell.name, value)"
          />
          <UCheckbox
            v-else-if="cell.meta.dataType === 'boolean'"
            data-cell-input
            :model-value="row.original.values[cell.name] === true"
            :aria-label="t('dataviews.inlineLines.cell', { column: cell.label, line: row.index + 1 })"
            @update:model-value="(value: boolean | 'indeterminate') => set(row.original, cell.name, value === true)"
          />
          <UInput
            v-else
            data-cell-input
            :model-value="(row.original.values[cell.name] ?? '') as string"
            :color="cellError(row.original, cell.name) ? 'error' : undefined"
            :highlight="cellError(row.original, cell.name)"
            :aria-invalid="cellError(row.original, cell.name) || undefined"
            :type="inputType(cell.meta.dataType)"
            :aria-label="t('dataviews.inlineLines.cell', { column: cell.label, line: row.index + 1 })"
            size="sm"
            class="w-full min-w-24"
            :ui="isNumber(cell.meta.dataType) ? { base: 'text-end' } : undefined"
            @update:model-value="(value: string | number) => set(row.original, cell.name, fromInput(cell.meta, value))"
          />
        </template>
        <span v-else>{{ shown(row.original, cell.name) }}</span>
      </template>
      <template #actions-cell="{ row }">
        <UButton
          v-if="row.original.original === null || canDelete"
          :icon="row.original.removed ? 'i-lucide-undo-2' : 'i-lucide-x'"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="row.original.removed ? t('dataviews.inlineLines.keep', { line: row.index + 1 }) : t('dataviews.inlineLines.remove', { line: row.index + 1 })"
          @click="remove(row.original)"
        />
      </template>
      <template #empty>
        <UEmpty
          icon="i-lucide-list"
          :title="t('dataviews.inlineLines.empty')"
          variant="naked"
        />
      </template>
    </UTable>
    <div v-if="canCreate">
      <UButton
        icon="i-lucide-plus"
        :label="newLabel || t('dataviews.grid.addItem')"
        color="neutral"
        variant="outline"
        size="sm"
        @click="add"
      />
    </div>
  </div>
</template>
