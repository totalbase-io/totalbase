// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import type { DashboardQueryResult } from '~/types/dashboard'
import { buildWidget, calendarNames, calendarYears, waterfallStack, waterfallSteps } from './dashboard-builders'
import { BROWSER_DATES, orderedCategories, resolvePaletteColor, SERIES_HUES } from './dashboard-widget-render'

const theme = { primary: '#3b82f6', secondary: '#8b5cf6', success: '#22c55e', warning: '#f59e0b', error: '#ef4444', text: '#374151', textMuted: '#6b7280', border: '#e5e7eb' }
const size = { width: 280, height: 260 }
type Option = { series: Record<string, unknown>[], color: string[], legend: Record<string, unknown>, grid?: Record<string, unknown>, tooltip: { formatter: (p: unknown) => string }, xAxis: unknown, yAxis: unknown, dataZoom?: Record<string, unknown>[] }
const option = (built: ReturnType<typeof buildWidget>) => (built.built as unknown as { option: Option }).option

// Specification_Dashboards.md §5 (D1): each builder draws from its roles - never a column's name.
describe('dashboard builders', () => {
  const ages: DashboardQueryResult = {
    columns: [{ name: 'rango', dataType: 'text' }, { name: 'personas', dataType: 'integer' }],
    rows: [['<18', 10], ['18-24', 20], ['25-34', 30], ['35-44', 25], ['45-54', 15], ['55-64', 8], ['65+', 5]].map(([rango, personas]) => ({ rango, personas })),
    truncated: false, durationMs: 0, cached: false
  }

  it('gives every slice its own color - all 17 hues before one repeats (DB5)', () => {
    const { color } = option(buildWidget({ type: 'DONUT', config: {} }, ages, { theme, size }))
    expect(new Set(color.slice(0, 7)).size).toBe(7)
    expect(color).toHaveLength(SERIES_HUES.length)
    expect(new Set(color).size).toBe(17)
  })

  it('reserves the legend\'s room below a narrow donut and sizes the ring by what\'s left (DB1)', () => {
    const card = option(buildWidget({ type: 'DONUT', config: { showLegend: true } }, ages, { theme, size }))
    const series = card.series[0] as { radius: number[], center: number[] }
    // The ring ends above the legend's lines - never under them.
    expect(card.legend.type).toBe('plain')
    expect(series.center[1]! + series.radius[1]!).toBeLessThanOrEqual(size.height - 30)
    // Too narrow for its lines: one scrolling line.
    expect(option(buildWidget({ type: 'DONUT', config: { showLegend: true } }, ages, { theme, size: { width: 180, height: 220 } })).legend.type).toBe('scroll')
    const wide = option(buildWidget({ type: 'DONUT', config: { showLegend: true } }, ages, { theme, size: { width: 900, height: 400 } }))
    expect(wide.legend.type).toBe('plain')
  })

  it('names a series by its column\'s presentation - an expression by its alias', () => {
    const result: DashboardQueryResult = {
      columns: [
        { name: 'mes', dataType: 'date' },
        { name: 'facturado', dataType: 'numeric', origin: { schema: 'public', table: 'facturas', column: 'total', resourceId: 'r1' }, presentation: { label: 'Total facturado' } },
        { name: 'cobrado', dataType: 'numeric' }
      ],
      rows: [{ mes: '2026-01-01', facturado: 100, cobrado: 80 }],
      truncated: false, durationMs: 0, cached: false
    }
    const { series } = option(buildWidget({ type: 'BAR', config: {} }, result, { theme, size }))
    expect(series.map(s => s.name)).toEqual(['Total facturado', 'cobrado'])
  })

  it('pivots long format by its Series column - one series per value', () => {
    const result: DashboardQueryResult = {
      columns: [{ name: 'mes', dataType: 'date' }, { name: 'vendedor', dataType: 'text' }, { name: 'total', dataType: 'numeric' }],
      rows: [{ mes: '2026-01-01', vendedor: 'Ana', total: 5 }, { mes: '2026-01-01', vendedor: 'Luis', total: 3 }, { mes: '2026-02-01', vendedor: 'Ana', total: 7 }],
      truncated: false, durationMs: 0, cached: false
    }
    const { series } = option(buildWidget({ type: 'LINE', config: { roles: { series: 'vendedor' } } }, result, { theme, size }))
    expect(series.map(s => [s.name, s.data])).toEqual([['Ana', [5, 7]], ['Luis', [3, null]]])
  })

  it('maps a point column by default and never guesses latitude and longitude by name (DB4)', () => {
    const named: DashboardQueryResult = { columns: [{ name: 'tienda', dataType: 'text' }, { name: 'lat', dataType: 'double precision' }, { name: 'lng', dataType: 'double precision' }], rows: [{ tienda: 'A', lat: -34.6, lng: -58.4 }], truncated: false, durationMs: 0, cached: false }
    expect(buildWidget({ type: 'MAP', config: {} }, named, { theme, size }).errors[0]).toMatch(/^Map needs a point column/)
    const chosen = buildWidget({ type: 'MAP', config: { roles: { latitude: 'lat', longitude: 'lng' } } }, named, { theme, size })
    expect(chosen.built).toMatchObject({ renderer: 'map', points: [{ lat: -34.6, lng: -58.4, label: 'A' }] })
    const point: DashboardQueryResult = { columns: [{ name: 'tienda', dataType: 'text' }, { name: 'donde', dataType: 'point' }], rows: [{ tienda: 'B', donde: { lng: -64.18, lat: -31.42 } }], truncated: false, durationMs: 0, cached: false }
    expect(buildWidget({ type: 'MAP', config: {} }, point, { theme, size }).built).toMatchObject({ points: [{ lat: -31.42, lng: -64.18 }] })
  })

  it('sizes a gauge\'s text by its arc\'s inner radius - readable, never wider than the hole (DB2)', () => {
    const result: DashboardQueryResult = { columns: [{ name: 'cobrado', dataType: 'numeric' }], rows: [{ cobrado: 82.7 }], truncated: false, durationMs: 0, cached: false }
    for (const card of [{ width: 262, height: 150 }, { width: 160, height: 120 }, { width: 600, height: 400 }]) {
      const gauge = option(buildWidget({ type: 'GAUGE', config: { target: 100 } }, result, { theme, size: card })).series[0] as { radius: number, detail: { fontSize: number }, title: { fontSize: number } }
      const inner = gauge.radius - 16
      expect(gauge.title.fontSize).toBeGreaterThanOrEqual(11)
      expect(gauge.detail.fontSize).toBeLessThanOrEqual(Math.max(14, inner * 0.5))
      expect(gauge.radius * 1.71 + 8).toBeLessThanOrEqual(card.height + 1)
    }
  })

  it('reports a role the query can\'t fill instead of drawing a wrong chart', () => {
    const texts: DashboardQueryResult = { columns: [{ name: 'mes', dataType: 'text' }, { name: 'total', dataType: 'text' }], rows: [{ mes: 'a', total: '1' }], truncated: false, durationMs: 0, cached: false }
    expect(buildWidget({ type: 'BAR', config: {} }, texts, { theme, size })).toEqual({ built: null, errors: ['Bar chart needs at least one column of a number for Values - the query returns mes (text), total (text).'] })
  })
})

