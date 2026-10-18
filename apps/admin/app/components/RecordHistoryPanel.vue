<script setup lang="ts">
/**
 * "Activity" - a timeline of audit log entries, in one of two modes
 * depending on whether `pkValue` is given:
 *  - Record mode (the record form's frame (DataViewRecordPanel.vue)'s own "Activity"): ONE row's
 *    own history (useRecordAudit.ts's own doc comment on how it's
 *    matched: `payload ->> primaryKey = pkValue`). This row's own DELETE
 *    (if any) never shows up here, by construction - this panel only
 *    opens from a record form, which only exists while the row itself
 *    still does.
 *  - Table mode (DataViewGrid.vue's own toolbar "History", `pkValue`
 *    omitted): every row's history for this resource, INCLUDING rows
 *    already deleted - the one place left to find out who deleted a row
 *    that's gone, since it has nowhere left to open its own per-row
 *    panel. Each card also names which record it touched (`dataviewSlug`
 *    given) with a link to open it, when that record still exists.
 *
 * Opens as its own USlideover, layered on top of whatever the record
 * form's own container already is (Drawer/Modal/Sidebar/Page) or the
 * grid itself - simplest way to offer the same panel from everywhere
 * without needing a different container per caller.
 *
 * Per-entry diffs: an UPDATE's from its own `changes` - old and new of
 * every column it changed, read in the same statement
 * (Specification_Security.md §11.4, utils/audit-changes.ts); CREATE and
 * DELETE from their full-row `payload` (the resulting row, or the row as
 * it existed right before). An UPDATE without `changes` (a table without a
 * primary key on PostgreSQL 15-17) falls back to consecutive `payload`
 * snapshots, as below.
 *
 * Table mode paginates 15 at a time (`PAGE_SIZE`), so an UPDATE's own
 * "previous" entry can easily sit on an OLDER page than the one loaded -
 * `findLocalPreviousPayload` only ever looks within the current page.
 * When that comes up empty, opening that entry's popover fires one
 * on-demand `GET /audit/logs` scoped to just that record
 * (useRecordAudit.ts's own `findPreviousPayload`, `pk_value` + `before`),
 * so the diff stays exact regardless of which page it's on - "se debe
 * mostrar consistencia con los datos",
 * rather than a page-boundary guess.
 */
import { formatDistanceToNow } from 'date-fns'
import { formatCondition, parseConditions } from '~/utils/filterConditions'
import type { AuditLog } from '~/types/audit'
import type { AuditDiffRow } from '~/utils/audit-changes'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()
const { t } = useI18n()
const ui = useUiLocale()

const PAGE_SIZE = 15

const props = defineProps<{
  /** The DataView's own `sourceResource` (the totalbase.resources catalog id) - NOT schema/table. */
  resourceId: string | null | undefined
  primaryKey: string | undefined
  /** Omitted = table mode (every row); given = record mode (one row only). */
  pkValue?: string | undefined
  /** For the panel's own title, e.g. "Activity - products #a1b2...". */
  resourceLabel: string
  /**
   * Column names in the order the record form/grid itself shows them -
   * "the DB/table order, whichever's more convenient": this is what's
   * already computed for the caller's own layout,
   * no extra fetch needed. A column not in here (a hidden/technical one
   * like `id` or `updated_at`) sorts after every named one, alphabetically
   * among itself.
   */
  fieldOrder?: string[]
  /** Each column's title by its name (`columnTitles`) - the changes show it instead of the name. */
  fieldLabels?: Record<string, string>
  /** Table mode only - lets each card link to `/app/dataviews/:slug/:pk/edit` for the record it touched. */
  dataviewSlug?: string
}>()
const open = defineModel<boolean>('open', { required: true })

const isTableMode = computed(() => !props.pkValue)

const { logs, total, pending, error, principalNames, load, findPreviousPayload: fetchPreviousPayload } = useRecordAudit()

/** The entry open in the detail level, if any - keyed by log id. */
const openLogId = ref<string | null>(null)

// Table mode only - record mode's own history is small enough (a single
// row) to fetch in one page (useRecordAudit.ts's own default limit: 50).
const page = ref(1)
function loadPage() {
  load(props.resourceId, props.primaryKey, props.pkValue, isTableMode.value ? { limit: PAGE_SIZE, offset: (page.value - 1) * PAGE_SIZE } : undefined)
}
// Immediate: a row's Activity is mounted open (DataViewGrid.vue) - it loads on mount, not only when opened later.
watch(open, (isOpen) => {
  if (!isOpen) return
  page.value = 1
  openLogId.value = null
  loadPage()
}, { immediate: true })
watch(page, () => {
  openLogId.value = null
  loadPage()
})

