<script setup lang="ts">
/**
 * One audit entry's data change as a field table - the Logs page's entry
 * slideover, the same way RecordHistoryPanel.vue builds its diffs:
 *
 * - CREATE: the row as created (`payload` is the resulting row);
 * - DELETE: the row as it was (`payload` is the row right before);
 * - UPDATE: only the fields that changed - from the entry's own `changes`
 *   (old and new of every changed column, utils/audit-changes.ts); without
 *   them (a table without a primary key on PostgreSQL 15-17), this entry's
 *   resulting row against the nearest earlier entry for the same record -
 *   one GET /audit/logs scoped by primary key + `before`.
 *
 * Renders nothing for anything else (access events, SQL, bulk actions) or
 * an entry without a row snapshot (DENIED/FAILED) - the raw JSON below it
 * on the page still covers those.
 */
import type { AuditLog } from '~/types/audit'
import type { AuditDiffRow } from '~/utils/audit-changes'
import type { RelationDetail } from '~/types/schema'
import type { Resource } from '~/types/resource'

const props = defineProps<{
  log: AuditLog
  /** The entry's resource, when it's still in the catalog - needed for the primary key and column order. */
  resource: Resource | undefined
}>()

const api = useAdminApi()
const { t } = useI18n()

type Row = Record<string, unknown>
interface FieldChange { field: string, before: unknown, after: unknown }

function isRow(value: unknown): value is Row {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

const DATA_ACTIONS = ['CREATE', 'UPDATE', 'DELETE']
const applies = computed(() => DATA_ACTIONS.includes(props.log.action) && props.log.status === 'EXECUTED' && isRow(props.log.payload))

// Module-level cache: a resource's structure is looked up once per session,
// however many of its entries get opened.
const structure = ref<{ primaryKey: string[], columns: string[] } | null>(null)
const previous = ref<Row | null | undefined>(undefined)
const loading = ref(false)

async function loadStructure(resource: Resource) {
  let promise = structureCache.get(resource.id)
  if (!promise) {
    const path = resource.type === 'TABLE' ? `/catalog/table/${resource.id}` : `/catalog/view/${resource.id}`
    promise = api.get<RelationDetail>(path).then(r => ({ primaryKey: r.data.primaryKey, columns: r.data.columns.map(c => c.name) }))
    promise.catch(() => structureCache.delete(resource.id))
    structureCache.set(resource.id, promise)
  }
  return promise
}

/** The record's own state right before this UPDATE; null when this is its first recorded change. */
async function loadPrevious(log: AuditLog, primaryKey: string): Promise<Row | null> {
  const recordId = (log.payload as Row)[primaryKey]
  if (recordId === undefined || recordId === null) return null
  const { data } = await api.get<AuditLog[]>('/audit/logs', {
    resource: log.resource,
    pk_column: primaryKey,
    pk_value: String(recordId),
    before: log.createdAt,
    limit: 5
  })
  const match = data.find(l => l.status === 'EXECUTED' && isRow(l.payload))
  return match ? match.payload as Row : null
}

watch(() => props.log.id, async () => {
  structure.value = null
  previous.value = undefined
  if (!applies.value) return
  const log = props.log
  loading.value = true
  try {
    if (props.resource) structure.value = await loadStructure(props.resource)
    const own = updateDiffFromChanges(log)
    if (own) {
      previous.value = own.before
    } else if (log.action === 'UPDATE') {
      // Only a single-column key can be matched in `payload` - a composite
      // one falls back to "no earlier snapshot" rather than guessing.
      const pk = structure.value?.primaryKey.length === 1 ? structure.value.primaryKey[0]! : undefined
      const found = pk ? await loadPrevious(log, pk) : null
      if (props.log.id === log.id) previous.value = found
    }
  } catch {
    previous.value = null
  } finally {
    if (props.log.id === log.id) loading.value = false
  }
}, { immediate: true })

/** Catalog column order first (what the table looks like), unknown fields after, alphabetically. */
function sortFields(fields: string[]): string[] {
  const order = structure.value?.columns ?? []
  const rank = (f: string) => {
    const i = order.indexOf(f)
    return i === -1 ? Number.MAX_SAFE_INTEGER : i
  }
  return [...fields].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

const mode = computed<'values' | 'diff' | 'first-change'>(() => {
  if (props.log.action !== 'UPDATE') return 'values'
  return previous.value ? 'diff' : 'first-change'
})

const rows = computed<FieldChange[]>(() => {
  const own = updateDiffFromChanges(props.log)
  const current = own ? own.after : props.log.payload as Row
  if (mode.value === 'diff') {
    const before = previous.value!
    return sortFields([...new Set([...Object.keys(before), ...Object.keys(current)])])
      .filter(f => JSON.stringify(before[f]) !== JSON.stringify(current[f]))
      .map(f => ({ field: f, before: before[f], after: current[f] }))
  }
  return sortFields(Object.keys(current)).map(f => ({ field: f, before: undefined, after: current[f] }))
})

const title = computed(() => {
  if (props.log.action === 'CREATE') return t('audit.changes.createdRow')
  if (props.log.action === 'DELETE') return t('audit.changes.deletedRow')
  return mode.value === 'diff' ? t('audit.changes.changedFields', rows.value.length) : t('audit.changes.rowAfterUpdate')
})

/** As AuditDiff.vue draws it: a DELETE's row is what was there (−), a CREATE's or a first known state what is (+). */
const diffRows = computed<AuditDiffRow[]>(() => rows.value.map(row => mode.value === 'diff'
  ? { field: row.field, ...(row.before === undefined ? {} : { old: row.before }), ...(row.after === undefined ? {} : { new: row.after }) }
  : props.log.action === 'DELETE' ? { field: row.field, old: row.after } : { field: row.field, new: row.after }))
</script>

<script lang="ts">
const structureCache = new Map<string, Promise<{ primaryKey: string[], columns: string[] }>>()
</script>

<template>
  <div v-if="applies">
    <p class="text-muted mb-1">
      {{ loading ? t('audit.changes.changes') : title }}
    </p>

    <div
      v-if="loading"
      class="flex items-center gap-2 text-xs text-muted py-2"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      {{ t('audit.changes.loadingPrevious') }}
    </div>

    <template v-else>
      <p
        v-if="mode === 'first-change'"
        class="text-xs text-muted mb-2"
      >
        {{ t('audit.changes.firstChange') }}
      </p>
      <p
        v-else-if="mode === 'diff' && rows.length === 0"
        class="text-xs text-muted"
      >
        {{ t('audit.changes.noChanges') }}
      </p>

      <AuditDiff
        v-if="rows.length"
        :rows="diffRows"
      />
    </template>
  </div>
</template>
