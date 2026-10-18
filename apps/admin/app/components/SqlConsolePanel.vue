<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui'
import type { SqlConsoleError, SqlExecuteResult, SqlHistoryEntry } from '~/types/sql-console'
import type { RelationColumns } from '~/types/schema'
// Absolute dates/times in the user's zone and format (My account > Preferences).
const dates = useDateTimeFormat()

/**
 * The actual SQL Console - editor, toolbar, results/plan, history. No
 * UDrawer/header chrome of its own, so it works identically whether it's
 * embedded inside SqlConsoleDrawer (Resources' New Resource/Edit flows)
 * or rendered directly as the full /sql-console page - one
 * implementation, two places to reach it from.
 *
 * `active` mirrors the drawer's open state so this stays byte-for-byte
 * compatible with the drawer's previous close-time reset/open-time
 * prefill behavior; a standalone page just leaves it `true` forever, so
 * the reset never fires and the prefill only runs once at mount.
 */
const props = withDefaults(defineProps<{
  initialSql?: string
  active?: boolean
  /**
   * The drawer has room to go side by side by default; the standalone
   * page is narrower relative to its content (no bottom-sheet width to
   * spread into), so it starts stacked instead. Either way the user's
   * own choice below still overrides it and persists (per context - see
   * `splitterStorageKey`).
   */
  defaultOrientation?: 'horizontal' | 'vertical'
  splitterStorageKey?: string
}>(), {
  initialSql: '',
  active: true,
  defaultOrientation: 'horizontal',
  splitterStorageKey: 'sql-console-panel-columns'
})

const emit = defineEmits<{ executed: [result: SqlExecuteResult] }>()

const api = useAdminApi()
const toast = useToast()
const { t } = useI18n()
const notifyError = useErrorToast()
// Before the first await (vue/no-expose-after-await); editorRef is read when focus() is called.
defineExpose({ focus: () => editorRef.value?.focus() })
const { schemaNames: catalogSchemas } = useSchemasList()

const activeView = ref<'editor' | 'history'>('editor')
const history = ref<SqlHistoryEntry[]>([])
const historySearch = ref('')
const historyLoadingMore = ref(false)
const historyHasMore = ref(false)

const HISTORY_PAGE_SIZE = 100

// Search runs server-side (GET /sql/history?search=) rather than filtering
// what's already loaded - with pagination, "already loaded" is only ever
// a partial window, so a client-side filter would silently miss anything
// older than the current page instead of actually searching the history.
async function fetchHistory(offset: number): Promise<{ entries: SqlHistoryEntry[], total: number }> {
  const { data, meta } = await api.get<SqlHistoryEntry[]>('/sql/history', {
    limit: HISTORY_PAGE_SIZE,
    offset,
    search: historySearch.value.trim() || undefined
  })
  return { entries: data, total: meta?.total ?? data.length }
}

async function refreshHistory() {
  const { entries, total } = await fetchHistory(0)
  history.value = entries
  historyHasMore.value = entries.length < total
}

async function loadMoreHistory() {
  historyLoadingMore.value = true
  try {
    const { entries, total } = await fetchHistory(history.value.length)
    history.value = [...history.value, ...entries]
    historyHasMore.value = history.value.length < total
  } finally {
    historyLoadingMore.value = false
  }
}

// Debounced so typing doesn't fire a request per keystroke - refreshHistory
// always restarts from offset 0 since the search term changed the result
// set entirely, not just the next page of it.
let historySearchTimer: ReturnType<typeof setTimeout> | undefined
watch(historySearch, () => {
  clearTimeout(historySearchTimer)
  historySearchTimer = setTimeout(refreshHistory, 300)
})

// Native <input type="date"> gives "YYYY-MM-DD" (local midnight) - good
// enough for a retention cutoff, no need for a full date-range picker
// component here.
const purgeBeforeDate = ref('')
const purging = ref(false)

