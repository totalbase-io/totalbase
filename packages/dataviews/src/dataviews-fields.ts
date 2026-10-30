import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import { columnFormInput, COLUMN_PRESENTATION_KEYS, gridCellConfigProblem, isColumnWidgetName, templateColumns, widgetDefinition, type WidgetName } from "@totalbase/tb-catalog";
import { widgetRelatedDashboard, widgetRelatedDataview, type WidgetFieldConfig } from "./widget-fields.js";
import { classifyColumnDataType, isJsonColumnDataType } from "./display-format.js";
import { DATAVIEW_FIELDS_SELECT, FIELDS_ORDER, toAdminDataViewField, type AdminDataViewField, type DataViewFieldKind, type DataViewFieldRow, type DataViewFieldSnapshotRow, type DataViewsContext, type FieldSource, type InheritedPresentation, type UpdateFieldInput } from "./dataviews-types.js";
import { assertExists, getDataView } from "./dataviews-read.js";
import { defaultDisplayColumn, livePresentation } from "./dataviews-presentation.js";
import { assertWidgetPatch } from "./dataviews-widgets.js";

/** The display keys a field read with `display_inherited` carries - filled in by the read, never stored. */
export const INHERITED_DISPLAY_KEYS = ["display_field", "display_template", "display_field_target", "display_inherited"] as const;

/**
 * What a column field's config says about its PostgreSQL type - computed on
 * every read from the live catalog (`withLiveColumnFacts`), never stored: a
 * type changed later reads right away.
 */
export const TYPE_DERIVED_CONFIG_KEYS = ["displayFormatKind", "displayFormatTzAware", "isJsonColumn"] as const;

/** `config` without what the type derives - what a column field stores. */
export function storedColumnConfig(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([key]) => !(TYPE_DERIVED_CONFIG_KEYS as readonly string[]).includes(key)));
}

/**
 * A column's config as it's stored, from one sent back as read: a display
 * read as inherited (`display_inherited`) and sent unchanged is its
 * table's, not the column's - none of it is stored; one changed is its own.
 */
export function withoutInheritedDisplay(config: Record<string, unknown>, read: Record<string, unknown>): Record<string, unknown> {
  if (config.display_inherited !== true) return config;
  const unchanged = config.display_field === read.display_field && config.display_template === read.display_template;
  return Object.fromEntries(Object.entries(config).filter(([key]) =>
    unchanged ? !(INHERITED_DISPLAY_KEYS as readonly string[]).includes(key) : key !== "display_inherited"));
}

/** What a DataView's column may not set itself - its title and presentation are its table's column's (§15), its foreign key's display its table's row presentation's (§15.5). */
export const COLUMN_FIELD_FORBIDDEN_KEYS: readonly string[] = [...COLUMN_PRESENTATION_KEYS, "disabledConditions", "display_field", "display_template", "display_field_target"];

/** A grid column's config, refused when it sets what belongs to its table's column (DataViews.md §15) or a cell format it can't take (§4.3). */
export function withoutColumnPresentation(config: Record<string, unknown>): Record<string, unknown> {
  const own = Object.keys(config).filter((key) => COLUMN_FIELD_FORBIDDEN_KEYS.includes(key));
  if (own.length > 0) {
    throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", `A DataView's column takes ${own.join(", ")} from its table's column - set it in Database › the column.`);
  }
  const cellProblem = gridCellConfigProblem(config);
  if (cellProblem) throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", cellProblem);
  return config;
}

/** The type-derived keys for a column of `dataType`. */
export function typeDerivedConfig(dataType: string): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  const classification = classifyColumnDataType(dataType);
  if (classification) {
    derived.displayFormatKind = classification.kind;
    if (classification.tzAware) derived.displayFormatTzAware = true;
  }
  if (isJsonColumnDataType(dataType)) derived.isJsonColumn = true;
  return derived;
}