// D4, D5, D6, D8: series, axes, thresholds, references, click and zoom.
describe('dashboard builders - tanda 2b', () => {
  const es = { ...BROWSER_DATES, locale: 'es' }
  const money: DashboardQueryResult = {
    columns: [{ name: 'sucursal', dataType: 'text' }, { name: 'facturado', dataType: 'numeric' }, { name: 'cobrado_pct', dataType: 'numeric' }],
    rows: [{ sucursal: 'Centro', facturado: 1250001, cobrado_pct: 85.5 }, { sucursal: 'Norte', facturado: 900000, cobrado_pct: 70 }],
    truncated: false, durationMs: 0, cached: false
  }
  const mixed = {
    series: { facturado: { displayFormat: '$ #,##0' }, cobrado_pct: { displayFormat: '0.0 %', type: 'line', axis: 'right', label: 'Cobrado' } },
    axes: { value: { title: 'Pesos' }, value2: { min: 0, max: 100 } }
  }

  it('formats each series in its own format in the tooltip, on its own axis (D4)', () => {
    const chart = option(buildWidget({ type: 'BAR', config: mixed }, money, { theme, size, dates: es }))
    const tip = chart.tooltip.formatter([
      { seriesIndex: 0, marker: '', seriesName: 'facturado', value: 1250001, axisValueLabel: 'Centro' },
      { seriesIndex: 1, marker: '', seriesName: 'Cobrado', value: 85.5, axisValueLabel: 'Centro' }
    ])
    expect(tip).toContain('$ 1.250.001')
    expect(tip).toContain('85,5 %')
    const axes = chart.yAxis as { position?: string, name?: string, min?: number, max?: number, axisLabel: { formatter: (v: number) => string } }[]
    expect(axes).toHaveLength(2)
    expect(axes[0]!.name).toBe('Pesos')
    expect(axes[1]).toMatchObject({ position: 'right', min: 0, max: 100 })
    // Each axis in its series' format, compact.
    expect(axes[0]!.axisLabel.formatter(1250000).replace(/\s/g, ' ')).toBe('$ 1,3 M')
    expect(axes[1]!.axisLabel.formatter(80)).toBe('80 %')
    expect(chart.series.map(s => [s.name, s.type, s.yAxisIndex])).toEqual([['facturado', 'bar', undefined], ['Cobrado', 'line', 1]])
  })

  it('starts bars at 0 and fits a line to its data; titles, bounds and log from axes (D4)', () => {
    const line = option(buildWidget({ type: 'LINE', config: {} }, money, { theme, size }))
    expect((line.yAxis as Record<string, unknown>).scale).toBe(true)
    const bar = option(buildWidget({ type: 'BAR', config: {} }, money, { theme, size }))
    expect((bar.yAxis as Record<string, unknown>).scale).toBeUndefined()
    const log = option(buildWidget({ type: 'LINE', config: { axes: { value: { log: true, min: 10 }, category: { title: 'Sucursal' } } } }, money, { theme, size }))
    expect(log.yAxis).toMatchObject({ type: 'log', min: 10 })
    expect(log.xAxis).toMatchObject({ name: 'Sucursal' })
  })

  it('names and colors a long format\'s series by its Series column\'s presentation - series.<value> over it (D4)', () => {
    const result: DashboardQueryResult = {
      columns: [{ name: 'mes', dataType: 'text' }, { name: 'estado', dataType: 'text', presentation: { options: { A: { label: 'Abierto', color: 'success' }, C: { label: 'Cerrado', color: 'error' } } } }, { name: 'n', dataType: 'integer' }],
      rows: [{ mes: 'ene', estado: 'A', n: 1 }, { mes: 'ene', estado: 'C', n: 2 }, { mes: 'feb', estado: 'C', n: 3 }],
      truncated: false, durationMs: 0, cached: false
    }
    const chart = option(buildWidget({ type: 'BAR', config: { roles: { series: 'estado' }, series: { C: { color: 'violet' } } } }, result, { theme, size }))
    expect(chart.series.map(s => s.name)).toEqual(['Abierto', 'Cerrado'])
    expect(chart.series.map(s => (s.itemStyle as { color: string }).color)).toEqual([resolvePaletteColor('emerald'), resolvePaletteColor('violet')])
    // A click on February's "Cerrado" bar is that row; away from a mark, the nearest series at that category (D6).
    const built = buildWidget({ type: 'BAR', config: { roles: { series: 'estado' } } }, result, { theme, size }).built as { pick: { rowAt: (s: number | null, d: number, v?: number) => unknown } }
    expect(built.pick.rowAt(1, 1)).toEqual(result.rows[2])
    expect(built.pick.rowAt(0, 1)).toBeUndefined()
    expect(built.pick.rowAt(null, 0, 1.8)).toEqual(result.rows[1])
  })

  it('colors a KPI by the threshold its value falls in, over its Color (D5)', () => {
    const thresholds = [{ color: 'red' }, { from: 60, color: 'amber' }, { from: 80, color: 'green' }]
    const kpi = (value: number, marks?: DashboardQueryResult['marks']) => buildWidget(
      { type: 'KPI', config: { color: 'blue', thresholds } },
      { columns: [{ name: 'pct', dataType: 'numeric' }], rows: [{ pct: value }], truncated: false, durationMs: 0, cached: false, marks },
      { theme, size }
    ).built as { color?: string }
    expect(new Set(['red', 'amber', 'green', 'blue'].map(resolvePaletteColor)).size).toBe(4)
    expect(kpi(55).color).toBe(resolvePaletteColor('red'))
    expect(kpi(70).color).toBe(resolvePaletteColor('amber'))
    expect(kpi(85).color).toBe(resolvePaletteColor('green'))
    // A variable's value, resolved on the server.
    expect(kpi(85, { thresholds: [null, 60, 90] }).color).toBe(resolvePaletteColor('amber'))
  })

  it('draws a gauge\'s arc in its thresholds\' bands (D5)', () => {
    const result: DashboardQueryResult = { columns: [{ name: 'pct', dataType: 'numeric' }], rows: [{ pct: 70 }], truncated: false, durationMs: 0, cached: false, marks: { thresholds: [null, 60, 80] } }
    const gauge = option(buildWidget({ type: 'GAUGE', config: { target: 100, thresholds: [{ color: 'red' }, { from: 60, color: 'amber' }, { from: 80, color: 'green' }] } }, result, { theme, size })).series[0] as { axisLine: { lineStyle: { color: [number, string][] } } }
    expect(gauge.axisLine.lineStyle.color.map(([end]) => end)).toEqual([0.6, 0.8, 1])
  })

  it('draws reference lines and bands, labeled in their axis\' format (D5), and zooms (D8)', () => {
    const config = {
      displayFormat: '$ #,##0',
      zoom: true,
      references: [{ type: 'line', value: 'average', label: 'Promedio' }, { type: 'line', value: { variable: 'meta' } }, { type: 'band', from: 800000, to: 1000000, label: 'Meta' }]
    }
    const chart = option(buildWidget({ type: 'LINE', config }, { ...money, marks: { references: [{ value: 'average' }, { value: 1000000 }, { from: 800000, to: 1000000 }] } }, { theme, size, dates: es }))
    const first = chart.series[0] as { markLine: { data: { type?: string, yAxis?: number, label: { formatter: (p: { value: number }) => string } }[] }, markArea: { data: unknown[][] } }
    expect(first.markLine.data.map(d => d.type ?? d.yAxis)).toEqual(['average', 1000000])
    expect(first.markLine.data[0]!.label.formatter({ value: 1075000.5 }).replace(/\s/g, ' ')).toBe('Promedio: $ 1,1 M')
    expect(first.markArea.data[0]).toMatchObject([{ yAxis: 800000, name: 'Meta' }, { yAxis: 1000000 }])
    expect(chart.dataZoom?.map(z => z.type)).toEqual(['slider', 'inside'])
  })

  it('ends a clickable chart\'s tooltip with what a click does (D6)', () => {
    const chart = option(buildWidget({ type: 'BAR', config: {} }, money, { theme, size, click: { hint: 'Click to <filter>' } }))
    expect(chart.tooltip.formatter([{ seriesIndex: 0, marker: '', seriesName: 'facturado', value: 1, axisValueLabel: 'Centro' }])).toContain('Click to &lt;filter&gt;')
    expect(chart.series[0]!.cursor).toBe('pointer')
  })

  it('reads a pie\'s slices from its Category role (DM6)', () => {
    const result: DashboardQueryResult = { columns: [{ name: 'canal', dataType: 'text' }, { name: 'n', dataType: 'integer' }, { name: 'otro', dataType: 'text' }], rows: [{ canal: 'Web', n: 3, otro: 'x' }], truncated: false, durationMs: 0, cached: false }
    const pie = option(buildWidget({ type: 'PIE', config: { roles: { category: 'otro' } } }, result, { theme, size }))
    expect((pie.series[0]!.data as { name: string }[])[0]!.name).toBe('x')
  })
})

