<script setup lang="ts">
/**
 * A published Dashboard's cards and variables bar, served by /app/api -
 * the viewer never receives SQL; each widget runs from the published
 * snapshot by its id (AGENTS.md section 7, "Dashboard widget SQL").
 *
 * Everything comes in as props (AGENTS.md §21A), so the same component is
 * the App's Dashboard page (DashboardViewer.vue, which adds the header and
 * mirrors the variables into the URL) and a `TDashboard` widget on a
 * DataView page (WidgetDashboard.vue, which sets some variables from the
 * page). `hiddenVariables` are set by the host and left out of the bar. No
 * top-level await: it mounts inside pages' widgets, outside a page's
 * Suspense.
 *
 * Access is the Dashboard's own: a viewer without it gets RESOURCE_NOT_FOUND
 * from every call, shown here as "not available".
 *
 * Auto-refresh (Specification_Dashboards.md §9.4): with the dashboard's
 * `refreshIntervalSeconds` set, each card re-runs its query on that interval
 * (DashboardWidgetCard.vue, utils/dashboard-refresh.ts) - in either host.
 */
import type { GridStack as GridStackCore, GridStackWidget } from 'gridstack'
import { GridStack } from 'gridstack/dist/vue'
import 'gridstack/dist/gridstack.css'
import type { LocationQuery } from 'vue-router'
import { formatDistanceToNow } from 'date-fns'
import { dashboardWidgetDefinition } from '@totalbase/tb-catalog'
import type { Dashboard, DashboardVariable } from '~/types/dashboard'
import { decodeVariableValues } from '~/utils/dashboard-variables'
import { DASHBOARD_CANVAS_CONTEXT_KEY, type ViewerDashboardWidget } from '~/composables/useDashboardCanvasContext'
import DashboardWidgetCard from '~/components/DashboardWidgetCard.vue'
import { DASHBOARD_DESIGN_COLUMNS, dashboardFlowLayout } from '~/utils/dashboard-layout'

const props = withDefaults(defineProps<{
  /** The App's dashboard (its slug or id) - unused with `embedToken`. */
  slug?: string
  /** A signed embed (Specification_Dashboards.md §9.5): the dashboard comes from the token, through /embed/api. */
  embedToken?: string
  /** Bumped by the host's Refresh - every card re-runs its query. */
  refreshKey?: number
  /** Variables the host sets itself (bound to a record) - not shown in the bar. */
  hiddenVariables?: string[]
  /** No variables bar at all (an embed's `hide=variables`). */
  hideBar?: boolean
  /** The dashboard's name and description above it - unset, an embed's own setting (`display.titled`). */
  titled?: boolean
  /** Starting values in the URL's own form (`dashboard-variables.ts`) - read once, when the variables arrive, unless some are already set. */
  initialQuery?: LocationQuery
  /** Overrides the dashboard's auto-refresh: seconds, or null for off; undefined keeps its own (an embed's `refresh=`). */
  refreshOverride?: number | null
}>(), {
  slug: '',
  embedToken: undefined,
  refreshKey: 0,
  hiddenVariables: () => [],
  hideBar: false,
  titled: undefined,
  initialQuery: undefined,
  refreshOverride: undefined
})
/** The explicitly-set `$VAR.*` values - sent with every widget's data request. */
const variableValues = defineModel<Record<string, unknown>>('variableValues', { required: true })
/** The open tab's value (D7) - unset: the first. The App's page keeps it in `?tab=`. */
const tab = defineModel<string | undefined>('tab', { default: undefined })
const emit = defineEmits<{
  /** A click set a variable (D6) - the App's page pushes the URL, so Back undoes it. */
  filter: []
}>()
const { t } = useI18n()

// The App's routes, or a signed embed's - the same shapes under another base (embed-dashboards.ts).
const api = props.embedToken ? useEmbedApi(props.embedToken) : useAppApi()
const base = computed(() => (props.embedToken ? '/dashboard' : `/dashboards/${props.slug}`))
const cacheKey = computed(() => (props.embedToken ? 'embed' : props.slug))

