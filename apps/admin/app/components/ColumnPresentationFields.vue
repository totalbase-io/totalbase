<script setup lang="ts">
/**
 * A column's presentation (DataViews.md §15):
 * how it reads wherever it shows - inherited by every grid column, form
 * field and Table widget that doesn't set its own. In sections: General,
 * In forms (its input), Display (its value), In tables (its cells' look)
 * and, for a CHECK list, how each value shows. Only what the column's type
 * takes (`columnPresentationOptions`); what values are valid is
 * PostgreSQL's, never edited here. Used by Add Column and by the Columns
 * tab's sidebar.
 */
import { COLUMN_INPUT_KEYS, COLUMN_INPUTS, columnPresentationOptions, WIDGET_COLORS, type ColumnOptionPresentation, type ColumnPresentation, type ValueKind } from '@totalbase/tb-catalog'
import { humanizeColumnName } from '~/utils/humanize-column-name'
import { useColumnInputText } from '~/utils/column-input-text'

const props = defineProps<{
  /** The column's name, for the label's fallback. Empty while Add Column has none yet. */
  columnName: string
  kind: ValueKind
  /** The values of the column's CHECK list - each gets its label, color and icon. Null when it has none. */
  checkValues?: string[] | null
  /** Its Properties alone - the column panel shows Styles and Conditions in their own tabs. Unset: everything (Add Column). */
  part?: 'properties'
  /** A view's column: what it inherits from its table's column - an option left empty shows that (§15.1). */
  inherited?: ColumnPresentation
  /** What Automatic edits it with - the rule's catalog entry and why (`columnFormInput`, §15.2). Unknown in Add Column. */
  automatic?: { input: string, widget: string, reason: string }
  /** The catalog entries that edit it - what its Control offers. None: no Control here (Add Column picks it first). */
  inputs?: string[]
}>()
const model = defineModel<ColumnPresentation>({ required: true })
const { t } = useI18n()

const options = computed(() => columnPresentationOptions(props.kind))

function update(patch: Partial<ColumnPresentation>) {
  model.value = { ...model.value, ...patch }
}

const LINK_ITEMS = computed(() => [
  { label: t('common.none'), value: 'none' },
  { label: t('database.columnPresentationFields.linkUrl'), value: 'url' },
  { label: t('database.columnPresentationFields.linkEmail'), value: 'email' },
  { label: t('database.columnPresentationFields.linkPhone'), value: 'tel' }
])

const labelHelp = computed(() => props.columnName
  ? t('database.columnPresentationFields.labelHelp', { name: props.inherited?.label ?? humanizeColumnName(props.columnName) })
  : t('database.columnPresentationFields.labelHelpNoName'))
/** Its icon's help - an empty one inherits its table's, named. */
const iconHelp = computed(() => (!model.value.icon && props.inherited?.icon
  ? t('database.columnPresentationFields.iconInherited', { icon: props.inherited.icon })
  : t('database.columnPresentationFields.iconHelp')))

const inputText = useColumnInputText()
/**
 * Its control - one entry of the column input catalog that edits it (§16), each named with what it is ("UInput · type
 * number"); Automatic, the rule's, says which and why. A choice is kept until Automatic is picked again.
 */
const INPUT_ITEMS = computed(() => {
  const keys = props.inputs ?? COLUMN_INPUT_KEYS.filter(key => COLUMN_INPUTS[key].kinds.includes(props.kind))
  const automatic = props.automatic
  return [
    {
      label: automatic
        ? t('database.columnPresentationFields.inputAutoIs', { input: inputText.label(automatic.input) })
        : t('database.columnPresentationFields.inputAuto'),
      description: automatic ? `${inputText.technical(automatic.input)} - ${t(`database.columnPresentationFields.inputReason.${automatic.reason}`)}` : undefined,
      icon: 'i-lucide-wand-sparkles',
      value: 'none'
    },
    ...keys.map(key => ({ label: inputText.label(key), description: inputText.technical(key), icon: COLUMN_INPUTS[key as keyof typeof COLUMN_INPUTS]?.icon, value: key }))
  ]
})
function setInput(value: string) {
  const { input: _input, ...rest } = model.value
  model.value = value === 'none' ? rest : { ...rest, input: value }
}

