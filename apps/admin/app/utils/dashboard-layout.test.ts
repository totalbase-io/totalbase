import { describe, expect, it } from 'vitest'
import type { GridStackNode } from 'gridstack'
import { dashboardFlowLayout } from './dashboard-layout'

const SAVED: Record<string, { x: number, y: number, w: number, h: number }> = {
  kpi1: { x: 0, y: 0, w: 3, h: 2 },
  kpi2: { x: 3, y: 0, w: 3, h: 2 },
  kpi3: { x: 6, y: 0, w: 3, h: 2 },
  line: { x: 0, y: 2, w: 8, h: 4 },
  donut: { x: 8, y: 2, w: 4, h: 4 }
}
function flow(column: number, mobile: Record<string, string> = {}) {
  const nodes: GridStackNode[] = Object.entries(SAVED).reverse().map(([id, s]) => ({ id, ...s }))
  const placed: GridStackNode[] = []
  dashboardFlowLayout(id => SAVED[id] && { ...SAVED[id], mobile: mobile[id] })(column, 12, placed, nodes)
  return Object.fromEntries(placed.map(n => [n.id, [n.x, n.y, n.w]]))
}

describe('dashboardFlowLayout', () => {
  it('on 6 columns: KPIs two to a row, everything else full width, in reading order', () => {
    expect(flow(6)).toEqual({
      kpi1: [0, 0, 3], kpi2: [3, 0, 3], kpi3: [0, 2, 3], line: [0, 4, 6], donut: [0, 8, 6]
    })
  })
  it('on one column: one per row', () => {
    expect(flow(1)).toEqual({
      kpi1: [0, 0, 1], kpi2: [0, 2, 1], kpi3: [0, 4, 1], line: [0, 6, 1], donut: [0, 10, 1]
    })
  })
  it('on 12 columns: the saved layout', () => {
    expect(flow(12)).toEqual({
      kpi1: [0, 0, 3], kpi2: [3, 0, 3], kpi3: [6, 0, 3], line: [0, 2, 8], donut: [8, 2, 4]
    })
  })
  it('honors a widget\'s "On a phone": a KPI the whole width, two charts side by side', () => {
    expect(flow(2, { kpi1: 'FULL', line: 'HALF', donut: 'HALF' })).toEqual({
      kpi1: [0, 0, 2], kpi2: [0, 2, 1], kpi3: [1, 2, 1], line: [0, 4, 1], donut: [1, 4, 1]
    })
  })
})