/** An embed's identity also says how it looks and where its editable variables start (embed-dashboards.ts). */
type ViewerDashboard = Omit<Dashboard, 'variables'> & {
  display?: { titled?: boolean, refreshSeconds?: number | null, allowExport?: boolean }
  startingValues?: Record<string, unknown>
}
const { data: dashboard, error } = useAsyncData(
  () => `app-dashboard-${cacheKey.value}`,
  () => api.get<ViewerDashboard>(base.value).then(r => r.data)
)
const titled = computed(() => props.titled ?? dashboard.value?.display?.titled ?? false)
const { data: widgets, pending } = useAsyncData(
  () => `app-dashboard-widgets-${cacheKey.value}`,
  () => api.get<ViewerDashboardWidget[]>(`${base.value}/widgets`).then(r => r.data),
  { default: (): ViewerDashboardWidget[] => [] }
)
const { data: variables } = useAsyncData(
  () => `app-dashboard-variables-${cacheKey.value}`,
  () => api.get<DashboardVariable[]>(`${base.value}/variables`).then(r => r.data),
  { default: (): DashboardVariable[] => [] }
)
const shownVariables = computed(() => (props.hideBar ? [] : (variables.value ?? []).filter(v => !props.hiddenVariables.includes(v.name))))
// Starting values once the definitions are known (they decide how a value is read: a range, a list, a number):
// an embed's configured ones, then the URL's over them.
let started = false
watch([variables, dashboard], ([list, identity]) => {
  if (started || !list?.length || !identity || Object.keys(variableValues.value).length > 0) return
  started = true
  const values = { ...identity.startingValues, ...(props.initialQuery ? decodeVariableValues(list, props.initialQuery) : {}) }
  if (Object.keys(values).length > 0) variableValues.value = values
}, { immediate: true })

async function loadVariableOptions(name: string, values: Record<string, unknown>) {
  const { data } = await api.post<{ value: string, label: string }[]>(`${base.value}/variables/${name}/options`, { data: { variables: values } })
  return data
}

const refreshKey = ref(props.refreshKey)
watch(() => props.refreshKey, (value) => {
  refreshKey.value = value
})
// A data widget without a query is the author's unfinished work: published, but never drawn for a viewer
// (Specification_Dashboards.md §2, item 6). A presentation widget draws without one (D3).
// Tabs (D7): only the open one's widgets are on the grid - the others don't run until it opens.
const tabs = computed(() => dashboard.value?.tabs ?? [])
const activeTab = computed({
  get: () => (tabs.value.some(t => t.value === tab.value) ? tab.value : tabs.value[0]?.value),
  set: (value) => {
    tab.value = value
  }
})
const tabItems = computed(() => tabs.value.map(t => ({ label: t.label, value: t.value, ...(t.icon && { icon: t.icon }) })))
const displayedWidgets = computed(() => ((widgets.value ?? []) as ViewerDashboardWidget[])
  .filter(widget => widget.configured || dashboardWidgetDefinition(widget.type).page)
  .filter(widget => !tabs.value.length || (widget.tab ?? tabs.value[0]!.value) === activeTab.value))
/** What the bar shows for each value - `{{vars.<name>.label}}`. */
const variableLabels = ref<Record<string, string>>({})
const session = useSession()
// "Updated 2 min ago" (D23): when the last widget's run came back, re-read every 30 s.
const updatedAt = ref<number | null>(null)
const now = ref(Date.now())
let clock: ReturnType<typeof setInterval> | undefined
onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now()
  }, 30_000)
})
onBeforeUnmount(() => clearInterval(clock))
const ui = useUiLocale()
const updatedAgo = computed(() => {
  if (updatedAt.value === null) return null
  void now.value
  return t('dashboards.view.updatedAgo', { ago: formatDistanceToNow(updatedAt.value, { addSuffix: true, locale: ui.dateFns.value }) })
})

provide(DASHBOARD_CANVAS_CONTEXT_KEY, {
  dashboardId: props.embedToken ? 'embed' : props.slug,
  widgets: displayedWidgets as ComputedRef<never[]>,
  onEdit: () => {},
  onDelete: () => {},
  refreshKey,
  refreshIntervalSeconds: computed(() => {
    if (props.refreshOverride !== undefined) return props.refreshOverride
    const own = dashboard.value?.display?.refreshSeconds
    return own !== undefined ? own : dashboard.value?.refreshIntervalSeconds ?? null
  }),
  variableValues,
  variables,
  variableLabels,
  // An embed has no viewer - nobody signed in sees it (Specification_Dashboards.md §9.5).
  user: computed(() => (props.embedToken ? null : session.admin.value)),
  onLoaded: () => {
    updatedAt.value = Date.now()
    now.value = updatedAt.value
  },
  readOnly: ref(true),
  dataPath: widget => `${base.value}/widgets/${widget.id}/data`,
  plane: 'app',
  client: api,
  // A click's FILTER sets this dashboard's variable (D6).
  onFilter: (name, value) => {
    emit('filter')
    variableValues.value = { ...variableValues.value, [name]: value }
  },
  // Downloads (D8): always in the App, in an embed only where it allows them.
  exports: {
    get allowed() {
      return props.embedToken ? dashboard.value?.display?.allowExport === true : true
    },
    auditPath: widget => `${base.value}/widgets/${widget.id}/exports`
  }
})

