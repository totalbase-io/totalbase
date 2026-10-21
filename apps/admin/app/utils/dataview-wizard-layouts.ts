import { isDateDataType, isNumericDataType } from '@totalbase/tb-catalog'
import {
  DEFAULT_CALENDAR_EVENT_COLOR,
  DEFAULT_GANTT_BAR_COLOR,
  DEFAULT_MAP_PIN_COLOR,
  DEFAULT_MAP_PIN_ICON,
  type CalendarLayoutConfig,
  type CardLayoutConfig,
  type GanttLayoutConfig,
  type KanbanLayoutConfig,
  type MapLayoutConfig,
  type TreeLayoutConfig
} from '~/types/dataview'

/**
 * The DataView wizard's layout steps (CARDS/MAP/KANBAN/CALENDAR/GANTT)
 * build the same typed config Edit DataView edits later, but only offer
 * plain column pickers: a picked column is stored as the bare formula
 * `{{column}}`; richer formulas are Edit DataView's job, once the
 * DataView exists. Every function here is pure - the wizard re-runs the
 * active layout's `pick*` whenever the Columns step changes, so a column
 * the builder excluded never stays mapped, and a required slot always has
 * a sensible default.
 */

/** A visible column the Columns step kept. */
export interface WizardColumn {
  name: string
  label: string
  dataType: string
  isForeignKey: boolean
  /** Its CHECK lists its values (`estado IN ('A', 'B')`) - a Kanban groups by it, a lane per value. */
  isCheckList?: boolean
  /** A foreign key to its own table - a TREE's parent. */
  isSelfReference?: boolean
}

const BARE_FORMULA = /^\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}$/

/** The column a bare `{{column}}` formula names, or null. */
export function formulaColumn(formula: string | null | undefined): string | null {
  return formula?.trim().match(BARE_FORMULA)?.[1] ?? null
}

/** A column as the bare formula the layout configs store. */
export function columnFormula(column: string | null | undefined): string | null {
  return column ? `{{${column}}}` : null
}

/** Keeps a formula only while its column is still among `names`. */
function keepFormula(formula: string | null, names: Set<string>): string | null {
  const column = formulaColumn(formula)
  return column && names.has(column) ? formula : null
}
function keepColumn(column: string | null, names: Set<string>): string | null {
  return column && names.has(column) ? column : null
}
const namesOf = (columns: WizardColumn[]) => new Set(columns.map(c => c.name))
const numericOf = (columns: WizardColumn[]) => columns.filter(c => isNumericDataType(c.dataType))
const dateOf = (columns: WizardColumn[]) => columns.filter(c => isDateDataType(c.dataType))
const foreignKeysOf = (columns: WizardColumn[]) => columns.filter(c => c.isForeignKey)