/**
 * A DataView's items in real display order (DataViews.md §2.2: `ORDER BY
 * grid_y, grid_x`) - `COLUMN` rows auto-populated at create time (§3.2),
 * plus the `WIDGET` rows of its page.
 */
export async function listFields(ctx: DataViewsContext, dataviewId: string): Promise<AdminDataViewField[]> {
  await assertExists(ctx, dataviewId); // 404s early if the DataView itself doesn't exist
  const { rows } = await ctx.database.query<DataViewFieldRow>(
    `${DATAVIEW_FIELDS_SELECT} WHERE f.dataview = $1 ORDER BY ${FIELDS_ORDER}`,
    [dataviewId],
  );
  const [presentation, source] = await Promise.all([livePresentation(ctx, dataviewId), fieldSource(ctx, dataviewId)]);
  return withColumnInputs(ctx, dataviewId, await withLiveColumnFacts(ctx, dataviewId, rows.map(toAdminDataViewField), presentation, source), presentation, undefined, source);
}

/** `listFields`'s published counterpart - see `getPublishedBySlug`'s doc comment for who should call which. */
export async function listPublishedFields(ctx: DataViewsContext, dataviewId: string): Promise<AdminDataViewField[]> {
  await assertExists(ctx, dataviewId);
  const { rows } = await ctx.database.query<{ fields_snapshot: DataViewFieldSnapshotRow[]; presentation_snapshot: InheritedPresentation }>(
    `SELECT fields_snapshot, presentation_snapshot FROM totalbase.dataviews_versions
     WHERE dataview = $1 ORDER BY version DESC LIMIT 1`,
    [dataviewId],
  );
  const published = rows[0];
  if (!published) throw new TotalBaseError("DATAVIEW_NOT_FOUND", `Published DataView not found: ${dataviewId}`);
  return hydrateFieldSnapshotRows(ctx, dataviewId, published.fields_snapshot, published.presentation_snapshot);
}

/** A version's field rows, as the API returns fields - with what they inherited when it was published. */
export async function hydrateFieldSnapshotRows(ctx: DataViewsContext, dataviewId: string, rows: DataViewFieldSnapshotRow[], presentation: InheritedPresentation): Promise<AdminDataViewField[]> {
  const source = await fieldSource(ctx, dataviewId);
  return withColumnInputs(ctx, dataviewId, await withLiveColumnFacts(ctx, dataviewId, rows.map(toAdminDataViewField), presentation, source), presentation, undefined, source);
}

/**
 * The source a DataView's fields read their column facts from - its resource id and its
 * current catalog detail; null for a DataView without a source (a CUSTOM page). Read once
 * per list and passed to `withLiveColumnFacts` and `withColumnInputs`, which both need it.
 */
export async function fieldSource(ctx: DataViewsContext, dataviewId: string): Promise<FieldSource | null> {
  const { rows } = await ctx.database.query<{ source_resource: string | null; postgres_oid: number | null }>(
    `SELECT d.source_resource, r.postgres_oid FROM totalbase.dataviews d
     LEFT JOIN totalbase.resources r ON r.id = d.source_resource WHERE d.id = $1`,
    [dataviewId],
  );
  const source = rows[0];
  if (!source?.source_resource || source.postgres_oid === null) return null;
  return { resource: source.source_resource, detail: await getRelationDetail(ctx.database, source.postgres_oid) };
}

/**
 * A form field's input that follows its column (`config.fromColumn`, DataViews.md §15.2): the input
 * its column is edited with - `columnFormInput` over the column's presentation (live on a draft, the version's on a
 * published read) and its live PostgreSQL facts. When that's another widget than the one stored, the field reads
 * as that one, keeping only the props and bindings it takes. `parents` are the form fields when `fields` lacks them.
 */