async function purgeHistory() {
  if (!purgeBeforeDate.value) return
  purging.value = true
  try {
    const { data } = await api.del<{ deletedCount: number }>('/sql/history', {
      before: new Date(purgeBeforeDate.value).toISOString()
    })
    toast.add({ title: t('database.sqlConsolePanel.purged', data.deletedCount) })
    purgeBeforeDate.value = ''
    await refreshHistory()
  } catch (err) {
    notifyError(err, t('database.sqlConsolePanel.purgeFailed'))
  } finally {
    purging.value = false
  }
}

function loadFromHistory(entry: SqlHistoryEntry) {
  sql.value = entry.sqlText
  activeView.value = 'editor'
}

async function copyHistoryEntry(entry: SqlHistoryEntry) {
  await navigator.clipboard.writeText(entry.sqlText)
  toast.add({ title: t('database.sqlConsolePanel.copiedToClipboard') })
}

// Copy + load-into-editor + switch tab + focus in one click - the plain
// Copy button above only puts it on the clipboard, and clicking the card
// itself only loads it without touching the clipboard or the editor's
// actual keyboard focus.
async function useInEditor(entry: SqlHistoryEntry) {
  await navigator.clipboard.writeText(entry.sqlText)
  sql.value = entry.sqlText
  activeView.value = 'editor'
  await nextTick()
  editorRef.value?.focus()
}

const schemas = computed(() => catalogSchemas.value ?? ['public'])
const schema = ref('public')

const { resources: allResources } = useResourcesList()
const catalogResources = computed(() => allResources.value.filter(resource => resource.status === 'ACTIVE'))
// The current schema's columns, in one read (not a request per table).
const { data: schemaColumns } = await useAsyncData(
  () => `sql-console-columns-${schema.value}`,
  () => api.get<RelationColumns[]>('/catalog/columns', { schema: schema.value }).then(r => r.data).catch(() => []),
  { default: () => [] as RelationColumns[] }
)

const completionItems = computed(() => {
  const resources = (catalogResources.value ?? []).filter(resource => resource.schema === schema.value)
  const items: { label: string, insertText?: string, kind: 'table' | 'view' | 'function' | 'field' }[] = resources.map(resource => ({
    label: resource.name,
    kind: resource.type === 'TABLE' ? 'table' as const : resource.type === 'VIEW' ? 'view' as const : 'function' as const
  }))
  for (const relation of schemaColumns.value ?? []) {
    if (relation.schema !== schema.value) continue
    for (const column of relation.columns) {
      items.push({ label: `${relation.name}.${column}`, insertText: `${relation.name}.${column}`, kind: 'field' as const })
    }
  }
  return items
})
const sql = ref('')
const editorRef = ref<{
  currentSelectionOrAll: () => string
  selectionOrAll: () => { text: string, start: number }
  markError: (position: number, start: number, message: string) => { line: number, column: number } | null
  clearErrorMarker: () => void
  fontSize: number
  setFontSize: (size: number) => void
  copySelection: () => Promise<void>
  pasteAtCursor: () => Promise<void>
  wordWrap: boolean
  toggleWordWrap: () => void
  formatSql: () => void
  clear: () => void
  undo: () => void
  redo: () => void
  focus: () => void
} | null>(null)

const executing = ref(false)
const result = ref<SqlExecuteResult | null>(null)
const executionError = ref<SqlConsoleError | null>(null)
const transactional = ref(false)

// Which way the editor/results split runs - side by side works better on a
// wide screen, stacked works better when this panel is cramped (a laptop
// screen, or the drawer not expanded). Defaults differ by context (see
// `defaultOrientation`'s doc above); the user's own choice always wins
// and is remembered from there on (USplitter's auto-save-id below).
// A phone starts stacked - two side-by-side columns are ~150px each there.
const isMobile = useIsMobile()
const splitterOrientation = ref<'horizontal' | 'vertical'>(isMobile.value ? 'vertical' : props.defaultOrientation)

