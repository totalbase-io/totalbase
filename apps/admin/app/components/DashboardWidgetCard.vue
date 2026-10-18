<script setup lang="ts">
/**
 * One canvas card on the Dashboard editor - mounted by GridStack itself
 * (`component: 'DashboardWidgetCard'`, see dashboards/[id].vue's own
 * `gridWidgets`/`gridComponents`), not by a normal parent `v-for`. Same
 * shape as DataView's DataViewDesignFieldCard.vue: only `widgetId` is a
 * real prop, everything else comes from useDashboardCanvasContext.
 *
 * Runs the widget's saved draft query (admin-only endpoint) and hands
 * the result to DashboardWidgetView.vue, which draws it.
 */
import type { DashboardQueryResult } from '~/types/dashboard'
import { DASHBOARD_TITLE_BINDING, dashboardWidgetDefinition } from '@totalbase/tb-catalog'
import { DASHBOARD_SLOW_QUERY_MS, DASHBOARD_WIDGET_META, useDashboardCatalogText } from '~/types/dashboard'
import { dashboardFormulaVars, evaluateDashboardFormula } from '~/utils/dashboard-formula'
import { useApiErrorMessage } from '~/utils/api-error-message'
import { AdminApiError } from '~/utils/admin-api-error'
import { DASHBOARD_CANVAS_CONTEXT_KEY, type ViewerDashboardWidget } from '~/composables/useDashboardCanvasContext'
import { createDashboardRefreshScheduler, type DashboardRefreshScheduler } from '~/utils/dashboard-refresh'
import { resolveDashboardClick } from '~/utils/dashboard-click'
import { dashboardExportTable, downloadDashboardTable, downloadImage } from '~/utils/dashboard-export'
import type { DateDisplay } from '~/utils/dashboard-widget-render'

const props = defineProps<{ widgetId: string }>()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const catalog = useDashboardCatalogText()

const ctx = inject(DASHBOARD_CANVAS_CONTEXT_KEY)
if (!ctx) throw new Error('DashboardWidgetCard must be mounted inside the Dashboard editor\'s canvas')

const api = ctx.client ?? (ctx.plane === 'app' ? useAppApi() : useAdminApi())

const widget = computed(() => ctx.widgets.value.find(w => w.id === props.widgetId))
const meta = computed(() => (widget.value ? DASHBOARD_WIDGET_META[widget.value.type] : undefined))
// The App never sends a viewer the query - its widgets say whether one exists instead.
const configured = computed(() => Boolean(widget.value && (widget.value.query ?? (widget.value as ViewerDashboardWidget).configured)))
/** A presentation widget (D3) draws from its props and formulas - its query, if any, only gives them rows. */
const presentation = computed(() => Boolean(widget.value && dashboardWidgetDefinition(widget.value.type).page))

const result = ref<DashboardQueryResult | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
/** PostgreSQL's own words for a failed query - the editor's, under the readable sentence (D23). */
const errorDetail = ref<string | null>(null)

/** The auto-refresh timer while the dashboard has an interval (below). */
let scheduler: DashboardRefreshScheduler | null = null
/** The run in flight, if any - an auto-refresh tick waits for it instead of starting a second one. */
let inflight: Promise<void> | null = null
function load(fresh = false): Promise<void> {
  const run = runQuery(fresh).finally(() => {
    if (inflight === run) inflight = null
  })
  inflight = run
  return run
}

