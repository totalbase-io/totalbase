<script setup lang="ts">
/**
 * Draws one dashboard widget from an already-fetched SQL result. Purely
 * presentational (AGENTS.md §21A): it never fetches and never reads the
 * route. The editor canvas (DashboardWidgetCard.vue), the widget drawer's
 * live preview, and the Apps viewer each fetch their own way (draft SQL,
 * saved draft, or a published widget by id) and hand the result in.
 *
 * What it draws is its builder's (utils/dashboard-builders.ts, one per
 * catalog entry): an ECharts option, or a KPI, progress, ranking, map, table,
 * detail or pivot model -
 * laid out in the card's real size (measured here), so a legend reserves its
 * room and a gauge's text fits its arc. A presentation widget (D3) is its page
 * widget's component instead (DashboardPresentationWidget.vue), its formulas
 * over `formulaContext` and the result's rows - drawn with no query too.
 *
 * Clickable (D6, `clickable` and the widget's `config.click`), a click hands
 * the clicked mark's row - the whole result row, `_` columns included - to
 * `select`; its host does what the action says. KPI, gauge and progress: the
 * card (its last row); detail: the card (its first row); ranking and table: a
 * row; pivot: a detail cell; map: a point; a chart: the mark, or the category
 * under the pointer. Its tooltip ends saying what a click does; on a
 * touch device the first tap shows the tooltip and a second tap on the same
 * mark clicks it. `imageDataUrl()` is an ECharts widget's PNG on the theme's
 * background (D8).
 */
import { dashboardWidgetDefinition } from '@totalbase/tb-catalog'
import type { DashboardQueryResult, DashboardWidget } from '~/types/dashboard'
import { buildWidget, type ClickDisplay } from '~/utils/dashboard-builders'
import { DASHBOARD_CANVAS_CONTEXT_KEY } from '~/composables/useDashboardCanvasContext'
import type { DashboardFormulaScope } from '~/utils/dashboard-formula'
import { fileLink, themeColor, type DateDisplay } from '~/utils/dashboard-widget-render'
import { widgetStyleClasses } from '~/utils/widget-style'

const props = withDefaults(defineProps<{
  widget: Pick<DashboardWidget, 'type' | 'config'>
  /** False = no query yet - a data widget draws the "not configured" state instead of data; a presentation widget draws all the same. */
  configured: boolean
  result?: DashboardQueryResult | null
  loading?: boolean
  error?: string | null
  /** PostgreSQL's message under the readable error - the editor's only. */
  errorDetail?: string | null
  /** What it says with no rows (D23) - the card's; else "No data". */
  emptyText?: string
  /** What a presentation widget's formulas read besides the rows: the variables and the viewer (D3). */
  formulaContext?: Pick<DashboardFormulaScope, 'vars' | 'user'>
  /** A click on its marks does what its `config.click` says (D6) - the App's; the editor's never. */
  clickable?: boolean
}>(), {
  result: null,
  loading: false,
  error: null,
  errorDetail: null,
  emptyText: undefined,
  formulaContext: () => ({ vars: {}, user: null }),
  clickable: false
})

const emit = defineEmits<{
  configure: []
  /** The clicked mark's row (D6). */
  select: [row: Record<string, unknown>]
}>()

/** A run still going after a few seconds says so (D24). */
const slow = ref(false)
let slowTimer: ReturnType<typeof setTimeout> | undefined
watch(() => props.loading, (loading) => {
  clearTimeout(slowTimer)
  slow.value = false
  if (loading) {
    slowTimer = setTimeout(() => {
      slow.value = true
    }, 3_000)
  }
}, { immediate: true })
onBeforeUnmount(() => clearTimeout(slowTimer))

const { colors } = useChartTheme()
const { t } = useI18n()
const ui = useUiLocale()
const colorMode = useColorMode()