// A phone: Run / Run selection / Explain and the schema stay in the
// editor toolbar, every other tool is in this "⋮" (the page header's own
// rule - AGENTS.md section 25).
const mobileToolbarMenu = computed<DropdownMenuItem[][]>(() => [
  [
    { label: t('database.sqlConsolePanel.openSqlFile'), icon: 'i-lucide-folder-open', onSelect: openSqlFile },
    { label: t('database.sqlConsolePanel.saveSqlFile'), icon: 'i-lucide-download', onSelect: saveSqlFile }
  ],
  [
    { label: t('database.sqlConsolePanel.formatSql'), icon: 'i-lucide-wand-sparkles', onSelect: () => editorRef.value?.formatSql() },
    { label: t('common.clear'), icon: 'i-lucide-eraser', onSelect: () => editorRef.value?.clear() }
  ],
  [
    { label: t('database.sqlConsolePanel.undo'), icon: 'i-lucide-undo-2', onSelect: () => editorRef.value?.undo() },
    { label: t('database.sqlConsolePanel.redo'), icon: 'i-lucide-redo-2', onSelect: () => editorRef.value?.redo() },
    { label: t('common.copy'), icon: 'i-lucide-copy', onSelect: () => editorRef.value?.copySelection() },
    { label: t('database.sqlConsolePanel.paste'), icon: 'i-lucide-clipboard-paste', onSelect: () => editorRef.value?.pasteAtCursor() }
  ],
  [
    { label: t('database.sqlConsolePanel.wordWrap'), icon: 'i-lucide-wrap-text', type: 'checkbox' as const, checked: !!editorRef.value?.wordWrap, onSelect: () => editorRef.value?.toggleWordWrap() },
    { label: t('database.sqlConsolePanel.decreaseFontSize'), icon: 'i-lucide-a-arrow-down', onSelect: () => editorRef.value?.setFontSize((editorRef.value?.fontSize ?? 13) - 1) },
    { label: t('database.sqlConsolePanel.increaseFontSize'), icon: 'i-lucide-a-arrow-up', onSelect: () => editorRef.value?.setFontSize((editorRef.value?.fontSize ?? 13) + 1) }
  ],
  [
    { label: t('database.sqlConsolePanel.sideBySide'), icon: 'i-lucide-columns-2', type: 'checkbox' as const, checked: splitterOrientation.value === 'horizontal', onSelect: () => { splitterOrientation.value = 'horizontal' } },
    { label: t('database.sqlConsolePanel.stacked'), icon: 'i-lucide-rows-2', type: 'checkbox' as const, checked: splitterOrientation.value === 'vertical', onSelect: () => { splitterOrientation.value = 'vertical' } }
  ],
  [
    { label: t('database.sqlConsolePanel.transactional'), icon: 'i-lucide-shield-check', type: 'checkbox' as const, checked: transactional.value, onSelect: () => { transactional.value = !transactional.value } }
  ]
])

// Results column: its own tab strip (Results/Plan), mirroring the editor
// column's Editor/History - each column's toolbar+tabs act only on that
// column's content.
const activeResultsView = ref<'results' | 'plan'>('results')
const resultsWrap = ref(false)
const resultsSearch = ref('')

/**
 * PostgreSQL's error as the result panel shows it - message, DETAIL, HINT,
 * SQLSTATE - and its position marked in the editor. `start` is the editor
 * offset where the SQL sent begins (Specification_Administration.md §5.6).
 */
function consoleError(err: unknown, start: number, fallback: string): SqlConsoleError {
  if (!(err instanceof AdminApiError)) return { message: fallback }
  const first = err.errors[0]
  const location = first?.position ? editorRef.value?.markError(first.position, start, err.message) ?? undefined : undefined
  return { message: err.message, detail: first?.detail, hint: first?.hint, sqlstate: first?.sqlstate, location }
}