// Full literal class strings, not built from a `color` keyword via
// template-literal interpolation (`text-${color}`) - Tailwind's content
// scanner only picks up classes it can find as complete strings in the
// source, so a dynamically-assembled one can silently never make it
// into the production CSS bundle.
const ACTION_META: Record<string, { icon: string, labelKey: string, badgeColor: 'success' | 'info' | 'error' | 'neutral' }> = {
  CREATE: { icon: 'i-lucide-plus-circle', labelKey: 'dataviews.history.actions.CREATE', badgeColor: 'success' },
  UPDATE: { icon: 'i-lucide-pencil', labelKey: 'dataviews.history.actions.UPDATE', badgeColor: 'info' },
  DELETE: { icon: 'i-lucide-trash-2', labelKey: 'dataviews.history.actions.DELETE', badgeColor: 'error' },
  // Bulk operations (DataViewGrid.vue's own toolbar) - same icon as the
  // button that triggered them, so a viewer recognizes the action at a
  // glance instead of learning a second, history-only icon set. `neutral`
  // rather than one of CREATE/UPDATE/DELETE's colors - these don't touch
  // row data themselves (no `payload`, by design - see useRecordAudit.ts).
  PRINT: { icon: 'i-lucide-printer', labelKey: 'dataviews.history.actions.PRINT', badgeColor: 'neutral' },
  EXPORT: { icon: 'i-lucide-download', labelKey: 'dataviews.history.actions.EXPORT', badgeColor: 'neutral' },
  IMPORT: { icon: 'i-lucide-upload', labelKey: 'dataviews.history.actions.IMPORT', badgeColor: 'neutral' }
}
const DEFAULT_ACTION_META = { icon: 'i-lucide-circle-dot', badgeColor: 'info' as const }
function actionMeta(action: string) {
  const meta = ACTION_META[action]
  return meta ? { icon: meta.icon, label: t(meta.labelKey), badgeColor: meta.badgeColor } : { ...DEFAULT_ACTION_META, label: action }
}
const BULK_ACTIONS = new Set(['PRINT', 'EXPORT', 'IMPORT'])
function isBulkAction(action: string): boolean {
  return BULK_ACTIONS.has(action)
}

/**
 * Whether a card has anything worth opening a popover for - a bulk
 * event (always does, see `bulkDetailOf`/`bulkFilterSummary`), or a
 * CREATE/UPDATE/DELETE with an actual full-row `payload` to work from.
 * Deliberately NOT `diffs[index].rows.length > 0`: an UPDATE's own diff
 * can still be unresolved (its previous entry not yet looked up - see
 * `computeDiff`'s own `'unresolved'`/`'loading'` states) at the moment
 * this renders, which would otherwise make the card look non-clickable
 * for something that's actually just one click away from resolving.
 */
function hasDetail(log: AuditLog): boolean {
  return isBulkAction(log.action) || (log.status === 'EXECUTED' && isRow(log.payload))
}

interface BulkEventDetail { rowCount?: number, format?: string, search?: string }
function bulkDetailOf(log: AuditLog): BulkEventDetail {
  if (!isRow(log.metadata)) return {}
  const meta = log.metadata
  return {
    rowCount: typeof meta.rowCount === 'number' ? meta.rowCount : undefined,
    format: typeof meta.format === 'string' ? meta.format : undefined,
    search: typeof meta.search === 'string' ? meta.search : undefined
  }
}

/** Same summary line DataViewGrid.vue's own Print header uses (`printFilterSummary`) - just built from this entry's stored `whereClause` instead of the grid's own live filter text. `null` back from `parseConditions` means a filter too complex to break into per-condition chips - still worth flagging as active, just not term-by-term. */
function bulkFilterSummary(log: AuditLog): string | undefined {
  if (!log.whereClause) return undefined
  const group = parseConditions(JSON.stringify(log.whereClause))
  if (!group || group.conditions.length === 0) return t('dataviews.history.customFilter')
  return group.conditions.map(formatCondition).join(` ${group.join.toUpperCase()} `)
}