export async function withColumnInputs(ctx: DataViewsContext, dataviewId: string, fields: AdminDataViewField[], presentation: InheritedPresentation, parents: AdminDataViewField[] = fields, source?: FieldSource | null): Promise<AdminDataViewField[]> {
  const inherits = (f: AdminDataViewField) => f.kind === "WIDGET" && f.parent !== null && f.config.fromColumn === true;
  if (!fields.some(inherits)) return fields;
  if (source === undefined) source = await fieldSource(ctx, dataviewId);
  if (!source) return fields;
  const { detail } = source;
  const columnPresentation = presentation.columns[source.resource] ?? {};
  return fields.map((field) => {
    if (!inherits(field)) return field;
    const parent = parents.find((p) => p.id === field.parent);
    const name = (parent?.config.props as { column?: unknown } | undefined)?.column;
    const column = typeof name === "string" ? detail.columns.find((c) => c.name === name) : undefined;
    if (!column) return field;
    const own = columnPresentation[column.name];
    const input = columnFormInput({
      name: column.name,
      dataType: column.dataType,
      foreignKey: detail.relations.find((r) => r.sourceColumn === column.name) ?? null,
      checks: detail.checkConstraints,
      input: own?.input,
      linkType: own?.linkType,
    });
    const config = field.config as WidgetFieldConfig;
    // The props that make it that control (an Input's type) are the column's too - it follows its column.
    const ownProps = (config.props ?? {}) as Record<string, unknown>;
    const sameProps = Object.entries(input.props).every(([key, value]) => ownProps[key] === value);
    if (input.widget === field.widget && sameProps) return field;
    const takes = widgetDefinition(input.widget).props;
    const keep = (values: unknown) => Object.fromEntries(Object.entries((values ?? {}) as Record<string, unknown>).filter(([key]) => key === "modelValue" || key in takes));
    const props = { ...keep(config.props), ...input.props };
    return { ...field, widget: input.widget, config: { ...field.config, props, bindings: keep(config.bindings) } };
  });
}

/**
 * Each COLUMN/RELATED field as the grid reads it: its column's PostgreSQL
 * type, live (`dataType`, and the format keys it derives - never stored),
 * and what it inherits from its resource's column out of `presentation`
 * (DataViews.md §15), and its column's name now. Matched by attnum, so a
 * rename keeps all three; a column that no longer exists gets none of them, and `orphaned: true`.
 *
 * A foreign-key COLUMN shows what it
 * inherits (§15.5) - its table's row presentation out of
 * `presentation.rows`, else the default column - filled into its config
 * with `display_inherited`, so every reader shows it and a config sent
 * back as read stores none of it (`updateField`).
 */
