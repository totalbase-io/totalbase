/**
 * A process-wide cache of what getRelationDetail() introspects, keyed by
 * the relation's OID (and the Database it was read through - one TotalBase
 * process talks to one PostgreSQL database, but a test may open several
 * Database instances and must never see another's entries as its own).
 *
 * Why: every Data API request resolves its root resource's columns, keys
 * and constraints, and every traversed relation's too - five catalog
 * queries each (Data_API.md §1.2). The catalog changes only
 * on DDL, so those reads are the same answer request after request.
 *
 * Invalidation is by clearing everything - entries are small and DDL is
 * rare, so there is nothing to gain from per-OID precision:
 * - DDL TotalBase itself runs clears it where it runs: a schema-management
 *   operation (always followed by a reconcile - reconcileResources() clears),
 *   a SQL Console run (SqlConsoleService.execute(), which workflows' SQL
 *   steps also go through), and every non-GET Admin API response as a
 *   backstop (apps/server's server.ts, beside the OpenAPI cache's own
 *   invalidation).
 * - DDL made outside TotalBase (psql, a migration tool) is noticed by the
 *   catalog fingerprint watch (catalog.watch_interval_seconds) and the
 *   scheduled sync (catalog.refresh_interval_minutes): both end in
 *   reconcileResources(), which clears. Until the watch's next tick, a
 *   column added from outside is not yet in a Data API read - the same
 *   window its resource row already had (Foundations.md §12.4).
 *
 * A pending load is cached as its promise, so concurrent requests for the
 * same relation share one introspection; a failed load is dropped, so the
 * next request tries again.
 */
export class RelationDetailCache<T> {
  private entries = new WeakMap<object, Map<number, Promise<T>>>();
  /** Off, every read introspects - for a test that changes the catalog by hand between reads. */
  enabled = true;

  async get(database: object, oid: number, load: () => Promise<T>): Promise<T> {
    if (!this.enabled) return load();
    let byOid = this.entries.get(database);
    if (!byOid) {
      byOid = new Map();
      this.entries.set(database, byOid);
    }
    const cached = byOid.get(oid);
    if (cached) return cached;
    const loading = load();
    byOid.set(oid, loading);
    loading.catch(() => {
      if (byOid.get(oid) === loading) byOid.delete(oid);
    });
    return loading;
  }

  /** One relation changed (or went away): forget what was read of it. */
  invalidate(database: object, oid: number): void {
    this.entries.get(database)?.delete(oid);
  }

  /** The catalog may have changed: forget everything, for every Database. */
  clear(): void {
    this.entries = new WeakMap();
  }
}
