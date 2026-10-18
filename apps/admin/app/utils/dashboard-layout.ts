import type { GridStackNode } from 'gridstack'

/** The columns a dashboard is designed and saved in. */
export const DASHBOARD_DESIGN_COLUMNS = 12

/** A widget's saved place on the 12-column design grid. */
export interface DashboardGridPlace {
  x: number
  y: number
  w: number
  /** "On a phone" (D23): FULL or HALF the width on a narrower grid; unset: half for a quarter-wide widget, else full. */
  mobile?: unknown
}

/**
 * How a dashboard re-flows on a narrower grid (GridStack's custom
 * `ColumnOptions` - the viewer's breakpoints and the editor's Tablet/Phone
 * preview use the same one): in reading order of the saved 12-column layout,
 * a widget a quarter of the desktop wide or less (a KPI) takes half the
 * width - two to a row - and every other one the whole width, unless its
 * "On a phone" (`config.mobile`, FULL or HALF) says otherwise; on one column,
 * each its own row. Heights stay. At 12 columns, the saved layout itself.
 *
 * `placeOf` gives a widget's saved place by its id - the 12-column layout,
 * not whatever the grid shows now.
 */
export function dashboardFlowLayout(placeOf: (id: string) => DashboardGridPlace | undefined) {
  return (column: number, _previous: number, placed: GridStackNode[], nodes: GridStackNode[]): void => {
    const ordered = nodes
      .map(node => ({ node, place: placeOf(String(node.id)) ?? { x: node.x ?? 0, y: node.y ?? 0, w: node.w ?? 1 } }))
      .sort((a, b) => a.place.y - b.place.y || a.place.x - b.place.x)
    if (column >= DASHBOARD_DESIGN_COLUMNS) {
      for (const { node, place } of ordered) {
        Object.assign(node, place)
        placed.push(node)
      }
      return
    }
    let x = 0
    let y = placed.reduce((bottom, node) => Math.max(bottom, (node.y ?? 0) + (node.h ?? 1)), 0)
    let rowHeight = 0
    for (const { node, place } of ordered) {
      const half = Math.floor(column / 2)
      const wantsHalf = place.mobile === 'HALF' || (place.mobile !== 'FULL' && place.w <= DASHBOARD_DESIGN_COLUMNS / 4)
      const w = column > 1 && half > 0 && wantsHalf ? half : column
      if (x + w > column) {
        x = 0
        y += rowHeight
        rowHeight = 0
      }
      node.x = x
      node.y = y
      node.w = w
      x += w
      rowHeight = Math.max(rowHeight, node.h ?? 1)
      placed.push(node)
    }
  }
}