const gridRef = ref<{ getGrid(): GridStackCore | null } | null>(null)
// Responsive by the grid's own width (the App's menu, or the form around
// it, takes room beside it): 6 columns on a tablet-sized grid, one on a
// phone, re-flowed from the saved 12-column layout (dashboardFlowLayout -
// the editor's Tablet/Phone preview uses the same). GridStack keeps the
// saved layout cached and restores it when the grid widens again.
/** The space GridStack leaves around each widget - the variables bar takes the same inset. */
const GRID_MARGIN = 8
const gridOptions = {
  column: DASHBOARD_DESIGN_COLUMNS,
  cellHeight: 72,
  margin: GRID_MARGIN,
  float: false,
  staticGrid: true,
  columnOpts: {
    layout: dashboardFlowLayout((id) => {
      const widget = displayedWidgets.value.find(w => w.id === id)
      return widget && { x: widget.gridX, y: widget.gridY, w: widget.gridW, mobile: widget.config?.mobile }
    }),
    // A phone gets 2 columns: a KPI takes half (two to a row), every other widget the whole width (T54).
    breakpoints: [{ w: 800, c: 6 }, { w: 640, c: 2 }]
  }
}
const gridComponents = { DashboardWidgetCard }
// "On a phone: hidden" (D23) - left out of a phone's grid.
const isMobile = useIsMobile()
const gridWidgets = computed<GridStackWidget[]>(() => displayedWidgets.value.filter(widget => !(isMobile.value && widget.config?.mobile === 'HIDDEN')).map(widget => ({
  id: widget.id,
  x: widget.gridX,
  y: widget.gridY,
  w: widget.gridW,
  h: widget.gridH,
  component: 'DashboardWidgetCard',
  props: { widgetId: widget.id }
})))
function syncGridWidgets() {
  gridRef.value?.getGrid()?.load(gridWidgets.value)
}
watch(gridWidgets, () => nextTick(syncGridWidgets), { deep: true })
onMounted(() => nextTick(syncGridWidgets))

defineExpose({ dashboard })
</script>

<template>
  <UEmpty
    v-if="error"
    icon="i-lucide-lock"
    :title="t('dashboards.view.notAvailable')"
    :description="t('dashboards.view.notAvailableHelp')"
    variant="naked"
  />
  <div
    v-else
    class="flex flex-col gap-3"
  >
    <div
      v-if="titled && dashboard"
      class="px-1"
    >
      <h1 class="text-lg font-semibold text-highlighted">
        {{ dashboard.name }}
      </h1>
      <p
        v-if="dashboard.description"
        class="text-sm text-muted"
      >
        {{ dashboard.description }}
      </p>
    </div>
    <!-- Inset as the widgets are (GridStack's margin around each one): the variables line up with the cards' edges. -->
    <DashboardVariablesBar
      v-if="shownVariables.length"
      v-model="variableValues"
      v-model:labels="variableLabels"
      :variables="shownVariables"
      :load-options="loadVariableOptions"
      :style="{ paddingInline: `${GRID_MARGIN}px` }"
    />
    <p
      v-if="updatedAgo && !hideBar"
      class="text-right text-xs text-dimmed"
      role="status"
      :style="{ paddingInline: `${GRID_MARGIN}px` }"
    >
      {{ updatedAgo }}
    </p>
    <!-- Tabs (D7): a strip that scrolls on a phone; the variables stay above, common to every tab. -->
    <div
      v-if="tabItems.length"
      class="overflow-x-auto"
      :style="{ paddingInline: `${GRID_MARGIN}px` }"
    >
      <UTabs
        v-model="activeTab"
        :items="tabItems"
        :content="false"
        variant="link"
        class="w-max min-w-full"
      />
    </div>
    <GridStack
      ref="gridRef"
      :options="gridOptions"
      :components="gridComponents"
    />
    <p
      v-if="!pending && displayedWidgets.length === 0 && dashboard"
      class="p-6 text-center text-sm text-muted"
    >
      {{ t('dashboards.view.noWidgets') }}
    </p>
  </div>
</template>