async function runQuery(fresh: boolean) {
  const current = widget.value
  if (!current || !configured.value) {
    result.value = null
    error.value = null
    return
  }
  loading.value = true
  error.value = null
  errorDetail.value = null
  try {
    const { data } = await api.post<DashboardQueryResult>(ctx!.dataPath(current), {
      data: { variables: ctx!.variableValues.value },
      // The header's Refresh: past the server's cache (D24).
      ...(fresh && { fresh: true })
    })
    result.value = data
    ctx!.onLoaded?.()
  } catch (err) {
    result.value = null
    // A failed or slow query reads as a sentence in the viewer's language; the editor also gets PostgreSQL's message.
    const code = err instanceof AdminApiError ? err.code : ''
    error.value = code === 'DASHBOARD_WIDGET_QUERY_TIMEOUT'
      ? t('dashboards.widgetView.timeout')
      : code === 'DASHBOARD_WIDGET_QUERY_FAILED' ? t('dashboards.widgetView.failed') : errorMessage(err, t('dashboards.widgetDrawer.runFailed'))
    // The editor also reads the server's own detail of a run's refusal (the row a negative value is in).
    const detailed = code === 'DASHBOARD_WIDGET_QUERY_FAILED' || code === 'DASHBOARD_WIDGET_NEGATIVE_VALUE' || code === 'DASHBOARD_PIVOT_TOO_MANY_COLUMNS'
    errorDetail.value = detailed && ctx!.plane !== 'app' ? (err as Error).message : null
  } finally {
    loading.value = false
  }
}

// Only the values of the variables THIS widget's query references - changing an unrelated filter doesn't re-run it.
const referencedValues = computed(() => JSON.stringify((widget.value?.referencedVariables ?? []).map(name => [name, ctx.variableValues.value[name]])))

// What's seen runs (D7): a card out of sight waits until it scrolls into view - then it runs as any other.
const root = useTemplateRef<HTMLElement>('root')
const seen = ref(typeof IntersectionObserver === 'undefined')
let sight: IntersectionObserver | null = null
onMounted(() => {
  if (seen.value || !root.value) return
  sight = new IntersectionObserver((entries) => {
    if (entries.some(entry => entry.isIntersecting)) {
      seen.value = true
      sight?.disconnect()
    }
  }, { rootMargin: '200px' })
  sight.observe(root.value)
})
onBeforeUnmount(() => sight?.disconnect())

// Re-run when the saved query changes (drawer Save), on the header's Refresh, or when a referenced variable changes.
// dataPath changes when a version preview opens/closes - same widget id, different source.
let lastRefreshKey = ctx.refreshKey.value
watch(() => [widget.value?.query, ctx.refreshKey.value, referencedValues.value, widget.value ? ctx.dataPath(widget.value) : '', seen.value], () => {
  if (!seen.value) return
  const fresh = ctx.refreshKey.value !== lastRefreshKey
  lastRefreshKey = ctx.refreshKey.value
  // The next interval counts from when this run ends, not from when it started.
  void load(fresh).finally(() => scheduler?.restart())
}, { immediate: true })

// Auto-refresh (Specification_Dashboards.md §9.4) - the App's viewer only (the editor's canvas provides no interval):
// re-run on the dashboard's interval, never while a run is in flight, paused while the tab is hidden.
const refreshIntervalMs = computed(() => {
  const seconds = ctx.refreshIntervalSeconds?.value
  return seconds && widget.value && configured.value ? seconds * 1000 : null
})
watch(refreshIntervalMs, (intervalMs) => {
  scheduler?.stop()
  scheduler = intervalMs ? createDashboardRefreshScheduler({ intervalMs, run: () => inflight ?? load() }) : null
  scheduler?.start()
  // A run already in flight (the first load): the interval counts from its end.
  if (inflight) void inflight.finally(() => scheduler?.restart())
}, { immediate: true })
onBeforeUnmount(() => scheduler?.stop())

// The editor's canvas shows each widget's rows and time, the slow ones marked (D24); a viewer never.
// Not on a card a quarter of the canvas wide or less (a KPI): its title needs the room - the drawer shows it too.
const timing = computed(() => (ctx.plane !== 'app' && !ctx.readOnly.value && result.value && (widget.value?.gridW ?? 12) > 3 ? result.value : null))
const slowRun = computed(() => (timing.value?.durationMs ?? 0) >= DASHBOARD_SLOW_QUERY_MS)

const config = computed(() => (widget.value?.config ?? {}) as Record<string, unknown>)

