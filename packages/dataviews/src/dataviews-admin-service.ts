import type { EffectivePermissionService } from "@totalbase/permissions";
import { diagnoseDataView, type DiagnosisIssue } from "./dataviews-diagnosis.js";
import type { Database } from "@totalbase/database";
import type {
  AddWidgetInput,
  AddWidgetTreeInput,
  AdminDataView,
  AdminDataViewField,
  AdminDataViewPublish,
  AffectedDataView,
  CreateDataViewInput,
  DataViewsContext,
  DetailCandidate,
  JunctionCandidate,
  SyncFieldsResult,
  UpdateDataViewInput,
  UpdateFieldInput,
} from "./dataviews-types.js";
import * as read from "./dataviews-read.js";
import * as access from "./dataviews-access.js";
import * as fields from "./dataviews-fields.js";
import * as columns from "./dataviews-columns.js";
import * as widgets from "./dataviews-widgets.js";
import * as crud from "./dataviews-crud.js";
import * as masterDetail from "./dataviews-master-detail.js";
import * as junctions from "./dataviews-junctions.js";
import * as versions from "./dataviews-versions.js";
import * as presentation from "./dataviews-presentation.js";

// The public shapes stay importable from here (and from the package index) - routes, MCP tools and tests
// never learned the module split.
export * from "./dataviews-types.js";

/**
 * Admin management of totalbase.dataviews/dataviews_fields - the
 * wizard's steps 1-2 (identity, source) plus the auto-population that
 * makes a freshly-created DataView already usable with the TABLE
 * layout, before the Design form (a later step) exists.
 * See DataViews.md.
 *
 * A façade: each responsibility lives in its own module (`dataviews-read`,
 * `-access`, `-fields`, `-columns`, `-widgets`, `-crud`, `-master-detail`,
 * `-generated-page`, `-versions`, `-presentation`), plain functions over the
 * one `DataViewsContext` this class holds. The methods below are the stable
 * surface routes, MCP tools and tests call.
 */
export class DataViewsAdminService {
  private readonly ctx: DataViewsContext;

  /**
   * `ownOrigin` resolves the instance's public URL (`system.public_url`) -
   * an EXTERNALFRAME's URL may never point back at it (frame-url.ts).
   */
  constructor(database: Database, ownOrigin: () => Promise<string | undefined> = async () => undefined) {
    this.ctx = { database, ownOrigin };
  }

  // --- Read (dataviews-read.ts)

  /** Every DataView, LISTED or EMBEDDED_ONLY, with its versioning status - the admin's DataViews list (the App's own list is `listPublished`). */
  list(): Promise<(AdminDataView & { hasUnpublishedChanges: boolean })[]> {
    return read.listDataViews(this.ctx);
  }

  /** Application-facing list: drafts have no route until first published. */
  listPublished(): Promise<AdminDataView[]> {
    return read.listPublished(this.ctx);
  }

  /** Published DataViews kept out of the App menu that could be shown in it - see `listHiddenFromMenu`. */
  listHiddenFromMenu(): Promise<AdminDataView[]> {
    return read.listHiddenFromMenu(this.ctx);
  }

  get(id: string): Promise<AdminDataView> {
    return read.getDataView(this.ctx, id);
  }

  /** Slug lookup for the admin SPA's own `/dataviews/:slug` route (not exposed by id there). */
  getBySlug(slug: string): Promise<AdminDataView> {
    return read.getDataViewBySlug(this.ctx, slug);
  }

  /** The latest published version's content in place of the draft's - see `getPublishedBySlug`'s own doc comment. */
  getPublishedBySlug(slug: string): Promise<AdminDataView> {
    return read.getPublishedBySlug(this.ctx, slug);
  }

  /** Published counterpart for embedded DataViews, whose config stores an id. */
  getPublished(id: string): Promise<AdminDataView> {
    return read.getPublished(this.ctx, id);
  }

  /** `get()` plus the versioning status the editor header shows. */
  getWithStatus(id: string): Promise<AdminDataView & { hasUnpublishedChanges: boolean }> {
    return read.getWithStatus(this.ctx, id);
  }

  // --- Object access (dataviews-access.ts, Security.md §7.1)

  listRoles(dataviewId: string): Promise<string[]> {
    return access.listRoles(this.ctx, dataviewId);
  }

