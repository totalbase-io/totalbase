<script setup lang="ts">
/**
 * `TDashboard` (DataViews.md §9.7): a
 * published Dashboard inside the page (DashboardView.vue, the App's own
 * viewer), its variables set from the page - `variables` holds a formula per
 * variable name, e.g. `{{vars.record.data.id}}` for a customer's figures.
 * Set ones are hidden from its bar and follow the page; the rest stay the
 * viewer's to pick. Access is the Dashboard's own: a viewer without it sees
 * that it isn't available.
 */
import { WIDGET_RUNTIME_KEY } from '~/composables/useWidgetRuntime'
import { evaluateWidgetFormula } from '~/utils/widget-formula'

const props = defineProps<{
  /** The Dashboard's id. */
  dashboard?: string
  /** Variable name → formula over the page's variables. */
  variables?: Record<string, string>
}>()

const runtime = inject(WIDGET_RUNTIME_KEY)!
const { t } = useI18n()
// A dashboard inside a CUSTOM page, on an App route: its texts are the dashboards area's, loaded here if the route didn't.
void useNuxtApp().$localeAreas.ensure(['dashboards'])
const live = runtime.mode === 'live'

// On the canvas: which Dashboard it shows - no query runs while designing.
const adminApi = useAdminApi()
const { data: designName } = useAsyncData(`embed-dashboard-${props.dashboard ?? 'none'}`,
  () => (!live && props.dashboard ? adminApi.get<{ name: string }>(`/dashboards/${props.dashboard}`).then(r => r.data.name) : Promise.resolve(null)),
  { default: () => null })

/** The variables the page sets, by name - re-evaluated as the page's variables change. */
const bound = computed(() => Object.entries(props.variables ?? {}).filter(([, formula]) => formula.trim() !== ''))
const boundValues = computed(() => Object.fromEntries(bound.value.map(([name, formula]) => [name, evaluateWidgetFormula(formula, { vars: runtime.vars }) ?? null])))
const hiddenVariables = computed(() => bound.value.map(([name]) => name))

/** What the viewer picks in its bar, over what the page sets. */
const picked = ref<Record<string, unknown>>({})
const variableValues = computed({
  get: () => ({ ...picked.value, ...boundValues.value }),
  set: (values: Record<string, unknown>) => {
    picked.value = Object.fromEntries(Object.entries(values).filter(([name]) => !hiddenVariables.value.includes(name)))
  }
})
</script>

<template>
  <div
    v-if="!live"
    class="flex h-full min-h-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-accented bg-elevated/50 p-3 text-center"
  >
    <UIcon
      name="i-lucide-layout-dashboard"
      class="size-5 text-muted"
    />
    <p class="text-sm font-medium text-highlighted">
      {{ designName ? t('dashboards.widget.designName', { name: designName }) : t('dashboards.widget.dashboard') }}
    </p>
    <p class="text-xs text-muted">
      {{ !dashboard ? t('dashboards.widget.pick') : bound.length ? t('dashboards.widget.boundFromPage', { names: bound.map(([name]) => name).join(', ') }) : t('dashboards.widget.viewerPicks') }}
    </p>
  </div>
  <UEmpty
    v-else-if="!dashboard"
    icon="i-lucide-layout-dashboard"
    :title="t('dashboards.widget.none')"
    :description="t('dashboards.widget.noneHelp')"
    variant="naked"
  />
  <div
    v-else
    class="h-full w-full overflow-auto"
  >
    <DashboardView
      v-model:variable-values="variableValues"
      :slug="dashboard"
      :hidden-variables="hiddenVariables"
    />
  </div>
</template>
