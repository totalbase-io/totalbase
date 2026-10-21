<script setup lang="ts">
/**
 * Settings' Scope: which rows the DataView reads - the row Filter - and the resulting
 * Query, read-only (DataViews.md §4: one
 * owner per part - Columns own `fields` and the default `order_by`, the
 * Filter owns `where`). Show records runs that query, paged.
 *
 * The page owns the values and saves them with its settings
 * (`v-model:where-text`); this only shows and edits.
 */
import {
  BASE_WHERE_SCOPE_NOTICE,
  type DataView,
  type DataViewField
} from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'

const props = defineProps<{
  dataview: DataView
  /** The DataView's name as being edited - the records modal's title. */
  name: string
  /** The source's columns, for the Filter's Builder - undefined while they load. */
  catalogColumns: CatalogColumn[] | undefined
  /** The DataView's columns - the query's `fields`. */
  columnFields: DataViewField[]
  primaryKey: string | undefined
  /** `view_config.default_state` - its `sort` is the query's `order_by`. */
  defaultState: Record<string, unknown>
  /** The Filter's text isn't valid JSON. */
  whereError: boolean
}>()
const whereText = defineModel<string>('whereText', { required: true })

const { t } = useI18n()
const cat = useCatalogText()
const dataApi = useDataApi()
const recordsOpen = ref(false)
const recordsPath = computed(() => {
  const view = props.dataview
  if (!view.sourceResourceSchema || !view.sourceResourceName) return null
  return dataApi.resourcePath(view.sourceResourceSchema, view.sourceResourceName, view.sourceResourceType === 'VIEW' ? 'view' : 'table')
})
/** What the DataView asks the Data API for: its columns, the Filter, the default sort (the primary key when none). */
const query = computed<Record<string, unknown>>(() => {
  const names = props.columnFields.filter(f => (f.kind === 'COLUMN' || f.kind === 'RELATED') && f.columnName).map(f => f.columnName!)
  if (props.primaryKey && !names.includes(props.primaryKey)) names.push(props.primaryKey)
  const text = whereText.value.trim()
  const where = text && !props.whereError ? JSON.parse(text) as Record<string, unknown> : null
  const sort = typeof props.defaultState.sort === 'string' && props.defaultState.sort ? props.defaultState.sort : props.primaryKey
  return {
    fields: names.join(','),
    ...(where && Object.keys(where).length ? { where } : {}),
    ...(sort ? { order_by: sort } : {})
  }
})
const queryText = computed(() => JSON.stringify(query.value, null, 2))
</script>

<template>
  <SettingsSection :title="t('designer.dataViewScopeSettings.heading')">
    <WhereField
      v-model="whereText"
      :label="t('designer.dataViewScopeSettings.filter')"
      :description="cat('dataviews.meta.notices.baseWhere', BASE_WHERE_SCOPE_NOTICE)"
      :error="whereError ? t('designer.dataViewScopeSettings.invalidJson') : null"
      min-height="16rem"
      :columns="catalogColumns"
    />

    <!-- The resulting query, read-only - each part is edited where it's owned. -->
    <UFormField
      :label="t('designer.dataViewScopeSettings.query')"
      :description="t('designer.dataViewScopeSettings.queryDescription')"
    >
      <pre class="overflow-x-auto rounded-md bg-elevated p-3 font-mono text-xs">{{ queryText }}</pre>
    </UFormField>
    <div>
      <UButton
        :label="t('designer.dataViewScopeSettings.showRecords')"
        icon="i-lucide-table"
        color="neutral"
        variant="outline"
        :disabled="whereError || !recordsPath"
        @click="recordsOpen = true"
      />
    </div>
    <QueryRecordsModal
      v-model:open="recordsOpen"
      :title="t('designer.dataViewScopeSettings.recordsTitle', { name: name || dataview.name })"
      :path="recordsPath"
      :query="query"
      :notes="[t('designer.dataViewScopeSettings.recordsNote')]"
    />
  </SettingsSection>
</template>
