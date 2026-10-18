<script setup lang="ts">
/**
 * Reference lines and bands on a chart's value axis (D5, `config.references`): a line at a value - a number, a
 * statistic of the series (average, min, max, median), a column of the row or a variable - optionally over one series;
 * a band from one value to another. Each with its label and color; added, removed, reordered. An empty list is
 * `undefined`. On a scatter (`axisChoice`) a line is on the y axis (unset) or the x one (`axis: "x"`).
 */
import { REFERENCE_STATISTICS } from '@totalbase/tb-catalog'
import type { RoleColor } from '~/types/permission'

type ValueSource = number | string | { column: string } | { variable: string }
type Reference
  = | { type: 'line', value: ValueSource, label?: string, color?: RoleColor, series?: string, axis?: 'x' | 'y' }
    | { type: 'band', from: ValueSource, to: ValueSource, label?: string, color?: RoleColor }

const props = defineProps<{
  /** The query's number columns, by name. */
  columns: string[]
  /** The dashboard's NUMBER and SELECT variables. */
  variables: { value: string, label: string }[]
  /** The chart's series - a line may follow one of them. */
  series: { value: string, label: string }[]
  /** A scatter's: a line may be on its x axis - unset, the y one. */
  axisChoice?: boolean
}>()
const model = defineModel<Reference[] | undefined>()
const { t } = useI18n()

/** A select can't hold an empty value - "every series" is this. */
const ALL = '__all__'
const list = computed<Reference[]>(() => (Array.isArray(model.value) ? model.value : []))
const axisItems = computed(() => (['y', 'x'] as const).map(value => ({ value, label: t(`dashboards.inspector.axes.${value}`) })))
const seriesItems = computed(() => [{ value: ALL, label: t('dashboards.inspector.references.allSeries') }, ...props.series])

function write(next: Reference[]) {
  model.value = next.length ? next : undefined
}
function update(index: number, patch: Record<string, unknown>) {
  write(list.value.map((row, i) => {
    if (i !== index) return row
    // A patched key left empty is dropped - never stored as undefined or ''.
    const merged = Object.fromEntries(Object.entries({ ...row, ...patch }).filter(([key, value]) => !(key in patch) || (value !== undefined && value !== '')))
    return merged as Reference
  }))
}
function add(type: 'line' | 'band') {
  write([...list.value, type === 'line' ? { type, value: 'average' } : { type, from: 0, to: 0 }])
}
function move(index: number, by: number) {
  const next = [...list.value]
  const [row] = next.splice(index, 1)
  next.splice(index + by, 0, row!)
  write(next)
}
function remove(index: number) {
  write(list.value.filter((_, i) => i !== index))
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <p
      v-if="list.length === 0"
      class="text-xs text-muted"
    >
      {{ t('dashboards.inspector.references.empty') }}
    </p>
    <div
      v-for="(row, index) in list"
      :key="index"
      class="flex flex-col gap-2 rounded-md border border-default p-2"
    >
      <div class="flex items-center gap-1">
        <UIcon
          :name="row.type === 'line' ? 'i-lucide-minus' : 'i-lucide-rectangle-horizontal'"
          class="size-4 shrink-0 text-muted"
        />
        <span class="min-w-0 flex-1 truncate text-xs text-muted">{{ t(`dashboards.inspector.references.${row.type}`) }}</span>
        <UButton
          icon="i-lucide-arrow-up"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === 0"
          :aria-label="t('dashboards.inspector.list.moveUp')"
          @click="move(index, -1)"
        />
        <UButton
          icon="i-lucide-arrow-down"
          color="neutral"
          variant="ghost"
          size="xs"
          :disabled="index === list.length - 1"
          :aria-label="t('dashboards.inspector.list.moveDown')"
          @click="move(index, 1)"
        />
        <UButton
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :aria-label="t('common.remove')"
          @click="remove(index)"
        />
      </div>

      <template v-if="row.type === 'line'">
        <DashboardValueSource
          :model-value="row.value"
          :label="t('common.value')"
          :columns="columns"
          :variables="variables"
          :statistics="REFERENCE_STATISTICS"
          @update:model-value="(v) => v !== undefined && update(index, { value: v })"
        />
        <UFormField
          v-if="axisChoice"
          :label="t('dashboards.inspector.references.axis')"
        >
          <USelect
            :model-value="row.axis ?? 'y'"
            :items="axisItems"
            class="w-full"
            @update:model-value="(v: string) => update(index, { axis: v === 'y' ? undefined : v })"
          />
        </UFormField>
        <UFormField
          v-if="series.length > 1"
          :label="t('dashboards.inspector.references.series')"
        >
          <USelect
            :model-value="row.series ?? ALL"
            :items="seriesItems"
            class="w-full"
            @update:model-value="(v: string) => update(index, { series: v === ALL ? undefined : v })"
          />
        </UFormField>
      </template>
      <template v-else>
        <DashboardValueSource
          :model-value="row.from"
          :label="t('dashboards.inspector.references.from')"
          :columns="columns"
          :variables="variables"
          @update:model-value="(v) => v !== undefined && update(index, { from: v })"
        />
        <DashboardValueSource
          :model-value="row.to"
          :label="t('dashboards.inspector.references.to')"
          :columns="columns"
          :variables="variables"
          @update:model-value="(v) => v !== undefined && update(index, { to: v })"
        />
      </template>

      <div class="flex items-end gap-2">
        <ColorPickerField
          :model-value="row.color"
          :label="t('common.color')"
          allow-none
          @update:model-value="(v?: RoleColor) => update(index, { color: v })"
        />
        <UFormField
          :label="t('common.label')"
          class="min-w-0 flex-1"
        >
          <UInput
            :model-value="row.label ?? ''"
            :maxlength="64"
            class="w-full"
            @update:model-value="(v: string | number) => update(index, { label: String(v) })"
          />
        </UFormField>
      </div>
    </div>
    <div class="flex gap-2">
      <UButton
        :label="t('dashboards.inspector.references.addLine')"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        size="xs"
        :disabled="list.length >= 10"
        @click="add('line')"
      />
      <UButton
        :label="t('dashboards.inspector.references.addBand')"
        icon="i-lucide-plus"
        color="neutral"
        variant="outline"
        size="xs"
        :disabled="list.length >= 10"
        @click="add('band')"
      />
    </div>
  </div>
</template>
