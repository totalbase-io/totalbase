<script setup lang="ts">
/**
 * Widget editor, Grafana-style (Specification_Dashboards.md §10.4): a live
 * preview of the widget, the SQL editor and its result grid on the
 * left, the widget type's properties on the right. A UDrawer, not a
 * modal or sidebar - this is "working" content (AGENTS.md §25), same
 * family as SqlConsoleDrawer.vue.
 *
 * Nothing is persisted until Save: Run executes the SQL as typed through
 * the admin-only, read-only query endpoint; the preview redraws from
 * that result plus the current (unsaved) properties. A presentation
 * widget (D3) previews from the start - its formulas over the variables,
 * the viewer and, once its optional query runs, its rows.
 */
import type { DashboardQueryResult, DashboardVariable, DashboardWidget, DashboardWidgetContent } from '~/types/dashboard'
import { dashboardWidgetDefinition, knownDashboardConfig, type DashboardWidgetType } from '@totalbase/tb-catalog'
import { DASHBOARD_WIDGET_META, useDashboardCatalogText } from '~/types/dashboard'
import type { CatalogColumn } from '~/types/permission'
import { dashboardFormulaVars } from '~/utils/dashboard-formula'
import { useApiErrorMessage } from '~/utils/api-error-message'
import type { SqlExecuteResult } from '~/types/sql-console'

const props = defineProps<{
  dashboardId: string
  widget: DashboardWidgetContent | null
  /** The variables bar's current `$VAR.*` values - Run uses them, same as the canvas. */
  variableValues: Record<string, unknown>
  /** The dashboard's variables - what "Optional filter" offers. */
  variables: DashboardVariable[]
  /** What the bar shows for each value - the preview's `{{vars.<name>.label}}`. */
  variableLabels?: Record<string, string>
}>()
const open = defineModel<boolean>('open', { required: true })
const emit = defineEmits<{ saved: [DashboardWidget] }>()

const api = useAdminApi()
const { t } = useI18n()
const errorMessage = useApiErrorMessage()
const notifyError = useErrorToast()
const catalog = useDashboardCatalogText()

const label = ref('')
/** Its type - a chart can switch to another chart (its query kept, its roles carried over); a presentation widget keeps its own. */
const type = ref<DashboardWidgetType>('KPI')
const query = ref('')
const config = ref<Record<string, unknown>>({})

const result = ref<DashboardQueryResult | null>(null)
/** The raw result grid is opt-in - the widget preview above is usually enough; the grid is for checking columns/values. */
const showResults = ref(false)
const running = ref(false)
const runError = ref<string | null>(null)
const saving = ref(false)

// A phone has no room for the query and the properties side by side:
// three tabs instead (Query, Preview, Settings).
// Run stays on Query, its results table right below the editor.
const isMobile = useIsMobile()
// Word wrap - a query read on a narrow screen scrolls sideways otherwise, so
// it starts on there; the toolbar's switch flips it either way.
// Wrap starts on for touch devices and narrow screens alike.
const isCompact = useCompactUi()
const sqlEditorRef = ref<{ wordWrap: boolean, toggleWordWrap: () => void, insertAtCursor: (text: string) => void } | null>(null)

// "Optional filter" (Specification_Dashboards.md §10.4): the standard
// `($VAR.x IS NULL OR ...)` pattern for a variable and a column, written at
// the cursor - plain SQL, nothing the server rewrites.
const filterOpen = ref(false)
const filterVariable = ref<string | undefined>(undefined)
const filterColumn = ref('')
const filterVariableItems = computed(() => props.variables.map(v => ({ label: v.label || v.name, description: `$VAR.${v.name}`, value: v.name })))
const filterPreview = computed(() => {
  const variable = props.variables.find(v => v.name === filterVariable.value)
  return variable && filterColumn.value.trim() ? optionalFilterSql(variable, filterColumn.value) : ''
})
function insertOptionalFilter() {
  if (!filterPreview.value) return
  sqlEditorRef.value?.insertAtCursor(filterPreview.value)
  filterOpen.value = false
  filterColumn.value = ''
}
type MobileTab = 'query' | 'preview' | 'settings'
const mobileTab = ref<MobileTab>('query')
watch(open, (isOpen) => {
  if (isOpen) mobileTab.value = 'query'
})
const mobileTabs = computed(() => [
  { label: t('dashboards.widgetDrawer.query'), value: 'query' as const },
  { label: t('common.preview'), value: 'preview' as const },
  { label: t('common.settings'), value: 'settings' as const }
])

