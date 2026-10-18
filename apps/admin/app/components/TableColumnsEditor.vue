<script setup lang="ts">
/**
 * A table's per-column settings (`Record<column, TableColumnSettings>` -
 * Specification_DataViews.md §15, "A table's columns, one
 * model"), for a narrow properties panel: one row per column - its name and
 * a summary of what it sets - opened in place (TableColumnFields.vue), with
 * Hide. Order is the query's. A column left with no settings is dropped
 * from the model, and an empty model is `undefined`. A Dashboard's TABLE
 * and a page's Table use it; the Table passes what each column inherits.
 * A Dashboard's TABLE also sets each column's total (`totals`, D28) - its
 * footer row, computed by PostgreSQL.
 */
import { columnValueKind, DASHBOARD_TOTAL_KINDS, type TableColumnSettings } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

const props = defineProps<{
  columns: { name: string, dataType: string }[]
  /** Columns never displayed (a Dashboard's `_*` metadata, its row-color column). */
  excluded?: string[]
  /** What each column falls back to, by name - a resource column's presentation. */
  inherited?: Record<string, TableColumnSettings>
  /** A column's title when none is set - its name otherwise. */
  defaultTitle?: (name: string) => string
  /** A page Table's: what a column's Color per row formula reads (TableColumnFields.vue). */
  formulaColumns?: CatalogColumn[]
  /** A Dashboard's TABLE: each column's total (`total`: sum, avg, min, max, count) - its footer row. */
  totals?: boolean
}>()
const model = defineModel<Record<string, TableColumnSettings> | undefined>()
const { t } = useI18n()

const editable = computed(() => props.columns.filter(c => !props.excluded?.includes(c.name)))
const expanded = ref<string | null>(null)

function settings(name: string): TableColumnSettings {
  return model.value?.[name] ?? {}
}

function write(name: string, column: TableColumnSettings) {
  const next = Object.fromEntries(Object.entries({ ...(model.value ?? {}), [name]: column }).filter(([, c]) => Object.keys(c).length > 0)) as Record<string, TableColumnSettings>
  model.value = Object.keys(next).length === 0 ? undefined : next
}
function replace(name: string, column: TableColumnSettings) {
  const hidden = settings(name).hidden
  const { hidden: _drop, ...rest } = column
  write(name, hidden ? { ...rest, hidden } : rest)
}
function setHidden(name: string, hidden: boolean) {
  const { hidden: _drop, ...rest } = settings(name)
  write(name, hidden ? { ...rest, hidden: true } : rest)
}

type TotalKind = (typeof DASHBOARD_TOTAL_KINDS)[number]
/** A select can't hold an empty value - no total is this. */
const NO_TOTAL = 'none'
const totalItems = computed(() => [NO_TOTAL, ...DASHBOARD_TOTAL_KINDS].map(value => ({ value, label: t(`dashboards.inspector.total.kinds.${value}`) })))
const totalOf = (name: string) => (settings(name) as TableColumnSettings & { total?: TotalKind }).total
function setTotal(name: string, total: string) {
  const { total: _drop, ...rest } = settings(name) as TableColumnSettings & { total?: TotalKind }
  write(name, (total === NO_TOTAL ? rest : { ...rest, total }) as TableColumnSettings)
}

/** What a row says it sets: its own title (else the inherited one, dimmed), format, alignment, emphasis. */
function summary(name: string): string {
  const own = settings(name)
  const parts = [
    own.label ? `"${own.label}"` : props.inherited?.[name]?.label ?? '',
    own.displayFormat ?? '',
    own.align ?? '',
    own.bold ? t('database.tableColumnsEditor.bold') : '',
    own.italic ? t('database.tableColumnsEditor.italic') : '',
    own.mono ? t('database.tableColumnsEditor.mono') : '',
    own.colorFormula ? t('database.tableColumnsEditor.colorPerRow') : '',
    props.totals && totalOf(name) ? t(`dashboards.inspector.total.kinds.${totalOf(name)}`) : ''
  ].filter(Boolean)
  return parts.join(' · ')
}
</script>

<template>
  <div class="flex flex-col divide-y divide-default rounded-md border border-default">
    <p
      v-if="editable.length === 0"
      class="px-3 py-2 text-xs text-muted"
    >
      {{ t('database.tableColumnsEditor.runQuery') }}
    </p>

    <div
      v-for="column in editable"
      :key="column.name"
    >
      <button
        type="button"
        class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elevated"
        :aria-expanded="expanded === column.name"
        @click="expanded = expanded === column.name ? null : column.name"
      >
        <UIcon
          :name="expanded === column.name ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-3.5 shrink-0 text-muted"
        />
        <span
          class="min-w-0 flex-1 truncate text-sm"
          :class="settings(column.name).hidden ? 'text-muted line-through' : 'text-highlighted'"
        >{{ column.name }}</span>
        <span class="max-w-32 truncate text-xs text-dimmed">{{ summary(column.name) || column.dataType }}</span>
      </button>

      <div
        v-if="expanded === column.name"
        class="flex flex-col gap-3 px-3 pb-3"
      >
        <TableColumnFields
          :model-value="settings(column.name)"
          :column-name="column.name"
          :default-title="defaultTitle?.(column.name)"
          :kind="columnValueKind(column.dataType, null)"
          :inherited="inherited?.[column.name]"
          :formula-columns="formulaColumns"
          @update:model-value="(v: TableColumnSettings) => replace(column.name, v)"
        />

        <UFormField
          v-if="totals"
          :label="t('dashboards.inspector.total.label')"
          :description="t('dashboards.inspector.total.help')"
        >
          <USelect
            :model-value="totalOf(column.name) ?? NO_TOTAL"
            :items="totalItems"
            size="sm"
            class="w-full"
            @update:model-value="(v: string) => setTotal(column.name, v)"
          />
        </UFormField>

        <USwitch
          :model-value="settings(column.name).hidden === true"
          :label="t('database.tableColumnsEditor.hideColumn')"
          size="sm"
          @update:model-value="(v: boolean) => setHidden(column.name, v)"
        />
      </div>
    </div>
  </div>
</template>