function principalLabel(log: AuditLog): string {
  // A local var, not two separate `principalNames.value[...]` reads - TS
  // doesn't narrow a second indexed-access expression from the first
  // one's truthiness check, even for the identical key.
  const name = log.principalId ? principalNames.value[log.principalId] : undefined
  if (name) return name
  if (log.principalType === 'SYSTEM') return t('dataviews.history.system')
  return log.principalId ? `${log.principalType} ${log.principalId}` : log.principalType
}

interface FieldDiff { field: string, old: unknown, new: unknown }
/**
 * `ready`: `rows` is the real diff. `loading`: an on-demand server
 * lookup for this entry's own previous state is in flight - don't render
 * `rows` yet, it's still `[]`. `unresolved`: nothing looked up yet (idle,
 * popover never opened) - same "don't render `rows` yet" as `loading`,
 * just before the fetch even starts. `first-change`: confirmed, via a
 * local match OR a server round-trip, that no earlier entry exists at
 * all for this record - `rows` is still meaningful (every field reads as
 * newly set, same as CREATE), just not really a "change" from something.
 */
interface EntryDiff { rows: FieldDiff[], state: 'ready' | 'loading' | 'unresolved' | 'first-change' }

function isRow(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** This entry's own record id, read straight out of its full-row `payload` - needed in table mode to tell entries for different rows apart, and to scope the on-demand server lookup below to just this one record. */
function recordIdOf(log: AuditLog): string | undefined {
  if (!props.primaryKey || !isRow(log.payload)) return undefined
  const value = log.payload[props.primaryKey]
  return value === undefined || value === null ? undefined : String(value)
}

/**
 * Nearest EARLIER (higher index - `logs` is newest-first) entry that
 * actually has a usable full-row snapshot to diff against, WITHIN the
 * currently loaded page only - in table mode, scoped to the SAME record
 * (`recordIdOf`), since the fetched window mixes every row's entries
 * together. `undefined` doesn't mean "there is no earlier entry" here,
 * only "not on this page" - `externalPrevious` below covers that case.
 */
function findLocalPreviousPayload(index: number): Record<string, unknown> | undefined {
  const recordId = isTableMode.value ? recordIdOf(logs.value[index]!) : undefined
  for (let i = index + 1; i < logs.value.length; i++) {
    const candidate = logs.value[i]!
    if (candidate.status !== 'EXECUTED' || !isRow(candidate.payload)) continue
    if (isTableMode.value && recordIdOf(candidate) !== recordId) continue
    return candidate.payload
  }
  return undefined
}

// On-demand, per-record server lookups (useRecordAudit.ts's own
// `findPreviousPayload`) for an UPDATE whose previous entry isn't on the
// currently loaded page - keyed by log id. `null` means "looked it up,
// there genuinely isn't one" (a confirmed `first-change`), as opposed to
// "not looked up yet" (absent from this object entirely).
const externalPrevious = ref<Record<string, Record<string, unknown> | null>>({})
const externalPreviousLoading = ref<Set<string>>(new Set())

/** Fires once, the first time a given entry's popover opens, if (and only if) its own previous state couldn't be found on the loaded page - never eagerly for every row up front. */
watch(openLogId, async (id) => {
  if (!id) return
  const index = logs.value.findIndex(l => l.id === id)
  if (index === -1) return
  const log = logs.value[index]!
  if (log.action !== 'UPDATE' || log.status !== 'EXECUTED' || !isRow(log.payload)) return
  if (updateDiffFromChanges(log) || findLocalPreviousPayload(index)) return
  if (id in externalPrevious.value || externalPreviousLoading.value.has(id)) return
  const recordId = recordIdOf(log)
  if (!props.resourceId || !props.primaryKey || !recordId) {
    externalPrevious.value = { ...externalPrevious.value, [id]: null }
    return
  }
  externalPreviousLoading.value.add(id)
  const result = await fetchPreviousPayload(props.resourceId, props.primaryKey, recordId, log.createdAt)
  externalPreviousLoading.value.delete(id)
  externalPrevious.value = { ...externalPrevious.value, [id]: result ?? null }
})

function fieldSortKey(field: string): [number, string] {
  const position = props.fieldOrder?.indexOf(field) ?? -1
  return position === -1 ? [1, field] : [0, String(position).padStart(6, '0')]
}

/**
 * Field-by-field diff for one entry - `before`/`after` come from the
 * SAME `payload` column, just from different entries (or `{}` when
 * there's genuinely nothing on that side): CREATE has no "before" (the
 * row didn't exist), DELETE has no "after" (it doesn't anymore), UPDATE
 * pairs this entry's own resulting row against the nearest earlier
 * entry's own resulting row - local first, `externalPrevious` otherwise.
 */
function computeDiff(log: AuditLog, index: number): EntryDiff {
  if (log.status !== 'EXECUTED' || !isRow(log.payload)) return { rows: [], state: 'ready' }
  const current = log.payload
  let before: Record<string, unknown> = {}
  let after: Record<string, unknown> = current
  let state: EntryDiff['state'] = 'ready'
  if (log.action === 'DELETE') {
    before = current
    after = {}
  } else if (log.action === 'UPDATE') {
    const own = updateDiffFromChanges(log)
    const local = own ? null : findLocalPreviousPayload(index)
    if (own) {
      before = own.before
      after = own.after
    } else if (local) {
      before = local
    } else {
      const cached = externalPrevious.value[log.id]
      if (cached === undefined) {
        state = externalPreviousLoading.value.has(log.id) ? 'loading' : 'unresolved'
      } else if (cached === null) {
        state = 'first-change'
      } else {
        before = cached
      }
    }
  }
  if (state === 'loading' || state === 'unresolved') return { rows: [], state }
  const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((a, b) => {
      const [aPos, aKey] = fieldSortKey(a)
      const [bPos, bKey] = fieldSortKey(b)
      return aPos !== bPos ? aPos - bPos : aKey.localeCompare(bKey)
    })
  const rows: FieldDiff[] = []
  for (const field of fields) {
    const beforeValue = before[field]
    const afterValue = after[field]
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      rows.push({ field, old: beforeValue, new: afterValue })
    }
  }
  return { rows, state }
}

