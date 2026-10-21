<script setup lang="ts">
/**
 * The wizard's Columns table for one table or view - every column, all
 * chosen by default; the builder unchecks what they don't want, and gives
 * each a widget and help text. What stays checked is where the
 * new DataView starts: its grid's columns and its record form's fields
 * (DataViews.md §4) - the widget goes
 * to both, help text to the form field; the title is its table's column's
 * (read only here, set in Database - §15). Afterwards each is edited on its
 * own: columns in Settings, fields in Form design.
 *
 * The primary key is always in the DataView - editing and deleting a row
 * need it: its checkbox only says whether it's shown.
 *
 * Loads the columns itself whenever `resourceId` changes; the rows are the
 * model, so the wizard reads the selection straight off them.
 */
import type { TableColumn } from '@nuxt/ui'
import { columnFormInput, COLUMN_WIDGET_NAMES, type WidgetName } from '@totalbase/tb-catalog'
import type { RelationDetail } from '~/types/schema'
import { humanizeColumnName } from '~/utils/humanize-column-name'

export interface WizardColumnRow {
  name: string
  dataType: string
  isForeignKey: boolean
  /** A foreign key to its own table - a TREE's parent (DataViews.md §5.14). */
  isSelfReference?: boolean
  /** Part of the primary key: always in the DataView, `visible` only shows it. */
  primaryKey: boolean
  visible: boolean
  label: string
  help: string
  widget: WidgetName
  /** Its column's input (`columnFormInput`) - left as is, the DataView's form follows the column (§15.2). */
  columnWidget: WidgetName
}

/** Audit columns by name - filled by PostgreSQL (a DEFAULT, a trigger), read by nobody filling the form. */
const AUDIT_COLUMNS = /^(created_at|updated_at|created_by|updated_by|creado|creado_en|creado_por|modificado|modificado_en|modificado_por|actualizado_en|actualizado_por)$/

const props = defineProps<{
  /** The table or view whose columns these are. */
  resource: { id: string, type: string, postgresOid: number, schema?: string, name?: string } | null | undefined
  /** Columns left out - the one a detail uses to point at its master. */
  exclude?: readonly string[]
}>()
const rows = defineModel<WizardColumnRow[]>('rows', { required: true })
const loading = defineModel<boolean>('loading', { default: false })
/** The loaded catalog - the wizard's layout steps read it too. */
const detail = defineModel<RelationDetail | null>('detail', { default: null })

const api = useAdminApi()
const { t } = useI18n()
const notifyError = useErrorToast()

// Primitive sources: `exclude` arrives as a fresh array on every render of the host.
watch([() => props.resource?.id, () => props.exclude?.join(',')], async () => {
  rows.value = []
  detail.value = null
  const resource = props.resource
  if (!resource) return
  loading.value = true
  try {
    const kind = resource.type === 'VIEW' ? 'view' : 'table'
    // Each column's input (its presentation's, Add Column's choice, else the rule) - the one create() picks server-side.
    const [{ data }, { data: storedWidgets }] = await Promise.all([
      api.get<RelationDetail>(`/catalog/${kind}/${resource.postgresOid}`),
      api.get<{ columnName: string, presentation?: { label?: string, input?: string, linkType?: string } }[]>(`/resources/${resource.id}/columns`)
    ])
    detail.value = data
    const fkColumns = new Map(data.relations.map(r => [r.sourceColumn, r]))
    const storedByColumn = new Map(storedWidgets.map(s => [s.columnName, s]))
    // Each column's title as it inherits it (DataViews.md §15): kept as is, it stays inherited - not copied.
    const titleByColumn = new Map(storedWidgets.filter(s => s.presentation?.label).map(s => [s.columnName, s.presentation!.label!]))
    rows.value = data.columns.filter(col => !props.exclude?.includes(col.name)).map((col) => {
      const fk = fkColumns.get(col.name) ?? null
      const stored = storedByColumn.get(col.name)
      const widget = columnFormInput({
        name: col.name,
        dataType: col.dataType,
        foreignKey: fk,
        checks: data.checkConstraints,
        input: stored?.presentation?.input,
        linkType: stored?.presentation?.linkType
      }).widget
      return {
        name: col.name,
        dataType: col.dataType,
        isForeignKey: fkColumns.has(col.name),
        isSelfReference: !!fk && fk.targetSchema === resource.schema && fk.targetTable === resource.name,
        primaryKey: data.primaryKey.includes(col.name),
        // A uuid key is nobody's to read - unchecked, it is still included, hidden (B53); nor are the audit columns
        // PostgreSQL fills (created_at, updated_by...) - unchecked, a box away (T61).
        visible: !(data.primaryKey.includes(col.name) && col.dataType === 'uuid') && !AUDIT_COLUMNS.test(col.name),
        label: titleByColumn.get(col.name) ?? humanizeColumnName(col.name),
        help: '',
        widget,
        columnWidget: widget
      }
    })
  } catch (err) {
    notifyError(err, t('designer.dataViewWizardColumns.loadError'))
  } finally {
    loading.value = false
  }
}, { immediate: true })

