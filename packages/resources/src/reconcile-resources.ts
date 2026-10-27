import { relationDetailCache, resourceFunctionSql, resourceRelationSql, type CatalogObject } from "@totalbase/pg-catalog";
import { isExposureFixed } from "@totalbase/shared";
import type { Database, Queryable } from "@totalbase/database";
import { syncRealtimePublication } from "./realtime-publication.js";

export interface ReconcileResourcesResult {
  discovered: number;
  reactivated: number;
  missing: number;
  purged: number;
}

/**
 * Reconciles the PostgreSQL catalog snapshot against totalbase.resources.
 * See Foundations.md §11.7 and §12.
 *
 * Rules:
 * - identity follows postgres_oid: rename preserves the TotalBase resource;
 * - drop+create with the same name is a new OID => a new resource, hidden by default;
 * - newly discovered resources always start with exposed_methods = '{}'
 *   (hidden - see resources-admin-service.ts, exposure is entirely
 *   whether any HTTP method is in that array, no separate flag) - except
 *   TotalBase's own tables, whose exposure is fixed (TOTALBASE_EXPOSURE);
 * - resources no longer present in the catalog are marked MISSING, then
 *   purged outright in the same pass (see purgeMissing() below) - a
 *   dropped OID can never come back (Postgres never reuses one, and a
 *   same-named recreate is a NEW oid per the rule above), so there's
 *   nothing left for MISSING to preserve. The chat that added this
 *   explicitly chose "purge every sync" over "keep as a permanent audit
 *   trail" once the accumulation from routine drop/recreate testing
 *   became visible in practice.
 */
/**
 * The exposure of TotalBase's own tables - fixed, not editable
 * (Security.md §10.1). The portal's screens, the
 * administrator's included, read and write these tables through the Data
 * API, which requires the method to be exposed for everyone; an exposure
 * narrowed by hand would break them. Exposure grants nothing by itself -
 * every access still needs a permission, and the guardrails decide what no
 * permission can lift. A TotalBase table not listed here is not exposed.
 * Enforced on every reconcile, so it also repairs a hand-edited row.
 */
export const TOTALBASE_EXPOSURE: Readonly<Record<string, readonly string[]>> = {
  users: ["GET", "POST", "PATCH", "DELETE"],
  roles: ["GET", "POST", "PATCH", "DELETE"],
  folders: ["GET", "POST", "PATCH", "DELETE"],
  templates: ["GET", "POST", "PATCH", "DELETE"],
  users_roles: ["GET", "POST", "DELETE"],
  roles_managers: ["GET", "POST", "DELETE"],
  dataviews_roles: ["GET", "POST", "DELETE"],
  dashboards_roles: ["GET", "POST", "DELETE"],
  sessions: ["GET", "PATCH"],
  tokens: ["GET", "PATCH", "DELETE"],
  // The transactions capability: the role editor's "Can run transactions"
  // switch writes it here - administrators only (the guardrail).
  roles_capabilities: ["GET", "POST", "PATCH", "DELETE"],
  // Access reviews (Security.md §1.8): recorded and read, never changed - administrators only (the guardrail).
  roles_reviews: ["GET", "POST"],
  permissions: ["GET"],
  menus: ["GET"],
  resources: ["GET"],
  logs: ["GET"],
  files: ["GET"],
};

/** TotalBase's own tables' fixed exposure (Security.md §10.1) - null for an application resource, whose exposure an administrator chooses. */
export function fixedExposure(schema: string, name: string): string[] | null {
  return isExposureFixed(schema) ? [...(TOTALBASE_EXPOSURE[name] ?? [])] : null;
}