export async function withLiveColumnFacts(ctx: DataViewsContext, dataviewId: string, fields: AdminDataViewField[], presentation: InheritedPresentation, source?: FieldSource | null): Promise<AdminDataViewField[]> {
  if (!fields.some((f) => f.kind === "COLUMN" || f.kind === "RELATED")) return fields;
  if (source === undefined) source = await fieldSource(ctx, dataviewId);
  if (!source) return fields;
  const { detail } = source;
  const targets = new Map<string, Promise<{ id: string; detail: RelationDetail } | null>>();
  const targetOf = (relation: RelationDetail["relations"][number]) => {
    const key = `${relation.targetSchema}.${relation.targetTable}`;
    if (!targets.has(key)) {
      targets.set(key, (async () => {
        const { rows: found } = await ctx.database.query<{ id: string; postgres_oid: number }>(
          `SELECT id, postgres_oid FROM totalbase.resources
           WHERE "schema" = $1 AND name = $2 AND type IN ('TABLE', 'VIEW') AND status = 'ACTIVE'`,
          [relation.targetSchema, relation.targetTable],
        );
        return found[0] ? { id: found[0].id, detail: await getRelationDetail(ctx.database, found[0].postgres_oid) } : null;
      })());
    }
    return targets.get(key)!;
  };
  // Its table's row presentation, else the default column; nothing when that's the key itself.
  const inheritedDisplay = async (relation: RelationDetail["relations"][number]): Promise<Record<string, unknown>> => {
    const target = await targetOf(relation);
    if (!target) return {};
    const row = presentation.rows[target.id] ?? {};
    const template = row.displayTemplate?.trim();
    const shown = template ? templateColumns(template)[0] : row.displayField ?? defaultDisplayColumn(target.detail, relation.targetColumn);
    if (!shown || shown === relation.targetColumn) return {};
    return {
      display_field: shown,
      ...(template ? { display_template: template } : {}),
      display_field_target: { schema: relation.targetSchema, table: relation.targetTable, column: relation.targetColumn },
      display_inherited: true,
    };
  };
  return Promise.all(fields.map(async (field) => {
    if (field.kind !== "COLUMN" && field.kind !== "RELATED") return field;
    let column: RelationDetail["columns"][number] | undefined;
    let resource: string | undefined;
    let name: string | undefined;
    let display: Record<string, unknown> = {};
    if (field.kind === "COLUMN") {
      column = detail.columns.find((c) => c.attnum === field.columnAttnum);
      resource = source.resource;
      name = column?.name;
      const relation = column ? detail.relations.find((r) => r.sourceColumn === column!.name) : undefined;
      if (relation) display = await inheritedDisplay(relation);
    } else {
      const fk = detail.columns.find((c) => c.attnum === field.relationAttnum);
      const relation = fk ? detail.relations.find((r) => r.sourceColumn === fk.name) : undefined;
      const target = relation ? await targetOf(relation) : null;
      column = target?.detail.columns.find((c) => c.attnum === field.targetAttnum);
      resource = target?.id;
      name = column ? `${fk!.name}.${column.name}` : undefined;
    }
    // Its column is gone (dropped, or its foreign key's target): orphaned (§4.2) - kept, never read (§4.8).
    if (!column || !resource || !name) return { ...field, orphaned: true };
    const inherited = presentation.columns[resource]?.[column.name];
    return {
      ...field,
      // Its column as it is named now - a rename after a version was published still reads it (§4.2).
      columnName: name,
      orphaned: false,
      config: { ...storedColumnConfig(field.config), ...display, ...typeDerivedConfig(column.dataType) },
      dataType: column.dataType,
      ...(inherited ? { inherited } : {}),
    };
  }));
}

