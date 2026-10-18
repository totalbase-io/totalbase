<script setup lang="ts">
/**
 * A DataView's record form on its own route (the PAGE Edit presentation),
 * editing record `:pk`: the DataView's generated page, framed by
 * DataViewRecordPanel.vue.
 */
const { t } = useI18n()
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const pk = computed(() => route.params.pk as string)
const { dataview, fields, error, primaryKey, features, canCreate, canDelete } = usePublishedDataViewBySlug(slug)
</script>

<template>
  <DataViewRecordPanel
    v-if="dataview && fields && primaryKey"
    :key="pk"
    :open="true"
    :dataview="dataview"
    :fields="fields"
    mode="edit"
    :row="{ [primaryKey]: pk }"
    :primary-key="primaryKey"
    presentation="PAGE"
    :features="features"
    :can-create="canCreate"
    :can-delete="canDelete"
  />
  <PageShell v-else>
    <UEmpty
      v-if="error"
      icon="i-lucide-lock"
      :title="t('dataviews.grid.notAvailable')"
      :description="t('dataviews.grid.notAvailableHelp')"
    />
    <UEmpty
      v-else
      loading
      variant="naked"
      size="sm"
    />
  </PageShell>
</template>
