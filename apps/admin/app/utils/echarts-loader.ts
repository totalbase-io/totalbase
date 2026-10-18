import type { Component } from 'vue'

let loading: Promise<Component> | null = null

/**
 * ECharts and vue-echarts, loaded the first time a chart mounts - never with
 * the app's entry (every route, the login page included, carried the nine
 * chart types when a plugin registered them globally). Registers only the
 * renderer, chart types and components the dashboards and Users -> Insights
 * use (core echarts is modular - importing 'echarts' whole would pull in
 * every chart type, map projections, 3D, etc.), once, and resolves to the
 * `VChart` component `ChartCanvas.vue` renders. One promise shared by every chart.
 */
export function loadEcharts(): Promise<Component> {
  loading ??= Promise.all([
    import('vue-echarts'),
    import('echarts/core'),
    import('echarts/renderers'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/features')
  ]).then(([vueEcharts, core, renderers, charts, components, features]) => {
    core.use([
      renderers.CanvasRenderer,
      charts.LineChart,
      charts.BarChart,
      charts.PieChart,
      // GaugeChart: the Dashboards GAUGE widget (a KPI against a target).
      charts.GaugeChart,
      // HeatmapChart (+ VisualMapComponent): Users -> Insights -> Activity's day x hour grid, the HEATMAP and CALENDAR widgets.
      charts.HeatmapChart,
      // FunnelChart, ScatterChart, TreemapChart, SunburstChart (+ CalendarComponent): the tanda 3 widgets (D10-D18).
      charts.FunnelChart,
      charts.ScatterChart,
      charts.TreemapChart,
      charts.SunburstChart,
      components.GridComponent,
      components.TooltipComponent,
      components.LegendComponent,
      components.DatasetComponent,
      components.VisualMapComponent,
      // aria: a chart read out by assistive technology, and its decals (patterns telling series apart) - DB8.
      components.AriaComponent,
      // A chart's reference lines and bands (D5).
      components.MarkLineComponent,
      components.MarkAreaComponent,
      // A chart's zoom: the slider under it, and the wheel or a pinch (D8).
      components.DataZoomComponent,
      // The CALENDAR widget's year grids (D10).
      components.CalendarComponent,
      // echarts 6 split `grid.containLabel` out of GridComponent into an opt-in
      // feature - the bar charts here use containLabel (so their category-axis
      // labels don't get clipped), and without this it silently no-ops (console
      // warning only, no error) instead of reserving space for the labels.
      features.LegacyGridContainLabel
    ])
    return vueEcharts.default
  })
  return loading
}