// Dates in labels read in the viewer's zone and format (My account); numbers and words in the UI's language.
const dateTimeFormat = useDateTimeFormat()
const dates: DateDisplay = {
  dateTime: dateTimeFormat.dateTime,
  date: dateTimeFormat.date,
  day: dateTimeFormat.day,
  get locale() { return ui.intlLocale.value },
  get language() { return ui.languageTag.value },
  get text() {
    return {
      empty: t('dashboards.widgetView.empty'),
      yes: t('common.yes'),
      no: t('common.no'),
      total: t('dashboards.widgetView.total'),
      cumulative: t('dashboards.widgetView.cumulative'),
      field: t('dashboards.widgetView.field'),
      value: t('dashboards.widgetView.value')
    }
  },
  ofTarget: (target: string) => t('dashboards.widgetView.ofTarget', { target })
}

// The card's room - what the builders lay a legend and a gauge's text in.
const root = ref<HTMLElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | null = null
onMounted(() => {
  if (!root.value) return
  observer = new ResizeObserver(([entry]) => {
    if (!entry) return
    const { width, height } = entry.contentRect
    if (Math.round(width) !== size.value.width || Math.round(height) !== size.value.height) size.value = { width: Math.round(width), height: Math.round(height) }
  })
  observer.observe(root.value)
})
onBeforeUnmount(() => observer?.disconnect())

// --- Click (D6) ---------------------------------------------------------------

const isTouch = useIsTouch()
/** What a click does, said in its tooltip: its `click.hint`, else the App's words for its action. Null - not clickable. */
const click = computed<ClickDisplay | null>(() => {
  const config = props.widget.config?.click
  if (!props.clickable || !config || typeof config !== 'object') return null
  const { hint, action } = config as Record<string, unknown>
  if (typeof hint === 'string' && hint.trim()) return { hint }
  const key = typeof action === 'string' ? action.toLowerCase() : ''
  return { hint: t(`dashboards.widgetView.${isTouch.value ? 'tapHint' : 'clickHint'}.${key}`) }
})

/** The mark a first tap showed the tooltip of (a touch device) - a second tap on it clicks it. */
let armed: string | null = null
function select(row: Record<string, unknown> | undefined, mark?: string) {
  if (!row || !click.value) return
  if (mark !== undefined && isTouch.value && armed !== mark) {
    armed = mark
    return
  }
  armed = null
  emit('select', row)
}

/** The card itself is the mark: a KPI, a gauge, a progress - its last row; a detail - its first. */
const cardClickable = computed(() => Boolean(click.value) && (built.value?.renderer === 'kpi' || built.value?.renderer === 'progress' || built.value?.renderer === 'detail' || (built.value?.renderer === 'echarts' && !built.value.pick)))
function onCardClick() {
  const current = built.value
  if (!cardClickable.value || !current) return
  if (current.renderer === 'kpi' || current.renderer === 'progress') select(current.row)
  else if (current.renderer === 'detail') select(props.result?.rows[0])
  else select(props.result?.rows[props.result.rows.length - 1])
}

/** What this component reads of the ECharts instance (vue-echarts exposes its methods). */
interface ChartHandle {
  getDataURL: (options: { type: 'png', pixelRatio: number, backgroundColor: string }) => string
  containPixel: (finder: Record<string, number>, value: number[]) => boolean
  convertFromPixel: (finder: Record<string, number>, value: number[]) => number[] | number
}
const chartRef = ref<ChartHandle | null>(null)