export function emptyCardLayout(): CardLayoutConfig {
  return { imageFormula: null, titleFormula: null, descriptionFormula: null }
}
export function pickCardLayout(layout: CardLayoutConfig, columns: WizardColumn[]): CardLayoutConfig {
  const names = namesOf(columns)
  const imageFormula = keepFormula(layout.imageFormula, names)
  return {
    imageFormula,
    titleFormula: keepFormula(layout.titleFormula, names) ?? columnFormula(columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    // How the image shows goes with it: no image, none of it.
    imageAspect: imageFormula ? layout.imageAspect ?? null : null,
    imageFit: imageFormula ? layout.imageFit ?? null : null,
    imagePosition: imageFormula ? layout.imagePosition ?? null : null
  }
}

export function emptyMapLayout(): MapLayoutConfig {
  return { pointColumn: null, latitudeColumn: null, longitudeColumn: null, nameFormula: null, descriptionFormula: null, iconFormula: null, colorFormula: null, defaultIcon: DEFAULT_MAP_PIN_ICON, defaultColor: DEFAULT_MAP_PIN_COLOR }
}
/**
 * The location: a `point` column kept when chosen (or picked when there's
 * no numeric pair but there is one), else Latitude/Longitude from numeric
 * columns, auto-picking the first two distinct ones.
 */
export function pickMapLayout(layout: MapLayoutConfig, columns: WizardColumn[]): MapLayoutConfig {
  const names = namesOf(columns)
  const numeric = numericOf(columns)
  const numericNames = namesOf(numeric)
  const pointNames = namesOf(columns.filter(c => c.dataType === 'point'))
  const keptPoint = keepColumn(layout.pointColumn, pointNames)
  const pointColumn = keptPoint ?? (numeric.length < 2 && !layout.latitudeColumn ? [...pointNames][0] ?? null : null)
  const latitudeColumn = pointColumn ? null : keepColumn(layout.latitudeColumn, numericNames) ?? numeric[0]?.name ?? null
  const longitudeColumn = pointColumn ? null : keepColumn(layout.longitudeColumn, numericNames) ?? numeric.find(c => c.name !== latitudeColumn)?.name ?? numeric[1]?.name ?? null
  return {
    ...layout,
    pointColumn,
    latitudeColumn,
    longitudeColumn,
    nameFormula: keepFormula(layout.nameFormula, names) ?? columnFormula(columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    iconFormula: keepFormula(layout.iconFormula, names),
    colorFormula: keepFormula(layout.colorFormula, names)
  }
}

export function emptyKanbanLayout(): KanbanLayoutConfig {
  // laneOrder starts empty - the related table's own order until lanes are reordered in Edit DataView.
  return { groupColumn: null, titleFormula: null, descriptionFormula: null, imageFormula: null, laneOrder: [], laneOrderColumn: null, laneColorColumn: null }
}
/** Group by a foreign key - a lane per row of the related table - else a column with a CHECK list - a lane per value. */
export function pickKanbanLayout(layout: KanbanLayoutConfig, columns: WizardColumn[]): KanbanLayoutConfig {
  const names = namesOf(columns)
  const groups = [...foreignKeysOf(columns), ...columns.filter(c => c.isCheckList && !c.isForeignKey)]
  return {
    ...layout,
    groupColumn: keepColumn(layout.groupColumn, namesOf(groups)) ?? groups[0]?.name ?? null,
    titleFormula: keepFormula(layout.titleFormula, names) ?? columnFormula(columns.find(c => !c.isForeignKey)?.name ?? columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    imageFormula: keepFormula(layout.imageFormula, names)
  }
}

export function emptyCalendarLayout(): CalendarLayoutConfig {
  return { dateColumn: null, titleFormula: null, descriptionFormula: null, colorFormula: null, defaultColor: DEFAULT_CALENDAR_EVENT_COLOR, weekStartsOn: 0, defaultView: 'month' }
}
/** One date/timestamp column places each row. */
export function pickCalendarLayout(layout: CalendarLayoutConfig, columns: WizardColumn[]): CalendarLayoutConfig {
  const names = namesOf(columns)
  const dates = dateOf(columns)
  const dateColumn = keepColumn(layout.dateColumn, namesOf(dates)) ?? dates[0]?.name ?? null
  return {
    ...layout,
    dateColumn,
    titleFormula: keepFormula(layout.titleFormula, names) ?? columnFormula(columns.find(c => c.name !== dateColumn)?.name ?? columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    colorFormula: keepFormula(layout.colorFormula, names)
  }
}

export function emptyGanttLayout(): GanttLayoutConfig {
  return { startDateColumn: null, endDateColumn: null, groupColumn: null, titleFormula: null, descriptionFormula: null, colorFormula: null, defaultColor: DEFAULT_GANTT_BAR_COLOR, laneOrder: [], defaultZoom: 'day', laneColorColumn: null, laneOrderColumn: null, progressColumn: null }
}
/** Start/End from date columns (two distinct ones when possible); Group by optional, foreign keys only. */
export function pickGanttLayout(layout: GanttLayoutConfig, columns: WizardColumn[]): GanttLayoutConfig {
  const names = namesOf(columns)
  const dates = dateOf(columns)
  const dateNames = namesOf(dates)
  const startDateColumn = keepColumn(layout.startDateColumn, dateNames) ?? dates[0]?.name ?? null
  const endDateColumn = keepColumn(layout.endDateColumn, dateNames) ?? dates.find(c => c.name !== startDateColumn)?.name ?? dates[1]?.name ?? null
  return {
    ...layout,
    startDateColumn,
    endDateColumn,
    groupColumn: keepColumn(layout.groupColumn, namesOf(foreignKeysOf(columns))),
    titleFormula: keepFormula(layout.titleFormula, names) ?? columnFormula(columns.find(c => c.name !== startDateColumn && c.name !== endDateColumn)?.name ?? columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    colorFormula: keepFormula(layout.colorFormula, names)
  }
}

export function emptyTreeLayout(): TreeLayoutConfig {
  return { parentColumn: null, orderColumn: null, titleFormula: null, descriptionFormula: null, iconFormula: null, colorFormula: null, imageFormula: null, defaultDisplay: 'tree', expandLevel: 1 }
}
/**
 * TREE (DataViews.md §5.14): the parent is a foreign key of the table to itself (the first one); the
 * order a number column, only when picked; the title the first column that isn't the parent. The parent and the
 * order come from every column (`all` - a hidden one is still read), the rest from the visible ones.
 */
export function pickTreeLayout(layout: TreeLayoutConfig, columns: WizardColumn[], all: WizardColumn[] = columns): TreeLayoutConfig {
  const names = namesOf(columns)
  const parents = all.filter(c => c.isSelfReference)
  const parentColumn = keepColumn(layout.parentColumn, namesOf(parents)) ?? parents[0]?.name ?? null
  return {
    ...layout,
    parentColumn,
    orderColumn: keepColumn(layout.orderColumn, namesOf(numericOf(all))),
    titleFormula: keepFormula(layout.titleFormula, names) ?? columnFormula(columns.find(c => c.name !== parentColumn && !c.isForeignKey)?.name ?? columns[0]?.name),
    descriptionFormula: keepFormula(layout.descriptionFormula, names),
    colorFormula: keepFormula(layout.colorFormula, names),
    imageFormula: keepFormula(layout.imageFormula, names)
  }
}
