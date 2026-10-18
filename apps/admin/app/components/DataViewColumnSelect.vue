<script setup lang="ts">
// A layout setting that names one source column (Latitude, Group by,
// Start date...): picks from `options` by name, shows each by its label.
// With `validate` (the settings page, once the catalog the options were
// narrowed with has loaded), a stored column no longer among `options` is
// cleared.
import type { ColumnOption } from '~/utils/dataview-columns'

const column = defineModel<string | null>({ required: true })
const props = defineProps<{
  label: string
  description: string
  options: ColumnOption[]
  validate?: boolean
}>()

const labelOf = (name: string) => props.options.find(o => o.name === name)?.label ?? name
const selected = computed({
  get: () => column.value ?? undefined,
  set: (value: string | undefined) => { column.value = value ?? null }
})

watch([() => props.options, () => props.validate], ([options, validate]) => {
  if (validate && column.value && !options.some(o => o.name === column.value)) column.value = null
})
</script>

<template>
  <UFormField
    :label="label"
    :description="description"
  >
    <USelectMenu
      v-model="selected"
      :items="options.map(o => o.name)"
      class="w-full"
    >
      <template #item-label="{ item }">
        {{ labelOf(item) }}
      </template>
      <template
        v-if="selected"
        #default
      >
        {{ labelOf(selected) }}
      </template>
    </USelectMenu>
  </UFormField>
</template>