/** `start`: the editor offset `text` begins at (0 for the whole buffer). */
async function run(text: string, start = 0) {
  const trimmed = text.trim()
  if (!trimmed) return
  // What PostgreSQL counts from: the trimmed text, past any leading whitespace.
  const sentStart = start + (text.length - text.trimStart().length)
  executing.value = true
  executionError.value = null
  editorRef.value?.clearErrorMarker()
  explainPlan.value = null
  try {
    const { data } = await api.post<SqlExecuteResult>('/sql/execute', { data: { sql: trimmed, transactional: transactional.value } })
    result.value = data
    // Status/row count/notices live in Results' own footer and the error
    // takes over its placeholder slot now - Results is always the right
    // tab to land on after running something, success or not.
    activeResultsView.value = 'results'
    emit('executed', data)
  } catch (err) {
    result.value = null
    executionError.value = consoleError(err, sentStart, t('database.sqlConsolePanel.executionFailed'))
    activeResultsView.value = 'results'
  } finally {
    executing.value = false
    await refreshHistory()
  }
}

const runAll = () => run(sql.value)
function runSelection() {
  const { text, start } = editorRef.value?.selectionOrAll() ?? { text: sql.value, start: 0 }
  return run(text, start)
}

const explaining = ref(false)
const explainPlan = ref<unknown>(null)

