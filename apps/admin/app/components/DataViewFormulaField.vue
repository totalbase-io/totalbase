<script setup lang="ts">
// One formula slot of a DataView layout (card title, pin color...): the
// current formula read-only, edited through BindingButton. Empty is null,
// the way the layout configs store it (types/dataview.ts).
import type { CatalogColumn } from '~/types/permission'
import type { RelationDefinition } from '~/types/schema'

defineProps<{
  label: string
  description: string
  columns: CatalogColumn[]
  relations?: RelationDefinition[]
}>()
const { t } = useI18n()
const formula = defineModel<string | null>({ required: true })
const text = computed({
  get: () => formula.value ?? '',
  set: (value: string) => { formula.value = value.trim() || null }
})
</script>

<template>
  <UFormField
    :label="label"
    :description="description"
  >
    <div class="flex items-center gap-1">
      <p
        v-if="text"
        class="flex-1 truncate rounded-md border border-default bg-elevated px-3 py-1.5 font-mono text-xs text-highlighted"
      >
        {{ text }}
      </p>
      <p
        v-else
        class="flex-1 px-1 py-1.5 text-xs text-muted"
      >
        {{ t('designer.dataViewFormulaField.notSet') }}
      </p>
      <BindingButton
        v-model="text"
        kind="text"
        :label="label"
        :columns="columns"
        :relations="relations"
      />
    </div>
  </UFormField>
</template>