// Tanda 3 (Specification_Dashboards.md §5.15): the new widgets' pure pieces.
describe('tanda 3 builders', () => {
  const result = (columns: { name: string, dataType: string }[], rows: Record<string, unknown>[]): DashboardQueryResult => ({ columns, rows, truncated: false, durationMs: 0, cached: false })

  it('keeps a heatmap\'s categories in the query\'s order, time sorted, a CHECK list in its order (D10)', () => {
    expect(orderedCategories([3, 1, 3, 2, 1], { kind: 'number' })).toEqual([3, 1, 2])
    expect(orderedCategories(['2026-03-01', '2026-01-01', '2026-03-01'], { kind: 'time' })).toEqual(['2026-01-01', '2026-03-01'])
    expect(orderedCategories(['LOW', 'HIGH', 'MID'], { kind: 'text', options: ['HIGH', 'MID', 'LOW'] })).toEqual(['HIGH', 'MID', 'LOW'])
    expect(orderedCategories(['b', 'a'], { kind: 'text' })).toEqual(['b', 'a'])
  })

  it('leaves a heatmap\'s missing cell empty - never 0 - with its first Y on top', () => {
    const data = result([{ name: 'day', dataType: 'integer' }, { name: 'hour', dataType: 'integer' }, { name: 'n', dataType: 'integer' }], [
      { day: 1, hour: 0, n: 5 }, { day: 1, hour: 1, n: 7 }, { day: 2, hour: 0, n: null }
    ])
    const chart = option(buildWidget({ type: 'HEATMAP', config: { roles: { x: 'hour', y: 'day' } } }, data, { theme, size })) as unknown as { series: { data: number[][] }[], yAxis: { inverse: boolean, data: string[] }, visualMap: { type: string } }
    expect(chart.series[0]!.data).toEqual([[0, 0, 5], [1, 0, 7]])
    expect(chart.yAxis).toMatchObject({ inverse: true, data: ['1', '2'] })
    expect(chart.visualMap.type).toBe('continuous')
    const banded = option(buildWidget({ type: 'HEATMAP', config: { roles: { x: 'hour', y: 'day' }, thresholds: [{ color: 'green' }, { from: 100, color: 'amber' }, { from: 200, color: 'red' }] } }, data, { theme, size })) as unknown as { visualMap: { type: string, pieces: Record<string, unknown>[] } }
    expect(banded.visualMap.type).toBe('piecewise')
    expect(banded.visualMap.pieces.map(({ lt, gte }) => [gte ?? null, lt ?? null])).toEqual([[null, 100], [100, 200], [200, null]])
  })

  it('keeps a calendar\'s latest three years, latest first, and says how many there are', () => {
    expect(calendarYears(['2024-05-01', '2026-01-02', '2025-03-03', '2023-01-01', '2026-02-02'])).toEqual({ years: [2026, 2025, 2024], count: 4 })
    expect(calendarYears(['2026-01-02'])).toEqual({ years: [2026], count: 1 })
  })

  it('names a calendar\'s days and months in the UI\'s language, its week from Monday in Spanish', () => {
    const es = calendarNames('es')
    expect(es.days).toHaveLength(7)
    expect(es.months[0]!.toLowerCase()).toContain('ene')
    expect(es.firstDay).toBe(1)
    expect(calendarNames('en-US').firstDay).toBe(0)
  })

  it('takes the names from the UI\'s language and the week\'s first day from the regional settings', () => {
    // An English UI in an Argentinian browser: January's name in English, the week from Monday.
    const names = calendarNames('en', 'es-AR')
    expect(names.months[0]).toBe('Jan')
    expect(names.firstDay).toBe(1)
  })

  it('builds a waterfall\'s running sum - a total from 0, the final total, a bar crossing zero in two parts (D15)', () => {
    const steps = waterfallSteps([{ value: 100, total: false }, { value: -150, total: false }, { value: 30, total: false }], true)
    expect(steps.map(s => [s.kind, s.low, s.high, s.cumulative])).toEqual([
      ['increase', 0, 100, 100],
      ['decrease', -50, 100, -50],
      ['increase', -50, -20, -20],
      ['total', -20, 0, -20]
    ])
    expect(steps.map(waterfallStack)).toEqual([
      { base: 0, positive: 100, negative: null },
      { base: null, positive: 100, negative: -50 },
      { base: -20, positive: null, negative: -30 },
      { base: 0, positive: null, negative: -20 }
    ])
    const totals = waterfallSteps([{ value: 1000, total: false }, { value: -150, total: false }, { value: null, total: true }, { value: -600, total: false }], false)
    expect(totals.map(s => [s.kind, s.low, s.high])).toEqual([['increase', 0, 1000], ['decrease', 850, 1000], ['total', 0, 850], ['decrease', 250, 850]])
  })

  it('draws a combo\'s first value as bars on the left and the rest as lines on the right (D11)', () => {
    const data = result([{ name: 'month', dataType: 'text' }, { name: 'visits', dataType: 'integer' }, { name: 'ticket', dataType: 'numeric' }], [{ month: 'Jan', visits: 120, ticket: 3500 }])
    const chart = option(buildWidget({ type: 'COMBO', config: {} }, data, { theme, size }))
    expect(chart.series.map(s => [s.type, s.yAxisIndex ?? 0])).toEqual([['bar', 0], ['line', 1]])
    expect(buildWidget({ type: 'COMBO', config: { roles: { values: ['visits'] } } }, data, { theme, size }).errors[0]).toContain('two columns')
  })

  it('keeps a funnel in the query\'s order with each step\'s share of the first (D13)', () => {
    const data = result([{ name: 'step', dataType: 'text' }, { name: 'n', dataType: 'integer' }], [{ step: 'Visits', n: 200 }, { step: 'Orders', n: 50 }, { step: 'Paid', n: 100 }])
    const chart = option(buildWidget({ type: 'FUNNEL', config: {} }, data, { theme, size }))
    const series = chart.series[0] as { sort: string, data: { name: string }[], label: { formatter: (p: { dataIndex: number, name: string }) => string } }
    expect(series.sort).toBe('none')
    expect(series.data.map(d => d.name)).toEqual(['Visits', 'Orders', 'Paid'])
    expect(series.label.formatter({ dataIndex: 1, name: 'Orders' })).toBe('Orders · 25%')
    const desc = option(buildWidget({ type: 'FUNNEL', config: { sort: 'DESC', conversion: 'PREVIOUS' } }, data, { theme, size })).series[0] as typeof series
    expect(desc.data.map(d => d.name)).toEqual(['Visits', 'Paid', 'Orders'])
    expect(desc.label.formatter({ dataIndex: 2, name: 'Orders' })).toBe('Orders · 50%')
  })

  it('sizes a bubble by its value\'s square root, 6 to 40 px, a series per group (D16)', () => {
    const data = result([{ name: 'who', dataType: 'text' }, { name: 'x', dataType: 'integer' }, { name: 'y', dataType: 'integer' }, { name: 's', dataType: 'integer' }, { name: 'level', dataType: 'text' }], [
      { who: 'a', x: 1, y: 2, s: 100, level: 'GOLD' }, { who: 'b', x: 2, y: 3, s: 25, level: 'BLACK' }, { who: 'c', x: 3, y: 1, s: 0, level: 'GOLD' }
    ])
    const chart = option(buildWidget({ type: 'SCATTER', config: { roles: { size: 's', group: 'level' } } }, data, { theme, size }))
    expect(chart.series.map(s => s.name)).toEqual(['GOLD', 'BLACK'])
    const symbol = chart.series[0]!.symbolSize as (p: number[]) => number
    expect([symbol([0, 0, 100]), symbol([0, 0, 25]), symbol([0, 0, 0])]).toEqual([40, 20, 6])
  })

  it('shows a progress past its target full, its percent real (D12)', () => {
    const data = result([{ name: 'billed', dataType: 'integer' }, { name: 'goal', dataType: 'integer' }], [{ billed: 115, goal: 100 }])
    const built = buildWidget({ type: 'PROGRESS', config: {} }, data, { theme, size }).built as { bar: number, percent: string }
    expect(built.bar).toBe(100)
    expect(built.percent).toBe('115%')
  })
})
