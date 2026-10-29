/**
 * TotalBase's own catalog - the pieces an author builds with, as plain data (no Vue, no `pg`), read by the admin,
 * the server and the MCP alike. `@totalbase/pg-catalog` is what PostgreSQL holds; this is what TotalBase offers to
 * build: the pieces available, never the objects built from them (those are rows of the `totalbase` schema).
 *
 * - `widgets/`: what a designed screen (a DataView page or a Dashboard canvas) places - the widget, variable and
 *   snippet catalogs, a placed control's config and its validation.
 * - `columns/`: a column's control (the column input catalog), its presentation and the rules read from its CHECKs.
 * - `dataviews/`, `dashboards/`: what only one of them has.
 * - `workflows/`: the operation catalog - every step a workflow can hold.
 */
export * from "./widgets/widget-catalog.js";
export * from "./widgets/widget-inference.js";
export * from "./widgets/widget-compatibility.js";
export * from "./widgets/widget-control.js";
export * from "./widgets/variable-catalog.js";
export * from "./widgets/snippet-catalog.js";
export * from "./widgets/frame-url.js";
export * from "./columns/column-inputs.js";
export * from "./columns/column-presentation.js";
export * from "./columns/check-values.js";
export * from "./columns/check-bounds.js";
export * from "./columns/check-expression.js";
export * from "./columns/regex-patterns.js";
export * from "./dataviews/dataview-features.js";
export * from "./dataviews/settings-layout.js";
export * from "./dataviews/custom-actions.js";
export * from "./dataviews/grid-cell.js";
export * from "./dataviews/record-form-defaults.js";
export * from "./dashboards/dashboard-catalog.js";
export * from "./dashboards/dashboard-shapes.js";
export * from "./dashboards/dashboard-decisions.js";
export * from "./workflows/operation-catalog.js";
