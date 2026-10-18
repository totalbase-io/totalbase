<script setup lang="ts">
import type { TableColumn } from '@nuxt/ui'
import type { Resource } from '~/types/resource'
import type { RelationDetail } from '~/types/schema'
import type { CatalogColumn } from '~/types/permission'
import { brokenDataViewLine, type BrokenDataViewReference, type BrokenReferences } from '~/composables/useBrokenReferences'
import { checkConstraintValues, columnValueKind, COLUMN_INPUTS, isColumnInputKey, type ColumnPresentation } from '@totalbase/tb-catalog'

const props = defineProps<{
  resource: Resource
  /** A column whose presentation opens once the columns load - a designer's "Edit in Database" link. */
  openPresentation?: string
}>()
/** The relation's detail once loaded - its page reads `owner`/`canAlter` from it (Specification_Administration.md §3.15) without a second request. */
const emit = defineEmits<{ loaded: [detail: RelationDetail] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
const kind = computed(() => (props.resource.type === 'VIEW' ? 'view' : 'table'))

// The relation's detail, shared with the page's other panels (useRelationDetail):
// a column change below refreshes it once and Check constraints and Indexes follow.
const { detail, pending, error, refresh } = useRelationDetail(kind, () => props.resource.id)
watch(detail, (value) => {
  if (value) emit('loaded', value)
}, { immediate: true })

// Each column's widget (its icon, Strapi-style) and presentation - a
// separate fetch since both live in TotalBase's own resources_columns, not
// in PostgreSQL's catalog RelationDetail already fetched above.
interface ResourceColumnMeta { columnName: string, presentation: ColumnPresentation, inherited?: ColumnPresentation, automatic?: { input: string, widget: string, props: Record<string, unknown>, reason: string }, inputs?: string[] }
const { data: columnMeta, refresh: refreshColumnWidgets } = await useAsyncData(
  () => `resource-columns-meta-${props.resource.id}`,
  () => api.get<ResourceColumnMeta[]>(`/resources/${props.resource.id}/columns`).then(r => r.data),
  { watch: [() => props.resource.id], default: () => [] }
)
const metaByColumn = computed(() => new Map((columnMeta.value ?? []).map(c => [c.columnName, c])))
/** Each column's control: its own, else what Automatic gives it - a catalog entry. */
const inputByColumn = computed(() => new Map((columnMeta.value ?? []).map(c => [c.columnName, c.presentation.input ?? c.inherited?.input ?? c.automatic?.input])))

function refreshAll() {
  refresh()
  refreshColumnWidgets()
  void refreshBroken()
}

// --- Default order (Specification.md §11.7): the same control as a DataView's Columns, saved at once - the Data API
// without order_by and every new DataView start from it. ---
interface SortEntry { column: string, direction: 'asc' | 'desc' }
const sortEntries = ref<SortEntry[]>([...props.resource.defaultSort])
watch(() => props.resource.defaultSort, (value) => {
  sortEntries.value = [...value]
})
const savingSort = ref(false)
function sortStateFor(column: string): { direction: 'asc' | 'desc', priority: number } | null {
  const idx = sortEntries.value.findIndex(e => e.column === column)
  return idx === -1 ? null : { direction: sortEntries.value[idx]!.direction, priority: idx + 1 }
}
function sortHint(column: string): string {
  const state = sortStateFor(column)
  if (!state) return t('database.resourceColumns.sortHint.none')
  const priority = sortEntries.value.length > 1 ? t('database.resourceColumns.sortHint.priority', { priority: state.priority }) : ''
  return state.direction === 'asc' ? t('database.resourceColumns.sortHint.asc', { priority }) : t('database.resourceColumns.sortHint.desc', { priority })
}
/** none -> asc -> desc -> none, a new column appended last; written as a whole. */
async function cycleSort(column: string) {
  const idx = sortEntries.value.findIndex(e => e.column === column)
  const next: SortEntry[] = idx === -1
    ? [...sortEntries.value, { column, direction: 'asc' }]
    : sortEntries.value[idx]!.direction === 'asc' ? sortEntries.value.map((e, i) => i === idx ? { ...e, direction: 'desc' as const } : e) : sortEntries.value.filter((_, i) => i !== idx)
  const previous = sortEntries.value
  sortEntries.value = next
  savingSort.value = true
  try {
    sortEntries.value = (await api.put<SortEntry[]>(`/resources/${props.resource.id}/default-sort`, { data: next })).data
  } catch (err) {
    sortEntries.value = previous
    notifyError(err, t('database.resourceColumns.sortError'))
  } finally {
    savingSort.value = false
  }
}

/** A column's icon: its control's (the column input catalog's) - a generic one for a column with none yet. */
function iconForColumn(columnName: string): string {
  const input = inputByColumn.value.get(columnName)
  return isColumnInputKey(input) ? COLUMN_INPUTS[input].icon : 'i-lucide-square'
}

// What still names a column of this table that is gone - its DataViews' layouts and Filter, dashboard
// widgets whose query names it and PostgreSQL refuses (Specification_DataViews.md §4.8). Reread with the columns.
const { data: broken, refresh: refreshBroken } = useAsyncData(
  () => `resource-broken-${props.resource.id}`,
  () => api.get<BrokenReferences>(`/catalog/broken-references?resource=${props.resource.id}`).then(r => r.data),
  { watch: [() => props.resource.id], default: (): BrokenReferences => ({ dashboards: [], dataviews: [] }), lazy: true }
)
const brokenCount = computed(() => broken.value.dashboards.length + broken.value.dataviews.length)
/** Where to fix it: a layout in the DataView's Views, its Filter in Data; a widget in its dashboard. */
function dataviewFixPath(reference: BrokenDataViewReference): string {
  const section = reference.part === 'base_where' || reference.part === 'source' ? 'data' : 'views'
  return `/dataviews/${reference.dataview.id}/settings?section=${section}`
}

const isAddOpen = ref(false)

// --- A column's presentation (Specification_DataViews.md §15):
// how it reads in every view that shows it. ---
const editing = ref<CatalogColumn | null>(null)
const presentationOpen = ref(false)
function editPresentation(column: CatalogColumn) {
  editing.value = column
  presentationOpen.value = true
}
watch([detail, () => props.openPresentation], ([value, column]) => {
  const found = column ? value?.columns.find(c => c.name === column) : undefined
  if (found && editing.value?.name !== found.name) editPresentation(found)
}, { immediate: true })
function kindOf(column: CatalogColumn) {
  const relation = detail.value?.relations.find(r => r.sourceColumn === column.name)
  return columnValueKind(column.dataType, relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable } : null)
}
/** After a change: the published DataViews it reaches (Specification_DataViews.md §15), to publish or leave. */
const affected = ref<{ id: string, name: string, slug: string, liveVersion: number, otherChanges: boolean }[]>([])
const affectedOpen = ref(false)
async function presentationSaved() {
  refreshColumnWidgets()
  try {
    affected.value = (await api.get<typeof affected.value>(`/resources/${props.resource.id}/affected-dataviews`)).data
    affectedOpen.value = affected.value.length > 0
  } catch {
    // Best-effort - the change is saved; each DataView still shows its Unpublished changes.
  }
}
function checkValuesOf(column: CatalogColumn): string[] | null {
  return checkConstraintValues(column.name, (detail.value?.checkConstraints ?? []).map(c => c.expression))
}

