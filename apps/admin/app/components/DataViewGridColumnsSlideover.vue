<script setup lang="ts">
/**
 * DataViewGrid.vue's Columns panel (features.columnsToggle): every column's
 * visibility and order, as the viewer's own prefs (useGridColumnPrefs.ts owns
 * the list and the writes - this only draws it). All / None toggle every
 * column; Default reapplies the DataView-wide `default_state`'s columns,
 * shown only once such a default exists.
 */
import type { ColItem } from '~/composables/useGridColumnPrefs'

defineProps<{
  items: ColItem[]
  hasDefault: boolean
}>()
const emit = defineEmits<{
  setAll: [visible: boolean]
  selectDefault: []
  toggle: [key: string]
  moveUp: [index: number]
  moveDown: [index: number]
}>()
const open = defineModel<boolean>('open', { default: false })
const { t } = useI18n()
</script>

<template>
  <USlideover
    v-model:open="open"
    :title="t('dataviews.meta.featureLabels.columnsToggle')"
  >
    <template #body>
      <div class="flex h-full flex-col gap-4 p-1">
        <div class="flex items-center gap-1.5">
          <UButton
            :label="t('common.all')"
            color="neutral"
            variant="subtle"
            size="xs"
            @click="emit('setAll', true)"
          />
          <UButton
            :label="t('common.none')"
            color="neutral"
            variant="subtle"
            size="xs"
            @click="emit('setAll', false)"
          />
          <UButton
            v-if="hasDefault"
            :label="t('dataviews.grid.defaultColumns')"
            icon="i-lucide-rotate-ccw"
            color="neutral"
            variant="subtle"
            size="xs"
            @click="emit('selectDefault')"
          />
        </div>
        <!-- Its own scroll between the buttons and the note: overflow-hidden lets a flex item shrink below its rows,
        which then hid behind the note on a table with many columns. -->
        <div class="min-h-0 flex-1 overflow-y-auto rounded-lg border border-default">
          <div
            v-for="(item, i) in items"
            :key="item.key"
            class="flex items-center gap-2 border-b border-default px-3 py-1 last:border-b-0"
          >
            <!-- Tightened padding/icon size on both arrows (below default
            xs's own p-1 + size-4 icon) - stacked, they otherwise made
            this row much taller than a plain checkbox row, most visible
            on a table with many columns. -->
            <div class="flex flex-col">
              <UButton
                icon="i-lucide-chevron-up"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="i === 0"
                :aria-label="t('dataviews.grid.moveUp', { name: item.label })"
                @click="emit('moveUp', i)"
              />
              <UButton
                icon="i-lucide-chevron-down"
                color="neutral"
                variant="ghost"
                size="xs"
                :disabled="i === items.length - 1"
                :aria-label="t('dataviews.grid.moveDown', { name: item.label })"
                @click="emit('moveDown', i)"
              />
            </div>
            <span class="flex-1 text-sm">{{ item.label }}</span>
            <UCheckbox
              :model-value="item.visible"
              :aria-label="item.label"
              @update:model-value="() => emit('toggle', item.key)"
            />
          </div>
        </div>
        <!-- Pinned to the bottom of the panel (mt-auto on an h-full
        column), same convention every DataView sidebar's own intro
        UAlert follows now - see Saved views' own doc comment. -->
        <UAlert
          color="info"
          variant="subtle"
          icon="i-lucide-info"
          class="mt-auto shrink-0"
          :title="t('dataviews.grid.columnsHelpTitle')"
          :description="t('dataviews.grid.columnsHelpDescription')"
        />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton
          :label="t('common.close')"
          color="neutral"
          variant="outline"
          @click="open = false"
        />
      </div>
    </template>
  </USlideover>
</template>
