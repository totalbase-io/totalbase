<script setup lang="ts">
/**
 * A new form field on the Design canvas (CustomDesigner.vue): its label, its
 * input, and what it edits - a column of the page's record, or a Value it
 * keeps its value in (created with it, unless the author says otherwise).
 * The modal owns the draft; the designer places the field (`confirm`).
 */
import type { ValueType, WidgetName } from '@totalbase/tb-catalog'
import type { CatalogColumn } from '~/types/permission'

/** What the new field is: its label and input, bound to a record column or to a new Value. */
export interface FieldSetupSpec { label: string, input: WidgetName, column?: string, variable?: string }

const props = defineProps<{
  /** The record's columns - none when the page has no record: the field edits a Value. */
  columns: CatalogColumn[]
  /** The inputs a form field can hold, for its select. */
  inputOptions: { label: string, description: string, icon: string, value: WidgetName }[]
  /** The title a column's field shows with none of its own. */
  columnTitle: (column: string) => string
  /** The input a column is edited with (Specification_DataViews.md §15.2). */
  inputForColumn: (column: string) => WidgetName
  /** `Razón social` → `razonSocial`, unique among the variables. */
  identifierFrom: (label: string) => string
  /** The Value type an input keeps its value in. */
  valueTypeFor: (input: WidgetName) => ValueType
  saving: boolean
}>()
const emit = defineEmits<{
  confirm: [spec: FieldSetupSpec]
}>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()

const fieldSetup = reactive({
  /** Bound to a column of the record, or to a Value. */
  source: 'column' as 'column' | 'value',
  column: undefined as string | undefined,
  label: '',
  labelEdited: false,
  input: 'UInput' as WidgetName,
  createVariable: true,
  variable: '',
  variableEdited: false
})
// A fresh draft every time it opens.
watch(open, (isOpen) => {
  if (!isOpen) return
  Object.assign(fieldSetup, {
    source: props.columns.length ? 'column' : 'value',
    column: undefined,
    label: '',
    labelEdited: false,
    input: 'UInput',
    createVariable: true,
    variable: '',
    variableEdited: false
  })
})
watch(() => fieldSetup.label, (label) => {
  if (!fieldSetup.variableEdited) fieldSetup.variable = props.identifierFrom(label)
})
watch(() => fieldSetup.column, (column) => {
  if (!column) return
  if (!fieldSetup.labelEdited) fieldSetup.label = props.columnTitle(column)
  fieldSetup.input = props.inputForColumn(column)
})
/** What a new form field edits. */
const fieldSourceItems = computed(() => [
  { label: t('designer.customDesigner.fieldSetup.sourceColumn'), description: t('designer.customDesigner.fieldSetup.sourceColumnHelp', { code: 'record.save()' }), value: 'column' },
  { label: t('designer.customDesigner.fieldSetup.sourceValue'), description: t('designer.customDesigner.fieldSetup.sourceValueHelp'), value: 'value' }
])
const columnOptions = computed(() => props.columns.map(c => ({ label: c.name, description: c.dataType, value: c.name })))
const fieldSetupValid = computed(() => fieldSetup.label.trim() !== '' && (fieldSetup.source === 'value' || Boolean(fieldSetup.column)))

function confirm() {
  const label = fieldSetup.label.trim()
  const variable = fieldSetup.variable.trim()
  const byColumn = fieldSetup.source === 'column'
  const createVariable = !byColumn && fieldSetup.createVariable
  if (!fieldSetupValid.value || (createVariable && !/^[a-z][a-zA-Z0-9_]*$/.test(variable))) return
  emit('confirm', {
    label,
    input: fieldSetup.input,
    column: byColumn ? fieldSetup.column : undefined,
    variable: createVariable ? variable : undefined
  })
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('designer.customDesigner.fieldSetup.title')"
    :description="t('designer.customDesigner.fieldSetup.description')"
  >
    <template #body>
      <div class="flex flex-col gap-4">
        <UFormField
          v-if="columns.length"
          :label="t('designer.customDesigner.fieldSetup.edits')"
        >
          <URadioGroup
            v-model="fieldSetup.source"
            :items="fieldSourceItems"
          />
        </UFormField>
        <UFormField
          v-if="fieldSetup.source === 'column' && columns.length"
          :label="t('designer.customDesigner.fieldSetup.column')"
          required
        >
          <USelectMenu
            v-model="fieldSetup.column"
            :items="columnOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <UFormField
          :label="t('common.label')"
          required
        >
          <UInput
            v-model="fieldSetup.label"
            class="w-full"
            autofocus
            @update:model-value="fieldSetup.labelEdited = true"
          />
        </UFormField>
        <UFormField :label="t('designer.customDesigner.input')">
          <USelectMenu
            v-model="fieldSetup.input"
            :items="inputOptions"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <USwitch
          v-if="fieldSetup.source === 'value' || !columns.length"
          v-model="fieldSetup.createVariable"
          :label="t('designer.customDesigner.fieldSetup.createVariable')"
          :description="t('designer.customDesigner.fieldSetup.createVariableHelp', { type: valueTypeFor(fieldSetup.input), code: 'dataview.vars.name.value' })"
        />
        <UFormField
          v-if="fieldSetup.createVariable && (fieldSetup.source === 'value' || !columns.length)"
          :label="t('designer.customDesigner.fieldSetup.variable')"
          :description="t('designer.customDesigner.fieldSetup.variableHelp')"
        >
          <UInput
            v-model="fieldSetup.variable"
            class="w-full font-mono"
            @update:model-value="fieldSetup.variableEdited = true"
          />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton
          :label="t('common.cancel')"
          color="neutral"
          variant="ghost"
          @click="open = false"
        />
        <UButton
          :label="t('designer.customDesigner.fieldSetup.add')"
          :loading="saving"
          :disabled="!fieldSetupValid"
          @click="confirm"
        />
      </div>
    </template>
  </UModal>
</template>