/** A presentation widget (D3): drawn from its props and formulas - its query optional, only rows for them. */
const presentation = computed(() => Boolean(props.widget && dashboardWidgetDefinition(type.value).page))
const meta = computed(() => (props.widget ? DASHBOARD_WIDGET_META[type.value] : undefined))

watch(open, (isOpen) => {
  if (!isOpen || !props.widget) return
  label.value = props.widget.label ?? ''
  type.value = props.widget.type
  query.value = props.widget.query ?? ''
  config.value = { ...props.widget.config }
  result.value = null
  runError.value = null
  showResults.value = false
  if (query.value.trim()) run()
})

/** The type's catalog entry - its query's shape and example. */
const definition = computed(() => dashboardWidgetDefinition(type.value))
const exampleOpen = ref(false)
function useExample() {
  if (!definition.value.example) return
  query.value = definition.value.example
  exampleOpen.value = false
  void run()
}

async function run() {
  if (!query.value.trim()) return
  running.value = true
  runError.value = null
  try {
    const { data } = await api.post<DashboardQueryResult>(`/dashboards/${props.dashboardId}/query`, {
      data: { query: query.value, variables: props.variableValues }
    })
    result.value = data
  } catch (error) {
    result.value = null
    runError.value = errorMessage(error, t('dashboards.widgetDrawer.runFailed'))
  } finally {
    running.value = false
  }
}

// SqlResultsPanel.vue (the SQL Console's own grid) expects the console's
// result shape - adapted rather than duplicating the grid.
const resultsPanelData = computed<SqlExecuteResult | null>(() => result.value
  ? { status: 'EXECUTED', rows: result.value.rows, rowCount: result.value.rows.length, columns: result.value.columns, notices: [], durationMs: 0 }
  : null)

const previewWidget = computed(() => ({
  type: type.value,
  config: config.value
}))
const previewEmpty = computed(() => !presentation.value && !result.value && !running.value && !runError.value)

// What its formulas read (D3) - the preview's scope, and the Bind modal's Fields: the variables, the viewer, the rows.
const session = useSession()
const formulaContext = computed(() => ({
  vars: dashboardFormulaVars(props.variables, props.variableValues, props.variableLabels ?? {}),
  user: session.admin.value
}))
const field = (name: string, dataType: string): CatalogColumn => ({ attnum: 0, name, dataType, nullable: true, isIdentity: false, isGenerated: false, defaultExpression: null })
const formulaFields = computed<CatalogColumn[]>(() => [
  ...props.variables.flatMap(v => [
    field(`vars.${v.name}`, v.type.toLowerCase()),
    field(`vars.${v.name}.label`, 'text'),
    ...(v.type === 'DATE_RANGE' ? [field(`vars.${v.name}.from`, 'date'), field(`vars.${v.name}.to`, 'date')] : [])
  ]),
  field('user.id', 'uuid'),
  field('user.email', 'text'),
  field('user.name', 'text'),
  ...(result.value?.columns ?? []).map(c => field(`row.${c.name}`, c.dataType)),
  field('rows.length', 'integer')
])