  /** Replaces the whole grant set - the admin UI edits it as one multi-select. */
  setRoles(dataviewId: string, roleIds: string[]): Promise<string[]> {
    return access.setRoles(this.ctx, dataviewId, roleIds);
  }

  /** The DataViews among `dataviewIds` granted to at least one of `roleIds` (Administrators are the caller's check). */
  grantedToRoles(dataviewIds: string[], roleIds: string[]): Promise<Set<string>> {
    return access.grantedToRoles(this.ctx, dataviewIds, roleIds);
  }

  /** Whether `roleIds` reach this DataView - granted, or embedded in one they reach (see `reachableByRoles`). */
  reachableByRoles(dataviewId: string, roleIds: string[]): Promise<boolean> {
    return access.reachableByRoles(this.ctx, dataviewId, roleIds);
  }

  /** The DataView a field belongs to - its draft row, or a published version holding it - or null. */
  dataviewOfField(fieldId: string): Promise<string | null> {
    return access.dataviewOfField(this.ctx, fieldId);
  }

  // --- Fields and columns (dataviews-fields.ts, dataviews-columns.ts)

  /** A DataView's items in real display order - its `COLUMN` rows plus the `WIDGET` rows of its page. */
  listFields(dataviewId: string): Promise<AdminDataViewField[]> {
    return fields.listFields(this.ctx, dataviewId);
  }

  /** `listFields`'s published counterpart - see `getPublishedBySlug`'s doc comment for who should call which. */
  listPublishedFields(dataviewId: string): Promise<AdminDataViewField[]> {
    return fields.listPublishedFields(this.ctx, dataviewId);
  }

  /** Reconciles the DataView's `COLUMN` rows against the source's current columns - see `syncFields`. */
  syncFields(dataviewId: string): Promise<SyncFieldsResult> {
    return columns.syncFields(this.ctx, dataviewId);
  }

  /** Sync columns on every DataView whose source has a column it hasn't seen - the catalog watch's (§4.2). */
  syncNewColumns(): Promise<string[]> {
    return columns.syncNewColumns(this.ctx);
  }

  /** "Add columns…": source columns not in the DataView yet, and `fk.column` related columns - see `addColumns`. */
  addColumns(dataviewId: string, columnNames: string[]): Promise<AdminDataViewField[]> {
    return columns.addColumns(this.ctx, dataviewId, columnNames);
  }

  /** Each related column's PostgreSQL type, by path - see `relatedColumnTypes`. */
  relatedColumnTypes(fieldList: AdminDataViewField[], sourceOid: number): Promise<Record<string, string>> {
    return columns.relatedColumnTypes(this.ctx, fieldList, sourceOid);
  }

  /** One field's change - a grid column's or a page widget's; never its identity. See `updateField`. */
  updateField(dataviewId: string, fieldId: string, patch: UpdateFieldInput): Promise<AdminDataViewField> {
    return fields.updateField(this.ctx, dataviewId, fieldId, patch);
  }

  /** Removes a widget with what its slots hold, or takes a column out of the DataView - never the primary key's. See `deleteField`. */
  deleteField(dataviewId: string, fieldId: string): Promise<void> {
    return fields.deleteField(this.ctx, dataviewId, fieldId);
  }

  // --- Page widgets (dataviews-widgets.ts)

  /** Places one widget of the widget catalog - on the canvas, or in a slot of another widget. */
  addWidget(dataviewId: string, input: AddWidgetInput): Promise<AdminDataViewField> {
    return widgets.addWidget(this.ctx, dataviewId, input);
  }

  /** Places several widgets, each with what it holds, in one transaction - see `addWidgets`. */
  addWidgets(dataviewId: string, inputs: AddWidgetTreeInput[]): Promise<AdminDataViewField[]> {
    return widgets.addWidgets(this.ctx, dataviewId, inputs);
  }

  /** Moves a placed widget, with what its slots hold, to another place on the page - see `moveWidget`. */
  moveWidget(dataviewId: string, fieldId: string, move: { parent?: string | null | undefined; slot?: string | undefined; position?: number | undefined }): Promise<AdminDataViewField[]> {
    return widgets.moveWidget(this.ctx, dataviewId, fieldId, move);
  }

  // --- Create, update, delete (dataviews-crud.ts, dataviews-master-detail.ts)

  create(input: CreateDataViewInput): Promise<AdminDataView> {
    return crud.createDataView(this.ctx, input);
  }

