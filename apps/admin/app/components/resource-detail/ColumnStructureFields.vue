<script setup lang="ts">
import type { CatalogColumn } from '~/types/permission'
import type { EditOperationBody, InlineForeignKeyBody, RelationDetail } from '~/types/schema'
import { BASE_TYPES, composeDataType, currentDataType, dataTypeParts, LENGTH_TYPES, PRECISION_TYPES } from '~/utils/column-data-type'

/**
 * A table column's structure (Administration.md §3), the column panel's Database tab: its name, type, nulls, default,
 * a single-column UNIQUE and its foreign key - diffed against the catalog into ALTER operations, whose SQL shows
 * below as it is edited. The panel's Save runs them with its presentation, in one transaction. Its CHECKs are the
 * Constraints section's.
 */
const props = defineProps<{
  schema: string
  table: string
  column: CatalogColumn
  detail: RelationDetail
  /** TotalBase's role doesn't own the table: shown, not editable (§3.15). */
  readOnly?: boolean
}>()
/** What Save sends: the operations in order, the column's name once they ran, and whether they can be sent. */
const emit = defineEmits<{ change: [change: { operations: EditOperationBody[], columnName: string, valid: boolean }] }>()
const { t } = useI18n()

const { tables: allTables } = useCatalogTablesList()

const uniqueName = computed(() => {
  const index = props.detail.uniqueConstraints.findIndex((group, i) => group.length === 1 && group[0] === props.column.name && props.detail.uniqueConstraintNames[i])
  return index === -1 ? null : props.detail.uniqueConstraintNames[index]!
})
const relation = computed(() => props.detail.relations.find(r => r.sourceColumn === props.column.name) ?? null)
const isDomain = computed(() => Boolean(props.column.domain))
const originalForeignKey = computed<InlineForeignKeyBody | undefined>(() => relation.value
  ? { targetSchema: relation.value.targetSchema, targetTable: relation.value.targetTable, targetColumn: relation.value.targetColumn }
  : undefined)

const name = ref('')
const type = ref(dataTypeParts(props.column))
const notNull = ref(false)
const defaultValue = ref('')
const unique = ref(false)
const foreignKey = ref<InlineForeignKeyBody | undefined>()
const fkValid = ref(true)
const fkOpen = ref(false)

function reset() {
  name.value = props.column.name
  type.value = dataTypeParts(props.column)
  notNull.value = !props.column.nullable
  defaultValue.value = props.column.defaultExpression ?? ''
  unique.value = uniqueName.value !== null
  foreignKey.value = originalForeignKey.value ? { ...originalForeignKey.value } : undefined
  fkValid.value = true
}
watch(() => [props.column, props.detail], reset, { immediate: true })

/** The draft against the column as the catalog has it - in the order the edit route runs them, the rename first. */
const operations = computed<EditOperationBody[]>(() => {
  const original = props.column.name
  const next = name.value.trim()
  const ops: EditOperationBody[] = []
  const patch: { rename?: string, dataType?: string, nullable?: boolean, default?: string | null } = {}
  if (next && next !== original) patch.rename = next
  if (!isDomain.value && type.value.base.trim() && composeDataType(type.value) !== currentDataType(props.column)) patch.dataType = composeDataType(type.value)
  if (notNull.value === props.column.nullable) patch.nullable = !notNull.value
  const nextDefault = defaultValue.value.trim() || null
  if (nextDefault !== props.column.defaultExpression) patch.default = nextDefault
  if (Object.keys(patch).length > 0) ops.push({ kind: 'alter_column', column: original, patch })

  const finalName = next || original
  if (unique.value && !uniqueName.value) ops.push({ kind: 'add_unique', columns: [finalName] })
  else if (!unique.value && uniqueName.value) ops.push({ kind: 'drop_constraint', name: uniqueName.value })

  if (fkValid.value && JSON.stringify(foreignKey.value ?? null) !== JSON.stringify(originalForeignKey.value ?? null)) {
    if (relation.value) ops.push({ kind: 'drop_constraint', name: relation.value.name })
    if (foreignKey.value) ops.push({ kind: 'add_foreign_key', column: finalName, ...foreignKey.value })
  }
  return ops
})
const valid = computed(() => name.value.trim() !== '' && type.value.base.trim() !== '' && fkValid.value)
watch([operations, valid], () => emit('change', { operations: operations.value, columnName: name.value.trim() || props.column.name, valid: valid.value }), { immediate: true })