// What its formulas read (D3): the variables (value and label), the viewer, and its rows.
const formulaContext = computed(() => ({
  vars: dashboardFormulaVars(ctx.variables?.value ?? [], ctx.variableValues.value, ctx.variableLabels?.value ?? {}),
  user: ctx.user?.value ?? null
}))
/** Its title: a formula's text when it gives one (`bindings.title`), else its label, else - a data widget - its type's name. */
const title = computed(() => {
  const current = widget.value
  if (!current) return ''
  const binding = (config.value.bindings as Record<string, { formula?: unknown }> | undefined)?.[DASHBOARD_TITLE_BINDING]
  if (typeof binding?.formula === 'string' && binding.formula.trim()) {
    const rows = result.value?.rows ?? []
    const text = evaluateDashboardFormula(binding.formula, { ...formulaContext.value, row: rows[0] ?? null, rows }, 'string')
    if (typeof text === 'string' && text.trim()) return text
  }
  return current.label || (presentation.value ? '' : catalog.widgetLabel(current.type))
})
/** A presentation widget shows a header only with a title or a description to show - the editor always, to drag it by. */
const showHeader = computed(() => !presentation.value || !ctx.readOnly.value || !!title.value || !!description.value)
const description = computed(() => (typeof config.value.description === 'string' && config.value.description.trim() ? config.value.description : null))
// What it says with no rows: its own text, else whether it filters by a period (D23).
const emptyText = computed(() => {
  if (typeof config.value.emptyText === 'string' && config.value.emptyText.trim()) return config.value.emptyText
  const periods = new Set((ctx.variables?.value ?? []).filter(v => v.type === 'DATE_RANGE').map(v => v.name))
  return (widget.value?.referencedVariables ?? []).some(name => periods.has(name)) ? t('dashboards.widgetView.noDataForPeriod') : t('dashboards.widgetView.noData')
})

function edit() {
  if (widget.value) ctx!.onEdit(widget.value)
}
/** The card's "⋮" in the editor - what acts on the widget (AGENTS.md section 25: every menu of actions is "⋮"). */
const editorMenu = computed(() => [
  [{ label: t('common.edit'), icon: 'i-lucide-pencil', onSelect: edit }],
  ...(ctx.onDuplicate ? [[{ label: t('common.duplicate'), icon: 'i-lucide-copy', onSelect: () => { if (widget.value) ctx.onDuplicate!(widget.value) } }]] : []),
  ...(ctx.tabs?.value.length && ctx.onMoveToTab
    ? [[{ label: t('dashboards.widgetCard.moveToTab'), icon: 'i-lucide-folder-input', children: ctx.tabs.value.filter(tab => tab.value !== (widget.value?.tab ?? ctx.tabs!.value[0]?.value)).map(tab => ({ label: tab.label, icon: tab.icon, onSelect: () => { if (widget.value) ctx.onMoveToTab!(widget.value, tab.value) } })) }]]
    : []),
  [{ label: t('common.deleteEllipsis'), icon: 'i-lucide-trash-2', color: 'error' as const, onSelect: () => { if (widget.value) ctx.onDelete(widget.value) } }]
])

