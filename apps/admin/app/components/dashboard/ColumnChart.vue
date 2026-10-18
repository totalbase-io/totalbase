<script setup lang="ts">
/**
 * Vertical bars over a fixed set of categories (days of the week, hours
 * of the day) - the busiest one highlighted, so "when" reads at a glance.
 */
const props = defineProps<{
  labels: string[]
  values: number[]
  /** Name of the measure, for the tooltip - e.g. "Sign-ins". */
  name: string
  color?: string
}>()

const { colors } = useChartTheme()

const option = computed(() => {
  const max = Math.max(...props.values, 0)
  const base = props.color ?? colors.value.primary
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 8, right: 8, top: 16, bottom: 8, containLabel: true },
    xAxis: {
      type: 'category',
      data: props.labels,
      axisLine: { lineStyle: { color: colors.value.border } },
      axisTick: { show: false },
      axisLabel: { color: colors.value.textMuted }
    },
    yAxis: {
      type: 'value',
      minInterval: 1,
      splitLine: { lineStyle: { color: colors.value.border, type: 'dashed' } },
      axisLabel: { color: colors.value.textMuted }
    },
    series: [{
      name: props.name,
      type: 'bar',
      barMaxWidth: 28,
      data: props.values.map(value => ({
        value,
        itemStyle: { color: base, opacity: max > 0 && value === max ? 1 : 0.45, borderRadius: [4, 4, 0, 0] }
      }))
    }]
  }
})
</script>

<template>
  <div style="height: 220px; width: 100%;">
    <ChartCanvas
      class="h-full w-full"
      :option="option"
      autoresize
    />
  </div>
</template>
