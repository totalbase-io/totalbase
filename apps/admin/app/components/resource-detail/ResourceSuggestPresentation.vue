<script setup lang="ts">
/**
 * Suggest presentation (Specification_DataViews.md §15.6): what each column's type and constraints suggest -
 * never its name - reviewed before anything is written. One row per difference with the column's own
 * presentation: what it lacks ticked, a change of a value it has unticked (never overwritten unless ticked);
 * a text value editable; its reason beside it. Opening it again re-analyses.
 */
import type { TableColumn } from '@nuxt/ui'
import type { ColumnPresentation } from '@totalbase/tb-catalog'
import type { Resource } from '~/types/resource'

type Reason = 'unique-integer' | 'nullable' | 'check-pattern' | 'check-pattern-code' | 'email-pattern' | 'url-pattern' | 'check-list' | 'comment'
interface Suggestion { key: keyof ColumnPresentation, value: unknown, reason: Reason, replaces: boolean, detail?: string }
interface Review {
  columns: { columnName: string, dataType: string, presentation: ColumnPresentation, suggestions: Suggestion[] }[]
  row: { displayField: string, reason: 'unique-text' } | null
}
/** One line of the review: a column's key, or the table's row presentation. */
interface Line { id: string, column: string | null, key: string, current: unknown, value: unknown, reason: string, replaces: boolean, detail?: string }

