<script setup lang="ts">
/** Compact horizontal ranking bar - users by role, top resources, etc. */
const props = defineProps<{
  items: { name: string, value: number }[]
  color?: string
}>()

const { colors } = useChartTheme()

const option = computed(() => {
  // Longest row first at the top of the chart reads top-to-bottom as
  // "most to least" - ECharts draws category axes bottom-up by default.
  const sorted = [...props.items].sort((a, b) => a.value - b.value)
  return {
    color: [props.color ?? colors.value.primary],
    tooltip: { trigger: 'item' },
    grid: { left: 8, right: 24, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'value', show: false },
    yAxis: {
      type: 'category',
      data: sorted.map(i => i.name),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.value.text }
    },
    series: [{
      type: 'bar',
      data: sorted.map(i => i.value),
      barMaxWidth: 16,
      itemStyle: { borderRadius: [0, 4, 4, 0] },
      label: { show: true, position: 'right', color: colors.value.textMuted }
    }]
  }
})
</script>

<template>
  <ChartCanvas
    class="w-full"
    :style="{ height: `${Math.max(items.length, 1) * 34 + 16}px` }"
    :option="option"
    autoresize
  />
</template>
