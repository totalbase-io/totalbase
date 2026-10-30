/**
 * A grid column's cell (DataViews.md §4.3): how its text fits, where it sits and how wide the column is - a
 * spreadsheet's cell format, kept in the DataView's column `config`. Every key is optional; unset, a cell is
 * one line cut with "…", vertically centered, its column as wide as its content up to `GRID_COLUMN_DEFAULT_MAX_WIDTH`.
 */
export interface GridCellConfig {
  /** `truncate` (default): one line, "…", the whole value on hover; `wrap`: several lines within the column's width. */
  textWrap?: GridCellTextWrap
  /** With `wrap`: at most this many lines, then "…" - unset, every line. */
  maxLines?: number
  verticalAlign?: GridCellVerticalAlign
  /** In px. `width` fixes the column; `minWidth`/`maxWidth` bound it. */
  width?: number
  minWidth?: number
  maxWidth?: number
}

export const GRID_CELL_TEXT_WRAPS = ["truncate", "wrap"] as const;
export type GridCellTextWrap = (typeof GRID_CELL_TEXT_WRAPS)[number];
export const GRID_CELL_VERTICAL_ALIGNS = ["top", "middle", "bottom"] as const;
export type GridCellVerticalAlign = (typeof GRID_CELL_VERTICAL_ALIGNS)[number];

export const GRID_CELL_CONFIG_KEYS = ["textWrap", "maxLines", "verticalAlign", "width", "minWidth", "maxWidth"] as const;
export const GRID_COLUMN_WIDTH_KEYS = ["width", "minWidth", "maxWidth"] as const;
export const GRID_COLUMN_WIDTH_RANGE = { min: 24, max: 2000 } as const;
export const GRID_CELL_MAX_LINES = 10;
/** A column with no width of its own is never wider than this - a long text or a document never pushes the grid sideways. */
export const GRID_COLUMN_DEFAULT_MAX_WIDTH = 320;
/** With no rows, a column with no minimum of its own is at least this wide - its title, not "…", until rows size it. */
export const GRID_COLUMN_EMPTY_MIN_WIDTH = 120;

/** What's wrong with a column's cell config, or null - the server refuses it (422 `DATAVIEW_COLUMN_INVALID`), the MCP says it first. */
export function gridCellConfigProblem(config: Record<string, unknown>): string | null {
  const { textWrap, maxLines, verticalAlign, minWidth, maxWidth } = config;
  if (textWrap != null && !(GRID_CELL_TEXT_WRAPS as readonly unknown[]).includes(textWrap)) return `textWrap is one of ${GRID_CELL_TEXT_WRAPS.join(", ")}.`;
  if (maxLines != null && !(Number.isInteger(maxLines) && (maxLines as number) >= 1 && (maxLines as number) <= GRID_CELL_MAX_LINES)) return `maxLines is a whole number from 1 to ${GRID_CELL_MAX_LINES}.`;
  if (verticalAlign != null && !(GRID_CELL_VERTICAL_ALIGNS as readonly unknown[]).includes(verticalAlign)) return `verticalAlign is one of ${GRID_CELL_VERTICAL_ALIGNS.join(", ")}.`;
  for (const key of GRID_COLUMN_WIDTH_KEYS) {
    const value = config[key];
    if (value == null) continue;
    if (!Number.isInteger(value) || (value as number) < GRID_COLUMN_WIDTH_RANGE.min || (value as number) > GRID_COLUMN_WIDTH_RANGE.max) {
      return `${key} is a whole number of pixels from ${GRID_COLUMN_WIDTH_RANGE.min} to ${GRID_COLUMN_WIDTH_RANGE.max}.`;
    }
  }
  if (typeof minWidth === "number" && typeof maxWidth === "number" && minWidth > maxWidth) return "minWidth can't be wider than maxWidth.";
  return null;
}

/**
 * The column's width bounds as CSS px: `width` fixes it (and lifts the default cap to it), `minWidth` and `maxWidth`
 * bound it, and with none of them it is as wide as its content up to `GRID_COLUMN_DEFAULT_MAX_WIDTH`.
 */
export function gridColumnWidths(config: GridCellConfig): { width?: number; minWidth?: number; maxWidth: number } {
  const maxWidth = config.maxWidth ?? Math.max(GRID_COLUMN_DEFAULT_MAX_WIDTH, config.width ?? 0, config.minWidth ?? 0);
  return {
    ...(config.width !== undefined && { width: Math.min(config.width, maxWidth) }),
    ...(config.minWidth !== undefined && { minWidth: config.minWidth }),
    maxWidth,
  };
}
