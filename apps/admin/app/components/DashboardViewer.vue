<script setup lang="ts">
/**
 * A published Dashboard as the App's page shows it (Dashboards.md §9.2):
 * the header with Refresh around DashboardView.vue (cards and
 * variables bar, the same component a DataView page's TDashboard widget embeds). Variable
 * values mirror into the URL so a shared link shows the same view.
 */
import { useDashboardCatalogText, type Dashboard, type DashboardVariable } from '~/types/dashboard'
import { decodeVariableValues, encodeVariableValues } from '~/utils/dashboard-variables'
import { DASHBOARD_REFRESH_INTERVALS } from '@totalbase/tb-catalog'

const props = defineProps<{ slug: string }>()

const api = useAppApi()
const route = useRoute()
const router = useRouter()
const { t } = useI18n()
const catalog = useDashboardCatalogText()

const { data: dashboard, error } = await useAsyncData(
  () => `app-dashboard-${props.slug}`,
  () => api.get<Omit<Dashboard, 'variables'>>(`/dashboards/${props.slug}`).then(r => r.data)
)
const { data: variables } = await useAsyncData(
  () => `app-dashboard-variables-${props.slug}`,
  () => api.get<DashboardVariable[]>(`/dashboards/${props.slug}/variables`).then(r => r.data),
  { default: (): DashboardVariable[] => [] }
)

const variableValues = ref<Record<string, unknown>>(decodeVariableValues(variables.value ?? [], route.query))
/** The open tab (D7) - `?tab=`, shareable. */
const tab = ref<string | undefined>(typeof route.query.tab === 'string' ? route.query.tab : undefined)
/** A click's filter (D6) is a step of its own: pushed, so Back takes it off; a viewer's own choice replaces. */
const pushNext = ref(false)
function urlQuery() {
  return { ...encodeVariableValues(variables.value ?? [], variableValues.value), ...(tab.value && { tab: tab.value }) }
}
/** Two queries alike as a URL reads them - every value text. */
function sameQuery(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const text = (q: Record<string, unknown>) => JSON.stringify(Object.keys(q).sort().map(k => [k, Array.isArray(q[k]) ? (q[k] as unknown[]).map(String) : String(q[k] ?? '')]))
  return text(a) === text(b)
}
watch([variableValues, tab], () => {
  const query = urlQuery()
  if (sameQuery(query, route.query)) return
  void (pushNext.value ? router.push({ query }) : router.replace({ query }))
  pushNext.value = false
})
// Back and Forward: the URL's values become the dashboard's again.
watch(() => route.query, (query) => {
  if (sameQuery(query, urlQuery())) return
  variableValues.value = decodeVariableValues(variables.value ?? [], query)
  tab.value = typeof query.tab === 'string' ? query.tab : undefined
})

const refreshKey = ref(0)
// Tells the viewer the cards re-run on their own (Dashboards.md §9.4).
const autoRefreshLabel = computed(() => {
  const interval = DASHBOARD_REFRESH_INTERVALS.find(i => i.seconds === dashboard.value?.refreshIntervalSeconds)
  return interval ? catalog.refreshLabel(interval.seconds, interval.label) : undefined
})
</script>

<template>
  <PageShell>
    <template #header>
      <PageHeader
        :title="dashboard?.name ?? 'Dashboard'"
        :description="dashboard?.description ?? undefined"
        :icon="dashboard?.icon ?? 'i-lucide-layout-dashboard'"
        :actions="[{ label: t('common.refresh'), icon: 'i-lucide-refresh-cw', onSelect: () => { refreshKey++ } }]"
      >
        <UBadge
          v-if="autoRefreshLabel"
          color="neutral"
          variant="subtle"
          icon="i-lucide-timer"
          class="max-md:hidden"
        >
          {{ t('dashboards.viewer.autoRefresh', { interval: autoRefreshLabel.toLowerCase() }) }}
        </UBadge>
      </PageHeader>
    </template>

    <UEmpty
      v-if="error"
      icon="i-lucide-lock"
      :title="t('dashboards.view.notAvailable')"
      :description="t('dashboards.view.notAvailableHelp')"
    />
    <DashboardView
      v-else
      v-model:variable-values="variableValues"
      v-model:tab="tab"
      :slug="slug"
      :refresh-key="refreshKey"
      @filter="pushNext = true"
    />
  </PageShell>
</template>