// --- A viewer's card (D6, D8): what a click does, its downloads and full screen -----------------------------
const view = useTemplateRef<{ imageDataUrl?: () => string | null }>('view')
/** Its click runs for a viewer (an embed gets only the ones it can run). */
const clickable = computed(() => Boolean(ctx.onFilter && config.value.click && result.value))
function onSelect(row: Record<string, unknown>) {
  const action = resolveDashboardClick(config.value.click, { ...formulaContext.value, row, rows: result.value?.rows ?? [] })
  if (!action) return
  if (action.kind === 'filter') ctx!.onFilter?.(action.variable, action.value)
  else if (action.kind === 'route') void navigateTo({ path: action.path, query: action.query })
  else if (action.newTab) window.open(action.href, '_blank', 'noopener')
  else window.top!.location.href = action.href
}
const toast = useToast()
const ui = useUiLocale()
const dateTimeFormat = useDateTimeFormat()
/** A file's dates and numbers read as the card shows them - the viewer's zone and format, the UI's language. */
const dates: DateDisplay = {
  dateTime: dateTimeFormat.dateTime,
  date: dateTimeFormat.date,
  day: dateTimeFormat.day,
  get locale() { return ui.intlLocale.value },
  get text() { return { empty: t('dashboards.widgetView.empty'), yes: t('common.yes'), no: t('common.no'), total: t('dashboards.widgetView.total'), field: t('dashboards.widgetView.field'), value: t('dashboards.widgetView.value') } }
}
async function download(format: 'csv' | 'xlsx' | 'png') {
  const current = widget.value
  if (!current || !result.value) return
  try {
    if (format === 'png') {
      const url = view.value?.imageDataUrl?.()
      if (!url) return
      downloadImage(url, title.value)
    } else {
      await downloadDashboardTable(dashboardExportTable(current.type, config.value, result.value, dates), format, title.value)
      // Cut short by the row cap: the file holds what came, as a DataView's export says.
      if (result.value.truncated) toast.add({ title: t('dashboards.widgetCard.exportTruncated', { count: result.value.rows.length }), color: 'warning' })
    }
    if (ctx!.exports) await api.post(ctx!.exports.auditPath(current), { data: { format, rowCount: result.value.rows.length } }).catch(() => {})
  } catch (err) {
    notifyError(err, t('dashboards.widgetCard.exportError'))
  }
}
const fullscreen = ref(false)
/** A touch screen has no hover: a tap on a cut title shows all of it (DB21). */
const isTouch = useIsTouch()
const titleOpen = ref(false)
const isChart = computed(() => Boolean(widget.value && dashboardWidgetDefinition(widget.value.type).renderer === 'echarts'))
/** The viewer's "⋮": downloads (where allowed) and full screen - the same menu alerts will join. */
const viewerMenu = computed(() => {
  const downloads = ctx.exports?.allowed && result.value && !presentation.value
    ? [
        { label: t('dashboards.widgetCard.downloadCsv'), icon: 'i-lucide-file-text', onSelect: () => download('csv') },
        { label: t('dashboards.widgetCard.downloadExcel'), icon: 'i-lucide-file-spreadsheet', onSelect: () => download('xlsx') },
        ...(isChart.value ? [{ label: t('dashboards.widgetCard.downloadImage'), icon: 'i-lucide-image', onSelect: () => download('png') }] : [])
      ]
    : []
  const openFullscreen = () => {
    fullscreen.value = true
  }
  return [...(downloads.length ? [downloads] : []), [{ label: t('dashboards.widgetCard.fullscreen'), icon: 'i-lucide-maximize', onSelect: openFullscreen }]]
})
const menuItems = computed(() => (ctx.readOnly.value ? (ctx.onFilter ? viewerMenu.value : []) : editorMenu.value))
</script>

