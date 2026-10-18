<script setup lang="ts">
import type { CatalogObjectSummary, FkAction, InlineForeignKeyBody, RelationDetail } from '~/types/schema'

const FK_ACTIONS: FkAction[] = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']

// Vertical, one field per line - this only ever shows up inside a modal
// dedicated to a single column's foreign key (opened by that column's
// pencil icon), so there's no need to share width with anything else the
// way the inline grid's cells do.
const props = defineProps<{
  allTables: CatalogObjectSummary[]
}>()

const foreignKey = defineModel<InlineForeignKeyBody | undefined>({ required: true })
const valid = defineModel<boolean>('valid', { default: true })

const api = useAdminApi()
const { t } = useI18n()

const targetSchema = ref(foreignKey.value?.targetSchema ?? 'public')
const targetTable = ref(foreignKey.value?.targetTable ?? '')
const targetColumn = ref(foreignKey.value?.targetColumn ?? '')
const onDelete = ref<FkAction | undefined>(foreignKey.value?.onDelete)
const onUpdate = ref<FkAction | undefined>(foreignKey.value?.onUpdate)
const targetColumns = ref<string[]>([])
const targetDetail = ref<RelationDetail | null>(null)
const loadingTarget = ref(false)

const schemaOptions = computed(() => [...new Set(props.allTables.map(table => table.schema))])
const targetTableOptions = computed(() => props.allTables.filter(table => table.schema === targetSchema.value).map(table => table.name))

async function onTargetTableChange() {
  targetColumn.value = ''
  targetColumns.value = []
  targetDetail.value = null
  const target = props.allTables.find(table => table.schema === targetSchema.value && table.name === targetTable.value)
  if (!target) return
  loadingTarget.value = true
  try {
    const { data } = await api.get<RelationDetail>(`/catalog/table/${target.oid}`)
    targetDetail.value = data
    targetColumns.value = data.columns.map(c => c.name)
  } finally {
    loadingTarget.value = false
  }
}
if (targetTable.value) onTargetTableChange()

// PostgreSQL requires the referenced column to carry a PK or UNIQUE -
// checked against the target's own catalog detail rather than finding
// out from a failed CREATE/ALTER.
const targetIsValid = computed(() => {
  if (!targetColumn.value || !targetDetail.value) return false
  const detail = targetDetail.value
  return detail.primaryKey.includes(targetColumn.value)
    || detail.uniqueConstraints.some(cols => cols.length === 1 && cols[0] === targetColumn.value)
})

watch([targetSchema, targetTable, targetColumn, onDelete, onUpdate], () => {
  valid.value = !targetColumn.value || targetIsValid.value
  foreignKey.value = targetIsValid.value
    ? { targetSchema: targetSchema.value, targetTable: targetTable.value, targetColumn: targetColumn.value, onDelete: onDelete.value, onUpdate: onUpdate.value }
    : undefined
})
</script>

<template>
  <div class="flex flex-col gap-3">
    <UFormField :label="t('database.foreignKeyFields.targetSchema')">
      <USelect
        v-model="targetSchema"
        :items="schemaOptions"
        class="w-full"
        @update:model-value="onTargetTableChange"
      />
    </UFormField>
    <UFormField :label="t('database.foreignKeyFields.targetTable')">
      <USelect
        v-model="targetTable"
        :items="targetTableOptions"
        class="w-full"
        @update:model-value="onTargetTableChange"
      />
    </UFormField>
    <UFormField :label="t('database.foreignKeyFields.targetColumn')">
      <USelect
        v-model="targetColumn"
        :items="targetColumns"
        :loading="loadingTarget"
        class="w-full"
      />
    </UFormField>
    <UAlert
      v-if="targetColumn && !targetIsValid"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="t('database.foreignKeyFields.invalidTargetTitle')"
      :description="t('database.foreignKeyFields.invalidTargetDescription')"
    />
    <UFormField :label="t('database.foreignKeyFields.onDelete')">
      <USelect
        v-model="onDelete"
        :items="FK_ACTIONS"
        class="w-full"
      />
    </UFormField>
    <UFormField :label="t('database.foreignKeyFields.onUpdate')">
      <USelect
        v-model="onUpdate"
        :items="FK_ACTIONS"
        class="w-full"
      />
    </UFormField>
  </div>
</template>
