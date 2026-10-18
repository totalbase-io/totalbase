import { describe, expect, it } from 'vitest'
import { buildFinalSpec, carryTicks, defaultTicks, widgetChoices, widgetReasons, type DashboardSuggestion, type SuggestBase } from '~/utils/dashboard-from-table'

const kpi = { type: 'KPI', label: 'Readings', query: 'SELECT count(*) AS value FROM t', config: {} }
const line = { type: 'LINE', label: 'Readings per day', query: 'SELECT 1', config: {} }
const board = { type: 'LEADERBOARD', label: 'Readings by branch', query: 'SELECT 2', config: {} }
const table = { type: 'TABLE', label: 'Latest readings', query: 'SELECT 3', config: {} }
const calendar = { type: 'CALENDAR', label: 'Readings per day', query: 'SELECT 4', config: {} }

const base: SuggestBase = {
  spec: { name: 'Readings', variables: [], widgets: [kpi, line, board, table] },
  more: [calendar]
}
// "Only the viewer's": the leaderboard by branch goes, the rest filtered.
const only: SuggestBase = {
  spec: { name: 'Readings', variables: [], widgets: [{ ...kpi, query: 'filtered' }, line, table] },
  more: [calendar]
}

describe('dashboard-from-table', () => {
  it('ticks the spec\'s widgets and leaves more\'s unticked', () => {
    expect([...defaultTicks(base)]).toEqual(['widgets[0]', 'widgets[1]', 'widgets[2]', 'widgets[3]'])
    expect(widgetChoices(base).map(c => c.proposed)).toEqual([true, true, true, true, false])
  })

  it('builds the spec from the ticks, spec\'s then more\'s, without grid or id', () => {
    const ticks = new Set(['more[0]', 'widgets[0]', 'widgets[3]'])
    const withGrid: SuggestBase = { ...base, spec: { ...base.spec, widgets: base.spec.widgets.map(w => ({ ...w, grid: { x: 0, y: 0, w: 3, h: 2 }, id: 'x' })) } }
    const spec = buildFinalSpec(withGrid, ticks, '  My readings ')
    expect(spec.name).toBe('My readings')
    expect(spec.widgets.map(w => w.type)).toEqual(['KPI', 'TABLE', 'CALENDAR'])
    expect(spec.widgets.every(w => !('grid' in w) && !('id' in w))).toBe(true)
    expect(spec.variables).toEqual([])
  })

  it('carries the user\'s ticks to a security option by type and title', () => {
    // The user left the table out and ticked the calendar.
    const ticks = new Set(['widgets[0]', 'widgets[1]', 'widgets[2]', 'more[0]'])
    const carried = carryTicks(base, ticks, only)
    expect([...carried].sort()).toEqual(['more[0]', 'widgets[0]', 'widgets[1]'])
    // And back: the leaderboard returns as the user had it (ticked).
    expect([...carryTicks(only, carried, base)].sort()).toEqual(['more[0]', 'widgets[0]', 'widgets[1]', 'widgets[2]'])
  })

  it('keeps a widget only the new proposal has at its default', () => {
    const extra: SuggestBase = { spec: { ...only.spec, widgets: [...only.spec.widgets, { type: 'DONUT', label: 'New' }] }, more: only.more }
    expect(carryTicks(base, defaultTicks(base), extra).has('widgets[3]')).toBe(true)
  })

  it('finds a widget\'s reason by its type and title', () => {
    const suggestion = {
      ...base,
      reasons: [{ path: 'widgets[2]', reason: { code: 'leaderboard', message: 'Top 10' } }, { path: 'more[0]', reason: { code: 'calendar', message: 'Long period' } }]
    } as unknown as DashboardSuggestion
    const reasons = widgetReasons(suggestion)
    expect(reasons.get('LEADERBOARD\u0000Readings by branch')?.code).toBe('leaderboard')
    // Same title, another type: its own reason.
    expect(reasons.get('CALENDAR\u0000Readings per day')?.code).toBe('calendar')
    expect(reasons.get('LINE\u0000Readings per day')).toBeUndefined()
  })
})
