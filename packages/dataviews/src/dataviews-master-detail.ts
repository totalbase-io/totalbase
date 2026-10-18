import { TotalBaseError } from "@totalbase/errors";
import { getChildForeignKeys, getRelationDetail, type RelationDetail } from "@totalbase/pg-catalog";
import type { RoleColor } from "@totalbase/permissions";
import { validateName, validateSlug } from "@totalbase/shared";
import { getColumnInputs } from "@totalbase/resources";
import { generateRecordPage } from "./record-page.js";
import type { AdminDataView, CreateDataViewInput, DataViewsContext, DetailCandidate } from "./dataviews-types.js";
import { getDataView } from "./dataviews-read.js";
import { getSourceForCreate, remapDataViewUniqueViolation } from "./dataviews-crud.js";
import { insertColumnFields, insertGeneratedPage, recordPageColumns } from "./dataviews-generated-page.js";

/**
 * Tables whose single-column FK points at `masterResourceId` - the
 * possible details of a MASTER_DETAIL DataView over it (the wizard's
 * Detail step). Only TotalBase TABLE resources; a self-reference (a
 * parent/child hierarchy on one table) is not a detail.
 */
export async function listDetailCandidates(ctx: DataViewsContext, masterResourceId: string): Promise<DetailCandidate[]> {
  const source = await getSourceForCreate(ctx, masterResourceId);
  if (source.type !== "TABLE") return [];
  const children = (await getChildForeignKeys(ctx.database, source.postgresOid)).filter((c) => c.childOid !== source.postgresOid);
  if (children.length === 0) return [];
  const { rows } = await ctx.database.query<{ id: string; postgres_oid: number }>(
    `SELECT id, postgres_oid FROM totalbase.resources WHERE type = 'TABLE' AND status = 'ACTIVE' AND postgres_oid = ANY($1)`,
    [children.map((c) => c.childOid)],
  );
  const resourceByOid = new Map(rows.map((r) => [Number(r.postgres_oid), r.id]));
  return children
    .filter((c) => resourceByOid.has(c.childOid))
    .map((c) => ({ resourceId: resourceByOid.get(c.childOid)!, schema: c.childSchema, table: c.childTable, fkColumn: c.childColumn }));
}

/**
 * MASTER_DETAIL: the master DataView over a table, with every editable
 * column on its canvas (four to a row, no primary key) and below them a
 * Detail widget - a detail DataView created here with it
 * (EMBEDDED_ONLY, a TABLE over the detail table whose records open in a
 * modal, every column but the primary key and the FK to the master, which
 * the Detail widget fills in). One transaction: both or neither. The
 * master owns that detail form: publishing, "unpublished changes" and
 * deleting it include it.
 */