async function runExplain() {
  const selected = editorRef.value?.selectionOrAll() ?? { text: sql.value, start: 0 }
  const text = selected.text.trim()
  if (!text) return
  const sentStart = selected.start + (selected.text.length - selected.text.trimStart().length)
  explaining.value = true
  editorRef.value?.clearErrorMarker()
  try {
    const { data } = await api.post<{ plan: unknown }>('/sql/explain', { data: { sql: text } })
    explainPlan.value = data.plan
    activeResultsView.value = 'plan'
  } catch (err) {
    const error = consoleError(err, sentStart, t('database.sqlConsolePanel.explainFailedMessage'))
    toast.add({
      title: t('database.sqlConsolePanel.explainFailed'),
      description: [error.message, error.hint && t('database.sqlConsolePanel.hint', { hint: error.hint }), error.location && t('database.sqlConsolePanel.lineColumn', { line: error.location.line, column: error.location.column })].filter(Boolean).join(' · '),
      color: 'error'
    })
  } finally {
    explaining.value = false
  }
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

const sqlFileInput = ref<HTMLInputElement | null>(null)

function openSqlFile() {
  sqlFileInput.value?.click()
}

// Replaces the editor's content wholesale - same as "Use in editor" from
// History, no confirmation prompt. Consistent with Clear, which already
// discards unsaved content the same way; Ctrl/Cmd+Z still gets it back.
async function onSqlFileSelected(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return
  sql.value = await file.text()
  ;(event.target as HTMLInputElement).value = ''
}

function saveSqlFile() {
  downloadBlob(sql.value, 'query.sql', 'text/plain')
}

function csvCell(value: unknown): string {
  const text = value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function exportCsv() {
  if (!result.value || result.value.rows.length === 0) return
  const header = result.value.columns.map(c => csvCell(c.name)).join(',')
  const lines = result.value.rows.map(row => result.value!.columns.map(c => csvCell(row[c.name])).join(','))
  downloadBlob([header, ...lines].join('\n'), 'results.csv', 'text/csv')
}

function exportJson() {
  if (!result.value || result.value.rows.length === 0) return
  downloadBlob(JSON.stringify(result.value.rows, null, 2), 'results.json', 'application/json')
}

// `active` stands in for the drawer's `open` - true the whole time for a
// standalone page, so the prefill runs once at mount and the reset branch
// never fires; toggling it (drawer open/close) reproduces the drawer's
// previous per-open prefill and per-close reset exactly.
watch([() => props.active, () => props.initialSql], ([isActive]) => {
  if (isActive) {
    sql.value = props.initialSql
    refreshHistory()
  } else {
    sql.value = ''
    result.value = null
    executionError.value = null
    explainPlan.value = null
    activeView.value = 'editor'
    activeResultsView.value = 'results'
    resultsSearch.value = ''
    historySearch.value = ''
    historyHasMore.value = false
    purgeBeforeDate.value = ''
  }
}, { immediate: true })
</script>

<template>
  <div class="flex h-full w-full flex-col">
    <USplitter
      :items="[{ id: 'editor', defaultSize: 50, minSize: 25 }, { id: 'results', defaultSize: 50, minSize: 25 }]"
      :orientation="splitterOrientation"
      :auto-save-id="props.splitterStorageKey"
      class="flex-1 min-h-0"
    >
      <template #panel-0>
        <div :class="['flex flex-col min-h-0 min-w-0 gap-2 h-full w-full', splitterOrientation === 'horizontal' ? 'pe-3' : 'pb-3']">
          <div class="flex flex-wrap items-center gap-1 shrink-0 border-b border-default pb-3">
            <UTooltip :text="t('database.sqlConsolePanel.runAllShortcut')">
              <UButton
                :aria-label="t('database.sqlConsolePanel.runAll')"
                icon="i-lucide-play"
                color="primary"
                variant="outline"
                size="sm"
                square
                :loading="executing"
                @click="runAll"
              />
            </UTooltip>
            <UTooltip :text="t('database.sqlConsolePanel.runSelection')">
              <UButton
                :aria-label="t('database.sqlConsolePanel.runSelection')"
                icon="i-lucide-square-play"
                color="neutral"
                variant="outline"
                size="sm"
                square
                :loading="executing"
                @click="runSelection"
              />
            </UTooltip>
            <UTooltip :text="t('database.sqlConsolePanel.explain')">
              <UButton
                :aria-label="t('database.sqlConsolePanel.explain')"
                icon="i-lucide-list-tree"
                color="neutral"
                variant="outline"
                size="sm"
                square
                :loading="explaining"
                @click="runExplain"
              />
            </UTooltip>

            <input
              ref="sqlFileInput"
              type="file"
              accept=".sql,.txt"
              class="hidden"
              @change="onSqlFileSelected"
            >
            <UDropdownMenu
              v-if="isMobile"
              :items="mobileToolbarMenu"
            >
              <UButton
                icon="i-lucide-ellipsis-vertical"
                color="neutral"
                variant="outline"
                size="sm"
                square
                :aria-label="t('database.sqlConsolePanel.moreTools')"
              />
            </UDropdownMenu>
            <template v-else>
              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.openSqlFile')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.openSqlFile')"
                  icon="i-lucide-folder-open"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="openSqlFile"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.saveSqlFile')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.saveSqlFile')"
                  icon="i-lucide-download"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="saveSqlFile"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.formatSql')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.formatSql')"
                  icon="i-lucide-wand-sparkles"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.formatSql()"
                />
              </UTooltip>
              <UTooltip :text="t('common.clear')">
                <UButton
                  :aria-label="t('common.clear')"
                  icon="i-lucide-eraser"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.clear()"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.undoShortcut')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.undo')"
                  icon="i-lucide-undo-2"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.undo()"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.redoShortcut')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.redo')"
                  icon="i-lucide-redo-2"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.redo()"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('common.copy')">
                <UButton
                  :aria-label="t('common.copy')"
                  icon="i-lucide-copy"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.copySelection()"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.paste')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.paste')"
                  icon="i-lucide-clipboard-paste"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.pasteAtCursor()"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.wordWrap')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.wordWrap')"
                  icon="i-lucide-wrap-text"
                  :color="editorRef?.wordWrap ? 'primary' : 'neutral'"
                  variant="outline"
                  size="sm"
                  square
                  @click="editorRef?.toggleWordWrap()"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.decreaseFontSize')">
                <UButton
                  label="A-"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="editorRef?.setFontSize((editorRef?.fontSize ?? 13) - 1)"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.increaseFontSize')">
                <UButton
                  label="A+"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  @click="editorRef?.setFontSize((editorRef?.fontSize ?? 13) + 1)"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.sideBySide')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.sideBySide')"
                  icon="i-lucide-columns-2"
                  :color="splitterOrientation === 'horizontal' ? 'primary' : 'neutral'"
                  variant="outline"
                  size="sm"
                  square
                  @click="splitterOrientation = 'horizontal'"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.stacked')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.stacked')"
                  icon="i-lucide-rows-2"
                  :color="splitterOrientation === 'vertical' ? 'primary' : 'neutral'"
                  variant="outline"
                  size="sm"
                  square
                  @click="splitterOrientation = 'vertical'"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <div class="flex items-center gap-2">
                <USwitch
                  v-model="transactional"
                  :aria-label="t('database.sqlConsolePanel.transactional')"
                />
                <span class="text-sm text-muted">{{ t('database.sqlConsolePanel.transactional') }}</span>
              </div>
            </template>
            <USelect
              v-model="schema"
              :items="schemas.map(schema => ({ label: schema, value: schema }))"
              value-key="value"
              size="sm"
              class="ms-auto w-36"
              :aria-label="t('database.sqlConsolePanel.schemaContext')"
            />
          </div>

          <UTabs
            v-model="activeView"
            :items="[
              { label: t('database.sqlConsolePanel.editor'), value: 'editor', icon: 'i-lucide-code' },
              { label: t('database.sqlConsolePanel.history'), value: 'history', icon: 'i-lucide-history' }
            ]"
            :content="false"
            size="sm"
            class="shrink-0 w-56"
          />

          <div
            v-show="activeView === 'editor'"
            class="flex-1 border border-default rounded-lg overflow-hidden min-h-0"
          >
            <SqlEditor
              ref="editorRef"
              v-model="sql"
              :completion-items="completionItems"
              @execute="run"
            />
          </div>

          <div
            v-if="activeView === 'history'"
            class="flex-1 min-h-0 flex flex-col gap-2 border border-default rounded-lg p-3"
          >
            <div class="flex items-center gap-1 shrink-0">
              <UInput
                v-model="historySearch"
                :aria-label="t('database.sqlConsolePanel.searchHistory')"
                icon="i-lucide-search"
                :placeholder="t('database.sqlConsolePanel.searchHistory')"
                size="sm"
                class="w-40"
              />

              <UPopover class="ms-auto">
                <UTooltip :text="t('database.sqlConsolePanel.purgeTooltip')">
                  <UButton
                    icon="i-lucide-calendar-x"
                    :label="t('database.sqlConsolePanel.purge')"
                    color="neutral"
                    variant="outline"
                    size="sm"
                  />
                </UTooltip>

                <template #content>
                  <div class="flex flex-col gap-2 p-3 w-64">
                    <i18n-t
                      keypath="database.sqlConsolePanel.purgeHelp"
                      tag="p"
                      class="text-xs text-muted"
                    >
                      <template #settings>
                        <span class="font-medium text-default">{{ t('database.sqlConsolePanel.purgeHelpSettings') }}</span>
                      </template>
                    </i18n-t>
                    <UInput
                      v-model="purgeBeforeDate"
                      type="date"
                      :aria-label="t('database.sqlConsolePanel.purgeBefore')"
                      size="sm"
                    />
                    <UButton
                      :label="t('database.sqlConsolePanel.purge')"
                      color="error"
                      variant="outline"
                      size="sm"
                      block
                      :disabled="!purgeBeforeDate"
                      :loading="purging"
                      @click="purgeHistory"
                    />
                  </div>
                </template>
              </UPopover>
            </div>

            <div class="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
              <button
                v-for="entry in history"
                :key="entry.id"
                type="button"
                class="flex items-start gap-2 text-left border border-default rounded-lg p-3 hover:bg-elevated transition-colors"
                @click="loadFromHistory(entry)"
              >
                <div class="flex-1 min-w-0">
                  <div class="flex items-center justify-between mb-1 gap-2">
                    <UBadge
                      :color="entry.status === 'EXECUTED' ? 'success' : 'error'"
                      variant="subtle"
                      size="sm"
                    >
                      {{ entry.status }}
                    </UBadge>
                    <span class="text-xs text-muted shrink-0">{{ dates.dateTime(entry.createdAt) }}</span>
                  </div>
                  <code class="text-xs font-mono line-clamp-2">{{ entry.sqlText }}</code>
                </div>
                <UTooltip :text="t('common.copy')">
                  <UButton
                    :aria-label="t('common.copy')"
                    icon="i-lucide-copy"
                    color="neutral"
                    variant="outline"
                    size="xs"
                    square
                    class="shrink-0"
                    @click.stop="copyHistoryEntry(entry)"
                  />
                </UTooltip>
                <UTooltip :text="t('database.sqlConsolePanel.useInEditor')">
                  <UButton
                    :aria-label="t('database.sqlConsolePanel.useInEditor')"
                    icon="i-lucide-clipboard-copy"
                    color="neutral"
                    variant="outline"
                    size="xs"
                    square
                    class="shrink-0"
                    @click.stop="useInEditor(entry)"
                  />
                </UTooltip>
              </button>
              <p
                v-if="history.length === 0"
                class="text-sm text-muted py-8 text-center"
              >
                {{ historySearch ? t('database.sqlConsolePanel.noHistoryMatch', { search: historySearch }) : t('database.sqlConsolePanel.noHistory') }}
              </p>
              <UButton
                v-if="historyHasMore"
                :label="t('database.sqlConsolePanel.loadMore')"
                icon="i-lucide-chevron-down"
                color="neutral"
                variant="outline"
                size="sm"
                block
                :loading="historyLoadingMore"
                @click="loadMoreHistory"
              />
            </div>
          </div>
        </div>
      </template>

      <template #panel-1>
        <div :class="['flex flex-col min-h-0 min-w-0 gap-2 h-full w-full', splitterOrientation === 'horizontal' ? 'ps-3' : 'pt-3']">
          <div class="flex flex-wrap items-center gap-1 shrink-0 border-b border-default pb-3">
            <div class="ms-auto flex items-center gap-1">
              <UInput
                v-model="resultsSearch"
                :aria-label="t('database.sqlConsolePanel.searchRows')"
                icon="i-lucide-search"
                :placeholder="t('database.sqlConsolePanel.searchRows')"
                size="sm"
                class="w-40"
              />

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.wrapCells')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.wrapCells')"
                  icon="i-lucide-wrap-text"
                  :color="resultsWrap ? 'primary' : 'neutral'"
                  variant="outline"
                  size="sm"
                  square
                  @click="resultsWrap = !resultsWrap"
                />
              </UTooltip>

              <div class="w-px h-5 bg-border mx-1" />

              <UTooltip :text="t('database.sqlConsolePanel.exportCsv')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.exportCsv')"
                  icon="i-lucide-file-down"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  :disabled="!result || result.rows.length === 0"
                  @click="exportCsv"
                />
              </UTooltip>
              <UTooltip :text="t('database.sqlConsolePanel.exportJson')">
                <UButton
                  :aria-label="t('database.sqlConsolePanel.exportJson')"
                  icon="i-lucide-braces"
                  color="neutral"
                  variant="outline"
                  size="sm"
                  square
                  :disabled="!result || result.rows.length === 0"
                  @click="exportJson"
                />
              </UTooltip>
            </div>
          </div>

          <UTabs
            v-model="activeResultsView"
            :items="[
              { label: t('database.sqlConsolePanel.results'), value: 'results', icon: 'i-lucide-table' },
              { label: t('database.sqlConsolePanel.plan'), value: 'plan', icon: 'i-lucide-list-tree' }
            ]"
            :content="false"
            size="sm"
            class="shrink-0 w-56"
          />

          <div
            v-show="activeResultsView === 'results'"
            class="flex-1 border border-default rounded-lg overflow-hidden min-h-0 p-3"
          >
            <SqlResultsPanel
              :result="result"
              :error="executionError"
              :executing="executing"
              :search="resultsSearch"
              :wrap="resultsWrap"
            />
          </div>

          <div
            v-if="activeResultsView === 'plan'"
            class="flex-1 min-h-0 overflow-y-auto border border-default rounded-lg p-3"
          >
            <pre
              v-if="explainPlan"
              class="text-xs font-mono whitespace-pre-wrap bg-elevated rounded-md p-3"
            >{{ JSON.stringify(explainPlan, null, 2) }}</pre>
            <p
              v-else
              class="text-sm text-muted py-8 text-center"
            >
              {{ t('database.sqlConsolePanel.planEmpty') }}
            </p>
          </div>
        </div>
      </template>
    </USplitter>
  </div>
</template>
