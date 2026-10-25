import { DASHBOARD_REFRESH_INTERVALS, isDashboardRefreshInterval, type DashboardRefreshInterval } from "@totalbase/tb-catalog";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import { validateRoleColor } from "@totalbase/permissions";
import { slugify, validateDescription, validateMenuLabel, validateName, validateSlug } from "@totalbase/shared";
import { validateTabs, type DashboardTab } from "./tabs.js";
import { validateVariables } from "./variables.js";
import { toAdminDashboard, type AdminDashboard, type CreateDashboardInput, type DashboardRow, type DashboardsContext, type UpdateDashboardInput } from "./dashboards-types.js";
import { checkVariableSources } from "./dashboards-variable-options.js";
import { forgetSnapshots, HAS_UNPUBLISHED_CHANGES_SQL, hasUnpublishedChanges } from "./dashboards-versions.js";

export function validateRefreshInterval(raw: unknown): DashboardRefreshInterval | null {
  if (raw === null || raw === undefined) return null;
  if (!isDashboardRefreshInterval(raw)) {
    throw new TotalBaseError(
      "INVALID_DASHBOARD_REFRESH_INTERVAL",
      `refreshIntervalSeconds must be null (off) or one of: ${DASHBOARD_REFRESH_INTERVALS.map((interval) => interval.seconds).join(", ")}`,
    );
  }
  return raw;
}

export function remapDashboardUniqueViolation(error: unknown): never {
  return remapUniqueViolation(
    error,
    [{ constraint: "dashboards_slug_key", code: "DASHBOARD_SLUG_DUPLICATE", message: "A Dashboard with this slug already exists." }],
    { code: "DASHBOARD_NAME_DUPLICATE", message: "A Dashboard with this name already exists." },
  );
}

export const DASHBOARD_COLUMNS = "id, name, slug, description, menu_label, icon, color, scope, refresh_interval_seconds, embedding_enabled, delegable, variables, tabs, created_at, updated_at";

/** Every dashboard with its versioning status - the admin's Dashboards list marks drafts and unpublished changes. */
export async function listDashboards(ctx: DashboardsContext): Promise<AdminDashboard[]> {
  const { rows } = await ctx.database.query<DashboardRow & { live_version: number | null; has_unpublished_changes: boolean }>(
    `SELECT ${DASHBOARD_COLUMNS},
            (SELECT MAX(v.version) FROM totalbase.dashboards_versions v WHERE v.dashboard = d.id) AS live_version,
            ${HAS_UNPUBLISHED_CHANGES_SQL} AS has_unpublished_changes
     FROM totalbase.dashboards d
     ORDER BY name`,
  );
  return rows.map((row) => ({ ...toAdminDashboard(row), liveVersion: row.live_version, hasUnpublishedChanges: row.has_unpublished_changes }));
}

/**
 * Apps list and menu: published, LISTED dashboards only - an
 * EMBEDDED_ONLY one is mounted in DataView pages, never listed (it stays
 * reachable by its slug for anyone granted). `roleIds === null` means an
 * Administrator (every such dashboard); otherwise only those granted to
 * at least one of the caller's roles.
 */
export async function listPublished(ctx: DashboardsContext, roleIds: string[] | null): Promise<AdminDashboard[]> {
  const { rows } = await ctx.database.query<DashboardRow>(
    `SELECT ${DASHBOARD_COLUMNS} FROM totalbase.dashboards d
     WHERE d.scope = 'LISTED'
       AND EXISTS (SELECT 1 FROM totalbase.dashboards_versions p WHERE p.dashboard = d.id)
       AND ($1::uuid[] IS NULL OR EXISTS (
         SELECT 1 FROM totalbase.dashboards_roles r WHERE r.dashboard = d.id AND r.role = ANY($1::uuid[])
       ))
     ORDER BY name`,
    [roleIds],
  );
  return rows.map(toAdminDashboard);
}

/** Published dashboards kept out of the App menu (`EMBEDDED_ONLY`) - the App menu editor's Hidden section. */
export async function listHiddenFromMenu(ctx: DashboardsContext): Promise<AdminDashboard[]> {
  const { rows } = await ctx.database.query<DashboardRow>(
    `SELECT ${DASHBOARD_COLUMNS} FROM totalbase.dashboards d
     WHERE d.scope = 'EMBEDDED_ONLY'
       AND EXISTS (SELECT 1 FROM totalbase.dashboards_versions p WHERE p.dashboard = d.id)
     ORDER BY name`,
  );
  return rows.map(toAdminDashboard);
}