<template>
  <div
    ref="root"
    class="flex h-full w-full select-none flex-col gap-2 rounded-lg border border-default bg-default px-3 py-2"
  >
    <!-- Drag handle (gridOptions.draggable.handle in dashboards/[id].vue) -
    only the header drags, so pointer interaction with the widget body
    below (chart tooltips, a table's scroll) never starts a move. -->
    <!-- Double-click the header to edit - the "⋮" holds the rest. -->
    <div
      v-if="showHeader"
      class="flex items-center gap-1"
      :class="ctx.readOnly.value ? '' : 'dashboard-widget-drag-handle cursor-move'"
      @dblclick="ctx.readOnly.value ? undefined : edit()"
    >
      <UIcon
        :name="meta?.icon ?? 'i-lucide-square'"
        class="size-3.5 shrink-0 text-muted"
      />
      <!-- Two lines before it's cut (DB21); the whole title on hover, or a tap on a touch screen. -->
      <p
        class="min-w-0 flex-1 break-words text-sm font-medium leading-tight text-highlighted"
        :class="titleOpen ? '' : 'line-clamp-2'"
        :title="title || undefined"
        @click="isTouch && (titleOpen = !titleOpen)"
      >
        {{ title || (widget && !ctx.readOnly.value ? catalog.widgetLabel(widget.type) : '') }}
      </p>
      <!-- The widget's description: a click or a tap opens it (never hover-only - AGENTS.md section 25). -->
      <UPopover
        v-if="description"
        :content="{ side: 'top', align: 'start' }"
      >
        <UButton
          icon="i-lucide-info"
          color="neutral"
          variant="link"
          size="xs"
          class="shrink-0 p-0"
          :aria-label="t('dashboards.widgetCard.about')"
          @dblclick.stop
        />
        <template #content>
          <p class="max-w-72 whitespace-pre-line p-3 text-sm text-default">
            {{ description }}
          </p>
        </template>
      </UPopover>

      <!-- A result past the row cap (DB35): said wherever the widget shows - a click or a tap opens it. -->
      <UPopover
        v-if="result?.truncated"
        :content="{ side: 'top', align: 'end' }"
      >
        <UButton
          icon="i-lucide-triangle-alert"
          color="warning"
          variant="link"
          size="xs"
          class="shrink-0 p-0"
          :aria-label="t('dashboards.widgetCard.truncated', { count: result.rows.length })"
          @dblclick.stop
        />
        <template #content>
          <div class="max-w-72 space-y-1 p-3 text-sm">
            <p class="font-medium text-default">
              {{ t('dashboards.widgetCard.truncated', { count: result.rows.length }) }}
            </p>
            <p class="text-muted">
              {{ t('dashboards.widgetCard.truncatedHint') }}
            </p>
          </div>
        </template>
      </UPopover>

      <UTooltip
        v-if="timing"
        :text="slowRun ? t('dashboards.widgetCard.slow', { seconds: DASHBOARD_SLOW_QUERY_MS / 1000 }) : undefined"
        :disabled="!slowRun"
      >
        <span
          class="flex shrink-0 items-center gap-1 text-xs tabular-nums max-md:hidden"
          :class="slowRun ? 'text-warning' : 'text-dimmed'"
        >
          <UIcon
            v-if="slowRun"
            name="i-lucide-timer"
            class="size-3.5"
          />
          {{ t('dashboards.widgetCard.timing', { rows: t('dashboards.widgetDrawer.rows', timing.rows.length), ms: timing.durationMs }) }}
        </span>
      </UTooltip>
      <UDropdownMenu
        v-if="menuItems.length"
        :items="menuItems"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-ellipsis-vertical"
          :aria-label="t('dashboards.widgetCard.actions')"
          size="xs"
          color="neutral"
          variant="ghost"
          @click.stop
        />
      </UDropdownMenu>
    </div>
    <div
      v-if="widget"
      class="min-h-0 flex-1"
    >
      <DashboardWidgetView
        ref="view"
        :widget="widget"
        :configured="configured"
        :result="result"
        :loading="loading"
        :error="error"
        :error-detail="errorDetail"
        :empty-text="emptyText"
        :formula-context="formulaContext"
        :clickable="clickable"
        @configure="ctx.readOnly.value ? undefined : edit()"
        @select="onSelect"
      />
    </div>
    <!-- Full screen (D8): the chart resized, a table with all its rows. -->
    <UModal
      v-model:open="fullscreen"
      fullscreen
      :title="title"
    >
      <template #body>
        <div
          v-if="widget"
          class="h-full min-h-[60vh]"
        >
          <DashboardWidgetView
            :widget="widget"
            :configured="configured"
            :result="result"
            :loading="loading"
            :error="error"
            :empty-text="emptyText"
            :formula-context="formulaContext"
            :clickable="clickable"
            @select="(row: Record<string, unknown>) => { fullscreen = false; onSelect(row) }"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
