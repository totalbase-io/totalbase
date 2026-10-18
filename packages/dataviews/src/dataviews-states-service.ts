import type { Database } from "@totalbase/database";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import { validateName } from "@totalbase/shared";

export interface AdminDataViewState {
  id: string;
  dataview: string;
  user: string;
  /** `null` for the viewer's own auto-saved current/default state - a value means a deliberately-saved, nameable, shareable preset. */
  name: string | null;
  /** Opaque - DataViewGrid.vue's own shape (columnPrefs/sort/density, optionally `where`), never interpreted server-side. */
  config: Record<string, unknown>;
  /** Whether the CALLING user owns this row (vs. it being shared with them) - only an owner may edit/delete/manage shares. Always true for the unnamed current row (never shared). */
  isOwner: boolean;
  /** How many users and roles this named preset is shared with (dataviews_shares) - lets the list tell a shared view from one only its owner sees, without a round-trip to `/shares` per row. Always 0 for a row the caller doesn't own, and for the unnamed current row (never shared). */
  sharedCount: number;
  /** Who shared it: its owner's name (else email) - null on the caller's own rows. */
  ownerName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface StateRow {
  id: string;
  dataview: string;
  user: string;
  name: string | null;
  config: Record<string, unknown>;
  is_owner: boolean;
  shared_count: string | number;
  owner_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

function toAdminState(row: StateRow): AdminDataViewState {
  return {
    id: row.id,
    dataview: row.dataview,
    user: row.user,
    name: row.name,
    config: row.config,
    isOwner: row.is_owner,
    sharedCount: Number(row.shared_count),
    ownerName: row.is_owner ? null : row.owner_name ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export interface SaveDataViewStateInput {
  name: string;
  config: Record<string, unknown>;
}

export interface UpdateDataViewStateInput {
  name?: string;
  config?: Record<string, unknown>;
}

/** Who a saved view is shared with: a user (name, email) or a role (its name). */
export interface StateShareRecipient {
  kind: "USER" | "ROLE";
  id: string;
  name: string | null;
  email: string | null;
}

/** Whom a viewer may share with: null - an administrator, anyone; else their active roles, and the users holding one. */
export type ShareScope = string[] | null;

/** Someone a viewer may share with, offered by the Share modal. */
export interface ShareCandidate {
  id: string;
  name: string | null;
  /** A user's email; a role's description. */
  detail: string | null;
}

/** One recipient - a user or a role, exactly one. */
export type StateShareTarget = { userId: string; roleId?: undefined } | { roleId: string; userId?: undefined };

const RECIPIENTS_SQL = `
  SELECT 'USER' AS kind, u.id, u.name, u.email
  FROM totalbase.dataviews_shares sh JOIN totalbase.users u ON u.id = sh."user"
  WHERE sh.state = $1
  UNION ALL
  SELECT 'ROLE' AS kind, r.id, r.name, NULL AS email
  FROM totalbase.dataviews_shares sh JOIN totalbase.roles r ON r.id = sh.role
  WHERE sh.state = $1`;

/**
 * A viewer's own DataView grid state - see AdminDataViewState's own doc
 * comment on the `name IS NULL` split (checked against Directus's
 * directus_presets, which uses the same one-table/nullable-name
 * pattern, before merging what were two separate tables/services this
 * session into this one). Two distinct call patterns share one table:
 *
 * - Named presets (`name` set): rare writes, listable, shareable with
 *   users and roles (dataviews_shares) - `listNamed`/`createNamed`/
 *   `updateNamed`/`deleteNamed`/`listShares`/`addShare`/`removeShare`.
 *   Anyone shares their own; one who isn't an administrator only with
 *   their own roles and the users holding one of them (`shareScope`).
 * - The unnamed current state (`name IS NULL`): frequent debounced
 *   upserts from DataViewGrid.vue's own auto-save, never listed, never
 *   shareable - `getCurrent`/`setCurrent`.
 */
export class DataViewsStatesService {
  constructor(private readonly database: Database) {}

  /**
   * "Copy link" (the Share modal's other option besides picking specific
   * users) - the link itself is the credential: any admin who has it
   * can fetch this ONE named preset's config, regardless of ownership
   * or being in `dataviews_shares`. Never the unnamed current
   * row (that one has no id a link could even carry). A bad/stale link
   * (deleted since, wrong dataview) is DATAVIEW_STATE_NOT_FOUND.
   */
  async getForLink(dataviewId: string, id: string): Promise<AdminDataViewState> {
    const { rows } = await this.database.query<StateRow>(
      `SELECT *, false AS is_owner, 0 AS shared_count FROM totalbase.dataviews_states WHERE id = $1 AND dataview = $2 AND name IS NOT NULL`,
      [id, dataviewId]
    );
    if (!rows[0]) throw new TotalBaseError("DATAVIEW_STATE_NOT_FOUND", `Saved view not found: ${id}`);
    return toAdminState(rows[0]);
  }

  /** Own named presets for this DataView, plus any other owner's preset shared with this user or one of `roleIds` (their active roles). Never includes the unnamed current row. */
  async listNamed(dataviewId: string, userId: string, roleIds: string[]): Promise<AdminDataViewState[]> {
    const { rows } = await this.database.query<StateRow>(
      `SELECT s.*, (s."user" = $2) AS is_owner,
         CASE WHEN s."user" = $2 THEN (SELECT COUNT(*) FROM totalbase.dataviews_shares sh WHERE sh.state = s.id) ELSE 0 END AS shared_count,
         COALESCE(o.name, o.email) AS owner_name
       FROM totalbase.dataviews_states s
       JOIN totalbase.users o ON o.id = s."user"
       WHERE s.dataview = $1 AND s.name IS NOT NULL
         AND (s."user" = $2 OR EXISTS (
           SELECT 1 FROM totalbase.dataviews_shares sh
           WHERE sh.state = s.id AND (sh."user" = $2 OR sh.role = ANY($3::uuid[]))
         ))
       ORDER BY s.name`,
      [dataviewId, userId, roleIds]
    );
    return rows.map(toAdminState);
  }

  async createNamed(dataviewId: string, userId: string, input: SaveDataViewStateInput): Promise<AdminDataViewState> {
    const name = validateName(input.name);
    try {
      const { rows } = await this.database.query<StateRow>(
        `INSERT INTO totalbase.dataviews_states (dataview, "user", name, config)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING *, true AS is_owner, 0 AS shared_count`,
        [dataviewId, userId, name, JSON.stringify(input.config)]
      );
      return toAdminState(rows[0]!);
    } catch (error) {
      remapStateUniqueViolation(error);
    }
  }

  /** Owner only: renames it, or saves the current state over it ("Save changes"). */
  async updateNamed(dataviewId: string, userId: string, id: string, input: UpdateDataViewStateInput): Promise<AdminDataViewState> {
    const name = input.name === undefined ? null : validateName(input.name);
    try {
      const { rows } = await this.database.query<StateRow>(
        `UPDATE totalbase.dataviews_states
         SET name = COALESCE($4, name), config = COALESCE($5::jsonb, config), updated_at = now()
         WHERE id = $1 AND dataview = $2 AND "user" = $3 AND name IS NOT NULL
         RETURNING *, true AS is_owner, (SELECT COUNT(*) FROM totalbase.dataviews_shares sh WHERE sh.state = $1) AS shared_count`,
        [id, dataviewId, userId, name, input.config === undefined ? null : JSON.stringify(input.config)]
      );
      if (!rows[0]) throw new TotalBaseError("DATAVIEW_STATE_NOT_FOUND", `Saved view not found: ${id}`);
      return toAdminState(rows[0]);
    } catch (error) {
      remapStateUniqueViolation(error);
    }
  }

  async deleteNamed(dataviewId: string, userId: string, id: string): Promise<void> {
    // Owner-only, and only ever a NAMED row - the unnamed current row
    // has no delete route of its own (setCurrent just overwrites it).
    const { rows } = await this.database.query(
      `DELETE FROM totalbase.dataviews_states WHERE id = $1 AND dataview = $2 AND "user" = $3 AND name IS NOT NULL RETURNING id`,
      [id, dataviewId, userId]
    );
    if (rows.length === 0) throw new TotalBaseError("DATAVIEW_STATE_NOT_FOUND", `Saved view not found: ${id}`);
  }

  /** Confirms `userId` owns a NAMED `stateId` before any share-management call - shared by listShares/addShare/removeShare so a non-owner never even learns who else it's shared with, and the unnamed current row is never a valid target. */
  private async requireOwnerOfNamed(dataviewId: string, userId: string, stateId: string): Promise<void> {
    const { rows } = await this.database.query(
      `SELECT 1 FROM totalbase.dataviews_states WHERE id = $1 AND dataview = $2 AND "user" = $3 AND name IS NOT NULL`,
      [stateId, dataviewId, userId]
    );
    if (rows.length === 0) throw new TotalBaseError("DATAVIEW_STATE_NOT_FOUND", `Saved view not found: ${stateId}`);
  }

  async listShares(dataviewId: string, userId: string, stateId: string): Promise<StateShareRecipient[]> {
    await this.requireOwnerOfNamed(dataviewId, userId, stateId);
    const { rows } = await this.database.query<StateShareRecipient>(`${RECIPIENTS_SQL} ORDER BY kind, name NULLS LAST, email`, [stateId]);
    return rows;
  }

  /**
   * Whom the viewer may share with (Specification_DataViews.md §5.9): an administrator, every active role but the
   * reserved ones and every active user; anyone else, their own roles and the users holding one of them. Users by
   * `term` (name or email), the first 20.
   */
  async shareCandidates(userId: string, scope: ShareScope, term: string): Promise<{ roles: ShareCandidate[]; users: ShareCandidate[] }> {
    const roles = await this.database.query<ShareCandidate>(
      `SELECT r.id, r.name, r.description AS detail FROM totalbase.roles r
       WHERE r.active AND NOT r.reserved AND ($1::uuid[] IS NULL OR r.id = ANY($1::uuid[]))
       ORDER BY r.name`,
      [scope]
    );
    const pattern = `%${term.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const users = await this.database.query<ShareCandidate>(
      `SELECT u.id, u.name, u.email AS detail FROM totalbase.users u
       WHERE u.active AND u.can_login AND u.id <> $2
         AND ($1::uuid[] IS NULL OR EXISTS (SELECT 1 FROM totalbase.users_roles a WHERE a."user" = u.id AND a.role = ANY($1::uuid[])))
         AND (u.name ILIKE $3 OR u.email ILIKE $3)
       ORDER BY u.name NULLS LAST, u.email
       LIMIT 20`,
      [scope, userId, pattern]
    );
    return { roles: roles.rows, users: users.rows };
  }

  /** Idempotent - sharing twice is a no-op. Returns the recipient, as `listShares` lists them (an unknown user or role is the foreign key's violation). */
  async addShare(dataviewId: string, userId: string, stateId: string, target: StateShareTarget, scope: ShareScope): Promise<StateShareRecipient> {
    await this.requireOwnerOfNamed(dataviewId, userId, stateId);
    if (target.userId === userId) {
      throw new TotalBaseError("DATAVIEW_STATE_SHARE_SELF", "A saved view is already yours - no need to share it with yourself.");
    }
    if (scope !== null) {
      const { rows } = target.roleId !== undefined
        ? await this.database.query(`SELECT 1 WHERE $1::uuid = ANY($2::uuid[])`, [target.roleId, scope])
        : await this.database.query(`SELECT 1 FROM totalbase.users_roles WHERE "user" = $1 AND role = ANY($2::uuid[]) LIMIT 1`, [target.userId, scope]);
      if (rows.length === 0) {
        throw new TotalBaseError("PERMISSION_DENIED", "A saved view is shared only with your own roles and the people who hold one of them.");
      }
    }
    const column = target.userId === undefined ? "role" : '"user"';
    const recipient = target.userId ?? target.roleId;
    await this.database.query(
      `INSERT INTO totalbase.dataviews_shares (state, ${column}) VALUES ($1, $2) ON CONFLICT (state, ${column}) DO NOTHING`,
      [stateId, recipient]
    );
    const { rows } = await this.database.query<StateShareRecipient>(`SELECT * FROM (${RECIPIENTS_SQL}) r WHERE r.id = $2`, [stateId, recipient]);
    return rows[0]!;
  }

  /** `recipientId` is the user's or the role's id; one it isn't shared with is DATAVIEW_STATE_NOT_FOUND. */
  async removeShare(dataviewId: string, userId: string, stateId: string, recipientId: string): Promise<void> {
    await this.requireOwnerOfNamed(dataviewId, userId, stateId);
    const { rows } = await this.database.query(
      `DELETE FROM totalbase.dataviews_shares WHERE state = $1 AND ("user" = $2 OR role = $2) RETURNING state`,
      [stateId, recipientId]
    );
    if (rows.length === 0) throw new TotalBaseError("DATAVIEW_STATE_NOT_FOUND", `This saved view isn't shared with ${recipientId}.`);
  }

  /** `null` when the viewer has never had anything saved yet - the caller falls back to its own defaults. */
  async getCurrent(dataviewId: string, userId: string): Promise<AdminDataViewState | null> {
    const { rows } = await this.database.query<StateRow>(
      `SELECT *, true AS is_owner, 0 AS shared_count FROM totalbase.dataviews_states WHERE dataview = $1 AND "user" = $2 AND name IS NULL`,
      [dataviewId, userId]
    );
    return rows[0] ? toAdminState(rows[0]) : null;
  }

  async setCurrent(dataviewId: string, userId: string, config: Record<string, unknown>): Promise<AdminDataViewState> {
    const { rows } = await this.database.query<StateRow>(
      `INSERT INTO totalbase.dataviews_states (dataview, "user", name, config, updated_at)
       VALUES ($1, $2, NULL, $3::jsonb, now())
       ON CONFLICT (dataview, "user") WHERE name IS NULL
       DO UPDATE SET config = $3::jsonb, updated_at = now()
       RETURNING *, true AS is_owner, 0 AS shared_count`,
      [dataviewId, userId, JSON.stringify(config)]
    );
    return toAdminState(rows[0]!);
  }
}

function remapStateUniqueViolation(error: unknown): never {
  return remapUniqueViolation(error, [], { code: "DATAVIEW_STATE_NAME_DUPLICATE", message: "You already have a saved view with this name for this DataView." });
}
