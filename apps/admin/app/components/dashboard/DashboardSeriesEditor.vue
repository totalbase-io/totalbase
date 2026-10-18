<script setup lang="ts">
/**
 * A chart's series (D4, `config.series`): one row per value column - or, in long format, per value of the Series
 * column - opened in place, as a table's column settings: its name, color, type (bar, line, area), axis (left, right)
 * and format. What is unset is inherited and shown as such (the column's title and format, the Series column's value
 * labels and colors, the chart's own type). A series left with no settings is dropped; an empty model is `undefined`.
 * A COMBO's series have their own automatic type and axis (`defaults`: the first bars on the left, the rest lines on
 * the right); a SCATTER's - one per Group value - only a name and a color (`colorOnly`).
 */
import { SERIES_TYPES } from '@totalbase/tb-catalog'
import type { RoleColor } from '~/types/permission'

interface SeriesSettings {
  label?: string
  color?: RoleColor
  type?: (typeof SERIES_TYPES)[number]
  axis?: 'left' | 'right'
  displayFormat?: string
}

const props = defineProps<{
  /** The series, in order, with what each inherits. */
  series: { name: string, label: string, color?: string, format?: string }[]
  /** The chart's own mark - a series' type while unset. */
  defaultType: (typeof SERIES_TYPES)[number]
  /** Long format without its rows at hand: a series value may be typed. */
  addable?: boolean
  /** The widget's format - a series' while it and its column have none. */
  formatFallback?: string
  /** A series' own automatic type and axis, by name - over `defaultType` and the left axis. */
  defaults?: Record<string, { type?: (typeof SERIES_TYPES)[number], axis?: 'left' | 'right' }>
  /** Only a name and a color per series (a scatter's groups) - no type, axis or format. */
  colorOnly?: boolean
}>()
const model = defineModel<Record<string, SeriesSettings> | undefined>()
const { t } = useI18n()

const expanded = ref<string | null>(null)
const adding = ref('')

const rows = computed(() => {
  const known = props.series.map(s => s.name)
  // A value set before that isn't among the rows read (long format): still listed, so it can be changed or removed.
  const extra = Object.keys(model.value ?? {}).filter(name => !known.includes(name)).map(name => ({ name, label: name } as (typeof props.series)[number]))
  return [...props.series, ...extra]
})

function settings(name: string): SeriesSettings {
  return model.value?.[name] ?? {}
}
function set(name: string, key: keyof SeriesSettings, value: unknown) {
  const empty = value === undefined || value === null || value === ''
  const { [key]: _old, ...rest } = settings(name)
  const column = (empty ? rest : { ...rest, [key]: value }) as SeriesSettings
  const next = Object.fromEntries(Object.entries({ ...(model.value ?? {}), [name]: column }).filter(([, s]) => Object.keys(s).length > 0))
  model.value = Object.keys(next).length ? next : undefined
}
function reset(name: string) {
  const { [name]: _old, ...rest } = model.value ?? {}
  model.value = Object.keys(rest).length ? rest : undefined
}
function add() {
  const name = adding.value.trim()
  if (!name) return
  adding.value = ''
  expanded.value = name
  if (!rows.value.some(r => r.name === name)) set(name, 'label', name)
}

const autoType = (name: string) => props.defaults?.[name]?.type ?? props.defaultType
const autoAxis = (name: string) => props.defaults?.[name]?.axis ?? 'left'
const typeItems = (name: string) => [
  { value: 'auto', label: t('dashboards.inspector.series.automaticType', { type: t(`dashboards.inspector.series.types.${autoType(name)}`) }) },
  ...SERIES_TYPES.map(value => ({ value, label: t(`dashboards.inspector.series.types.${value}`) }))
]
const axisItems = computed(() => (['left', 'right'] as const).map(value => ({ value, label: t(`dashboards.inspector.series.axes.${value}`) })))

function summary(name: string): string {
  const own = settings(name)
  return [
    own.label ? `"${own.label}"` : '',
    own.type ? t(`dashboards.inspector.series.types.${own.type}`) : '',
    own.axis ? t(`dashboards.inspector.series.axes.${own.axis}`) : '',
    own.displayFormat ?? ''
  ].filter(Boolean).join(' · ')
}
</script>