const ICON_POSITIONS = computed(() => [
  { label: t('database.columnPresentationFields.iconStart'), value: 'leading' },
  { label: t('database.columnPresentationFields.iconEnd'), value: 'trailing' }
])
const COLOR_ITEMS = computed(() => [{ label: t('database.columnPresentationFields.colorDefault'), value: 'none' }, ...WIDGET_COLORS.map(c => ({ label: t(`database.columnPresentationFields.colors.${c}`), value: c, chip: { color: c } }))])

function setOption(value: string, patch: Partial<ColumnOptionPresentation>) {
  update({ options: { ...model.value.options, [value]: { ...model.value.options?.[value], ...patch } } })
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <p class="text-xs font-semibold uppercase tracking-wide text-muted">
      {{ t('database.columnPresentationFields.general') }}
    </p>
    <UFormField
      :label="t('common.label')"
      :description="labelHelp"
    >
      <UInput
        :model-value="model.label ?? ''"
        class="w-full"
        @update:model-value="(v: string) => update({ label: v })"
      />
    </UFormField>
    <UFormField
      :label="t('database.columnPresentationFields.shortLabel')"
      :description="t('database.columnPresentationFields.shortLabelHelp')"
    >
      <UInput
        :model-value="model.shortLabel ?? ''"
        :maxlength="32"
        class="w-full"
        @update:model-value="(v: string) => update({ shortLabel: v })"
      />
    </UFormField>
    <UFormField
      :label="t('common.description')"
      :description="t('database.columnPresentationFields.descriptionHelp')"
    >
      <UInput
        :model-value="model.description ?? ''"
        class="w-full"
        @update:model-value="(v: string) => update({ description: v })"
      />
    </UFormField>
    <USeparator />
    <p class="text-xs font-semibold uppercase tracking-wide text-muted">
      {{ t('database.columnPresentationFields.inForms') }}
    </p>
    <UFormField
      v-if="inputs"
      :label="t('database.columnPresentationFields.input')"
      :description="t('database.columnPresentationFields.inputHelp')"
    >
      <USelectMenu
        :model-value="model.input ?? 'none'"
        :items="INPUT_ITEMS"
        value-key="value"
        :aria-label="t('database.columnPresentationFields.input')"
        class="w-full"
        :disabled="model.input === 'password'"
        @update:model-value="setInput"
      />
    </UFormField>
    <UFormField
      :label="t('database.columnPresentationFields.help')"
      :description="t('database.columnPresentationFields.helpHelp')"
    >
      <UInput
        :model-value="model.help ?? ''"
        class="w-full"
        @update:model-value="(v: string) => update({ help: v })"
      />
    </UFormField>
    <UFormField
      v-if="options.placeholder"
      :label="t('database.columnPresentationFields.placeholder')"
      :description="t('database.columnPresentationFields.placeholderHelp', { example: '20-12345678-9' })"
    >
      <UInput
        :model-value="model.placeholder ?? ''"
        class="w-full"
        @update:model-value="(v: string) => update({ placeholder: v })"
      />
    </UFormField>
    <div
      v-if="options.icon"
      class="flex items-end gap-3 max-md:flex-col max-md:items-stretch"
    >
      <IconPickerField
        :model-value="model.icon"
        :label="t('common.icon')"
        :description="iconHelp"
        options="lucide"
        clearable
        @update:model-value="(v: string | undefined) => update({ icon: v })"
      />
      <UFormField
        v-if="model.icon"
        :label="t('database.columnPresentationFields.position')"
        class="min-w-0 flex-1"
      >
        <USelect
          :model-value="model.iconPosition ?? 'leading'"
          :items="ICON_POSITIONS"
          class="w-full"
          @update:model-value="(v: string) => update({ iconPosition: v === 'trailing' ? 'trailing' : undefined })"
        />
      </UFormField>
    </div>
    <USeparator />
    <p class="text-xs font-semibold uppercase tracking-wide text-muted">
      {{ t('database.columnPresentationFields.display') }}
    </p>
    <DisplayFormatField
      v-if="options.displayFormat"
      :model-value="model.displayFormat"
      :kind="kind"
      @update:model-value="(v?: string) => update({ displayFormat: v })"
    />
    <div
      v-if="options.booleanLabels"
      class="grid grid-cols-2 gap-2 max-md:grid-cols-1"
    >
      <UFormField
        :label="t('database.columnPresentationFields.trueAs')"
        :description="t('database.columnPresentationFields.trueAsHelp')"
      >
        <UInput
          :model-value="model.booleanLabels?.true ?? ''"
          class="w-full"
          @update:model-value="(v: string) => update({ booleanLabels: { ...model.booleanLabels, true: v } })"
        />
      </UFormField>
      <UFormField
        :label="t('database.columnPresentationFields.falseAs')"
        :description="t('database.columnPresentationFields.falseAsHelp')"
      >
        <UInput
          :model-value="model.booleanLabels?.false ?? ''"
          class="w-full"
          @update:model-value="(v: string) => update({ booleanLabels: { ...model.booleanLabels, false: v } })"
        />
      </UFormField>
    </div>
    <UFormField
      v-if="options.linkType"
      :label="t('database.columnPresentationFields.link')"
      :description="t('database.columnPresentationFields.linkHelp')"
    >
      <USelect
        :model-value="model.linkType ?? 'none'"
        :items="LINK_ITEMS"
        class="w-full"
        @update:model-value="(v: string) => update({ linkType: v === 'url' || v === 'email' || v === 'tel' ? v : undefined })"
      />
    </UFormField>
    <UFormField
      :label="t('database.columnPresentationFields.emptyText')"
      :description="t('database.columnPresentationFields.emptyTextHelp')"
    >
      <UInput
        :model-value="model.emptyText ?? ''"
        class="w-full"
        @update:model-value="(v: string) => update({ emptyText: v })"
      />
    </UFormField>
    <template v-if="part !== 'properties'">
      <USeparator />
      <p class="text-xs font-semibold uppercase tracking-wide text-muted">
        {{ t('database.columnPresentationFields.inTables') }}
      </p>
      <TableCellStyleFields
        :model-value="model"
        @update:model-value="(style) => model = style as ColumnPresentation"
      />
    </template>
    <template v-if="checkValues?.length">
      <USeparator />
      <div>
        <p class="text-xs font-semibold uppercase tracking-wide text-muted">
          {{ t('database.columnPresentationFields.options') }}
        </p>
        <p class="mt-1 text-sm text-muted">
          {{ t('database.columnPresentationFields.optionsHelp') }}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <div
          v-for="value in checkValues"
          :key="value"
          class="flex items-center gap-2 max-md:flex-wrap"
        >
          <span class="w-28 shrink-0 truncate font-mono text-sm text-muted">{{ value }}</span>
          <UInput
            :model-value="model.options?.[value]?.label ?? ''"
            class="min-w-0 flex-1"
            :aria-label="t('database.columnPresentationFields.labelOf', { value })"
            @update:model-value="(v: string) => setOption(value, { label: v })"
          />
          <USelect
            :model-value="model.options?.[value]?.color ?? 'none'"
            :items="COLOR_ITEMS"
            class="w-32 max-md:flex-1"
            :aria-label="t('database.columnPresentationFields.colorOf', { value })"
            @update:model-value="(v: string) => setOption(value, { color: v === 'none' ? undefined : v as ColumnOptionPresentation['color'] })"
          />
          <IconPickerField
            :model-value="model.options?.[value]?.icon"
            label=""
            :aria-label="t('database.columnPresentationFields.iconOf', { value })"
            options="lucide"
            clearable
            @update:model-value="(v: string | undefined) => setOption(value, { icon: v })"
          />
        </div>
      </div>
    </template>
  </div>
</template>
