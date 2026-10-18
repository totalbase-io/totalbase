import type { Database } from "@totalbase/database";
import { TotalBaseError, type TotalBaseErrorCode } from "@totalbase/errors";
import { validateDescription } from "@totalbase/shared";

/** Name of the single reserved role that grants full Control Plane access. */
export const ADMINISTRATORS_ROLE_NAME = "Administrators";

/**
 * How a role's members reach TotalBase - three
 * independent flags, each a permission granted by the role (Core RBAC):
 *
 * - adminAccess: the portal in admin mode, plus a full bypass of
 *   permissions. Reserved roles only (a CHECK constraint) -
 *   never settable through the API.
 * - appAccess: the portal in app mode (published DataViews/dashboards).
 * - apiAccess: programmatic credentials - POST /api/auth/login, the
 *   data-plane OAuth login, and personal plane=API tokens.
 *
 * A user's effective access is each flag OR-ed across their active roles.
 */
export interface RoleAccessFlags {
  adminAccess: boolean;
  appAccess: boolean;
  apiAccess: boolean;
}

/** The flags a request may set on an ordinary role - adminAccess is reserved-only. */
export type AssignableRoleAccessFlags = Partial<Pick<RoleAccessFlags, "appAccess" | "apiAccess">>;

/**
 * Which portal a caller opens: ADMIN (the admin, plus the app as a
 * preview) or APP (the app only). Derived from the flags - adminAccess
 * wins - for the portal routes that only need to pick a surface.
 */
export type PortalAccess = "ADMIN" | "APP";

export function portalAccessOf(flags: RoleAccessFlags): PortalAccess | null {
  if (flags.adminAccess) return "ADMIN";
  if (flags.appAccess) return "APP";
  return null;
}

const NO_ACCESS: RoleAccessFlags = { adminAccess: false, appAccess: false, apiAccess: false };

/**
 * Fixed icon choices for a role's cosmetic display (roles list, like
 * database/resources.vue's type icons) - a curated set kept in code, not
 * a DB CHECK like `color`'s, since it's expected to grow over time
 * without needing a migration each time. Validated server-side so a
 * request can't set an arbitrary/misspelled icon name that would
 * silently render blank; PostgreSQL checks the shape only
 * (`roles_icon_valid`), for writers that skip this
 * service such as the Data API.
 */
export const ROLE_ICON_OPTIONS = [
  "i-lucide-shield",
  "i-lucide-shield-check",
  "i-lucide-shield-alert",
  "i-lucide-key",
  "i-lucide-lock",
  "i-lucide-lock-open",
  "i-lucide-crown",
  "i-lucide-users",
  "i-lucide-user",
  "i-lucide-user-cog",
  "i-lucide-user-check",
  "i-lucide-user-plus",
  "i-lucide-user-x",
  "i-lucide-briefcase",
  "i-lucide-building",
  "i-lucide-building-2",
  "i-lucide-store",
  "i-lucide-factory",
  "i-lucide-warehouse",
  "i-lucide-truck",
  "i-lucide-wrench",
  "i-lucide-settings",
  "i-lucide-sliders-horizontal",
  "i-lucide-eye",
  "i-lucide-eye-off",
  "i-lucide-pencil",
  "i-lucide-database",
  "i-lucide-server",
  "i-lucide-cpu",
  "i-lucide-hard-drive",
  "i-lucide-cloud",
  "i-lucide-bot",
  "i-lucide-star",
  "i-lucide-heart",
  "i-lucide-flag",
  "i-lucide-bookmark",
  "i-lucide-tag",
  "i-lucide-tags",
  "i-lucide-folder",
  "i-lucide-folder-open",
  "i-lucide-file-text",
  "i-lucide-clipboard",
  "i-lucide-clipboard-check",
  "i-lucide-calendar",
  "i-lucide-clock",
  "i-lucide-map-pin",
  "i-lucide-globe",
  "i-lucide-compass",
  "i-lucide-send",
  "i-lucide-mail",
  "i-lucide-message-circle",
  "i-lucide-message-square",
  "i-lucide-phone",
  "i-lucide-bell",
  "i-lucide-credit-card",
  "i-lucide-wallet",
  "i-lucide-coins",
  "i-lucide-receipt",
  "i-lucide-shopping-cart",
  "i-lucide-shopping-bag",
  "i-lucide-package",
  "i-lucide-box",
  "i-lucide-plane",
  "i-lucide-car",
  "i-lucide-ship",
  "i-lucide-leaf",
  "i-lucide-sun",
  "i-lucide-moon",
  "i-lucide-zap",
  "i-lucide-flame",
  "i-lucide-activity",
  "i-lucide-stethoscope",
  "i-lucide-microscope",
  "i-lucide-flask-conical",
  "i-lucide-book",
  "i-lucide-book-open",
  "i-lucide-graduation-cap",
  "i-lucide-palette",
  "i-lucide-camera",
  "i-lucide-video",
  "i-lucide-music",
  "i-lucide-headphones",
  "i-lucide-gamepad-2",
  "i-lucide-trophy",
  "i-lucide-target",
  "i-lucide-rocket",
  "i-lucide-satellite",
  "i-lucide-wifi",
  "i-lucide-battery",
  "i-lucide-plug",
  "i-lucide-lightbulb",
  "i-lucide-gauge",
  "i-lucide-filter",
  "i-lucide-search",
  "i-lucide-layers",
  "i-lucide-grid-3x3",
  "i-lucide-list",
  "i-lucide-table",
  "i-lucide-chart-bar",
  "i-lucide-chart-line",
  "i-lucide-pie-chart",
  "i-lucide-trending-up",
  "i-lucide-code",
  "i-lucide-terminal",
  "i-lucide-git-branch",
  "i-lucide-bug",
  "i-lucide-puzzle",
] as const;
export type RoleIcon = (typeof ROLE_ICON_OPTIONS)[number];
export const DEFAULT_ROLE_ICON: RoleIcon = "i-lucide-shield";

