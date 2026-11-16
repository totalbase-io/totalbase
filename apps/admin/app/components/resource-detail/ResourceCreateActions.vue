<script setup lang="ts">
import type { Resource } from '~/types/resource'
import type { DataView } from '~/types/dataview'

/**
 * A table's or view's way to a screen: Create DataView (a table's quick one in one step - More options opens the
 * wizard; a view's, the wizard) and Create dashboard (Dashboards.md §10.7, this resource chosen). The page's own
 * first actions go in the slot (Browse data, Edit view). Each modal loads on first open, then stays mounted.
 */
const props = defineProps<{ resource: Resource }>()
const { t } = useI18n()

const quickOpen = ref(false)
const quickMounted = useOpenedOnce(quickOpen)
const wizardOpen = ref(false)
const wizardMounted = useOpenedOnce(wizardOpen)
const dashboardOpen = ref(false)
const dashboardMounted = useOpenedOnce(dashboardOpen)

const { refresh: refreshDataViews } = useAppsNavDataViews()
const { refresh: refreshDashboards } = useAppsNavDashboards()

function createDataView() {
  if (props.resource.type === 'TABLE') quickOpen.value = true
  else wizardOpen.value = true
}
async function onDataViewCreated(dataview: DataView) {
  await refreshDataViews()
  await navigateTo(`/dataviews/${dataview.id}/settings`)
}
async function onDashboardCreated(id: string) {
  await refreshDashboards()
  await navigateTo(`/dashboards/${id}`)
}
</script>

<template>
  <div class="flex flex-wrap gap-2">
    <slot />
    <UButton
      :label="t('database.resourceDetail.createDataView')"
      icon="i-lucide-layout-panel-left"
      color="primary"
      variant="solid"
      @click="createDataView"
    />
    <UButton
      :label="t('database.resourceDetail.createDashboard')"
      icon="i-lucide-layout-dashboard"
      color="primary"
      variant="solid"
      @click="dashboardOpen = true"
    />
    <LazyQuickDataViewModal
      v-if="quickMounted"
      v-model:open="quickOpen"
      :resource-id="resource.id"
      :table-name="resource.name"
      @more="wizardOpen = true"
    />
    <LazyDataViewWizardModal
      v-if="wizardMounted"
      v-model:open="wizardOpen"
      :initial-resource-id="resource.id"
      @created="onDataViewCreated"
    />
    <LazyDashboardFromTableWizard
      v-if="dashboardMounted"
      v-model:open="dashboardOpen"
      :initial-resource-id="resource.id"
      @created="onDashboardCreated"
    />
  </div>
</template>
