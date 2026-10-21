import type { DataViewsContext } from "./dataviews-types.js";
import { assertExists } from "./dataviews-read.js";

// --- Object access (Security.md §7.1): which roles may
// see and open a published DataView in the App. Never grants data - the
// source resource's permissions still decide every read and write.

export async function listRoles(ctx: DataViewsContext, dataviewId: string): Promise<string[]> {
  await assertExists(ctx, dataviewId);
  const { rows } = await ctx.database.query<{ role: string }>(
    `SELECT role FROM totalbase.dataviews_roles WHERE dataview = $1 ORDER BY created_at`,
    [dataviewId],
  );
  return rows.map((r) => r.role);
}

/** Replaces the whole grant set - the admin UI edits it as one multi-select. */
export async function setRoles(ctx: DataViewsContext, dataviewId: string, roleIds: string[]): Promise<string[]> {
  await assertExists(ctx, dataviewId);
  const unique = [...new Set(roleIds)];
  await ctx.database.transaction(async (client) => {
    await client.query(`DELETE FROM totalbase.dataviews_roles WHERE dataview = $1`, [dataviewId]);
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO totalbase.dataviews_roles (dataview, role) SELECT $1, unnest($2::uuid[])`,
        [dataviewId, unique],
      );
    }
  });
  return unique;
}

/** The DataViews among `dataviewIds` granted to at least one of `roleIds` (Administrators are the caller's check). */
export async function grantedToRoles(ctx: DataViewsContext, dataviewIds: string[], roleIds: string[]): Promise<Set<string>> {
  if (dataviewIds.length === 0 || roleIds.length === 0) return new Set();
  const { rows } = await ctx.database.query<{ dataview: string }>(
    `SELECT DISTINCT dataview FROM totalbase.dataviews_roles WHERE dataview = ANY($1::uuid[]) AND role = ANY($2::uuid[])`,
    [dataviewIds, roleIds],
  );
  return new Set(rows.map((r) => r.dataview));
}

/**
 * Whether `roleIds` reach this DataView: granted to one of them, or
 * embedded (a Detail widget - any field's
 * `related_dataview`) in the live published version of a DataView they
 * reach, at any depth. A DataView embedded in a form opens for whoever
 * can open the form (Security.md §7.1).
 */
export async function reachableByRoles(ctx: DataViewsContext, dataviewId: string, roleIds: string[]): Promise<boolean> {
  if (roleIds.length === 0) return false;
  const { rows } = await ctx.database.query<{ reachable: boolean }>(
    `WITH RECURSIVE reachable(id) AS (
       SELECT dataview FROM totalbase.dataviews_roles WHERE role = ANY($2::uuid[])
       UNION
       SELECT (field->>'related_dataview')::uuid
       FROM reachable r
       JOIN LATERAL (
         SELECT fields_snapshot FROM totalbase.dataviews_versions v
         WHERE v.dataview = r.id ORDER BY v.version DESC LIMIT 1
       ) live ON true
       CROSS JOIN LATERAL jsonb_array_elements(live.fields_snapshot) field
       WHERE field->>'related_dataview' IS NOT NULL
     )
     SELECT EXISTS (SELECT 1 FROM reachable WHERE id = $1) AS reachable`,
    [dataviewId, roleIds],
  );
  return rows[0]?.reachable === true;
}

/** The DataView a field belongs to, or null. */
/**
 * The DataView a field belongs to - its draft row, or a published version
 * holding it: a field the draft already removed still serves the live
 * version until the next publish.
 */
export async function dataviewOfField(ctx: DataViewsContext, fieldId: string): Promise<string | null> {
  const { rows } = await ctx.database.query<{ dataview: string }>(
    `SELECT dataview FROM totalbase.dataviews_fields WHERE id = $1
     UNION ALL
     (SELECT dataview FROM totalbase.dataviews_versions
       WHERE fields_snapshot @> jsonb_build_array(jsonb_build_object('id', $1::text))
       ORDER BY published_at DESC LIMIT 1)
     LIMIT 1`,
    [fieldId],
  );
  return rows[0]?.dataview ?? null;
}