/**
 * Tailwind's full base palette (17 hues), the same list Nuxt UI's own
 * dashboard template offers for its "change the app's Primary color"
 * picker (app/components/UserMenu.vue there) - not this app's 7
 * semantic tokens (primary/secondary/...), which only cover the small
 * set of colors app.config.ts happens to alias. Rendered everywhere as
 * a raw swatch (inline `var(--color-<name>-500|400)`, light/dark - see
 * ColorPickerField.vue and roleColorVars() below), never through a
 * component's `color` prop, since that prop only resolves the 7
 * semantic keys. Also enforced by a DB CHECK (roles_color_allowed).
 */
export const ROLE_COLOR_OPTIONS = [
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;
export type RoleColor = (typeof ROLE_COLOR_OPTIONS)[number];
export const DEFAULT_ROLE_COLOR: RoleColor = "blue";

export interface Role {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  active: boolean;
  reserved: boolean;
  /** See RoleAccessFlags. adminAccess only ever appears on a reserved role. */
  adminAccess: boolean;
  appAccess: boolean;
  apiAccess: boolean;
  createdAt: Date;
}

interface RoleRow {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  color: string | null;
  active: boolean;
  reserved: boolean;
  admin_access: boolean;
  app_access: boolean;
  api_access: boolean;
  created_at: Date;
}

function toRole(row: RoleRow): Role {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    icon: row.icon,
    color: row.color,
    active: row.active,
    reserved: row.reserved,
    adminAccess: row.admin_access,
    appAccess: row.app_access,
    apiAccess: row.api_access,
    createdAt: row.created_at,
  };
}

const MAX_ROLE_NAME_LENGTH = 64;

/** Trimmed role name; `undefined` = leave untouched (update). Empty or too long is rejected. */
function validateRoleName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) throw new TotalBaseError("INVALID_QUERY", "A role's name can't be empty.");
  if (trimmed.length > MAX_ROLE_NAME_LENGTH) {
    throw new TotalBaseError("INVALID_QUERY", `A role's name can't be longer than ${MAX_ROLE_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/** PostgreSQL's own UNIQUE on roles.name decides duplicates - mapped to a readable message. */
function mapRoleNameConflict(error: unknown): never {
  if (error instanceof TotalBaseError && error.code === "UNIQUE_VIOLATION" && error.constraint?.endsWith("roles_name_key")) {
    throw new TotalBaseError("UNIQUE_VIOLATION", "A role with this name already exists.", { httpStatus: 409 });
  }
  throw error;
}

function validateFlag(name: string, value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new TotalBaseError("INVALID_QUERY", `A role's ${name} must be true or false.`);
  }
  return value;
}

function validateIcon(icon: string | null | undefined): string | null {
  if (icon === null || icon === undefined) return null;
  if (!(ROLE_ICON_OPTIONS as readonly string[]).includes(icon)) {
    throw new TotalBaseError("INVALID_QUERY", `Unknown role icon: ${icon}`);
  }
  return icon;
}

