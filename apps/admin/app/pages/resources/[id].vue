<script setup lang="ts">
import type { Component } from 'vue'
import TableResourceDetail from '~/components/resource-pages/TableResourceDetail.vue'
import ViewResourceDetail from '~/components/resource-pages/ViewResourceDetail.vue'
import FunctionResourceDetail from '~/components/resource-pages/FunctionResourceDetail.vue'

const route = useRoute()
const { t } = useI18n()
const apiError = useApiErrorMessage()
const resourcesApi = useResourcesApi()
const resourceId = computed(() => route.params.id as string)
const isDataRoute = computed(() => route.path.endsWith('/data'))

const { data: resource, pending, error } = await useAsyncData(
  () => `resource-route-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)

const detailComponent = computed<Component | null>(() => {
  switch (resource.value?.type) {
    case 'TABLE': return TableResourceDetail
    case 'VIEW': return ViewResourceDetail
    case 'FUNCTION': return FunctionResourceDetail
    default: return null
  }
})
</script>

<template>
  <NuxtPage v-if="isDataRoute" />

  <UEmpty
    v-else-if="pending"
    loading
    variant="naked"
    size="sm"
  />

  <UAlert
    v-else-if="error || !detailComponent"
    class="m-4 w-auto sm:m-6"
    color="error"
    variant="subtle"
    :title="t('database.resourcePage.loadError')"
    :description="apiError(error, t('database.resourcePage.loadErrorHelp'))"
  />

  <component
    :is="detailComponent"
    v-else
  />
</template>
