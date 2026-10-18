<script setup lang="ts">
// DataView settings, KANBAN layout (`view_config.kanban_layout`). Group
// by is a foreign key - a lane per row of the related table - or a column
// with a CHECK list - a lane per value, in the CHECK's order; never a
// formula. The card itself is CARDS' own card. Read only: cards don't move.
import { isForeignKeyField, type KanbanLayoutConfig } from '~/types/dataview'
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'
import { columnOptions, type DataViewColumnField } from '~/utils/dataview-columns'

const layout = defineModel<KanbanLayoutConfig>({ required: true })
const props = defineProps<{
  columnFields: DataViewColumnField[]
  bindingColumns: CatalogColumn[]
  relations?: RelationDefinition[]
  /** The source's columns with a CHECK list (`estado IN ('A', 'B')`) - a lane per value. */
  checkListColumns?: string[]
}>()
const { t } = useI18n()

const field = useModelField(layout)
const groupColumn = field('groupColumn')
const imageFormula = field('imageFormula')
const titleFormula = field('titleFormula')
const descriptionFormula = field('descriptionFormula')
const laneOrder = field('laneOrder')
const laneOrderColumn = field('laneOrderColumn')
const laneColorColumn = field('laneColorColumn')
const readOnly = computed({
  get: () => layout.value.readOnly === true,
  set: (value: boolean) => {
    const { readOnly: _drop, ...rest } = layout.value
    layout.value = value ? { ...rest, readOnly: true } : rest
  }
})

const groupOptions = computed(() => columnOptions(props.columnFields.filter(f => isForeignKeyField(f) || (!!f.columnName && (props.checkListColumns ?? []).includes(f.columnName)))))
/** Lanes from a related table - their order and color come from it; a CHECK list's are its values. */
const groupsByRelation = computed(() => !!groupColumn.value && !!props.relations?.some(r => r.sourceColumn === groupColumn.value))
</script>

<template>
  <SettingsSection :title="t('designer.dataViewKanbanSettings.heading')">
    <DataViewColumnSelect
      v-model="groupColumn"
      :label="t('designer.dataViewKanbanSettings.groupBy')"
      :description="t('designer.dataViewKanbanSettings.groupByHelp')"
      :options="groupOptions"
      :validate="bindingColumns.length > 0"
    />

    <UAlert
      v-if="groupOptions.length === 0"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('designer.dataViewKanbanSettings.noGroupColumns')"
    />

    <DataViewFormulaField
      v-model="imageFormula"
      :label="t('designer.dataViewKanbanSettings.cardImage')"
      :description="t('designer.dataViewKanbanSettings.cardImageHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="titleFormula"
      :label="t('designer.dataViewKanbanSettings.cardTitle')"
      :description="t('designer.dataViewKanbanSettings.cardTitleHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <DataViewFormulaField
      v-model="descriptionFormula"
      :label="t('designer.dataViewKanbanSettings.cardDescription')"
      :description="t('designer.dataViewKanbanSettings.cardDescriptionHelp')"
      :columns="bindingColumns"
      :relations="relations"
    />

    <USwitch
      v-model="readOnly"
      :label="t('designer.dataViewKanbanSettings.readOnly')"
      :description="t('designer.dataViewKanbanSettings.readOnlyHelp')"
    />

    <DataViewLaneColumns
      v-if="groupsByRelation"
      v-model:order-column="laneOrderColumn"
      v-model:color-column="laneColorColumn"
      :group-column="groupColumn"
      :relations="relations"
    />

    <DataViewLaneOrder
      v-if="groupsByRelation"
      v-model="laneOrder"
      :group-column="groupColumn"
      :relations="relations"
      :fields="columnFields"
      :order-column="laneOrderColumn"
      :description="t('designer.dataViewKanbanSettings.laneOrderHelp')"
      :empty-text="t('designer.dataViewKanbanSettings.noLanes')"
    />
  </SettingsSection>
</template>