/** A role color (ROLE_COLOR_OPTIONS) as a role, a DataView or a Dashboard stores it - null for none; `code` is the caller's own error. */
export function validateRoleColor(color: string | null | undefined, code: TotalBaseErrorCode = "INVALID_QUERY"): RoleColor | null {
  if (color === null || color === undefined) return null;
  if (!(ROLE_COLOR_OPTIONS as readonly string[]).includes(color)) {
    throw new TotalBaseError(code, code === "INVALID_QUERY" ? `Unknown role color: ${color}` : `color must be one of: ${ROLE_COLOR_OPTIONS.join(", ")}`);
  }
  return color as RoleColor;
}

/** Persistence for totalbase.roles. See Specification_Security.md §1.3. */
export class RolesService {
  constructor(private readonly database: Database) {}

  async list(): Promise<Role[]> {
    const { rows } = await this.database.query<RoleRow>(
      `SELECT id, name, description, icon, color, active, reserved, admin_access, app_access, api_access, created_at FROM totalbase.roles ORDER BY name`,
    );
    return rows.map(toRole);
  }

  async findById(id: string): Promise<Role | null> {
    const { rows } = await this.database.query<RoleRow>(
      `SELECT id, name, description, icon, color, active, reserved, admin_access, app_access, api_access, created_at FROM totalbase.roles WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRole(rows[0]) : null;
  }

  /** Id of the reserved "Administrators" role. Seeded by the baseline migration; assumed to always exist. */
  async getAdministratorsRoleId(): Promise<string> {
    const { rows } = await this.database.query<{ id: string }>(
      `SELECT id FROM totalbase.roles WHERE name = $1`,
      [ADMINISTRATORS_ROLE_NAME],
    );
    const row = rows[0];
    if (!row) {
      throw new TotalBaseError("INTERNAL_ERROR", "The reserved Administrators role is missing.");
    }
    return row.id;
  }

  /**
   * The caller's access flags: each one OR-ed across these role ids,
   * counting only ACTIVE roles - a deactivated role grants nothing. One
   * query, re-run on every request by the auth guards rather than cached
   * in the session, so a role change takes effect on the very next
   * request.
   */
  async effectiveAccess(roleIds: string[]): Promise<RoleAccessFlags> {
    if (roleIds.length === 0) return NO_ACCESS;
    const { rows } = await this.database.query<{ admin: boolean; app: boolean; api: boolean }>(
      `SELECT coalesce(bool_or(admin_access), false) AS admin,
              coalesce(bool_or(app_access), false) AS app,
              coalesce(bool_or(api_access), false) AS api
       FROM totalbase.roles WHERE id = ANY($1) AND active`,
      [roleIds],
    );
    const row = rows[0];
    return row ? { adminAccess: row.admin, appAccess: row.app, apiAccess: row.api } : NO_ACCESS;
  }

  /**
   * The App homes these roles set (Specification_Security.md §8.1), in role name order - active roles only. The
   * caller takes the first one its user may open.
   */
  async homes(roleIds: string[]): Promise<{ kind: "DATAVIEW" | "DASHBOARD"; id: string }[]> {
    if (roleIds.length === 0) return [];
    const { rows } = await this.database.query<{ dataview: string | null; dashboard: string | null }>(
      `SELECT home_dataview AS dataview, home_dashboard AS dashboard FROM totalbase.roles
       WHERE id = ANY($1) AND active AND (home_dataview IS NOT NULL OR home_dashboard IS NOT NULL)
       ORDER BY name`,
      [roleIds],
    );
    return rows.map((row) => (row.dataview ? { kind: "DATAVIEW" as const, id: row.dataview } : { kind: "DASHBOARD" as const, id: row.dashboard! }));
  }

  /**
   * Whether any of these role ids grants admin access (full bypass). A
   * non-throwing counterpart to auth-guards.ts's requireAdmin, for call
   * sites that branch behavior instead of rejecting the request.
   */
  async isAdministrator(roleIds: string[]): Promise<boolean> {
    return (await this.effectiveAccess(roleIds)).adminAccess;
  }

  /**
   * Whether these role ids include the active Administrators role - the
   * one gate to the Admin API (auth-guards.ts requireAdmin, plane="ADMIN"
   * tokens). Deliberately narrower than admin_access: the reserved
   * Workflows role also carries that flag, for the data-permission bypass
   * its system account runs workflows with, but a system account is not
   * an administrator.
   */
  async holdsAdministratorsRole(roleIds: string[]): Promise<boolean> {
    if (roleIds.length === 0) return false;
    const { rows } = await this.database.query<{ holds: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM totalbase.roles
         WHERE id = ANY($1) AND active AND reserved AND name = $2
       ) AS holds`,
      [roleIds, ADMINISTRATORS_ROLE_NAME],
    );
    return rows[0]?.holds === true;
  }