const fkLabel = computed(() => foreignKey.value ? `${foreignKey.value.targetSchema}.${foreignKey.value.targetTable}.${foreignKey.value.targetColumn}` : t('database.tableEdit.foreignKeyNone'))
</script>

<template>
  <div class="flex flex-col gap-4">
    <UFormField :label="t('common.name')">
      <UInput
        v-model="name"
        :disabled="readOnly"
        class="w-full"
      />
    </UFormField>

    <div class="flex flex-wrap gap-3">
      <UFormField
        :label="t('common.type')"
        :description="isDomain ? t('database.tableEdit.domainType') : undefined"
        class="flex-1 min-w-40"
      >
        <UInputMenu
          v-model="type.base"
          mode="autocomplete"
          :items="BASE_TYPES"
          :disabled="readOnly || isDomain"
          class="w-full"
        />
      </UFormField>
      <UFormField
        v-if="LENGTH_TYPES.has(type.base) || PRECISION_TYPES.has(type.base)"
        :label="t('database.tableEdit.lengthPrecision')"
        class="w-32"
      >
        <UInput
          v-if="LENGTH_TYPES.has(type.base)"
          v-model="type.length"
          inputmode="numeric"
          :disabled="readOnly"
        />
        <UInput
          v-else
          v-model="type.precision"
          inputmode="numeric"
          :disabled="readOnly"
        />
      </UFormField>
      <UFormField
        v-if="PRECISION_TYPES.has(type.base)"
        :label="t('database.tableEdit.scale')"
        class="w-24"
      >
        <UInput
          v-model="type.scale"
          inputmode="numeric"
          :disabled="readOnly"
        />
      </UFormField>
    </div>

    <UFormField
      :label="t('database.tableEdit.default')"
      :description="t('database.tableEdit.defaultHelp', { example1: 'now()', example2: '0' })"
    >
      <UInput
        v-model="defaultValue"
        :disabled="readOnly"
        class="w-full font-mono"
      />
    </UFormField>

    <USwitch
      v-model="notNull"
      :label="t('database.tableEdit.notNull')"
      :description="t('database.tableEdit.notNullHelp')"
      :disabled="readOnly"
    />
    <USwitch
      v-model="unique"
      :label="t('database.tableEdit.unique')"
      :description="t('database.tableEdit.uniqueHelp')"
      :disabled="readOnly"
    />

    <UFormField
      :label="t('database.tableEdit.foreignKey')"
      :description="t('database.tableEdit.foreignKeyHelp')"
    >
      <div class="flex items-center gap-2">
        <span
          class="text-sm"
          :class="foreignKey ? 'font-mono text-highlighted' : 'text-muted'"
        >{{ fkLabel }}</span>
        <UButton
          v-if="!readOnly"
          :label="foreignKey ? t('database.tableEdit.foreignKeyChange') : t('database.tableEdit.foreignKeySet')"
          size="xs"
          color="neutral"
          variant="outline"
          @click="fkOpen = true"
        />
        <UButton
          v-if="foreignKey && !readOnly"
          :label="t('common.clear')"
          size="xs"
          color="error"
          variant="ghost"
          @click="foreignKey = undefined; fkValid = true"
        />
      </div>
    </UFormField>

    <TableEditSqlPreview
      v-if="!readOnly"
      :schema="schema"
      :table="table"
      :operations="valid ? operations : []"
    />

    <UModal
      v-model:open="fkOpen"
      :title="t('database.tableEdit.foreignKeyModalTitle', { column: name || column.name })"
    >
      <template #body>
        <ForeignKeyFields
          v-model="foreignKey"
          v-model:valid="fkValid"
          :all-tables="(allTables ?? []).filter(other => !(other.name === table && other.schema === schema))"
        />
      </template>
      <template #footer>
        <div class="flex justify-end w-full">
          <UButton
            :label="t('common.done')"
            @click="fkOpen = false"
          />
        </div>
      </template>
    </UModal>
  </div>
</template>