  /** Tables whose single-column FK points at `masterResourceId` - a MASTER_DETAIL's possible details. */
  listDetailCandidates(masterResourceId: string): Promise<DetailCandidate[]> {
    return masterDetail.listDetailCandidates(this.ctx, masterResourceId);
  }

  /** The junction tables linking `recordResourceId` to another table - a form field's Junction table (DataViews.md §8.5). */
  listJunctions(recordResourceId: string): Promise<JunctionCandidate[]> {
    return junctions.listJunctions(this.ctx, recordResourceId);
  }

  /** One junction table of `recordResourceId`, by id - null when it isn't one (any more). */
  getJunction(recordResourceId: string, junctionResourceId: string): Promise<JunctionCandidate | null> {
    return junctions.getJunction(this.ctx, recordResourceId, junctionResourceId);
  }

  update(id: string, patch: UpdateDataViewInput): Promise<AdminDataView> {
    return crud.updateDataView(this.ctx, id, patch);
  }

  delete(id: string): Promise<void> {
    return crud.deleteDataView(this.ctx, id);
  }

  /** Draft-only save of the DataView's client-side controller code - never visible to consumers until `publish()` runs. */
  updateCode(dataviewId: string, code: string): Promise<void> {
    return crud.updateCode(this.ctx, dataviewId, code);
  }

  /** Save as (Foundations.md §13.4): a NEW DataView whose draft is version `version`'s content - see `duplicateVersion`. */
  duplicateVersion(dataviewId: string, version: number, input: { name: string; slug?: string | undefined }): Promise<AdminDataView> {
    return crud.duplicateVersion(this.ctx, dataviewId, version, input);
  }

  // --- Versions (dataviews-versions.ts)

  /** Foundations.md §13.5 - see `HAS_UNPUBLISHED_CHANGES_SQL`. */
  hasUnpublishedChanges(dataviewId: string): Promise<boolean> {
    return versions.hasUnpublishedChanges(this.ctx, dataviewId);
  }

  /** What publishing should warn about, never refuse (DataViews.md §6.5). */
  /** What stops it from working, and for whom (dataviews-diagnosis.ts) - every answer about a role from `permissions`. */
  diagnose(dataviewId: string, permissions: EffectivePermissionService): Promise<DiagnosisIssue[]> {
    return diagnoseDataView(this.ctx, permissions, dataviewId);
  }

  publishWarnings(dataviewId: string): Promise<string[]> {
    return versions.publishWarnings(this.ctx, dataviewId);
  }

  /** Snapshots the draft as the next version - a no-op when the draft equals the latest. See `publish`. */
  publish(dataviewId: string, userId: string | null, note: string | null = null): Promise<AdminDataViewPublish> {
    return versions.publish(this.ctx, dataviewId, userId, note);
  }

  /** Newest first, summary only (no snapshot payloads, which can be large). */
  listVersions(dataviewId: string): Promise<AdminDataViewPublish[]> {
    return versions.listVersions(this.ctx, dataviewId);
  }

  /** Deletes every version before `before` (Foundations.md §13.4) - never the live one. */
  deleteVersionsBefore(dataviewId: string, before: number): Promise<{ deleted: number[] }> {
    return versions.deleteDataViewVersionsBefore(this.ctx, dataviewId, before);
  }

  /** One version's full content, shaped like the published read path - the read-only preview. */
  getVersion(dataviewId: string, version: number): Promise<Omit<AdminDataViewPublish, "dataview"> & { dataview: AdminDataView; fields: AdminDataViewField[] }> {
    return versions.getVersion(this.ctx, dataviewId, version);
  }

  /** Restore (Foundations.md §13.4): version `version`'s content replaces the draft; publishes nothing. */
  restore(dataviewId: string, version: number): Promise<AdminDataView> {
    return versions.restore(this.ctx, dataviewId, version);
  }

  // --- Presentation impact (dataviews-presentation.ts, DataViews.md §15)

  /** The DataViews that show one column of a resource - what a change to its presentation reaches. */
  dataviewsShowingColumn(resourceId: string, column: string): Promise<{ id: string; name: string }[]> {
    return presentation.dataviewsShowingColumn(this.ctx, resourceId, column);
  }

  /** The published DataViews a change to `resourceId`'s columns' presentation reaches. */
  affectedByColumnPresentation(resourceId: string): Promise<AffectedDataView[]> {
    return presentation.affectedByColumnPresentation(this.ctx, resourceId);
  }
}