export async function createMasterDetail(
  ctx: DataViewsContext,
  input: CreateDataViewInput,
  source: { id: string; postgresOid: number; type: "TABLE" | "VIEW" | "FUNCTION" },
  identity: { name: string; slug: string; description: string | null; color: RoleColor | null },
): Promise<AdminDataView> {
  if (source.type !== "TABLE") {
    throw new TotalBaseError("DATAVIEW_SOURCE_TYPE_INVALID", "A Master-detail DataView's master must be a table.");
  }
  if (!input.detail) {
    throw new TotalBaseError("DATAVIEW_DETAIL_REQUIRED", "A Master-detail DataView needs its detail table.");
  }
  const requested = input.detail;
  const link = (await listDetailCandidates(ctx, source.id)).find(
    (c) => c.resourceId === requested.resourceId && c.fkColumn === requested.fkColumn,
  );
  if (!link) {
    throw new TotalBaseError(
      "DATAVIEW_DETAIL_INVALID",
      `The detail table has no foreign key column "${requested.fkColumn}" pointing at the master table.`,
    );
  }

  const masterDetail = await getRelationDetail(ctx.database, source.postgresOid);
  const masterInputs = await getColumnInputs(ctx.database, source.id);
  const detailSource = await getSourceForCreate(ctx, link.resourceId);
  const detailCatalog = await getRelationDetail(ctx.database, detailSource.postgresOid);
  const detailInputs = await getColumnInputs(ctx.database, detailSource.id);
  // "{name} - {its table}" / "{slug}-detail" - it lists right after its master, and its record form's title
  // ("New · Invoicing - Invoice lines") names the lines in the source's own words, never an English "Detail" (B51).
  const tableLabel = link.table.replace(/_+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
  const masterPart = identity.name.slice(0, 14).trim();
  const fullName = `${masterPart} - ${tableLabel}`;
  // Cut at a word, never through one.
  const detailName = validateName(fullName.length <= 32 ? fullName : fullName.slice(0, 33).replace(/\s+\S*$/, "").replace(/[\s-]+$/, ""));
  const detailSlug = validateSlug(`${identity.slug.slice(0, 25).replace(/-+$/, "")}-detail`);
  // The wizard's Columns steps: what the builder kept - every column when they didn't say.
  const masterSelected = input.selectedColumns ? new Set(input.selectedColumns) : undefined;
  const masterOverrides = input.fieldOverrides ?? {};
  const detailSelected = requested.selectedColumns ? new Set(requested.selectedColumns) : undefined;
  const detailOverrides = requested.fieldOverrides ?? {};
  const masterColumns = await recordPageColumns(ctx, masterDetail, masterInputs, {
    include: (column) => (masterSelected ? masterSelected.has(column) : true),
    widget: (column) => masterOverrides[column]?.widget,
    help: (column) => masterOverrides[column]?.help,
  });
  // A detail row's form: its columns but the one pointing at the master - the Detail fills that in.
  const detailColumns = await recordPageColumns(ctx, detailCatalog, detailInputs, {
    include: (column) => column !== link.fkColumn && (detailSelected ? detailSelected.has(column) : true),
    widget: (column) => detailOverrides[column]?.widget,
    help: (column) => detailOverrides[column]?.help,
  });

  const createdId = await ctx.database.transaction(async (client) => {
    let masterId: string;
    let detailId: string;
    try {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.dataviews (name, slug, description, icon, color, source_resource, view_type, view_config)
         VALUES ($1, $2, $3, $4, $5, $6, 'MASTER_DETAIL', $7)
         RETURNING id`,
        [identity.name, identity.slug, identity.description, input.icon ?? null, identity.color, source.id, JSON.stringify(input.viewConfig ?? {})],
      );
      masterId = rows[0]!.id;
      const { rows: detailRows } = await client.query<{ id: string }>(
        // Owned by the master: published and deleted with it.
        `INSERT INTO totalbase.dataviews (name, slug, icon, source_resource, view_type, scope, view_config, owner)
         VALUES ($1, $2, $3, $4, 'TABLE', 'EMBEDDED_ONLY', $5, $6)
         RETURNING id`,
        [detailName, detailSlug, input.icon ?? null, detailSource.id, JSON.stringify({ edit_presentation: "MODAL", ...detailOrder(detailCatalog, (column) => column !== link.fkColumn && (detailSelected ? detailSelected.has(column) : true)) }), masterId],
      );
      detailId = detailRows[0]!.id;
    } catch (error) {
      remapDataViewUniqueViolation(error);
    }

    await insertColumnFields(ctx, client, masterId, masterDetail, masterInputs, {
      presence: (column) => (!masterSelected || masterSelected.has(column.name) ? "shown" : masterDetail.primaryKey.includes(column.name) ? "hidden" : null),
      fieldOverrides: masterOverrides,
      columnsPerRow: 4,
    });
    // The detail's columns.
    await insertColumnFields(ctx, client, detailId, detailCatalog, detailInputs, {
      // The key pointing at the master is read, not shown - the Detail fills it in.
      presence: (column) => (column.name === link.fkColumn ? "hidden" : !detailSelected || detailSelected.has(column.name) ? "shown" : detailCatalog.primaryKey.includes(column.name) ? "hidden" : null),
      fieldOverrides: detailOverrides,
    });
    // Its record form: a generated page - the master's fields, the Detail over the detail DataView, Save & New.
    await insertGeneratedPage(ctx, client, masterId, generateRecordPage({ type: "MASTER_DETAIL", columns: masterColumns, detail: { dataview: detailId, column: link.fkColumn } }));
    await insertGeneratedPage(ctx, client, detailId, generateRecordPage({ type: "GRID", columns: detailColumns }));

    return masterId;
  });
  return getDataView(ctx, createdId);
}

/** A line's own order column, by name - a line number, a position. */
export const LINE_ORDER_COLUMNS = /^(line|line_number|line_no|position|sort_order|display_order|item|item_number|renglon|orden|posicion|nro|numero)$/;
/** A column that grows with every insert - an identity, a serial, a creation instant. */
export const CREATION_ORDER_COLUMNS = /^(created_at|creado|creado_en|fecha_alta)$/;

/**
 * A detail's lines in the order they were entered (B54, Specification_DataViews.md §6.2): its default sort,
 * from a line-order column, else an identity or serial, else a creation instant - none, the primary key's.
 */
export function detailOrder(detail: RelationDetail, shown: (column: string) => boolean): { default_state?: { sort: string } } {
  const columns = detail.columns.filter((column) => shown(column.name));
  const column = columns.find((c) => LINE_ORDER_COLUMNS.test(c.name))
    ?? columns.find((c) => c.isIdentity || /^nextval\(/.test(c.defaultExpression ?? ""))
    ?? columns.find((c) => CREATION_ORDER_COLUMNS.test(c.name));
  return column ? { default_state: { sort: column.name } } : {};
}
