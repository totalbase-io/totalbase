<script setup lang="ts">
/**
 * Where a column's presentation shows (DataViews.md §15): the DataViews with a grid column, a form
 * field or a related column on it - what a change here changes. Read when shown; nothing while it loads.
 */
const props = defineProps<{
  resourceId: string
  columnName: string
}>()

const { t } = useI18n()
const api = useAdminApi()
const dataviews = ref<{ id: string, name: string }[] | null>(null)
watch(() => [props.resourceId, props.columnName], async () => {
  try {
    dataviews.value = (await api.get<{ id: string, name: string }[]>(`/resources/${props.resourceId}/columns/${encodeURIComponent(props.columnName)}/dataviews`)).data
  } catch {
    dataviews.value = null
  }
}, { immediate: true })
const names = computed(() => (dataviews.value ?? []).map(d => d.name).join(', '))
</script>

<template>
  <p
    v-if="dataviews"
    class="flex items-start gap-1.5 text-xs"
    :class="dataviews.length > 1 ? 'text-warning' : 'text-muted'"
  >
    <UIcon
      :name="dataviews.length > 1 ? 'i-lucide-triangle-alert' : 'i-lucide-info'"
      class="mt-0.5 size-3.5 shrink-0"
    />
    <span>{{ dataviews.length ? t('database.columnUsage.shownIn', { n: dataviews.length, names }, dataviews.length) : t('database.columnUsage.none') }}</span>
  </p>
</template>