/** Whether any of `roleIds` is granted this dashboard (Administrators are checked by the caller, not here). */
export async function isVisibleToRoles(ctx: DashboardsContext, dashboardId: string, roleIds: string[]): Promise<boolean> {
  const { rows } = await ctx.database.query<{ visible: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM totalbase.dashboards_roles WHERE dashboard = $1 AND role = ANY($2::uuid[])
     ) AS visible`,
    [dashboardId, roleIds],
  );
  return rows[0]?.visible === true;
}

export async function getDashboard(ctx: DashboardsContext, id: string): Promise<AdminDashboard> {
  const { rows } = await ctx.database.query<DashboardRow>(
    `SELECT ${DASHBOARD_COLUMNS} FROM totalbase.dashboards WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DASHBOARD_NOT_FOUND", `Dashboard not found: ${id}`);
  return toAdminDashboard(row);
}

/** get() plus the draft-vs-latest-version flag (Foundations.md §13.5) - the editor's GET only; everything else uses the cheaper get(). */
export async function getWithStatus(ctx: DashboardsContext, id: string): Promise<AdminDashboard> {
  const dashboard = await getDashboard(ctx, id);
  return { ...dashboard, hasUnpublishedChanges: await hasUnpublishedChanges(ctx, dashboard.id) };
}

export async function getDashboardBySlug(ctx: DashboardsContext, slug: string): Promise<AdminDashboard> {
  const { rows } = await ctx.database.query<DashboardRow>(
    `SELECT ${DASHBOARD_COLUMNS} FROM totalbase.dashboards WHERE slug = $1`,
    [slug],
  );
  const row = rows[0];
  if (!row) throw new TotalBaseError("DASHBOARD_NOT_FOUND", `Dashboard not found: ${slug}`);
  return toAdminDashboard(row);
}

export async function createDashboard(ctx: DashboardsContext, input: CreateDashboardInput): Promise<AdminDashboard> {
  const name = validateName(input.name);
  const slug = validateSlug(input.slug?.trim() ? input.slug : slugify(name));
  const description = validateDescription(input.description);
  const color = validateRoleColor(input.color, "INVALID_DASHBOARD_COLOR");
  const refreshIntervalSeconds = validateRefreshInterval(input.refreshIntervalSeconds);

  try {
    const { rows } = await ctx.database.query<DashboardRow>(
      `INSERT INTO totalbase.dashboards (name, slug, description, icon, color, scope, refresh_interval_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${DASHBOARD_COLUMNS}`,
      [name, slug, description, input.icon ?? null, color, input.scope ?? "LISTED", refreshIntervalSeconds],
    );
    return toAdminDashboard(rows[0]!);
  } catch (error) {
    remapDashboardUniqueViolation(error);
  }
}

export async function updateDashboard(ctx: DashboardsContext, id: string, patch: UpdateDashboardInput): Promise<AdminDashboard> {
  await getDashboard(ctx, id); // 404s early if missing

  const name = patch.name !== undefined ? validateName(patch.name) : undefined;
  const slug = patch.slug !== undefined ? validateSlug(patch.slug) : undefined;
  const description = patch.description !== undefined ? validateDescription(patch.description) : undefined;
  const menuLabel = patch.menuLabel !== undefined ? validateMenuLabel(patch.menuLabel) : undefined;
  const color = patch.color !== undefined ? validateRoleColor(patch.color, "INVALID_DASHBOARD_COLOR") : undefined;
  const refreshIntervalSeconds = patch.refreshIntervalSeconds !== undefined ? validateRefreshInterval(patch.refreshIntervalSeconds) : undefined;

  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const [column, value] of [
    ["name", name],
    ["slug", slug],
    ["description", description],
    ["menu_label", menuLabel],
    ["icon", patch.icon],
    ["color", color],
    ["scope", patch.scope],
    ["refresh_interval_seconds", refreshIntervalSeconds],
    ["embedding_enabled", typeof patch.embeddingEnabled === "boolean" ? patch.embeddingEnabled : undefined],
    ["delegable", typeof patch.delegable === "boolean" ? patch.delegable : undefined],
  ] as const) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (patch.variables !== undefined) {
    const variables = validateVariables(patch.variables);
    await checkVariableSources(ctx, variables);
    values.push(JSON.stringify(variables));
    sets.push(`variables = $${values.length}::jsonb`);
  }
  const tabs = patch.tabs !== undefined ? validateTabs(patch.tabs) : undefined;
  if (tabs !== undefined) {
    await assertTabsKeepWidgets(ctx, id, tabs);
    values.push(JSON.stringify(tabs));
    sets.push(`tabs = $${values.length}::jsonb`);
  }
  if (sets.length === 0) return getDashboard(ctx, id);
  sets.push(`updated_at = now()`);

  try {
    return await ctx.database.transaction(async (client) => {
      const { rows } = await client.query<DashboardRow>(
        `UPDATE totalbase.dashboards SET ${sets.join(", ")} WHERE id = $1 RETURNING ${DASHBOARD_COLUMNS}`,
        values,
      );
      // No tabs left: every widget joins the one grid.
      if (tabs !== undefined && tabs.length === 0) await client.query(`UPDATE totalbase.dashboards_widgets SET tab = NULL WHERE dashboard = $1 AND tab IS NOT NULL`, [id]);
      return toAdminDashboard(rows[0]!);
    });
  } catch (error) {
    remapDashboardUniqueViolation(error);
  }
}