const diffs = computed(() => logs.value.map((log, index) => computeDiff(log, index)))

/** A diff's rows as AuditDiff.vue reads them: a CREATE (or a first known state) has no before, a DELETE no after. */
function diffRowsOf(log: AuditLog, diff: EntryDiff): AuditDiffRow[] {
  return diff.rows.map(row => ({
    field: row.field,
    ...(log.action === 'CREATE' || diff.state === 'first-change' || row.old === undefined ? {} : { old: row.old }),
    ...(log.action === 'DELETE' || row.new === undefined ? {} : { new: row.new })
  }))
}

// --- Detail: an entry opens in the same sidebar, as a level of its own
// (← back to the list, which keeps its page and scroll position), and
// steps to the previous/next entry in the list's order (newest first). ---
const detailIndex = computed(() => (openLogId.value ? logs.value.findIndex(l => l.id === openLogId.value) : -1))
const detailLog = computed(() => (detailIndex.value >= 0 ? logs.value[detailIndex.value]! : null))
const bodyEl = ref<HTMLElement | null>(null)
let listScrollTop = 0
function scroller(): HTMLElement | null {
  for (let node = bodyEl.value?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}
function openDetail(id: string) {
  if (!openLogId.value) listScrollTop = scroller()?.scrollTop ?? 0
  openLogId.value = id
  void nextTick(() => scroller()?.scrollTo({ top: 0 }))
}
function backToList() {
  openLogId.value = null
  void nextTick(() => {
    const node = scroller()
    if (node) node.scrollTop = listScrollTop
  })
}
// Table mode crosses into the neighboring page: it loads, then opens its first or last entry.
const pendingStep = ref<'first' | 'last' | null>(null)
const canStepPrevious = computed(() => detailIndex.value > 0 || (isTableMode.value && page.value > 1))
const canStepNext = computed(() => (detailIndex.value >= 0 && detailIndex.value < logs.value.length - 1) || (isTableMode.value && page.value * PAGE_SIZE < total.value))
function step(direction: -1 | 1) {
  const target = logs.value[detailIndex.value + direction]
  if (target) return openDetail(target.id)
  if (!isTableMode.value) return
  pendingStep.value = direction === 1 ? 'first' : 'last'
  page.value += direction
}
watch(logs, (list) => {
  if (!pendingStep.value || list.length === 0) return
  openDetail((pendingStep.value === 'first' ? list[0] : list[list.length - 1])!.id)
  pendingStep.value = null
})
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="detailLog ? `${actionMeta(detailLog.action).label} · ${principalLabel(detailLog)}` : t('dataviews.history.title', { name: resourceLabel })"
    :description="detailLog ? `${dates.dateTime(detailLog.createdAt)} · ${formatDistanceToNow(new Date(detailLog.createdAt), { addSuffix: true, locale: ui.dateFns.value })}` : isTableMode ? t('dataviews.history.descriptionTable') : t('dataviews.history.descriptionRow')"
  >
    <template #title>
      <div class="flex items-center gap-2">
        <UButton
          v-if="detailLog"
          icon="i-lucide-arrow-left"
          :aria-label="t('dataviews.history.back')"
          color="neutral"
          variant="ghost"
          size="sm"
          class="-ms-1.5"
          @click="backToList"
        />
        <span class="truncate">{{ detailLog ? `${actionMeta(detailLog.action).label} · ${principalLabel(detailLog)}` : t('dataviews.history.title', { name: resourceLabel }) }}</span>
      </div>
    </template>

    <template #body>
      <div ref="bodyEl">
        <UEmpty
          v-if="pending"
          loading
          variant="naked"
          size="sm"
        />

        <UAlert
          v-else-if="error"
          color="error"
          variant="subtle"
          :title="error"
        />

        <p
          v-else-if="logs.length === 0"
          class="text-sm text-muted py-6 text-center"
        >
          {{ isTableMode ? t('dataviews.history.noneTable') : t('dataviews.history.noneRow') }}
        </p>

        <template v-else>
          <!-- The list stays mounted while an entry is open: back finds it as it was. -->
          <div
            v-show="!detailLog"
            class="flex flex-col gap-3"
          >
            <component
              :is="hasDetail(log) ? 'button' : 'div'"
              v-for="(log, index) in logs"
              :key="log.id"
              :type="hasDetail(log) ? 'button' : undefined"
              class="flex w-full flex-wrap items-center justify-between gap-2 rounded-md border border-default p-3 text-left"
              :class="hasDetail(log) ? 'cursor-pointer hover:border-primary hover:bg-elevated/50' : undefined"
              @click="hasDetail(log) && openDetail(log.id)"
            >
              <!-- The action itself (create/update/delete) lives in the avatar's own icon+color. -->
              <UUser
                :name="principalLabel(log)"
                :description="actionMeta(log.action).label"
                :avatar="{ icon: actionMeta(log.action).icon, color: actionMeta(log.action).badgeColor }"
                size="sm"
                class="min-w-0"
              />
              <div class="flex items-center gap-1.5">
                <UTooltip :text="dates.dateTime(log.createdAt)">
                  <UBadge
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  >
                    {{ formatDistanceToNow(new Date(log.createdAt), { addSuffix: true, locale: ui.dateFns.value }) }}
                  </UBadge>
                </UTooltip>
                <UBadge
                  v-if="log.status === 'FAILED'"
                  color="error"
                  variant="subtle"
                  size="sm"
                >
                  {{ t('dataviews.history.failed') }}
                </UBadge>
                <template v-else-if="hasDetail(log)">
                  <UBadge
                    v-if="isBulkAction(log.action)"
                    :color="actionMeta(log.action).badgeColor"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('dataviews.history.rowCount', { count: bulkDetailOf(log).rowCount ?? '?' }, bulkDetailOf(log).rowCount ?? 2) }}
                  </UBadge>
                  <UBadge
                    v-else-if="diffs[index]!.state === 'loading' || diffs[index]!.state === 'unresolved'"
                    color="neutral"
                    variant="subtle"
                    size="sm"
                  >
                    <UIcon
                      v-if="diffs[index]!.state === 'loading'"
                      name="i-lucide-loader-circle"
                      class="size-3 animate-spin"
                    />
                    <span v-else>{{ t('dataviews.history.viewChanges') }}</span>
                  </UBadge>
                  <UBadge
                    v-else-if="diffs[index]!.state === 'first-change'"
                    :color="actionMeta(log.action).badgeColor"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('dataviews.history.firstChange') }}
                  </UBadge>
                  <UBadge
                    v-else
                    :color="actionMeta(log.action).badgeColor"
                    variant="subtle"
                    size="sm"
                  >
                    {{ t('dataviews.history.fieldCount', { count: diffs[index]!.rows.length }, diffs[index]!.rows.length) }}
                  </UBadge>
                </template>
                <UIcon
                  v-if="hasDetail(log)"
                  name="i-lucide-chevron-right"
                  class="size-4 text-dimmed"
                />
              </div>
            </component>

            <!-- Table mode only - record mode's own history fits on one page (useRecordAudit.ts's own doc comment). -->
            <TablePager
              v-if="isTableMode && total > PAGE_SIZE"
              v-model:page="page"
              :page-size="PAGE_SIZE"
              :total="total"
              :noun="t('dataviews.history.change')"
              :plural="t('dataviews.history.changes')"
              hide-page-size
              class="mt-1"
            />
          </div>

          <!-- One entry, the whole sidebar's width. -->
          <Transition
            enter-active-class="transition duration-200 ease-out"
            enter-from-class="translate-x-4 opacity-0"
          >
            <div
              v-if="detailLog"
              :key="detailLog.id"
              class="flex flex-col gap-3"
            >
              <!-- Bulk operations (Print/Export/Import): the operation's own metadata, and the
              filter active at the time - it decided which rows it covered. -->
              <dl
                v-if="isBulkAction(detailLog.action)"
                class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm"
              >
                <dt class="text-muted">
                  {{ t('dataviews.history.rows') }}
                </dt>
                <dd class="font-mono">
                  {{ bulkDetailOf(detailLog).rowCount ?? '—' }}
                </dd>
                <template v-if="bulkDetailOf(detailLog).format">
                  <dt class="text-muted">
                    {{ t('dataviews.history.format') }}
                  </dt>
                  <dd class="font-mono uppercase">
                    {{ bulkDetailOf(detailLog).format }}
                  </dd>
                </template>
                <template v-if="bulkDetailOf(detailLog).search">
                  <dt class="text-muted">
                    {{ t('common.search') }}
                  </dt>
                  <dd class="font-mono break-all">
                    {{ bulkDetailOf(detailLog).search }}
                  </dd>
                </template>
                <dt class="text-muted">
                  {{ t('dataviews.meta.featureLabels.filter') }}
                </dt>
                <dd class="break-words">
                  {{ bulkFilterSummary(detailLog) ?? t('common.none') }}
                </dd>
              </dl>

              <template v-else-if="hasDetail(detailLog)">
                <div
                  v-if="isTableMode && recordIdOf(detailLog)"
                  class="flex items-center gap-1.5 text-xs"
                >
                  <span class="text-muted">{{ t('dataviews.history.record') }}</span>
                  <UButton
                    v-if="detailLog.action !== 'DELETE' && dataviewSlug"
                    :to="`/app/dataviews/${dataviewSlug}/${encodeURIComponent(recordIdOf(detailLog)!)}/edit`"
                    :label="recordIdOf(detailLog)"
                    icon="i-lucide-hash"
                    size="xs"
                    color="neutral"
                    variant="link"
                    class="p-0 font-mono"
                  />
                  <span
                    v-else
                    class="font-mono text-dimmed"
                  >
                    {{ t('dataviews.history.deletedRecord', { id: recordIdOf(detailLog) }) }}
                  </span>
                </div>
                <UEmpty
                  v-if="diffs[detailIndex]!.state === 'loading' || diffs[detailIndex]!.state === 'unresolved'"
                  loading
                  variant="naked"
                  size="sm"
                />
                <template v-else>
                  <p
                    v-if="diffs[detailIndex]!.state === 'first-change'"
                    class="text-xs text-muted"
                  >
                    {{ t('dataviews.history.firstChangeNote') }}
                  </p>
                  <AuditDiff
                    :rows="diffRowsOf(detailLog, diffs[detailIndex]!)"
                    :labels="fieldLabels"
                  />
                </template>
              </template>

              <!-- A failed entry: what PostgreSQL or the server said. -->
              <UAlert
                v-else
                color="error"
                variant="subtle"
                icon="i-lucide-circle-x"
                :title="t('dataviews.history.failed')"
                :description="detailLog.errorMessage ?? undefined"
              />
            </div>
          </Transition>
        </template>
      </div>
    </template>

    <template
      v-if="detailLog"
      #footer
    >
      <div class="flex w-full justify-between gap-2">
        <UButton
          icon="i-lucide-chevron-left"
          :label="t('dataviews.history.previous')"
          color="neutral"
          variant="outline"
          :disabled="!canStepPrevious"
          @click="step(-1)"
        />
        <UButton
          trailing-icon="i-lucide-chevron-right"
          :label="t('dataviews.history.next')"
          color="neutral"
          variant="outline"
          :disabled="!canStepNext"
          @click="step(1)"
        />
      </div>
    </template>
  </USlideover>
</template>