const props = defineProps<{ resource: Resource }>()
const emit = defineEmits<{ saved: [] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()

const isCompact = useCompactUi()
const open = ref(false)
const loading = ref(false)
const applying = ref(false)
const lines = ref<Line[]>([])
const ticked = ref(new Set<string>())
/** A text value the reviewer edited, by line. */
const edited = ref<Record<string, string>>({})

/** Text values a reviewer may edit before applying. */
const EDITABLE_KEYS = new Set(['placeholder', 'description', 'emptyText', 'label', 'help'])

async function load() {
  open.value = true
  loading.value = true
  edited.value = {}
  try {
    const review = (await api.get<Review>(`/resources/${props.resource.id}/columns/suggested-presentation`)).data
    lines.value = [
      ...(review.row ? [{ id: 'row', column: null, key: 'displayField', current: null, value: review.row.displayField, reason: review.row.reason, replaces: false }] : []),
      ...review.columns.flatMap(column => column.suggestions.map(s => ({
        id: `${column.columnName}.${s.key}`,
        column: column.columnName,
        key: s.key,
        current: column.presentation[s.key],
        value: s.value,
        reason: s.reason,
        replaces: s.replaces,
        detail: s.detail
      })))
    ]
    // A column's input is a choice: offered, never ticked - unset, the rule already gives it (§15.2).
    ticked.value = new Set(lines.value.filter(l => !l.replaces && l.key !== 'widget').map(l => l.id))
  } catch (err) {
    open.value = false
    notifyError(err, t('database.resourceSuggestPresentation.loadError'))
  } finally {
    loading.value = false
  }
}
function toggle(id: string, on: boolean) {
  const next = new Set(ticked.value)
  if (on) next.add(id)
  else next.delete(id)
  ticked.value = next
}

/** A value as the review shows it - words for a flag, a CHECK list's labels. */
function shown(key: string, value: unknown): string {
  if (value === undefined || value === null || value === '') return '—'
  if (value === true) return t('database.resourceSuggestPresentation.on')
  if (key === 'options' && typeof value === 'object') return Object.entries(value as Record<string, { label?: string }>).map(([v, o]) => o.label ? `${v} → ${o.label}` : v).join(', ')
  return String(value)
}

async function apply() {
  applying.value = true
  const columns: Record<string, Record<string, unknown>> = {}
  let row: { displayField: string } | undefined
  for (const line of lines.value.filter(l => ticked.value.has(l.id))) {
    const value = line.id in edited.value ? edited.value[line.id] : line.value
    if (line.column === null) row = { displayField: String(value) }
    else (columns[line.column] ??= {})[line.key] = value
  }
  try {
    const applied = (await api.post<unknown[]>(`/resources/${props.resource.id}/columns/suggested-presentation`, { data: { columns, ...(row && { row }) } })).data
    open.value = false
    toast.add({ title: t('database.resourceSuggestPresentation.applied', { count: applied.length + (row ? 1 : 0) }), color: 'success' })
    emit('saved')
  } catch (err) {
    notifyError(err, t('database.resourceSuggestPresentation.applyError'))
  } finally {
    applying.value = false
  }
}

const COLUMNS = computed<TableColumn<Line>[]>(() => [
  { id: 'select', header: '' },
  { accessorKey: 'column', header: t('database.resourceSuggestPresentation.column') },
  { accessorKey: 'key', header: t('database.resourceSuggestPresentation.property') },
  { id: 'current', header: t('database.resourceSuggestPresentation.current') },
  { id: 'value', header: t('database.resourceSuggestPresentation.suggested') },
  { accessorKey: 'reason', header: t('database.resourceSuggestPresentation.why') }
])
</script>

<template>
  <UButton
    icon="i-lucide-wand-sparkles"
    size="sm"
    color="neutral"
    variant="outline"
    :label="t('database.resourceSuggestPresentation.action')"
    @click="load"
  />
  <UModal
    v-model:open="open"
    :title="t('database.resourceSuggestPresentation.title')"
    :description="t('database.resourceSuggestPresentation.description')"
    :ui="{ content: 'max-w-6xl' }"
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
        v-else-if="lines.length === 0"
        icon="i-lucide-check"
        :title="t('database.resourceSuggestPresentation.none')"
        :description="t('database.resourceSuggestPresentation.noneDescription')"
        variant="naked"
      />
      <UTable
        v-else
        :data="lines"
        :columns="COLUMNS"
        sticky
      >
        <template #select-cell="{ row }">
          <UCheckbox
            :model-value="ticked.has(row.original.id)"
            :aria-label="t('database.resourceSuggestPresentation.accept', { name: row.original.id })"
            @update:model-value="(on: boolean | 'indeterminate') => toggle(row.original.id, on === true)"
          />
        </template>
        <template #column-cell="{ row }">
          <span
            v-if="row.original.column"
            class="font-mono text-xs"
          >{{ row.original.column }}</span>
          <span
            v-else
            class="text-muted"
          >{{ t('database.resourceSuggestPresentation.rowPresentation') }}</span>
        </template>
        <template #key-cell="{ row }">
          {{ t(`database.resourceSuggestPresentation.keys.${row.original.key}`) }}
          <UBadge
            v-if="row.original.replaces"
            :label="t('database.resourceSuggestPresentation.change')"
            color="warning"
            variant="subtle"
            size="sm"
            class="ml-1"
          />
        </template>
        <template #current-cell="{ row }">
          <span class="text-muted">{{ shown(row.original.key, row.original.current) }}</span>
        </template>
        <template #value-cell="{ row }">
          <UInput
            v-if="EDITABLE_KEYS.has(row.original.key) && typeof row.original.value === 'string'"
            :model-value="row.original.id in edited ? edited[row.original.id] : (row.original.value as string)"
            size="sm"
            class="w-48"
            :aria-label="t('database.resourceSuggestPresentation.suggested')"
            @update:model-value="(v: string) => (edited[row.original.id] = v)"
          />
          <span
            v-else
            class="inline-flex items-center gap-1.5"
          >
            <UIcon
              v-if="row.original.key === 'icon'"
              :name="row.original.value as string"
              class="size-4"
            />
            {{ shown(row.original.key, row.original.value) }}
          </span>
        </template>
        <template #reason-cell="{ row }">
          <span class="block min-w-48 whitespace-normal text-muted">{{ t(`database.resourceSuggestPresentation.reasons.${row.original.reason}`, { detail: row.original.detail ?? '' }) }}</span>
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
          :label="t('database.resourceSuggestPresentation.apply', { count: ticked.size })"
          :loading="applying"
          :disabled="ticked.size === 0"
          @click="apply"
        />
      </div>
    </template>
  </UModal>
</template>