// A mark's own click, then - from the same zrender click - the area's: the area's only picks when no mark did.
let markClicked = false
function onChartClick(params: { componentType?: string, seriesIndex?: number, dataIndex?: number, data?: unknown }) {
  const current = built.value
  if (!click.value || current?.renderer !== 'echarts' || !current.pick || params.componentType !== 'series' || typeof params.dataIndex !== 'number') return
  markClicked = true
  select(current.pick.rowAt(params.seriesIndex ?? null, params.dataIndex, undefined, params.data), `${params.seriesIndex}:${params.dataIndex}`)
}
/** A click on the plot away from a mark (a line between its points): the category under the pointer. */
function onChartAreaClick(event: { offsetX: number, offsetY: number }) {
  setTimeout(() => {
    if (markClicked) {
      markClicked = false
      return
    }
    const current = built.value
    const handle = chartRef.value
    if (!click.value || current?.renderer !== 'echarts' || !current.pick?.grid || !handle) return
    const point = [event.offsetX, event.offsetY]
    if (!handle.containPixel({ gridIndex: 0 }, point)) return
    const at = handle.convertFromPixel({ gridIndex: 0 }, point)
    if (!Array.isArray(at)) return
    const [x, y] = at as [number, number]
    const dataIndex = Math.round(current.pick.horizontal ? y : x)
    select(current.pick.rowAt(null, dataIndex, current.pick.horizontal ? x : y), `category:${dataIndex}`)
  })
}

// --- Image (D8) ---------------------------------------------------------------

/** The theme's background (`--ui-bg`), canvas-safe - a PNG's, so it reads as on screen in light and dark. */
function themeBackground(): string {
  const holder = document.createElement('span')
  holder.style.color = 'var(--ui-bg)'
  document.body.appendChild(holder)
  const value = getComputedStyle(holder).color
  holder.remove()
  return themeColor(value || '#ffffff')
}

defineExpose({
  /** An ECharts widget's PNG at twice its size, on the theme's background - null for any other widget. */
  imageDataUrl: (): string | null => {
    if (built.value?.renderer !== 'echarts' || !chartRef.value) return null
    return chartRef.value.getDataURL({ type: 'png', pixelRatio: 2, backgroundColor: themeBackground() })
  }
})

/** A presentation widget's page widget - drawn from its props and formulas, with or without rows. */
const page = computed(() => dashboardWidgetDefinition(props.widget.type).page)
const scope = computed<DashboardFormulaScope>(() => {
  const rows = props.result?.rows ?? []
  return { ...props.formulaContext, row: rows[0] ?? null, rows }
})

const drawn = computed(() => {
  if (page.value || !props.result || props.result.rows.length === 0 || size.value.width === 0) return null
  // Reads colorMode so a light/dark switch re-resolves the palette's shades.
  void colorMode.value
  return buildWidget({ type: props.widget.type, config: props.widget.config ?? {} }, props.result, { theme: colors.value, dates, size: size.value, click: click.value })
})
const built = computed(() => drawn.value?.built ?? null)
const roleErrors = computed(() => drawn.value?.errors ?? [])
/** Its Styles (`config.style` - the page catalog's common block) on its body. */
const styleClasses = computed(() => {
  const style = props.widget.config?.style
  return style && typeof style === 'object' ? widgetStyleClasses(style as Record<string, unknown>) : []
})
const echartsLocale = computed(() => (ui.intlLocale.value?.toLowerCase().startsWith('es') ? 'ES' : 'EN'))

/** The editor's (its canvas or its drawer's preview), not the App's - where a DETAIL says it shows only the first row. */
const canvas = inject(DASHBOARD_CANVAS_CONTEXT_KEY, null)
const inEditor = computed(() => (canvas?.plane ?? 'admin') === 'admin')
const isMobile = useIsMobile()
/** A DETAIL's two columns (AUTO): a card about 6 grid columns wide or more - never on a phone. */
const detailWide = computed(() => size.value.width >= 560 && !isMobile.value)
const detailNotice = computed(() => (inEditor.value && (props.result?.rows.length ?? 0) > 1 ? t('dashboards.widgetView.detailFirstRow', { count: props.result!.rows.length }) : null))
const timezone = computed(() => dateTimeFormat.timezone.value)
</script>