const COLUMNS = computed<TableColumn<CatalogColumn>[]>(() => [
  { accessorKey: 'name', header: t('common.name') },
  { id: 'label', header: t('common.label') },
  { accessorKey: 'dataType', header: t('common.type') },
  { id: 'nullable', header: t('database.resourceColumns.nullable') },
  { id: 'default', header: t('database.resourceColumns.default') },
  { id: 'sort', header: t('database.resourceColumns.sort'), meta: { class: { th: 'text-center', td: 'text-center' } } },
  { id: 'actions', header: '', meta: { class: { td: 'text-right' } } }
])

// --- Drop column (TABLE only - a VIEW's columns come from its own
// definition, not ALTER TABLE ... DROP COLUMN). ---
const removing = ref<string | null>(null)
async function removeColumn(columnName: string) {
  removing.value = columnName
  try {
    await api.del(`/schema/${props.resource.schema}/tables/${props.resource.name}/columns/${columnName}`)
    toast.add({ title: t('database.resourceColumns.dropped'), color: 'success' })
    await refreshAll()
  } catch (err) {
    notifyError(err, t('database.resourceColumns.dropError'))
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <SettingsSection :title="t('database.resourceColumns.title')">
    <template #actions>
      <div class="flex items-center gap-2">
        <ResourceSuggestPresentation
          v-if="detail"
          :resource="resource"
          @saved="presentationSaved"
        />
        <ResourceRowPresentation
          v-if="detail"
          :resource="resource"
          :columns="detail.columns.map(c => c.name)"
          @saved="presentationSaved"
        />
        <UButton
          v-if="resource.type === 'TABLE'"
          :label="t('database.resourceColumns.addColumn')"
          icon="i-lucide-plus"
          size="sm"
          color="neutral"
          variant="outline"
          :disabled="detail?.canAlter === false"
          @click="isAddOpen = true"
        />
      </div>
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="error.message"
    />

    <!-- What still names a column that is gone - to fix where it lives. -->
    <UAlert
      v-if="brokenCount > 0"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('database.resourceColumns.brokenTitle', { count: brokenCount }, brokenCount)"
      :description="t('database.resourceColumns.brokenDescription')"
    >
      <template #actions>
        <ul class="flex w-full flex-col gap-1 text-sm">
          <li
            v-for="reference in broken.dataviews"
            :key="`${reference.dataview.id}-${reference.part}-${reference.column}`"
          >
            <ULink
              :to="dataviewFixPath(reference)"
              class="font-medium"
            >
              {{ reference.dataview.name }}
            </ULink>
            <span class="text-muted"> · {{ brokenDataViewLine(reference, t('dataviews.tree.sourceGone')) }}{{ reference.version !== null ? ` (v${reference.version})` : '' }}</span>
          </li>
          <li
            v-for="widget in broken.dashboards"
            :key="`${widget.widget.id}-${widget.version}`"
          >
            <ULink
              :to="`/dashboards/${widget.dashboard.id}`"
              class="font-medium"
            >
              {{ widget.dashboard.name }} › {{ widget.widget.label || widget.widget.type }}
            </ULink>
            <span class="text-muted"> · {{ widget.message }}{{ widget.version !== null ? ` (v${widget.version})` : '' }}</span>
          </li>
        </ul>
      </template>
    </UAlert>

    <UEmpty
      v-if="pending"
      loading
      variant="naked"
      size="sm"
    />

    <template v-else-if="detail">
      <UTable
        sticky
        :data="detail.columns"
        :columns="COLUMNS"
      >
        <template #name-cell="{ row }">
          <UIcon
            :name="iconForColumn(row.original.name)"
            class="size-4 text-muted align-[-2px] mr-1"
          />
          <span class="font-medium text-highlighted">{{ row.original.name }}</span>
          <UBadge
            v-if="detail.primaryKey.includes(row.original.name)"
            color="primary"
            variant="subtle"
            size="sm"
            class="ml-1"
          >
            PK
          </UBadge>
        </template>
        <template #label-cell="{ row }">
          <span
            v-if="metaByColumn.get(row.original.name)?.presentation.label"
            class="text-highlighted"
          >{{ metaByColumn.get(row.original.name)!.presentation.label }}</span>
          <!-- A view's column shows its table column's label - marked as the table's. -->
          <span
            v-else-if="metaByColumn.get(row.original.name)?.inherited?.label"
            class="text-muted"
          >{{ metaByColumn.get(row.original.name)!.inherited!.label }} <span class="text-dimmed">· {{ t('database.resourceColumns.fromTable') }}</span></span>
          <span
            v-else
            class="text-muted"
          >—</span>
        </template>
        <template #nullable-cell="{ row }">
          {{ row.original.nullable ? t('common.yes') : t('common.no') }}
        </template>
        <template #default-cell="{ row }">
          <span class="font-mono text-xs">{{ row.original.defaultExpression ?? '—' }}</span>
        </template>
        <template #sort-cell="{ row }">
          <SortOrderButton
            :direction="sortStateFor(row.original.name)?.direction ?? null"
            :priority="sortEntries.length > 1 ? sortStateFor(row.original.name)?.priority : undefined"
            :hint="sortHint(row.original.name)"
            @click="cycleSort(row.original.name)"
          />
        </template>
        <template #actions-cell="{ row }">
          <UTooltip :text="t('database.resourceColumns.howItShows')">
            <UButton
              icon="i-lucide-pencil"
              size="xs"
              color="neutral"
              variant="ghost"
              :aria-label="t('database.resourceColumns.howColumnShows', { name: row.original.name })"
              @click="editPresentation(row.original)"
            />
          </UTooltip>
          <ConfirmDeletePopover
            v-if="resource.type === 'TABLE' && detail.canAlter && !detail.primaryKey.includes(row.original.name)"
            :title="t('database.resourceColumns.deleteTitle')"
            :description="t('database.resourceColumns.deleteDescription', { name: row.original.name })"
            @confirm="removeColumn(row.original.name)"
          >
            <UButton
              icon="i-lucide-trash-2"
              size="xs"
              color="error"
              variant="ghost"
              :aria-label="t('database.resourceColumns.deleteAria', { name: row.original.name })"
              :loading="removing === row.original.name"
            />
          </ConfirmDeletePopover>
        </template>
      </UTable>
    </template>

    <ColumnPresentationSlideover
      v-if="editing"
      v-model:open="presentationOpen"
      :resource-id="resource.id"
      :column-name="editing.name"
      :data-type="editing.dataType"
      :kind="kindOf(editing)"
      :check-values="checkValuesOf(editing)"
      :presentation="metaByColumn.get(editing.name)?.presentation ?? {}"
      :inherited="metaByColumn.get(editing.name)?.inherited"
      :automatic="metaByColumn.get(editing.name)?.automatic"
      :inputs="metaByColumn.get(editing.name)?.inputs"
      :resource="resource"
      :columns="detail?.columns"
      @saved="presentationSaved"
    />

    <AffectedDataViewsModal
      v-model:open="affectedOpen"
      :dataviews="affected"
    />

    <AddColumnModal
      v-if="resource.type === 'TABLE'"
      v-model:open="isAddOpen"
      :schema="resource.schema"
      :table="resource.name"
      @added="refreshAll"
    />
  </SettingsSection>
</template>