/**
 * A tab that holds widgets stays (D7): refused with DASHBOARD_TAB_NOT_EMPTY, naming each tab and its widgets - move
 * them first (a widget unset is the first tab's). An empty list is the exception: every widget joins one grid.
 */
export async function assertTabsKeepWidgets(ctx: DashboardsContext, dashboardId: string, tabs: DashboardTab[]): Promise<void> {
  if (tabs.length === 0) return;
  const current = (await getDashboard(ctx, dashboardId)).tabs;
  if (current.length === 0) return;
  const kept = new Set(tabs.map((t) => t.value));
  const first = current[0]!.value;
  const { rows } = await ctx.database.query<{ tab: string; labels: string[] }>(
    `SELECT coalesce(tab, $2) AS tab, array_agg(coalesce(label, type) ORDER BY grid_y, grid_x) AS labels
     FROM totalbase.dashboards_widgets WHERE dashboard = $1 GROUP BY 1`,
    [dashboardId, first],
  );
  // A widget unset follows the first tab: it may move with a renamed first tab only if that first tab stays.
  const holding = rows.filter((r) => !kept.has(r.tab) && !(r.tab === first && kept.has(tabs[0]!.value) && tabs[0]!.value === first));
  if (holding.length) {
    throw new TotalBaseError("DASHBOARD_TAB_NOT_EMPTY", `A tab with widgets can't be removed - move them first: ${holding.map((r) => `"${r.tab}" holds ${r.labels.map((l) => `"${l}"`).join(", ")}`).join("; ")}.`);
  }
}

export async function deleteDashboard(ctx: DashboardsContext, id: string): Promise<void> {
  const { rowCount } = await ctx.database.query(`DELETE FROM totalbase.dashboards WHERE id = $1`, [id]);
  if (!rowCount) throw new TotalBaseError("DASHBOARD_NOT_FOUND", `Dashboard not found: ${id}`);
  forgetSnapshots(ctx, id);
}

// --- Roles (who may view the published dashboard in Apps) ---

export async function listRoles(ctx: DashboardsContext, dashboardId: string): Promise<string[]> {
  await getDashboard(ctx, dashboardId);
  const { rows } = await ctx.database.query<{ role: string }>(
    `SELECT role FROM totalbase.dashboards_roles WHERE dashboard = $1 ORDER BY created_at`,
    [dashboardId],
  );
  return rows.map((r) => r.role);
}

/** Replaces the whole grant set - the admin UI edits it as one multi-select. */
export async function setRoles(ctx: DashboardsContext, dashboardId: string, roleIds: string[]): Promise<string[]> {
  await getDashboard(ctx, dashboardId);
  const unique = [...new Set(roleIds)];
  await ctx.database.transaction(async (client) => {
    await client.query(`DELETE FROM totalbase.dashboards_roles WHERE dashboard = $1`, [dashboardId]);
    if (unique.length > 0) {
      await client.query(
        `INSERT INTO totalbase.dashboards_roles (dashboard, role) SELECT $1, unnest($2::uuid[])`,
        [dashboardId, unique],
      );
    }
  });
  return unique;
}