async function save() {
  if (!props.widget) return
  saving.value = true
  try {
    // Only its type's properties travel - a key another type left behind is dropped (the catalog's knownDashboardConfig).
    const savedConfig = knownDashboardConfig(type.value, config.value)
    const body = { ...(type.value !== props.widget.type ? { type: type.value } : {}), label: label.value || null, config: savedConfig, query: query.value.trim() ? query.value : null }
    const { data } = await api.patch<DashboardWidget>(`/dashboards/${props.dashboardId}/widgets/${props.widget.id}`, { data: body })
    emit('saved', data)
    open.value = false
  } catch (error) {
    notifyError(error, t('dashboards.widgetDrawer.saveFailed'))
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppDrawer
    v-model:open="open"
    :title="label || (meta ? catalog.widgetLabel(meta.type) : t('dashboards.widgetDrawer.widget'))"
    :description="presentation ? t('dashboards.widgetDrawer.presentationDescription') : t('dashboards.widgetDrawer.queryDescription')"
    size="xl"
  >
    <UTabs
      v-if="widget && isMobile"
      v-model="mobileTab"
      :items="mobileTabs"
      variant="link"
      :content="false"
      class="mb-3 shrink-0"
    />
    <div
      v-if="widget"
      class="flex min-h-0 flex-1 gap-4"
    >
      <div
        v-show="!isMobile || mobileTab !== 'settings'"
        class="flex min-w-0 flex-1 flex-col gap-3"
      >
        <div
          v-show="!isMobile || mobileTab === 'preview'"
          class="shrink-0 rounded-lg border border-default bg-elevated/30 p-3"
          :class="isMobile ? 'min-h-64 flex-1' : 'h-64'"
        >
          <p
            v-if="previewEmpty"
            class="flex h-full items-center justify-center text-sm text-muted"
          >
            {{ t('dashboards.widgetDrawer.runToPreview') }}
          </p>
          <DashboardWidgetView
            v-else
            :widget="previewWidget"
            configured
            :result="result"
            :loading="running"
            :error="runError"
            :formula-context="formulaContext"
          />
        </div>
        <!-- A Detail draws one row (D14): say so when the query returns more. -->
        <p
          v-if="type === 'DETAIL' && result && result.rows.length > 1"
          v-show="!isMobile || mobileTab === 'preview'"
          class="-mt-1 flex shrink-0 items-center gap-1 text-xs text-muted"
        >
          <UIcon
            name="i-lucide-info"
            class="size-3.5 shrink-0"
          />
          {{ t('dashboards.widgetDrawer.detailFirstRow', { count: result.rows.length }) }}
        </p>

        <div
          v-show="!isMobile || mobileTab === 'query'"
          class="flex min-h-0 flex-1 flex-col gap-3"
        >
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-xs font-medium uppercase text-muted">
              {{ t('dashboards.widgetDrawer.query') }}
            </h3>
            <div class="flex items-center gap-2">
              <span
                v-if="result"
                class="text-xs"
                :class="result.truncated ? 'text-warning' : 'text-muted'"
              >
                {{ t('dashboards.widgetDrawer.rows', result.rows.length) }}{{ t('dashboards.widgetDrawer.duration', { ms: result.durationMs }) }}{{ result.truncated ? t('dashboards.widgetDrawer.cutOff', { setting: 'dashboards.query_max_rows' }) : '' }}
              </span>
              <USwitch
                :model-value="sqlEditorRef?.wordWrap ?? isCompact"
                :label="t('dashboards.widgetDrawer.wrap')"
                size="sm"
                @update:model-value="sqlEditorRef?.toggleWordWrap()"
              />
              <!-- What this type's query should return, and an example that runs anywhere (the widget catalog). -->
              <UPopover
                v-if="definition.example"
                v-model:open="exampleOpen"
                :content="{ align: 'end' }"
              >
                <UButton
                  icon="i-lucide-lightbulb"
                  :label="t('dashboards.widgetDrawer.example')"
                  size="sm"
                  color="neutral"
                  variant="outline"
                />
                <template #content>
                  <div class="flex w-[28rem] max-w-[90vw] flex-col gap-3 p-3">
                    <p class="text-sm font-medium text-highlighted">
                      {{ meta ? catalog.widgetLabel(meta.type) : '' }}
                    </p>
                    <p class="text-xs text-muted">
                      {{ catalog.widgetDescription(type) }}
                    </p>
                    <pre class="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-elevated p-2 font-mono text-xs">{{ definition.example }}</pre>
                    <div class="flex items-center justify-between gap-2">
                      <p class="text-xs text-muted">
                        {{ query.trim() ? t('dashboards.widgetDrawer.replacesQuery') : t('dashboards.widgetDrawer.runsOnItsOwn') }}
                      </p>
                      <UButton
                        :label="t('dashboards.widgetDrawer.useThisQuery')"
                        size="xs"
                        @click="useExample"
                      />
                    </div>
                  </div>
                </template>
              </UPopover>
              <UPopover
                v-if="variables.length > 0"
                v-model:open="filterOpen"
              >
                <UButton
                  icon="i-lucide-filter"
                  :label="t('dashboards.widgetDrawer.optionalFilter')"
                  size="sm"
                  color="neutral"
                  variant="outline"
                />
                <template #content>
                  <div class="flex w-80 flex-col gap-3 p-3">
                    <p class="text-sm text-muted">
                      {{ t('dashboards.widgetDrawer.optionalFilterHelp') }}
                    </p>
                    <UFormField :label="t('dashboards.widgetDrawer.variable')">
                      <USelectMenu
                        v-model="filterVariable"
                        :items="filterVariableItems"
                        value-key="value"
                        :aria-label="t('dashboards.widgetDrawer.variable')"
                        class="w-full"
                      />
                    </UFormField>
                    <UFormField
                      :label="t('dashboards.widgetDrawer.column')"
                      :description="t('dashboards.widgetDrawer.columnHelp', { example: 'o.created_at' })"
                    >
                      <UInput
                        v-model="filterColumn"
                        class="w-full font-mono"
                      />
                    </UFormField>
                    <pre
                      v-if="filterPreview"
                      class="whitespace-pre-wrap rounded-md bg-elevated p-2 font-mono text-xs"
                    >{{ filterPreview }}</pre>
                    <div class="flex justify-end">
                      <UButton
                        :label="t('dashboards.widgetDrawer.insert')"
                        size="xs"
                        :disabled="!filterPreview"
                        @click="insertOptionalFilter"
                      />
                    </div>
                  </div>
                </template>
              </UPopover>
              <UButton
                icon="i-lucide-table-2"
                :label="t('dashboards.widgetDrawer.results')"
                size="sm"
                color="neutral"
                :variant="showResults ? 'subtle' : 'outline'"
                :aria-pressed="showResults"
                @click="showResults = !showResults"
              />
              <UButton
                icon="i-lucide-play"
                :label="t('dashboards.widgetDrawer.run')"
                size="sm"
                :loading="running"
                :disabled="!query.trim()"
                @click="run"
              />
            </div>
          </div>
          <div
            class="overflow-hidden rounded-lg border border-default"
            :class="showResults ? 'h-56 shrink-0' : 'min-h-56 flex-1'"
          >
            <SqlEditor
              ref="sqlEditorRef"
              v-model="query"
              :initial-word-wrap="isCompact"
              @execute="run"
            />
          </div>
          <div
            v-if="showResults"
            class="flex min-h-40 flex-1 flex-col rounded-lg border border-default p-3"
          >
            <SqlResultsPanel
              :result="resultsPanelData"
              :error="runError"
              :executing="running"
              class="min-h-0 flex-1"
            />
          </div>
        </div>
      </div>

      <div
        v-show="!isMobile || mobileTab === 'settings'"
        class="flex flex-col gap-4 overflow-y-auto"
        :class="isMobile ? 'w-full' : 'w-80 shrink-0 border-l border-default pl-4'"
      >
        <DashboardWidgetInspector
          v-model:type="type"
          v-model:label="label"
          v-model:config="config"
          :columns="result?.columns ?? []"
          :formula-fields="formulaFields"
          :variables="variables"
          :rows="result?.rows"
        />
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          :label="t('common.save')"
          :loading="saving"
          @click="save"
        />
      </div>
    </template>
  </AppDrawer>
</template>