<template>
  <div class="flex flex-col gap-2">
    <div class="flex flex-col divide-y divide-default rounded-md border border-default">
      <p
        v-if="rows.length === 0"
        class="px-3 py-2 text-xs text-muted"
      >
        {{ addable ? t('dashboards.inspector.series.emptyLong') : t('dashboards.inspector.series.empty') }}
      </p>

      <div
        v-for="row in rows"
        :key="row.name"
      >
        <button
          type="button"
          class="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-elevated"
          :aria-expanded="expanded === row.name"
          @click="expanded = expanded === row.name ? null : row.name"
        >
          <UIcon
            :name="expanded === row.name ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
            class="size-3.5 shrink-0 text-muted"
          />
          <ColorDot
            v-if="settings(row.name).color ?? row.color"
            :color="(settings(row.name).color ?? row.color)!"
            size="sm"
          />
          <span class="min-w-0 flex-1 truncate text-sm text-highlighted">{{ row.name }}</span>
          <span class="max-w-32 truncate text-xs text-dimmed">{{ summary(row.name) }}</span>
        </button>

        <div
          v-if="expanded === row.name"
          class="flex flex-col gap-3 px-3 pb-3"
        >
          <UFormField
            :label="t('common.name')"
            :description="t('dashboards.inspector.series.defaultLabel', { label: row.label })"
          >
            <UInput
              :model-value="settings(row.name).label ?? ''"
              size="sm"
              class="w-full"
              @update:model-value="(v: string | number) => set(row.name, 'label', String(v).trim() ? String(v) : undefined)"
            />
          </UFormField>
          <div class="flex items-end gap-2">
            <ColorPickerField
              :model-value="settings(row.name).color"
              :label="t('common.color')"
              allow-none
              @update:model-value="(v?: RoleColor) => set(row.name, 'color', v)"
            />
            <template v-if="!colorOnly">
              <UFormField
                :label="t('common.type')"
                class="min-w-0 flex-1"
              >
                <USelect
                  :model-value="settings(row.name).type ?? 'auto'"
                  :items="typeItems(row.name)"
                  class="w-full"
                  @update:model-value="(v: string) => set(row.name, 'type', v === 'auto' ? undefined : v)"
                />
              </UFormField>
              <UFormField
                :label="t('dashboards.inspector.series.axis')"
                class="min-w-0 flex-1"
              >
                <USelect
                  :model-value="settings(row.name).axis ?? autoAxis(row.name)"
                  :items="axisItems"
                  class="w-full"
                  @update:model-value="(v: string) => set(row.name, 'axis', v === autoAxis(row.name) ? undefined : v)"
                />
              </UFormField>
            </template>
          </div>
          <DisplayFormatField
            v-if="!colorOnly"
            :model-value="settings(row.name).displayFormat"
            kind="number"
            size="sm"
            :description="(row.format ?? formatFallback) ? t('dashboards.inspector.unsetFormat', { format: row.format ?? formatFallback }) : t('dashboards.inspector.unsetLocaleFormat')"
            @update:model-value="(v?: string) => set(row.name, 'displayFormat', v)"
          />
          <div
            v-if="model?.[row.name]"
            class="flex justify-end"
          >
            <UButton
              :label="t('dashboards.inspector.useDefault')"
              icon="i-lucide-rotate-ccw"
              color="neutral"
              variant="ghost"
              size="xs"
              @click="reset(row.name)"
            />
          </div>
        </div>
      </div>
    </div>

    <UFormField
      v-if="addable"
      :label="t('dashboards.inspector.series.addValue')"
      :description="t('dashboards.inspector.series.addValueHelp')"
    >
      <div class="flex gap-1">
        <UInput
          v-model="adding"
          class="min-w-0 flex-1"
          @keydown.enter.prevent="add"
        />
        <UButton
          icon="i-lucide-plus"
          color="neutral"
          variant="outline"
          :aria-label="t('dashboards.inspector.series.addValue')"
          :disabled="!adding.trim()"
          @click="add"
        />
      </div>
    </UFormField>
  </div>
</template>