<template>
  <div
    ref="root"
    class="relative h-full w-full min-h-0"
    :class="styleClasses"
  >
    <div
      v-if="!configured && !page"
      class="flex h-full flex-col items-center justify-center gap-2 text-center"
    >
      <p class="text-xs text-muted">
        {{ t('dashboards.widgetView.notConfigured') }}
      </p>
      <UButton
        :label="t('dashboards.widgetView.configure')"
        icon="i-lucide-settings-2"
        size="xs"
        color="neutral"
        variant="outline"
        @click.stop="emit('configure')"
      />
    </div>

    <!-- Readable, never cut: the sentence, and (the editor's) PostgreSQL's words scrolling under it (D23). -->
    <div
      v-else-if="error || roleErrors.length"
      class="flex h-full flex-col items-center justify-center gap-1 overflow-y-auto px-2 text-center text-xs"
      role="alert"
    >
      <UIcon
        name="i-lucide-circle-alert"
        class="size-4 shrink-0 text-error"
      />
      <p class="text-error">
        {{ error ?? roleErrors.join(' ') }}
      </p>
      <p
        v-if="error && errorDetail"
        class="font-mono text-muted"
      >
        {{ errorDetail }}
      </p>
    </div>

    <!-- A presentation widget: its page widget, its formulas over the rows (none until they arrive, or without a query). -->
    <DashboardPresentationWidget
      v-else-if="page"
      :page="page"
      :config="widget.config ?? {}"
      :scope="scope"
      :files="result?.files ?? null"
    />

    <!-- Loading, nothing to show yet: a skeleton, and after a few seconds a word that it is still running (D24). -->
    <div
      v-else-if="!result"
      class="relative flex h-full items-center justify-center"
    >
      <template v-if="loading">
        <USkeleton class="absolute inset-0" />
        <p
          v-if="slow"
          class="relative text-xs text-muted"
          role="status"
        >
          {{ t('dashboards.widgetView.stillComputing') }}
        </p>
      </template>
    </div>

    <div
      v-else-if="result.rows.length === 0"
      class="flex h-full items-center justify-center text-xs text-muted"
    >
      {{ emptyText ?? t('dashboards.widgetView.noData') }}
    </div>

    <template v-else-if="built">
      <!-- The value's size follows the card's width (container query units), so a narrow card shrinks it instead of cutting it; the whole value on hover. -->
      <div
        v-if="built.renderer === 'kpi'"
        class="@container flex h-full flex-col justify-center gap-1"
        :role="cardClickable ? 'button' : undefined"
        :tabindex="cardClickable ? 0 : undefined"
        :class="{ 'card-click': cardClickable }"
        @click="onCardClick"
        @keydown.enter.space.self.prevent="onCardClick"
      >
        <div class="flex min-w-0 items-baseline gap-2">
          <p
            class="min-w-0 truncate text-[clamp(1rem,11cqw,1.875rem)] font-semibold tabular-nums text-highlighted"
            :style="built.color ? { color: built.color } : undefined"
            :title="built.value"
          >
            {{ built.value }}
          </p>
          <UBadge
            v-if="built.delta"
            :color="built.delta.positive ? 'success' : 'error'"
            variant="subtle"
            size="sm"
            :icon="built.delta.up ? 'i-lucide-trending-up' : 'i-lucide-trending-down'"
          >
            {{ built.delta.text }}
          </UBadge>
        </div>
        <p
          v-if="built.target"
          class="text-xs text-muted"
        >
          {{ t('dashboards.widgetView.ofTarget', { target: built.target }) }}
        </p>
        <ChartCanvas
          v-if="built.sparkline"
          class="h-8 w-full"
          :option="built.sparkline"
          autoresize
        />
      </div>

      <DashboardWidgetProgress
        v-else-if="built.renderer === 'progress'"
        :model="built"
        :role="cardClickable ? 'button' : undefined"
        :tabindex="cardClickable ? 0 : undefined"
        :class="{ 'card-click': cardClickable }"
        @click="onCardClick"
        @keydown.enter.space.self.prevent="onCardClick"
      />

      <ol
        v-else-if="built.renderer === 'ranking'"
        class="flex h-full flex-col gap-2 overflow-y-auto"
      >
        <li
          v-for="(row, index) in built.rows"
          :key="index"
          class="flex flex-col gap-1"
          :class="{ 'cursor-pointer': click }"
          :role="click ? 'button' : undefined"
          :tabindex="click ? 0 : undefined"
          @click="select(row.row)"
          @keydown.enter="select(row.row)"
        >
          <div class="flex items-baseline gap-2 text-sm">
            <span class="w-5 shrink-0 text-right text-xs tabular-nums text-muted">{{ index + 1 }}</span>
            <DashboardFileImage
              v-if="row.image && fileLink(result, row.image)"
              :file="fileLink(result, row.image)"
              :alt="row.label"
              variant="thumb"
            />
            <span class="min-w-0 flex-1 truncate text-highlighted">{{ row.label }}</span>
            <span class="shrink-0 tabular-nums font-medium">{{ row.value }}</span>
          </div>
          <div class="ml-7 h-1.5 rounded-full bg-elevated">
            <div
              class="h-full rounded-full"
              :style="{ width: `${row.pct}%`, backgroundColor: row.color ?? built.color }"
            />
          </div>
        </li>
      </ol>

      <div
        v-else-if="built.renderer === 'map'"
        class="h-full"
      >
        <p
          v-if="built.points.length === 0"
          class="flex h-full items-center justify-center text-center text-xs text-muted"
        >
          {{ t('dashboards.widgetView.noLocations') }}
        </p>
        <DashboardWidgetMap
          v-else
          :points="built.points"
          :color="built.color"
          :cluster="built.cluster"
          :click-hint="click?.hint ?? null"
          :confirm-tap="isTouch"
          @select="select"
        />
      </div>

      <DashboardWidgetTable
        v-else-if="built.renderer === 'table'"
        :result="result"
        :config="widget.config ?? {}"
        :shown="built.columns"
        :clickable="Boolean(click)"
        @select="select"
      />

      <DashboardWidgetDetail
        v-else-if="built.renderer === 'detail'"
        :result="result"
        :config="widget.config ?? {}"
        :columns="built.columns"
        :image="built.image"
        :layout="built.layout"
        :wide="detailWide"
        :dates="dates"
        :timezone="timezone"
        :notice="detailNotice"
        :role="cardClickable ? 'button' : undefined"
        :tabindex="cardClickable ? 0 : undefined"
        :class="{ 'card-click': cardClickable }"
        @click="onCardClick"
        @keydown.enter.space.self.prevent="onCardClick"
      />

      <DashboardWidgetPivot
        v-else-if="built.renderer === 'pivot'"
        :result="result"
        :config="widget.config ?? {}"
        :roles="{ rows: built.rows, columns: built.columns, values: built.values }"
        :dates="dates"
        :timezone="timezone"
        :clickable="Boolean(click)"
        @select="(row: Record<string, unknown>) => select(row)"
      />

      <div
        v-else-if="built.renderer === 'echarts'"
        class="flex h-full w-full flex-col"
        :role="cardClickable ? 'button' : undefined"
        :tabindex="cardClickable ? 0 : undefined"
        :class="{ 'card-click': cardClickable }"
        @click="onCardClick"
        @keydown.enter.space.self.prevent="onCardClick"
      >
        <ChartCanvas
          ref="chartRef"
          class="min-h-0 w-full flex-1"
          :option="built.option"
          :init-options="{ locale: echartsLocale }"
          autoresize
          @click="onChartClick"
          @zr:click="onChartAreaClick"
        />
        <p
          v-if="built.notice"
          class="shrink-0 pt-1 text-center text-xs text-warning"
          role="note"
        >
          {{ t(`dashboards.widgetView.${built.notice.key}`, built.notice.params) }}
        </p>
      </div>
    </template>

    <UIcon
      v-if="loading && result"
      name="i-lucide-loader-circle"
      class="absolute right-0 top-0 size-3.5 animate-spin text-muted"
    />
  </div>
</template>

<style scoped>
/* The whole card is the mark (KPI, gauge): the hand everywhere on it - over ECharts' own cursor on its canvas too. */
.card-click,
.card-click :deep(*) {
  cursor: pointer !important;
}
</style>