const tableColumns = computed<TableColumn<WizardColumnRow>[]>(() => [
  { id: 'visible', header: '', meta: { class: { th: 'w-10', td: 'w-10' } } },
  // The label, with the column's own name under it - as Settings' Columns show it.
  {
    id: 'label',
    header: () => h('div', [h('span', t('common.label')), h('span', { class: 'block font-mono text-xs font-normal text-muted' }, t('designer.dataViewWizardColumns.columnName'))]),
    meta: { class: { th: 'w-56', td: 'w-56' } }
  },
  { id: 'help', header: t('designer.dataViewWizardColumns.helpText') },
  { id: 'widget', header: t('designer.dataViewWizardColumns.widget'), meta: { class: { th: 'w-40', td: 'w-40' } } }
])
</script>

<template>
  <UEmpty
    v-if="loading"
    loading
    variant="naked"
    size="sm"
  />
  <div
    v-else
    class="flex flex-col gap-2"
  >
    <p class="text-xs text-muted">
      {{ t('designer.dataViewWizardColumns.intro') }}
    </p>
    <UTable
      sticky
      :meta="{ class: { tr: (row: { original: WizardColumnRow }) => (row.original.visible ? '' : 'opacity-50') } }"
      :data="rows"
      :columns="tableColumns"
    >
      <template #visible-cell="{ row: { original: col } }">
        <UTooltip
          v-if="col.primaryKey"
          :text="t('designer.dataViewWizardColumns.primaryKeyTooltip')"
        >
          <UCheckbox
            v-model="col.visible"
            :aria-label="t('designer.dataViewWizardColumns.show', { column: col.name })"
          />
        </UTooltip>
        <UCheckbox
          v-else
          v-model="col.visible"
          :aria-label="t('designer.dataViewWizardColumns.include', { column: col.name })"
        />
      </template>
      <template #label-cell="{ row: { original: col } }">
        <p class="truncate text-sm text-highlighted">
          {{ col.label }}
        </p>
        <p class="mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-muted">
          <UIcon
            v-if="col.primaryKey"
            name="i-lucide-key-round"
            class="size-3 shrink-0"
          />
          {{ col.name }}
        </p>
      </template>
      <template #help-cell="{ row: { original: col } }">
        <UInput
          v-model="col.help"
          size="sm"
          class="w-full"
          :aria-label="t('designer.dataViewWizardColumns.helpTextOf', { column: col.name })"
        />
      </template>
      <template #widget-cell="{ row: { original: col } }">
        <USelectMenu
          v-model="col.widget"
          :aria-label="t('designer.dataViewWizardColumns.widget')"
          :items="[...COLUMN_WIDGET_NAMES]"
          size="sm"
          class="w-full"
        />
      </template>
    </UTable>
  </div>
</template>
