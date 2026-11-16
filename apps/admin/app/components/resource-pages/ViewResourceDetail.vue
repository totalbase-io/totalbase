<script setup lang="ts">
import type { RelationDetail } from '~/types/schema'

/** VIEW detail rendered by the canonical resource route (its TotalBase UUID, stable across renames). */
const route = useRoute()
const resourcesApi = useResourcesApi()
const { t } = useI18n()
const resourceId = computed(() => route.params.id as string)

const { data: resource, pending, error } = await useAsyncData(
  () => `view-detail-${resourceId.value}`,
  () => resourcesApi.get(resourceId.value),
  { watch: [resourceId] }
)

// May TotalBase's PostgreSQL role drop this view (Administration.md §3.15) - from the Columns section's own catalog read.
const ownership = ref<Pick<RelationDetail, 'owner' | 'canAlter'> | null>(null)
watch(resourceId, () => {
  ownership.value = null
})
</script>

<template>
  <ResourceDetailShell
    :resource="resource"
    :pending="pending"
    :error="error"
    :load-error="t('database.viewResourceDetail.loadError')"
  >
    <template #default="{ resource: view }">
      <ResourceDataSection
        :resource="view"
        :rename-hint="t('database.viewResourceDetail.renameHint')"
        @update:resource="next => resource = next"
      />

      <ResourceCreateActions :resource="view">
        <ResourceEditSqlButton
          :resource="view"
          :label="t('database.viewResourceDetail.editView')"
        />
      </ResourceCreateActions>

      <section>
        <ResourceColumns
          :resource="view"
          @loaded="(detail: RelationDetail) => ownership = { owner: detail.owner, canAlter: detail.canAlter }"
        />
      </section>

      <section>
        <ResourceDataViews :resource="view" />
      </section>

      <ResourceEndpoints
        :resource="view"
        @update:resource="next => resource = next"
      />

      <ResourceAuditing
        :key="view.id"
        :resource="view"
        @update:resource="next => resource = next"
      />

      <ResourceDangerZone
        :resource="view"
        :ownership="ownership"
      />
    </template>
  </ResourceDetailShell>
</template>
