<script setup lang="ts">
// A SETTINGS DataView's columns (`view_config.settings_layout`, Specification_DataViews.md §5.12) - the
// wizard's Settings step and Edit DataView's section alike. Key, value, title and description are
// required; group and order optional.
import type { SettingsLayoutConfig } from '~/types/dataview'
import type { ColumnOption } from '~/utils/dataview-columns'

const layout = defineModel<SettingsLayoutConfig>({ required: true })
defineProps<{ columns: ColumnOption[], validate?: boolean }>()
const { t } = useI18n()

const field = useModelField(layout)
const SLOTS = ['keyColumn', 'valueColumn', 'titleColumn', 'descriptionColumn', 'groupColumn', 'orderColumn'] as const
const models = Object.fromEntries(SLOTS.map(slot => [slot, field(slot)])) as Record<typeof SLOTS[number], ReturnType<typeof field<typeof SLOTS[number]>>>
</script>

<template>
  <div class="flex flex-col gap-4">
    <DataViewColumnSelect
      v-for="slot in SLOTS"
      :key="slot"
      v-model="models[slot].value"
      :label="t(`designer.settingsLayout.${slot}`)"
      :description="t(`designer.settingsLayout.${slot}Help`)"
      :options="columns"
      :validate="validate"
    />
  </div>
</template>
