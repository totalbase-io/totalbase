<script setup lang="ts">
/**
 * A chart's axes (D4, `config.axes`): the category axis' title; the value axis' - and the right one's (`value2`), only
 * while a series uses it - title, minimum, maximum, logarithmic scale and format. Empty parts are dropped; an empty
 * model is `undefined`. A SCATTER's (`xy`, AXES_XY_SHAPE) are its two number axes instead, `x` and `y`, each with the same
 * settings as a value axis.
 */
type ValueAxis = { title?: string, min?: number, max?: number, log?: boolean, displayFormat?: string }
interface Axes { category?: { title?: string }, value?: ValueAxis, value2?: ValueAxis, x?: ValueAxis, y?: ValueAxis }

const props = defineProps<{
  /** Some series is on the right axis - its settings show. */
  showValue2: boolean
  /** What an unset minimum is: 0 (bars, areas) or fitted to the data (lines). */
  minUnset: 'zero' | 'fit'
  /** What each value axis reads in while it has no format of its own - its series'. */
  formatFallback?: string
  value2FormatFallback?: string
  /** A scatter's axes: x and y, both numbers (or x a date) - no category axis. Their fallbacks: `formatFallback` (x), `value2FormatFallback` (y). */
  xy?: boolean
}>()
const model = defineModel<Axes | undefined>()
const { t } = useI18n()

function set(axis: keyof Axes, key: string, value: unknown) {
  const empty = value === undefined || value === null || value === '' || value === false
  const kept = Object.entries((model.value?.[axis] ?? {}) as Record<string, unknown>).filter(([k]) => k !== key)
  const current = Object.fromEntries(empty ? kept : [...kept, [key, value]])
  const others = Object.entries(model.value ?? {}).filter(([k]) => k !== axis)
  const next = Object.fromEntries(Object.keys(current).length ? [...others, [axis, current]] : others)
  model.value = Object.keys(next).length ? next as Axes : undefined
}

const valueAxes = computed(() => props.xy
  ? [
      { id: 'x' as const, title: t('dashboards.inspector.axes.x'), fallback: props.formatFallback },
      { id: 'y' as const, title: t('dashboards.inspector.axes.y'), fallback: props.value2FormatFallback }
    ]
  : [
      { id: 'value' as const, title: t('dashboards.inspector.axes.value'), fallback: props.formatFallback },
      ...(props.showValue2 || model.value?.value2 ? [{ id: 'value2' as const, title: t('dashboards.inspector.axes.value2'), fallback: props.value2FormatFallback }] : [])
    ])
</script>

<template>
  <div class="flex flex-col gap-4">
    <div
      v-if="!xy"
      class="flex flex-col gap-2"
    >
      <p class="text-xs font-medium text-highlighted">
        {{ t('dashboards.inspector.axes.category') }}
      </p>
      <UFormField :label="t('dashboards.inspector.axes.title')">
        <UInput
          :model-value="model?.category?.title ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="(v: string | number) => set('category', 'title', String(v))"
        />
      </UFormField>
    </div>

    <div
      v-for="axis in valueAxes"
      :key="axis.id"
      class="flex flex-col gap-2"
    >
      <p class="text-xs font-medium text-highlighted">
        {{ axis.title }}
      </p>
      <UFormField :label="t('dashboards.inspector.axes.title')">
        <UInput
          :model-value="model?.[axis.id]?.title ?? ''"
          size="sm"
          class="w-full"
          @update:model-value="(v: string | number) => set(axis.id, 'title', String(v))"
        />
      </UFormField>
      <div class="flex gap-2">
        <UFormField
          :label="t('dashboards.inspector.axes.min')"
          class="min-w-0 flex-1"
        >
          <template #hint>
            <FieldHelp
              :text="t(`dashboards.inspector.axes.minUnset.${minUnset}`)"
              :label="t('dashboards.inspector.axes.min')"
            />
          </template>
          <UInputNumber
            :model-value="model?.[axis.id]?.min"
            size="sm"
            class="w-full"
            @update:model-value="(v?: number | null) => set(axis.id, 'min', v)"
          />
        </UFormField>
        <UFormField
          :label="t('dashboards.inspector.axes.max')"
          class="min-w-0 flex-1"
        >
          <template #hint>
            <FieldHelp
              :text="t('dashboards.inspector.axes.maxUnset')"
              :label="t('dashboards.inspector.axes.max')"
            />
          </template>
          <UInputNumber
            :model-value="model?.[axis.id]?.max"
            size="sm"
            class="w-full"
            @update:model-value="(v?: number | null) => set(axis.id, 'max', v)"
          />
        </UFormField>
      </div>
      <USwitch
        :model-value="model?.[axis.id]?.log === true"
        :label="t('dashboards.inspector.axes.log')"
        :description="t('dashboards.inspector.axes.logHelp')"
        size="sm"
        @update:model-value="(v: boolean) => set(axis.id, 'log', v)"
      />
      <DisplayFormatField
        :model-value="model?.[axis.id]?.displayFormat"
        kind="number"
        size="sm"
        :description="axis.fallback ? t('dashboards.inspector.unsetFormat', { format: axis.fallback }) : t('dashboards.inspector.axes.formatUnset')"
        @update:model-value="(v?: string) => set(axis.id, 'displayFormat', v)"
      />
    </div>
  </div>
</template>
