<script setup lang="ts">
/**
 * Settings > Data, at the foot of Columns (DataViews.md §4.2): what a column the table gains later
 * does - shown, hidden or left out. The page or the wizard owns the value (`v-model`).
 */
import { COLUMN_SYNC_META, COLUMN_SYNC_SCOPE_NOTICE, dataviewMetaKey, type ColumnSync } from '~/types/dataview'

const columnSync = defineModel<ColumnSync>({ required: true })
const cat = useCatalogText()
const { t } = useI18n()
</script>

<template>
  <UFormField :label="t('designer.dataViewScopeSettings.columnSet')">
    <template #hint>
      <FieldHelp
        :text="cat('dataviews.meta.notices.columnSync', COLUMN_SYNC_SCOPE_NOTICE)"
        :label="t('designer.dataViewScopeSettings.columnSet')"
      />
    </template>
    <USelectMenu
      v-model="columnSync"
      :items="(['auto_show', 'auto_hide', 'locked'] as const)"
      class="w-full"
    >
      <template #item-label="{ item }">
        {{ cat(dataviewMetaKey('columnSync', item as ColumnSync, 'label'), COLUMN_SYNC_META[item as ColumnSync].label) }}
      </template>
      <template #default>
        {{ cat(dataviewMetaKey('columnSync', columnSync, 'label'), COLUMN_SYNC_META[columnSync].label) }}
      </template>
    </USelectMenu>
    <p class="mt-1 text-xs text-muted">
      {{ cat(dataviewMetaKey('columnSync', columnSync, 'description'), COLUMN_SYNC_META[columnSync].description) }}
    </p>
  </UFormField>
</template>
