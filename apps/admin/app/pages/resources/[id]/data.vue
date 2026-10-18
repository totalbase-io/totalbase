<script setup lang="ts">
const route = useRoute()
const { t } = useI18n()
const apiError = useApiErrorMessage()
const resourceId = computed(() => route.params.id as string)
const resourcesApi = useResourcesApi()

const { data: resource, pending, error } = await useAsyncData(
  () => `table-data-resource-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)
</script>

<template>
  <PageShell :scroll="false">
    <template
      v-if="!error && !pending && resource"
      #header
    >
      <PageHeader
        :title="resource.name"
        icon="i-lucide-arrow-left"
        icon-back
      />
    </template>
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      :title="t('database.resourceDataPage.loadError')"
      :description="apiError(error, t('database.resourceDataPage.loadErrorHelp'))"
    />
    <template v-else-if="pending || !resource">
      <UEmpty
        loading
        variant="naked"
        size="sm"
      />
    </template>
    <UEmpty
      v-else-if="!resource.exposedMethods.includes('GET')"
      icon="i-lucide-eye-off"
      :title="t('database.resourceDataPage.getOffTitle')"
      :description="t('database.tableResourceDetail.browseDataNeedsGet')"
      :actions="[{ label: t('database.resourceDataPage.openEndpoints'), color: 'neutral', variant: 'outline', to: `/resources/${resource.id}` }]"
    />
    <template v-else>
      <div class="min-h-0 flex-1 -mx-4 sm:-mx-6">
        <ResourceDataGrid :resource="resource" />
      </div>
    </template>
  </PageShell>
</template>
