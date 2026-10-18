<script setup lang="ts">
/**
 * A day-of-week × hour-of-day grid - the darker the cell, the busier that
 * hour on that day. `values[day][hour]`, days in `days` order (Monday
 * first), hours 0-23.
 */
const props = defineProps<{
  values: number[][]
  days: string[]
  name: string
}>()

const { colors } = useChartTheme()
const { t } = useI18n()

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'))

const option = computed(() => {
  // ECharts draws the y axis bottom-up: reverse so Monday is on top.
  const rows = props.days.length
  const data = props.values.flatMap((hours, day) => hours.map((value, hour) => [hour, rows - 1 - day, value]))
  const max = Math.max(1, ...props.values.flat())
  return {
    tooltip: {
      position: 'top',
      formatter: (p: { value: [number, number, number] }) =>
        `${props.days[rows - 1 - p.value[1]]} ${HOURS[p.value[0]]}:00 - <b>${p.value[2]}</b> ${props.name.toLowerCase()}`
    },
    grid: { left: 8, right: 8, top: 8, bottom: 40, containLabel: true },
    xAxis: {
      type: 'category',
      data: HOURS,
      splitArea: { show: false },
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.value.textMuted }
    },
    yAxis: {
      type: 'category',
      data: [...props.days].reverse(),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: colors.value.textMuted }
    },
    visualMap: {
      min: 0,
      max,
      calculable: false,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      itemHeight: 120,
      itemWidth: 10,
      text: [t('dashboards.charts.more'), t('dashboards.charts.less')],
      textStyle: { color: colors.value.textMuted },
      inRange: { color: [colors.value.border, colors.value.primary] }
    },
    series: [{
      name: props.name,
      type: 'heatmap',
      data,
      itemStyle: { borderColor: 'transparent', borderWidth: 2, borderRadius: 3 },
      emphasis: { itemStyle: { borderColor: colors.value.text, borderWidth: 1 } }
    }]
  }
})
</script>

<template>
  <div style="height: 300px; width: 100%;">
    <ChartCanvas
      class="h-full w-full"
      :option="option"
      autoresize
    />
  </div>
</template>