/** One field, as the API returns it. */
/** `on`: the transaction a write just made the row in, when read before its commit. */
export async function getField(ctx: DataViewsContext, dataviewId: string, fieldId: string, on: Queryable = ctx.database): Promise<AdminDataViewField> {
  const { rows } = await on.query<DataViewFieldRow>(
    `${DATAVIEW_FIELDS_SELECT} WHERE f.id = $1 AND f.dataview = $2`,
    [fieldId, dataviewId],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DATAVIEW_FIELD_NOT_FOUND", `Field not found: ${fieldId}`);
  const field = toAdminDataViewField(row);
  if (field.kind === "WIDGET") return withColumnInput(ctx, dataviewId, field, on);
  if (field.kind !== "COLUMN" && field.kind !== "RELATED") return field;
  const [withFacts] = await withLiveColumnFacts(ctx, dataviewId, [field], await livePresentation(ctx, dataviewId));
  return withFacts!;
}

/** One placed widget, as read: a form field's input that follows its column, resolved (`withColumnInputs`). */
export async function withColumnInput(ctx: DataViewsContext, dataviewId: string, field: AdminDataViewField, on: Queryable = ctx.database): Promise<AdminDataViewField> {
  if (field.config.fromColumn !== true || !field.parent) return field;
  const { rows } = await on.query<DataViewFieldRow>(`${DATAVIEW_FIELDS_SELECT} WHERE f.id = $1 AND f.dataview = $2`, [field.parent, dataviewId]);
  const [resolved] = await withColumnInputs(ctx, dataviewId, [field], await livePresentation(ctx, dataviewId), rows.map(toAdminDataViewField));
  return resolved!;
}

/**
 * One field's change. A `COLUMN` field (a grid column): its label,
 * widget, visibility, config and position. A `WIDGET` field (a page's
 * widget): its name, config, position and parent - checked against the
 * widget catalog and the page's variables (`assertWidgetPatch`). Never
 * `kind`, `column_attnum` or `column_name`: those are identity.
 */
export async function updateField(ctx: DataViewsContext, dataviewId: string, fieldId: string, patch: UpdateFieldInput): Promise<AdminDataViewField> {
  return updateFieldOn(ctx, ctx.database, dataviewId, fieldId, patch);
}

/** `updateField` on `on` - the pool, or a transaction that moves several fields at once (`moveWidget`). */
export async function updateFieldOn(ctx: DataViewsContext, on: Queryable, dataviewId: string, fieldId: string, patch: UpdateFieldInput): Promise<AdminDataViewField> {
  const dataview = await getDataView(ctx, dataviewId); // 404s early if the DataView itself doesn't exist

  const { rows: widgetRows } = await on.query<{ widget: string | null; parent: string | null; config: WidgetFieldConfig }>(
    `SELECT widget, parent, config FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2 AND kind = 'WIDGET'`,
    [fieldId, dataviewId],
  );
  const widgetRow = widgetRows[0];
  // An input that follows its column is checked - and stored - as the input it reads as now.
  const columnInput = widgetRow?.config.fromColumn === true ? (await getField(ctx, dataviewId, fieldId, on)).widget : null;
  if (widgetRow && columnInput) widgetRow.widget = columnInput;
  if (widgetRow) {
    await assertWidgetPatch(ctx, dataview, fieldId, patch, widgetRow, on);
  } else if (patch.parent !== undefined) {
    throw new TotalBaseError("DATAVIEW_WIDGET_SLOT_INVALID", "Only a placed widget has a parent widget.");
  } else if (patch.widget !== undefined && !isColumnWidgetName(patch.widget)) {
    throw new TotalBaseError("DATAVIEW_FIELD_WIDGET_INVALID", `Unknown widget: ${patch.widget}`);
  }

  // A widget's config names the DataView it shows (a Detail's) - kept as the foreign key.
  const relatedDataview = widgetRow && patch.config !== undefined
    ? widgetRelatedDataview(widgetRow.widget as WidgetName, patch.config as WidgetFieldConfig)
    : undefined;
  // An embedded Dashboard's, the same way.
  const relatedDashboard = widgetRow && patch.config !== undefined
    ? widgetRelatedDashboard(widgetRow.widget as WidgetName, patch.config as WidgetFieldConfig)
    : undefined;
  // A DataView's column has no title or presentation of its own: its table's column's, set in Database
  // (DataViews.md §15) - only how the list shows it is its own.
  if (!widgetRow && patch.label !== undefined && patch.label !== null) {
    throw new TotalBaseError("DATAVIEW_COLUMN_INVALID", "A DataView's column takes its title from its table's column - set it in Database › the column.");
  }
  // Its config as read carries the foreign key's display it inherits (withLiveColumnFacts) - sent back as read, none of it is stored.
  const read = !widgetRow && patch.config !== undefined ? (await getField(ctx, dataviewId, fieldId, on)).config : undefined;
  const columnConfig = !widgetRow && patch.config !== undefined
    ? withoutColumnPresentation(withoutInheritedDisplay(storedColumnConfig(patch.config), read ?? {}))
    : undefined;
  const { rows } = await on.query<DataViewFieldRow>(
    `UPDATE totalbase.dataviews_fields
     SET label = CASE WHEN $3::boolean THEN $4 ELSE label END,
         widget = coalesce($5, widget),
         visible = coalesce($6, visible),
         config = coalesce($7::jsonb, config),
         grid_x = coalesce($8, grid_x),
         grid_y = coalesce($9, grid_y),
         grid_w = coalesce($10, grid_w),
         grid_h = coalesce($11, grid_h),
         parent = CASE WHEN $12::boolean THEN $13::uuid ELSE parent END,
         related_dataview = CASE WHEN $14::boolean THEN $15::uuid ELSE related_dataview END,
         related_dashboard = CASE WHEN $14::boolean THEN $16::uuid ELSE related_dashboard END,
         updated_at = now()
     WHERE id = $1 AND dataview = $2
     RETURNING *`,
    [
      fieldId,
      dataviewId,
      patch.label !== undefined,
      patch.label ?? null,
      patch.widget ?? columnInput,
      patch.visible ?? null,
      // A column's type-derived keys come back with what was read - never stored (withLiveColumnFacts).
      patch.config !== undefined ? JSON.stringify(widgetRow ? patch.config : columnConfig) : null,
      patch.gridX ?? null,
      patch.gridY ?? null,
      patch.gridW ?? null,
      patch.gridH ?? null,
      patch.parent !== undefined,
      patch.parent ?? null,
      relatedDataview !== undefined,
      relatedDataview ?? null,
      relatedDashboard ?? null,
    ],
  );
  if (!rows[0]) throw new TotalBaseError("DATAVIEW_FIELD_NOT_FOUND", `Field not found: ${fieldId}`);
  return getField(ctx, dataviewId, fieldId, on);
}

/**
 * Removes a widget outright, with what its slots hold (ON DELETE
 * CASCADE) - and a detail DataView only a removed Detail owned. A
 * `COLUMN` field leaves the DataView: it's no longer read - but never
 * the primary key's, which can only be hidden.
 */
export async function deleteField(ctx: DataViewsContext, dataviewId: string, fieldId: string): Promise<void> {
  const dataview = await getDataView(ctx, dataviewId); // 404s early if the DataView itself doesn't exist

  const { rows } = await ctx.database.query<{ kind: DataViewFieldKind; column_name: string | null }>(
    `SELECT kind, column_name FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2`,
    [fieldId, dataviewId],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DATAVIEW_FIELD_NOT_FOUND", `Field not found: ${fieldId}`);
  // A column leaves the DataView - it's no longer read (DataViews.md §4.1); "Add columns…" brings it back.
  // Never the primary key: editing and deleting a row need it - it can be hidden instead.
  if (row.kind === "COLUMN" || row.kind === "RELATED") {
    if (row.kind === "COLUMN" && row.column_name && dataview.sourceResourceOid !== null) {
      const detail = await getRelationDetail(ctx.database, dataview.sourceResourceOid);
      if (detail.primaryKey.includes(row.column_name)) {
        throw new TotalBaseError("DATAVIEW_FIELD_NOT_DELETABLE", `${row.column_name} is the primary key - editing and deleting a row need it. Hide it instead.`);
      }
    }
    await ctx.database.query(`DELETE FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2`, [fieldId, dataviewId]);
    return;
  }

  await ctx.database.transaction(async (client) => {
    // A widget takes what its slots hold with it (ON DELETE CASCADE) - an embedded DataView among them included.
    const { rows: related } = await client.query<{ related_dataview: string | null }>(
      `WITH RECURSIVE gone AS (
         SELECT id, widget, related_dataview FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2
         UNION ALL
         SELECT f.id, f.widget, f.related_dataview FROM totalbase.dataviews_fields f JOIN gone g ON f.parent = g.id
       )
       SELECT related_dataview FROM gone WHERE related_dataview IS NOT NULL`,
      [fieldId, dataviewId],
    );
    await client.query(`DELETE FROM totalbase.dataviews_fields WHERE id = $1 AND dataview = $2`, [fieldId, dataviewId]);
    // An embed takes the DataView this page owns for it (a Master-detail's items) - once nothing else shows it. Never one it doesn't own.
    const shown = related.flatMap((r) => (r.related_dataview ? [r.related_dataview] : []));
    if (shown.length > 0) {
      await client.query(
        `DELETE FROM totalbase.dataviews d
         WHERE d.id = ANY($1::uuid[]) AND d.owner = $2
           AND NOT EXISTS (SELECT 1 FROM totalbase.dataviews_fields f WHERE f.related_dataview = d.id)`,
        [shown, dataviewId],
      );
    }
  });
}
