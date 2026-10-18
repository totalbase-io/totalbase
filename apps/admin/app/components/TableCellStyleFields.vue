<script setup lang="ts">
/**
 * How a column's cells look in a table (`CellStyle`, @totalbase/tb-catalog):
 * alignment, font size, bold/italic/monospace and a palette color. The
 * same fields wherever a table column is styled - a Dashboard TABLE's
 * column (TableColumnFields.vue) and a resource column's default
 * (ColumnPresentationFields.vue). An unset key ("Auto", "Default", off) is
 * dropped from the model, never stored empty.
 */
import type { CellStyle } from '@totalbase/tb-catalog'
import type { RoleColor } from '~/types/permission'

const props = defineProps<{
  /** What the parent's model sets beyond the cell style - kept as is. */
  modelValue: CellStyle
  /** The inputs' size - `sm` in a narrow properties panel. */
  size?: 'sm' | 'md'
}>()
const emit = defineEmits<{ 'update:modelValue': [value: CellStyle] }>()
const { t } = useI18n()

const ALIGN_ITEMS = computed(() => [
  { label: t('database.tableCellStyleFields.alignAuto'), value: 'auto' },
  { label: t('database.tableCellStyleFields.alignLeft'), value: 'left' },
  { label: t('database.tableCellStyleFields.alignCenter'), value: 'center' },
  { label: t('database.tableCellStyleFields.alignRight'), value: 'right' }
])
const SIZE_ITEMS = computed(() => [
  { label: t('database.tableCellStyleFields.sizeDefault'), value: 'auto' },
  { label: t('database.tableCellStyleFields.sizeXs'), value: 'xs' },
  { label: t('database.tableCellStyleFields.sizeSm'), value: 'sm' },
  { label: t('database.tableCellStyleFields.sizeBase'), value: 'base' },
  { label: t('database.tableCellStyleFields.sizeLg'), value: 'lg' }
])
const STYLE_TOGGLES = computed(() => [
  { key: 'bold', icon: 'i-lucide-bold', label: t('database.tableCellStyleFields.bold') },
  { key: 'italic', icon: 'i-lucide-italic', label: t('database.tableCellStyleFields.italic') },
  { key: 'mono', icon: 'i-lucide-code', label: t('database.tableCellStyleFields.monospace') },
  { key: 'underline', icon: 'i-lucide-underline', label: t('database.tableCellStyleFields.underline') },
  { key: 'strike', icon: 'i-lucide-strikethrough', label: t('database.tableCellStyleFields.strike') }
] as const)

function set(key: keyof CellStyle, value: unknown) {
  const empty = value === undefined || value === null || value === '' || value === false || value === 'auto'
  emit('update:modelValue', Object.fromEntries(Object.entries({ ...props.modelValue, [key]: value }).filter(([k]) => k !== key || !empty)) as CellStyle)
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex gap-2">
      <UFormField
        :label="t('database.tableCellStyleFields.align')"
        class="flex-1"
      >
        <USelect
          :model-value="modelValue.align ?? 'auto'"
          :items="ALIGN_ITEMS"
          :size="size"
          class="w-full"
          @update:model-value="(v: string) => set('align', v)"
        />
      </UFormField>
      <UFormField
        :label="t('database.tableCellStyleFields.fontSize')"
        class="flex-1"
      >
        <USelect
          :model-value="modelValue.fontSize ?? 'auto'"
          :items="SIZE_ITEMS"
          :size="size"
          class="w-full"
          @update:model-value="(v: string) => set('fontSize', v)"
        />
      </UFormField>
    </div>

    <div class="flex items-end gap-2">
      <div class="flex gap-1">
        <UTooltip
          v-for="toggle in STYLE_TOGGLES"
          :key="toggle.key"
          :text="toggle.label"
        >
          <UButton
            :icon="toggle.icon"
            :aria-label="toggle.label"
            :aria-pressed="modelValue[toggle.key] === true"
            :size="size"
            color="neutral"
            :variant="modelValue[toggle.key] ? 'subtle' : 'outline'"
            square
            @click="set(toggle.key, !modelValue[toggle.key])"
          />
        </UTooltip>
      </div>
      <ColorPickerField
        :model-value="modelValue.color"
        :label="t('common.color')"
        allow-none
        @update:model-value="(v?: RoleColor) => set('color', v)"
      />
      <ColorPickerField
        :model-value="modelValue.background"
        :label="t('database.tableCellStyleFields.background')"
        allow-none
        @update:model-value="(v?: RoleColor) => set('background', v)"
      />
    </div>
  </div>
</template>
