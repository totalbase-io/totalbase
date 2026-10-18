/**
 * The keys `view_config.features` may hold, per DataView type
 * (Specification_DataViews.md §5.1). Every feature defaults to on; the admin's
 * catalog (labels, descriptions - apps/admin/app/types/dataview.ts) lists the
 * same keys, and the server refuses any other (DataViewsAdminService). A key
 * two views share means the same thing in both; a view's own control has its
 * own key - a table's row `density`, the cards' `cardDensity`.
 */
const RECORD_FORM = ["recordClone", "recordSaveAndNew", "recordCopy", "recordPrint", "recordHistory", "recordNavigation"] as const;
/** The toolbar of a list view that isn't a table grid: CARDS, MAP, KANBAN, CALENDAR, GANTT, TREE. */
const LIST_TOOLBAR = ["search", "savedViews", "history", "filter", "import", "export", "refresh"] as const;

/** The list types (Specification_DataViews.md §5): one DataView may offer several of them as its views (`layouts`), and a TDataView embeds one. */
export const LIST_VIEW_TYPES = ["TABLE", "CARDS", "MAP", "KANBAN", "CALENDAR", "GANTT", "TREE"] as const;

export const DATAVIEW_FEATURE_KEYS: Readonly<Record<string, readonly string[]>> = {
  TABLE: ["search", "savedViews", "history", "density", "filter", "columnsToggle", "import", "export", "print", "refresh", "rowEdit", ...RECORD_FORM],
  FORM: ["search", "recordSaveCancel", ...RECORD_FORM],
  MASTER_DETAIL: ["recordSaveCancel", "recordCopy", "recordPrint", "recordHistory"],
  CARDS: [...LIST_TOOLBAR, "cardDensity", ...RECORD_FORM],
  MAP: [...LIST_TOOLBAR, ...RECORD_FORM],
  KANBAN: [...LIST_TOOLBAR, ...RECORD_FORM],
  CALENDAR: [...LIST_TOOLBAR, ...RECORD_FORM],
  GANTT: [...LIST_TOOLBAR, ...RECORD_FORM],
  TREE: [...LIST_TOOLBAR, ...RECORD_FORM],
  EXTERNALFRAME: ["openInNewTab", "fullscreen"],
  CUSTOM: [],
  SETTINGS: ["search"],
};