  async create(
    name: string,
    options?: { description?: string | null; icon?: string | null; color?: string | null } & AssignableRoleAccessFlags,
  ): Promise<Role> {
    const description = validateDescription(options?.description);
    const icon = validateIcon(options?.icon);
    const color = validateRoleColor(options?.color);
    // A new role starts with app access only (the column defaults).
    const appAccess = validateFlag("appAccess", options?.appAccess) ?? true;
    const apiAccess = validateFlag("apiAccess", options?.apiAccess) ?? false;
    const validName = validateRoleName(name)!;
    try {
      const { rows } = await this.database.query<RoleRow>(
        `INSERT INTO totalbase.roles (name, description, icon, color, app_access, api_access)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, name, description, icon, color, active, reserved, admin_access, app_access, api_access, created_at`,
        [validName, description, icon, color, appAccess, apiAccess],
      );
      return toRole(rows[0]!);
    } catch (error) {
      mapRoleNameConflict(error);
    }
  }

  async update(
    id: string,
    input: {
      name?: string;
      description?: string | null;
      icon?: string | null;
      color?: string | null;
      active?: boolean;
    } & AssignableRoleAccessFlags,
  ): Promise<void> {
    await this.assertNotReserved(id);
    // Unlike name/active's coalesce($n, column) above (undefined and
    // null are indistinguishable there, and neither is ever meant to
    // clear the column), description/icon/color need a real three-way:
    // key omitted = leave untouched, explicit null = clear back to
    // "unset". A plain coalesce can't tell "clear it" from "don't touch
    // it" apart, both being SQL NULL - so each gets its own "did the
    // caller mention this field at all" flag alongside the (possibly
    // null) validated value.
    const touchDescription = input.description !== undefined;
    const description = touchDescription ? validateDescription(input.description) : null;
    const touchIcon = input.icon !== undefined;
    const icon = touchIcon ? validateIcon(input.icon) : null;
    const touchColor = input.color !== undefined;
    const color = touchColor ? validateRoleColor(input.color) : null;
    const name = validateRoleName(input.name);
    const appAccess = validateFlag("appAccess", input.appAccess) ?? null;
    const apiAccess = validateFlag("apiAccess", input.apiAccess) ?? null;
    try {
      await this.database.query(
        `UPDATE totalbase.roles
         SET name = coalesce($2, name),
             description = CASE WHEN $3 THEN $4 ELSE description END,
             icon = CASE WHEN $5 THEN $6 ELSE icon END,
             color = CASE WHEN $7 THEN $8 ELSE color END,
             active = coalesce($9, active),
             app_access = coalesce($10, app_access),
             api_access = coalesce($11, api_access),
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          name ?? null,
          touchDescription,
          description,
          touchIcon,
          icon,
          touchColor,
          color,
          validateFlag("active", input.active) ?? null,
          appAccess,
          apiAccess,
        ],
      );
    } catch (error) {
      mapRoleNameConflict(error);
    }
  }

  async delete(id: string): Promise<void> {
    await this.assertNotReserved(id);
    await this.database.query(`DELETE FROM totalbase.roles WHERE id = $1`, [id]);
  }

  /** The roles whose members may assign role `id` (roles_managers, Specification_Security.md §9.4). */
  async listManagers(id: string): Promise<string[]> {
    const { rows } = await this.database.query<{ manager: string }>(
      `SELECT manager FROM totalbase.roles_managers WHERE role = $1 ORDER BY created_at`,
      [id],
    );
    return rows.map((row) => row.manager);
  }

  /** Replaces who may assign role `id` - administrators only (the Data API refuses this table to everyone else). */
  async setManagers(id: string, managerIds: string[]): Promise<string[]> {
    const role = await this.findById(id);
    if (!role) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Role not found.");
    if (role.adminAccess) throw new TotalBaseError("PERMISSION_DENIED", `The "${role.name}" role can only be assigned by an administrator.`);
    const unique = [...new Set(managerIds)].filter((manager) => manager !== id);
    await this.database.transaction(async (client) => {
      await client.query(`DELETE FROM totalbase.roles_managers WHERE role = $1 AND manager <> ALL($2::uuid[])`, [id, unique]);
      if (unique.length > 0) {
        await client.query(
          `INSERT INTO totalbase.roles_managers (role, manager) SELECT $1, unnest($2::uuid[]) ON CONFLICT (role, manager) DO NOTHING`,
          [id, unique],
        );
      }
    });
    return this.listManagers(id);
  }

  private async assertNotReserved(id: string): Promise<void> {
    const role = await this.findById(id);
    if (role?.reserved) {
      throw new TotalBaseError("PERMISSION_DENIED", `The "${role.name}" role is reserved and cannot be modified or deleted.`);
    }
  }
}
