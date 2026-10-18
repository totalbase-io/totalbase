<script setup lang="ts">
/** Small labeled donut - resource type mix, audit status mix, etc. */
const props = defineProps<{
  items: { name: string, value: number, color: string }[]
  /** How a value reads (the total, the tooltip) - e.g. bytes. Plain numbers by default. */
  format?: (value: number) => string
  /** Height in px - 160 by default; 256 beside an ActivityAreaChart, so the two line up. */
  height?: number
}>()

const { colors } = useChartTheme()

const total = computed(() => props.items.reduce((sum, i) => sum + i.value, 0))

const option = computed(() => ({
  color: props.items.map(i => i.color),
  tooltip: { trigger: 'item', ...(props.format ? { valueFormatter: (value: number) => props.format!(value) } : {}) },
  legend: {
    orient: 'vertical',
    right: 4,
    top: 'center',
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: colors.value.textMuted }
  },
  series: [{
    type: 'pie',
    radius: ['62%', '85%'],
    center: ['32%', '50%'],
    avoidLabelOverlap: false,
    label: { show: false },
    labelLine: { show: false },
    data: props.items.map(i => ({ name: i.name, value: i.value }))
  }]
}))
</script>

<template>
  <div
    class="relative w-full"
    :style="{ height: `${height ?? 160}px` }"
  >
    <ChartCanvas
      class="h-full w-full"
      :option="option"
      autoresize
    />
    <div class="pointer-events-none absolute inset-y-0 left-0 flex w-[64%] flex-col items-center justify-center">
      <p class="text-xl font-semibold">
        {{ format ? format(total) : total }}
      </p>
      <p class="text-xs text-muted">
        {{ $t('dashboards.charts.total') }}
      </p>
    </div>
  </div>
</template>
