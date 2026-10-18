<script setup lang="ts">
/**
 * WidgetInspector.vue's fields for an embedded Dashboard: which one
 * (`dashboard`, with a warning for the roles that open this page but can't
 * see it - its access is its own) and its variables set from the page
 * (`dashboardVariables`, a formula each). One instance per prop; each
 * lookup follows a selection that can change again before the server
 * answers, so only the latest answer lands.
 */
import { widgetDefinition, type WidgetControlConfig, type WidgetProp } from '@totalbase/tb-catalog'
import type { Dashboard, DashboardVariable } from '~/types/dashboard'

const props = defineProps<{
  name: string
  prop: WidgetProp
  /** The widget's whole config - the chosen Dashboard is read from its `dashboard` prop. */
  config: WidgetControlConfig
  /** The page's DataView - whose roles the warning checks. */
  dataviewId?: string
}>()
const emit = defineEmits<{
  /** A prop's new value - `undefined` clears it. */
  set: [name: string, value: unknown]
}>()
const { t } = useI18n()
const adminApi = useAdminApi()

function stringProp(name: string): string | undefined {
  const value = props.config.props[name]
  return typeof value === 'string' ? value : undefined
}
// The Dashboards the sidebar already holds (useAppsNavDashboards), not a list of this inspector's own.
const { dashboards: dashboardList } = useAppsNavDashboards()
const dashboardItems = computed(() => dashboardList.value.map(d => ({ label: d.name, description: d.description ?? undefined, value: d.id })))
const chosenDashboard = computed(() => {
  const name = Object.entries(widgetDefinition(props.config.widget).props).find(([, p]) => p.editor === 'dashboard')?.[0]
  return name ? stringProp(name) ?? null : null
})

// --- dashboardVariables: its variables, read when it's chosen - each gets a formula field. ---
const latestVariables = useLatest()
const dashboardVariables = ref<DashboardVariable[]>([])
watch(chosenDashboard, async (id) => {
  const load = latestVariables.next()
  dashboardVariables.value = []
  if (!id || props.prop.editor !== 'dashboardVariables') return
  try {
    const variables = (await adminApi.get<Dashboard>(`/dashboards/${id}`)).data.variables ?? []
    if (load.isCurrent()) dashboardVariables.value = variables
  } catch {
    // Best-effort: no fields to set.
  }
}, { immediate: true })
function variableFormula(variable: string): string {
  const map = props.config.props[props.name]
  return map && typeof map === 'object' ? String((map as Record<string, unknown>)[variable] ?? '') : ''
}
function setVariableFormula(variable: string, formula: string) {
  const current = (props.config.props[props.name] && typeof props.config.props[props.name] === 'object' ? props.config.props[props.name] : {}) as Record<string, string>
  const next = Object.fromEntries(Object.entries({ ...current, [variable]: formula }).filter(([, v]) => v.trim() !== ''))
  emit('set', props.name, Object.keys(next).length ? next : undefined)
}

// --- dashboard: the roles that open this page but can't see the chosen Dashboard (only a warning). ---
const { data: allRoles } = useRoles()
const latestRolesWithout = useLatest()
const rolesWithoutDashboard = ref<string[]>([])
watch(chosenDashboard, async (id) => {
  const load = latestRolesWithout.next()
  rolesWithoutDashboard.value = []
  if (!id || !props.dataviewId || props.prop.editor !== 'dashboard') return
  try {
    const { data } = await adminApi.get<string[]>(`/dataviews/${props.dataviewId}/dashboard-access?dashboard=${id}`)
    if (load.isCurrent()) rolesWithoutDashboard.value = data.map(role => allRoles.value.find(r => r.id === role)?.name ?? role)
  } catch {
    // Best-effort: no warning.
  }
}, { immediate: true })
</script>

<template>
  <!-- An embedded Dashboard. -->
  <UFormField
    v-if="prop.editor === 'dashboard'"
    :label="prop.label"
    :description="prop.description"
  >
    <UAlert
      v-if="rolesWithoutDashboard.length"
      class="mb-2"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="t('designer.inspector.rolesWithoutDashboard', { roles: rolesWithoutDashboard.join(', ') }, rolesWithoutDashboard.length)"
    />
    <USelectMenu
      :model-value="stringProp(name)"
      :items="dashboardItems"
      value-key="value"
      class="w-full"
      @update:model-value="emit('set', name, $event || undefined)"
    />
  </UFormField>

  <!-- Its variables: a formula each, set from the page. -->
  <UFormField
    v-else-if="prop.editor === 'dashboardVariables'"
    :label="prop.label"
    :description="!chosenDashboard ? t('designer.inspector.pickDashboardFirst') : dashboardVariables.length === 0 ? t('designer.inspector.dashboardNoVariables') : prop.description"
  >
    <div class="flex flex-col gap-2">
      <UFormField
        v-for="variable in dashboardVariables"
        :key="variable.name"
        :label="variable.label || variable.name"
        :description="`$VAR.${variable.name} - ${variable.type.toLowerCase().replace('_', ' ')}`"
        size="sm"
      >
        <UInput
          :model-value="variableFormula(variable.name)"
          class="w-full font-mono"
          :aria-label="t('designer.inspector.formulaFor', { name: variable.name })"
          @update:model-value="setVariableFormula(variable.name, String($event ?? ''))"
        />
      </UFormField>
    </div>
  </UFormField>
</template>
