<script setup lang="ts">
/**
 * A column's display format (`displayFormat`, utils/format-pattern.ts): a
 * number or a date pattern, typed or picked from the presets of its kind.
 * Shared by a resource column's presentation and a table column's settings.
 */
import type { ValueKind } from '@totalbase/tb-catalog'
import { CURRENCY_CODE_PRESETS, DATE_FORMAT_PRESETS, NUMBER_FORMAT_PRESETS } from '~/utils/format-pattern'

const props = defineProps<{
  kind: ValueKind
  description?: string
  size?: 'sm' | 'md'
}>()
const model = defineModel<string | undefined>()

const { t } = useI18n()
/** NUMBER_FORMAT_PRESETS' labels in the UI's language, by pattern. */
const NUMBER_PRESET_KEYS: Record<string, string> = {
  '#,##0.00': 'designer.displayFormatField.numberPresets.number',
  '#,##0': 'designer.displayFormatField.numberPresets.integer',
  '$#,##0.00': 'designer.displayFormatField.numberPresets.currency',
  '0.00%': 'designer.displayFormatField.numberPresets.percentage',
  '#,##0.00;(#,##0.00);"-"': 'designer.displayFormatField.numberPresets.accounting'
}
const presets = computed(() => {
  const pick = (pattern: string) => () => {
    model.value = pattern
  }
  if (props.kind === 'number') {
    return [
      ...NUMBER_FORMAT_PRESETS.map(p => ({ label: NUMBER_PRESET_KEYS[p.pattern] ? t(NUMBER_PRESET_KEYS[p.pattern]!) : p.label, onSelect: pick(p.pattern) })),
      ...CURRENCY_CODE_PRESETS.map(c => ({ label: t('designer.displayFormatField.currencyCode', { code: c.code }), onSelect: pick(`CURRENCY:${c.code}`) }))
    ]
  }
  const temporal = props.kind === 'timestamp' ? 'datetime' : props.kind === 'date' || props.kind === 'time' ? props.kind : null
  return temporal ? DATE_FORMAT_PRESETS[temporal].map(p => ({ label: p.label, onSelect: pick(p.pattern) })) : []
})
</script>

<template>
  <UFormField
    :label="t('designer.displayFormatField.format')"
    :description="description ?? t('designer.displayFormatField.description')"
  >
    <div class="flex gap-1">
      <UInput
        :model-value="model ?? ''"
        :size="size"
        class="min-w-0 flex-1 font-mono"
        :aria-label="t('designer.displayFormatField.format')"
        @update:model-value="(v: string) => model = v.trim() ? v : undefined"
      />
      <UDropdownMenu
        :items="presets"
        :content="{ align: 'end' }"
      >
        <UButton
          icon="i-lucide-chevron-down"
          color="neutral"
          variant="outline"
          :size="size"
          :aria-label="t('designer.displayFormatField.presets')"
        />
      </UDropdownMenu>
    </div>
  </UFormField>
</template>
