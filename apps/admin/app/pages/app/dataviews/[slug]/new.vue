<script setup lang="ts">
/**
 * A DataView's record form on its own route (the PAGE Edit presentation),
 * creating a record: the DataView's generated page, framed by
 * DataViewRecordPanel.vue. `?initial[<column>]=` values start the record -
 * a Calendar's day, carried across the route change.
 */
const { t } = useI18n()
const route = useRoute()
const slug = computed(() => route.params.slug as string)
const initialValues = computed<Record<string, unknown> | undefined>(() => {
  const entries = Object.entries(route.query)
    .map(([key, value]) => [/^initial\[(.+)\]$/.exec(key)?.[1], value] as const)
    .filter((pair): pair is [string, string] => typeof pair[0] === 'string' && typeof pair[1] === 'string')
  return entries.length ? Object.fromEntries(entries) : undefined
})
const { dataview, fields, error, primaryKey, features } = usePublishedDataViewBySlug(slug)
</script>

<template>
  <DataViewRecordPanel
    v-if="dataview && fields && primaryKey"
    :open="true"
    :dataview="dataview"
    :fields="fields"
    mode="create"
    :row="null"
    :initial-values="initialValues"
    :primary-key="primaryKey"
    presentation="PAGE"
    :features="features"
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