export async function reconcileResources(
  database: Database,
  catalog: CatalogObject[],
): Promise<ReconcileResourcesResult> {
  const exposable = catalog.filter((object) => object.resourceType !== undefined);
  const oids = exposable.map((object) => object.oid);

  return database.transaction(async (client) => {
    // One reconcile at a time (the admin's actions, the scheduled sync,
    // several server processes): two passes would otherwise both insert
    // the same new OID, or one would act on a snapshot older than the
    // other's writes.
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('totalbase.reconcile_resources'))`);
    // Set-based, in three statements whatever the catalog's size: the counts first
    // (what is new, what comes back from MISSING), then one UPDATE that touches only a row whose schema, name,
    // status or fixed exposure really changed - an unchanged resource keeps its updated_at, so a sync
    // doesn't bump the OpenAPI revision for every table - then one INSERT of the new OIDs.
    const input = JSON.stringify(exposable.map((object) => ({
      oid: object.oid,
      schema: object.schema,
      name: object.name,
      type: object.resourceType,
      functionClass: object.resourceType === "FUNCTION" ? "UNCLASSIFIED" : null,
      fixedExposure: fixedExposure(object.schema, object.name),
    })));
    const INPUT = `jsonb_to_recordset($1::jsonb) AS i(oid oid, schema text, name text, type text, "functionClass" text, "fixedExposure" text[])`;
    const { rows: counted } = await client.query<{ discovered: number; reactivated: number }>(
      `SELECT count(*) FILTER (WHERE r.id IS NULL)::int AS discovered,
              count(*) FILTER (WHERE r.status = 'MISSING')::int AS reactivated
       FROM ${INPUT} LEFT JOIN totalbase.resources r ON r.postgres_oid = i.oid`,
      [input],
    );
    const discovered = counted[0]?.discovered ?? 0;
    const reactivated = counted[0]?.reactivated ?? 0;
    // Rename (schema/name change) preserves identity because we match on OID.
    await client.query(
      `UPDATE totalbase.resources r
       SET "schema" = i.schema, name = i.name, status = 'ACTIVE',
           exposed_methods = coalesce(i."fixedExposure", r.exposed_methods), updated_at = now()
       FROM ${INPUT}
       WHERE r.postgres_oid = i.oid
         AND (r."schema", r.name, r.status, r.exposed_methods)
             IS DISTINCT FROM (i.schema, i.name, 'ACTIVE', coalesce(i."fixedExposure", r.exposed_methods))`,
      [input],
    );
    await client.query(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, function_class, exposed_methods)
       SELECT i.oid, i.schema, i.name, i.type, 'ACTIVE', i."functionClass", coalesce(i."fixedExposure", '{}')
       FROM ${INPUT}
       WHERE NOT EXISTS (SELECT 1 FROM totalbase.resources r WHERE r.postgres_oid = i.oid)`,
      [input],
    );

    const missing = await markMissing(client, oids);
    const purged = await purgeMissing(client);

    // REALTIME off a table that lost what it needs (dropped, its primary key gone), and the publication in
    // step (Data_API.md §16.2). A failure here never fails the reconcile: the next one tries again.
    await client.query("SAVEPOINT realtime_publication");
    try {
      await syncRealtimePublication(client);
      await client.query("RELEASE SAVEPOINT realtime_publication");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT realtime_publication");
    }

    // A reconcile is how DDL reaches TotalBase - the schema editor's own,
    // the catalog watch's and the scheduled sync's: what was introspected
    // of any relation before it may be stale now (relation-detail-cache.ts).
    relationDetailCache.clear();
    return { discovered, reactivated, missing, purged };
  });
}

/**
 * PostgreSQL still has the object, as a resource: `catalog` was read before
 * this transaction, so an object created since (e.g. by the table editor,
 * while a scheduled sync was running) is absent from it without being gone.
 * One that stopped being a resource - a table attached as a partition, a
 * function that became an extension's member - is gone all the same.
 */
const STILL_EXISTS = `(EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = r.postgres_oid AND ${resourceRelationSql("c")})
  OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.oid = r.postgres_oid AND ${resourceFunctionSql("p")}
    -- TotalBase's own functions are never resources (catalog-snapshot.ts): one registered before is gone all the same.
    AND p.pronamespace <> 'totalbase'::regnamespace))`;

async function markMissing(client: Queryable, activeOids: number[]): Promise<number> {
  const { rowCount } = await client.query(
    `UPDATE totalbase.resources r
     SET status = 'MISSING', updated_at = now()
     WHERE r.status = 'ACTIVE'
       AND r.postgres_oid <> ALL($1::oid[])
       AND NOT ${STILL_EXISTS}`,
    [activeOids],
  );
  return rowCount;
}

/**
 * Deletes every MISSING resource - both the one markMissing() just produced
 * and any from before this function existed (the backlog that prompted
 * adding it). Cascades into permissions/audits_exclusions/outbox (their
 * own ON DELETE CASCADE) - correct, not data loss: those rows were already
 * inert, pointing at an OID that can never become ACTIVE again. Excludes
 * any resource still referenced as a DataView's own source_resource (that
 * column lives on dataviews itself) - it is ON DELETE RESTRICT, so
 * deleting it would abort this whole transaction. They're left
 * MISSING for a human to notice and fix the DataView first.
 */
async function purgeMissing(client: Queryable): Promise<number> {
  const { rowCount } = await client.query(
    `DELETE FROM totalbase.resources r
     WHERE r.status = 'MISSING'
       AND NOT ${STILL_EXISTS}
       AND NOT EXISTS (SELECT 1 FROM totalbase.dataviews d WHERE d.source_resource = r.id)`,
  );
  return rowCount;
}
