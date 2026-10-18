import { buildCatalogSnapshot, getCatalogFingerprint, relationDetailCache } from "@totalbase/pg-catalog";
import { brokenDataViewReferences } from "@totalbase/dataviews";
import { reconcileResources, syncAllResourceColumns, syncResourceDescriptions } from "@totalbase/resources";
import type { AppContext } from "./context.js";

/**
 * Brings TotalBase's resources in line with the PostgreSQL catalog after
 * DDL: new objects discovered (hidden), dropped ones MISSING, renames kept
 * by OID. Also drops cached OpenAPI documents and introspected relation
 * details and dashboard widgets' planned columns - DDL is the one change no
 * trigger reports (openapi-cache.ts, @totalbase/pg-catalog's
 * relation-detail-cache.ts, DashboardsAdminService.forgetPlans; reconcileResources()
 * clears the latter itself, repeated here so the two caches read as one
 * decision).
 */
export async function reconcileCatalog(context: AppContext) {
  const snapshot = await buildCatalogSnapshot(context.database);
  const result = await reconcileResources(context.database, snapshot);
  context.openApiCache.invalidate();
  relationDetailCache.clear();
  // Published widgets' planned columns, too: DDL may have changed what a query returns.
  context.dashboardsAdmin.forgetPlans();
  return result;
}

/**
 * What still names a column, a table or view PostgreSQL no longer has
 * (Specification_DataViews.md §4.8, Specification_Dashboards.md §2.8): dashboard
 * widgets whose query PostgreSQL refuses, DataViews whose layouts or Filter name a
 * column their source lost. Narrowed to one resource: its DataViews, and the
 * widgets whose query names its table or view.
 */
export async function brokenReferences(context: AppContext, resourceId?: string) {
  const timeoutMs = await context.settings.get("dashboards.query_timeout_ms");
  let dashboards = await context.dashboardsAdmin.brokenWidgets(timeoutMs);
  let dataviews = await brokenDataViewReferences(context.database);
  if (resourceId) {
    const resource = await context.resourcesAdmin.get(resourceId);
    const names = new RegExp(`(^|[^a-z0-9_])"?${resource.name.replace(/[^a-z0-9_]/gi, "")}"?($|[^a-z0-9_])`, "i");
    dashboards = dashboards.filter((widget) => widget.query !== null && names.test(widget.query));
    dataviews = dataviews.filter((reference) => reference.resource === resourceId);
  }
  return { dashboards, dataviews };
}

/**
 * The full "Sync resources" pass - the admin's manual action and the
 * catalog.refresh_interval_minutes job: reconcile, then pull column
 * changes, then (catalog.track_comments) keep each resource's description
 * and PostgreSQL's own COMMENT ON in step. `descriptions` is null when
 * comments aren't tracked. `autoPresentation` then fills what each column's type and constraints suggest
 * and it lacks (Suggest presentation, never a value of its own - `presentedColumns`, null
 * when not asked). When a column was renamed or removed, or a resource went
 * MISSING, `brokenReferences` lists what still names what's gone (null otherwise).
 */
export async function syncCatalog(context: AppContext, options: { autoPresentation?: boolean } = {}) {
  const result = await reconcileCatalog(context);
  const columns = await syncAllResourceColumns(context.database);
  const descriptions = (await context.settings.get("catalog.track_comments"))
    ? await syncResourceDescriptions(context.database)
    : null;
  const presentedColumns = options.autoPresentation
    ? await context.resourcesAdmin.applyPresentationFills()
    : null;
  const lostSomething = result.missing > 0 || columns.renamed > 0 || columns.removed > 0;
  return { ...result, columns, descriptions, presentedColumns, brokenReferences: lostSomething ? await brokenReferences(context) : null };
}

/**
 * The catalog.watch_interval_seconds job: a full sync only when the
 * catalog's fingerprint differs from `previous` (the one this returned last
 * time), so DDL made outside TotalBase shows up within seconds while an
 * unchanged schema costs one small query. `result` is null when nothing
 * changed. The fingerprint is read again after a sync - its own COMMENT ON
 * (catalog.track_comments) must not count as the next change.
 */
export async function syncCatalogIfChanged(context: AppContext, previous: string) {
  const current = await getCatalogFingerprint(context.database);
  if (current === previous) return { fingerprint: current, result: null };
  const result = await syncCatalog(context);
  return { fingerprint: await getCatalogFingerprint(context.database), result };
}
