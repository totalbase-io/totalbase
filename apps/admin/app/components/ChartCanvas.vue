<script setup lang="ts">
/**
 * The admin's one chart component - vue-echarts' `VChart`, with ECharts
 * loaded on the first mount (utils/echarts-loader.ts) instead of shipped
 * in every route's entry chunk. Attributes, classes and listeners (`@click`,
 * `@zr:click`) fall through to VChart; until it loads, an empty box of the
 * same classes holds the chart's place, so the layout doesn't jump.
 */
import type { Component } from 'vue'
import { loadEcharts } from '~/utils/echarts-loader'

defineOptions({ inheritAttrs: false })
withDefaults(defineProps<{
  option: Record<string, unknown>
  initOptions?: Record<string, unknown>
  autoresize?: boolean
}>(), { initOptions: undefined, autoresize: true })

/** What the dashboard widget reads of the ECharts instance (vue-echarts exposes its methods). */
interface ChartHandle {
  getDataURL: (options: { type: 'png', pixelRatio: number, backgroundColor: string }) => string
  containPixel: (finder: Record<string, number>, value: number[]) => boolean
  convertFromPixel: (finder: Record<string, number>, value: number[]) => number[] | number
}

const VChart = shallowRef<Component | null>(null)
const inner = ref<ChartHandle | null>(null)
onMounted(() => {
  void loadEcharts().then((component) => {
    VChart.value = component
  })
})

defineExpose<ChartHandle>({
  getDataURL: options => inner.value?.getDataURL(options) ?? '',
  containPixel: (finder, value) => inner.value?.containPixel(finder, value) ?? false,
  convertFromPixel: (finder, value) => inner.value?.convertFromPixel(finder, value) ?? []
})
</script>

<template>
  <component
    :is="VChart"
    v-if="VChart"
    ref="inner"
    v-bind="$attrs"
    :option="option"
    :init-options="initOptions"
    :autoresize="autoresize"
  />
  <div
    v-else
    v-bind="$attrs"
  />
</template>
