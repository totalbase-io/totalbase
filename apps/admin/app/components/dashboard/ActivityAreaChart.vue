<script setup lang="ts">
/**
 * Stacked daily chart - the activity trends on the dashboard and the
 * Insights pages. Areas by default; `bars` draws one stacked column per
 * day instead, `lines` plain lines with a point per day - both clickable
 * (`select-day`, with the series clicked): the dashboard opens that day in
 * Logs.
 */
const props = withDefaults(defineProps<{
  days: string[]
  series: { name: string, data: number[], color: string }[]
  /** Stack the series into a total (parts of a whole) - off to compare them side by side (e.g. successful vs failed). */
  stacked?: boolean
  /** One stacked column per day, clickable - emits `select-day`. */
  bars?: boolean
  /** Plain lines, no area, a clickable point per day - emits `select-day`. */
  lines?: boolean
}>(), {
  stacked: true,
  bars: false,
  lines: false
})
const emit = defineEmits<{ 'select-day': [day: string, seriesIndex: number] }>()

function onClick(params: { dataIndex?: number, seriesIndex?: number }) {
  const day = params.dataIndex === undefined ? undefined : props.days[params.dataIndex]
  if (day) emit('select-day', day, params.seriesIndex ?? 0)
}

const { colors } = useChartTheme()

const option = computed(() => ({
  color: props.series.map(s => s.color),
  tooltip: {
    trigger: 'axis',
    axisPointer: { type: props.bars ? 'shadow' : 'line' }
  },
  legend: {
    bottom: 0,
    icon: 'circle',
    itemWidth: 8,
    itemHeight: 8,
    textStyle: { color: colors.value.textMuted }
  },
  grid: { left: 8, right: 8, top: 16, bottom: 36, containLabel: true },
  xAxis: {
    type: 'category',
    boundaryGap: props.bars,
    data: props.days.map(d => d.slice(5)),
    axisLine: { lineStyle: { color: colors.value.border } },
    axisLabel: { color: colors.value.textMuted }
  },
  yAxis: {
    type: 'value',
    minInterval: 1,
    splitLine: { lineStyle: { color: colors.value.border, type: 'dashed' } },
    axisLabel: { color: colors.value.textMuted }
  },
  series: props.series.map(s => props.bars
    ? {
        name: s.name,
        type: 'bar',
        data: s.data,
        stack: props.stacked ? 'total' : undefined,
        barMaxWidth: 28,
        cursor: 'pointer'
      }
    : {
        name: s.name,
        type: 'line',
        data: s.data,
        stack: props.stacked ? 'total' : undefined,
        ...(props.lines
          ? { symbolSize: 6, cursor: 'pointer' }
          : { areaStyle: { opacity: 0.18 }, showSymbol: false }),
        lineStyle: { width: 2 },
        smooth: 0.2
      })
}))
</script>

<template>
  <div style="height: 256px; width: 100%;">
    <ChartCanvas
      class="h-full w-full"
      :option="option"
      autoresize
      @click="onClick"
    />
  </div>
</template>
