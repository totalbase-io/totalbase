import { quoteIdentifier, type Database, type Queryable } from "@totalbase/database";
import { isProjectUserColumn } from "@totalbase/shared";
import { TotalBaseError } from "@totalbase/errors";
import { WORKFLOWS_SYSTEM_USER_EMAIL } from "@totalbase/shared";
import { STORED_PREFERENCE_KEYS, toUserPreferences, type UserPreferences, type UserPreferencesPatch } from "./user-preferences.js";

/**
 * `Admin` is kept as a name for the projection of a `User` that the
 * Control Plane guard decorates onto the request (auth-guards.ts) - it
 * is not a separate identity - admins are
 * users; it just narrows to the fields the few consumers of
 * `request.admin` (admin-sql-console.ts, admin-auth.ts) actually read.
 */
export type Admin = Pick<User, "id" | "email" | "name" | "avatarUrl" | "active">;

export interface User {
  id: string;
  /** Required and never blank - PostgreSQL enforces it. */
  email: string;
  name: string | null;
  avatarUrl: string | null;
  active: boolean;
  /** The single instance owner (bootstrapped from TOTALBASE_ADMIN_EMAIL/PASSWORD): cannot be deleted, cannot lose the Administrators role. */
  owner: boolean;
  /** Postgres NOLOGIN's analogue at the user (not role) level - checked first in AuthService.login(), regardless of password correctness. False for system/service accounts (e.g. the seeded Workflows user) that must exist and be selectable but never authenticate a session directly. */
  canLogin: boolean;
  emailVerifiedAt: Date | null;
  createdAt: Date;
}

interface UserRow {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  active: boolean;
  owner: boolean;
  can_login: boolean;
  email_verified_at: Date | null;
  created_at: Date;
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    active: row.active,
    owner: row.owner,
    canLogin: row.can_login,
    emailVerifiedAt: row.email_verified_at,
    createdAt: row.created_at,
  };
}

/**
 * One row of the Admin API's user list - the user plus what the list
 * screen filters on: its role ids and whether it still has no password
 * (an invited account that hasn't accepted yet).
 */
export interface UserListItem extends User {
  roles: string[];
  hasPassword: boolean;
  lastLoginAt: Date | null;
  /** Sign-in refused until then (account lockout); null when not locked. */
  lockedUntil: Date | null;
  /** Consecutive failed sign-ins since the last success/unlock/lockout (auth.lockout_max_attempts). */
  failedLoginCount: number;
  /** The picture of the user's most recently used OAuth identity, if any - offered as "Use picture from <provider>". */
  providerAvatar: { url: string; provider: string } | null;
  /** Two-factor authentication is on: a confirmed factor (Security.md §2.17). */
  mfaEnabled: boolean;
}

const MAX_NAME_LENGTH = 200;
const MAX_EMAIL_LENGTH = 254;

/** Trimmed display name; `undefined` = leave untouched. Empty or too long is rejected. */
function validateUserName(name: string | null | undefined): string | null | undefined {
  if (name === undefined || name === null) return name;
  if (typeof name !== "string") throw new TotalBaseError("INVALID_QUERY", "A user's name must be text.");
  const trimmed = name.trim();
  if (!trimmed) throw new TotalBaseError("INVALID_QUERY", "A user's name can't be empty.");
  if (trimmed.length > MAX_NAME_LENGTH) {
    throw new TotalBaseError("INVALID_QUERY", `A user's name can't be longer than ${MAX_NAME_LENGTH} characters.`);
  }
  return trimmed;
}

/** Trimmed email with a minimal shape check - deliverability is the invitation's job, not this one's. */
/** Every user has an email - the sign-in identity (PostgreSQL enforces it too). */
function validateEmail(email: string | null | undefined): string {
  if (email === undefined || email === null || (typeof email === "string" && !email.trim())) {
    throw new TotalBaseError("INVALID_QUERY", "Email is required.");
  }
  const trimmed = typeof email === "string" ? email.trim() : "";
  if (!/^[^\s@]+@[^\s@]+$/.test(trimmed) || trimmed.length > MAX_EMAIL_LENGTH) {
    throw new TotalBaseError("INVALID_QUERY", "Enter a valid email address.");
  }
  return trimmed;
}

/** PostgreSQL's own unique index on lower(email) decides duplicates - mapped to a readable message. */
function mapEmailConflict(error: unknown): never {
  if (error instanceof TotalBaseError && error.code === "UNIQUE_VIOLATION" && error.constraint === "users_email_unique") {
    throw new TotalBaseError("UNIQUE_VIOLATION", "A user with this email already exists.", { httpStatus: 409 });
  }
  throw error;
}

/** How the Users screen classifies an account (mirrored by the admin's userStatus()). */
export type UserStatus = "ACTIVE" | "INVITED" | "INACTIVE";

export interface UserSearchFilter {
  q?: string | undefined;
  status?: UserStatus | undefined;
  role?: string | undefined;
  /** Only users not holding this role id. */
  notRole?: string | undefined;
  /** Holders of this role id first, then the rest, each by name - a role's Members tab. Else newest first. */
  roleFirst?: string | undefined;
  /** Only these users - a batch lookup of ids to names (the admin's user directory). */
  ids?: string[] | undefined;
  /** true = only active accounts (e.g. an "execute as" picker). */
  active?: boolean | undefined;
  /** A project's own columns (not TotalBase's - the caller checks): each equal to its value as text, null = empty. */
  extra?: { column: string; value: string | null }[] | undefined;
  limit: number;
  offset: number;
}

/** SQL for each status, over alias `u` - INVITED is an active, sign-in-capable account with no password yet. */
const STATUS_CONDITION: Record<UserStatus, string> = {
  INACTIVE: "NOT u.active",
  INVITED: "u.active AND u.password_hash IS NULL AND u.can_login",
  ACTIVE: "u.active AND NOT (u.password_hash IS NULL AND u.can_login)",
};

const SELECT_COLUMNS = `id, email, name, avatar_url, active, owner, can_login, email_verified_at, created_at`;

/** Persistence for totalbase.users. See Security.md. */
export class UsersService {
  constructor(private readonly database: Database) {}

  /** Every user, newest first, with the fields the Admin API's Users screen needs. */
  async listForAdmin(): Promise<UserListItem[]> {
    return this.queryForAdmin("ORDER BY u.created_at DESC", []);
  }

  /** One user in the same shape as listForAdmin(), or null. */
  async findForAdmin(id: string): Promise<UserListItem | null> {
    const [user] = await this.queryForAdmin("WHERE u.id = $1", [id]);
    return user ?? null;
  }

  /**
   * One page of the Admin API's user list, filtered and counted in
   * PostgreSQL: `q` matches name or email (case-insensitive substring),
   * `status` is the Users screen's ACTIVE / INVITED / INACTIVE, `role` a
   * role id the user holds (`notRole`: doesn't). Newest first, or `roleFirst`'s holders first.
   */
  async searchForAdmin(filter: UserSearchFilter): Promise<{ users: UserListItem[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    if (filter.q?.trim()) {
      const pattern = push(`%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      conditions.push(`(u.name ILIKE ${pattern} OR u.email ILIKE ${pattern})`);
    }
    if (filter.status) conditions.push(STATUS_CONDITION[filter.status]);
    if (filter.active) conditions.push("u.active");
    if (filter.ids) conditions.push(`u.id = ANY(${push(filter.ids)}::uuid[])`);
    const holds = (role: string) => `EXISTS (SELECT 1 FROM totalbase.users_roles a WHERE a."user" = u.id AND a.role = ${push(role)})`;
    if (filter.role) conditions.push(holds(filter.role));
    if (filter.notRole) conditions.push(`NOT ${holds(filter.notRole)}`);
    for (const { column, value } of filter.extra ?? []) {
      conditions.push(value === null ? `u.${quoteIdentifier(column)} IS NULL` : `u.${quoteIdentifier(column)}::text = ${push(value)}`);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const { rows: countRows } = await this.database.query<{ total: string }>(
      `SELECT count(*) AS total FROM totalbase.users u ${where}`,
      params,
    );
    // The id last: a stable order, so a page boundary never repeats or skips a user.
    const order = filter.roleFirst
      ? `ORDER BY ${holds(filter.roleFirst)} DESC, lower(coalesce(u.name, u.email)), u.id`
      : "ORDER BY u.created_at DESC";
    const users = await this.queryForAdmin(
      `${where} ${order} LIMIT ${push(filter.limit)} OFFSET ${push(filter.offset)}`,
      params,
    );
    return { users, total: Number(countRows[0]?.total ?? 0) };
  }

  /** The columns a project added to users (AGENTS.md §11) - read from PostgreSQL's catalog, TotalBase's own left out. */
  async projectColumns(): Promise<string[]> {
    const { rows } = await this.database.query<{ name: string }>(
      `SELECT a.attname AS name FROM pg_attribute a
       WHERE a.attrelid = 'totalbase.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
    );
    return rows.map((r) => r.name).filter(isProjectUserColumn);
  }

  /**
   * Sets columns the project added to the users table (AGENTS.md §11) on one account - a delegated
   * invitation's, in its own transaction, before the grant's row filter is checked on the row.
   * Only project columns; their names are checked against the catalog and quoted, the values bound
   * and cast by PostgreSQL to each column's type.
   */
  async setProjectColumns(id: string, values: Record<string, unknown>, client: Queryable = this.database): Promise<void> {
    const entries = Object.entries(values);
    if (entries.length === 0) return;
    const columns = await this.projectColumns();
    for (const [column] of entries) {
      if (!columns.includes(column)) throw new TotalBaseError("INVALID_QUERY", `${column} is not a column the project added to the users table.`);
    }
    const sets = entries.map(([column], i) => `${quoteIdentifier(column)} = $${i + 2}`);
    await client.query(
      `UPDATE totalbase.users SET ${sets.join(", ")} WHERE id = $1`,
      [id, ...entries.map(([, value]) => value)],
    );
  }

  /** Counts for the Users panel: every user, per status, and per role. */
  async summaryForAdmin(): Promise<{ total: number; byStatus: Record<UserStatus, number>; byRole: Record<string, number> }> {
    const { rows } = await this.database.query<{ total: string; active: string; invited: string; inactive: string }>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE ${STATUS_CONDITION.ACTIVE}) AS active,
              count(*) FILTER (WHERE ${STATUS_CONDITION.INVITED}) AS invited,
              count(*) FILTER (WHERE ${STATUS_CONDITION.INACTIVE}) AS inactive
       FROM totalbase.users u`,
    );
    const { rows: roleRows } = await this.database.query<{ role: string; count: string }>(
      `SELECT role, count(*) AS count FROM totalbase.users_roles GROUP BY role`,
    );
    const row = rows[0]!;
    return {
      total: Number(row.total),
      byStatus: { ACTIVE: Number(row.active), INVITED: Number(row.invited), INACTIVE: Number(row.inactive) },
      byRole: Object.fromEntries(roleRows.map((r) => [r.role, Number(r.count)])),
    };
  }

  private async queryForAdmin(where: string, params: unknown[]): Promise<UserListItem[]> {
    const { rows } = await this.database.query<
      UserRow & {
        roles: string[];
        has_password: boolean;
        last_login_at: Date | null;
        locked_until: Date | null;
        failed_login_count: number;
        provider_avatar: { url: string; provider: string } | null;
        mfa_enabled: boolean;
      }
    >(
      `SELECT ${SELECT_COLUMNS}, password_hash IS NOT NULL AS has_password, last_login_at, failed_login_count,
              (SELECT jsonb_build_object('url', i.provider_avatar_url, 'provider', p.name)
                 FROM totalbase.identities i
                 JOIN totalbase.providers p ON p.id = i.provider
                WHERE i."user" = u.id AND i.provider_avatar_url IS NOT NULL
                ORDER BY i.last_login_at DESC NULLS LAST
                LIMIT 1) AS provider_avatar,
              CASE WHEN locked_until > now() THEN locked_until END AS locked_until,
              EXISTS (SELECT 1 FROM totalbase.factors f WHERE f."user" = u.id AND f.confirmed_at IS NOT NULL) AS mfa_enabled,
              COALESCE(
                (SELECT array_agg(a.role ORDER BY a.role) FROM totalbase.users_roles a WHERE a."user" = u.id),
                '{}'
              ) AS roles
       FROM totalbase.users u
       ${where}`,
      params,
    );
    return rows.map((row) => ({
      ...toUser(row),
      roles: row.roles,
      hasPassword: row.has_password,
      lastLoginAt: row.last_login_at,
      lockedUntil: row.locked_until,
      failedLoginCount: row.failed_login_count,
      providerAvatar: row.provider_avatar,
      mfaEnabled: row.mfa_enabled,
    }));
  }

  async findByEmail(email: string, client: Queryable = this.database): Promise<User | null> {
    const { rows } = await client.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.users WHERE lower(email) = lower($1)`,
      [email],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(id: string, client: Queryable = this.database): Promise<User | null> {
    const { rows } = await client.query<UserRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.users WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUser(rows[0]) : null;
  }

  /** Returns the password_hash too; only for authentication checks. */
  async findByEmailWithPasswordHash(
    email: string,
  ): Promise<(User & { passwordHash: string | null; locked: boolean }) | null> {
    const { rows } = await this.database.query<UserRow & { password_hash: string | null; locked: boolean }>(
      `SELECT ${SELECT_COLUMNS}, password_hash, coalesce(locked_until > now(), false) AS locked
       FROM totalbase.users WHERE lower(email) = lower($1)`,
      [email],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.password_hash, locked: row.locked } : null;
  }

  /**
   * Counts one failed sign-in - atomically, in PostgreSQL: the attempt
   * that reaches `maxAttempts` locks the account for `lockMinutes` and
   * resets the counter. `maxAttempts` 0 = lockout off (nothing counted).
   */
  async recordFailedLogin(userId: string, maxAttempts: number, lockMinutes: number): Promise<{ locked: boolean }> {
    if (maxAttempts <= 0) return { locked: false };
    const { rows } = await this.database.query<{ locked: boolean }>(
      `UPDATE totalbase.users
       SET locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + ($3 * interval '1 minute') ELSE locked_until END,
           failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END
       WHERE id = $1
       RETURNING coalesce(locked_until > now(), false) AS locked`,
      [userId, maxAttempts, lockMinutes],
    );
    return { locked: rows[0]?.locked ?? false };
  }

  /** Whether sign-in is refused right now by a lockout - PostgreSQL's clock decides. */
  async isLocked(userId: string): Promise<boolean> {
    const { rows } = await this.database.query<{ locked: boolean }>(
      `SELECT coalesce(locked_until > now(), false) AS locked FROM totalbase.users WHERE id = $1`,
      [userId],
    );
    return rows[0]?.locked ?? false;
  }

  /**
   * Deactivates the accounts unused for `days` (auth.dormant_account_days, Security.md §1.11): no sign-in, no
   * session seen and no token used since - or since their creation. Never the owner, nor a system account.
   * Deactivation revokes their sessions (a trigger). Returns their ids; 0 days does nothing.
   */
  async deactivateDormant(days: number): Promise<string[]> {
    if (days <= 0) return [];
    const { rows } = await this.database.query<{ id: string }>(
      `UPDATE totalbase.users u SET active = false
       WHERE u.active AND u.can_login AND NOT u.owner
         AND greatest(
           coalesce(u.last_login_at, u.created_at),
           coalesce((SELECT max(s.last_seen_at) FROM totalbase.sessions s WHERE s."user" = u.id), u.created_at),
           coalesce((SELECT max(t.last_used_at) FROM totalbase.tokens t WHERE t."user" = u.id), u.created_at)
         ) < now() - make_interval(days => $1::int)
       RETURNING u.id`,
      [days],
    );
    return rows.map((row) => row.id);
  }

  /** Ends a lockout and forgets past failures (an admin's unlock, a password reset). */
  async unlock(userId: string, client: Queryable = this.database): Promise<void> {
    await client.query(
      `UPDATE totalbase.users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [userId],
    );
  }

  /** Returns the password_hash too; only for authentication checks. */
  async findByIdWithPasswordHash(
    id: string,
  ): Promise<(User & { passwordHash: string | null }) | null> {
    const { rows } = await this.database.query<UserRow & { password_hash: string | null }>(
      `SELECT ${SELECT_COLUMNS}, password_hash FROM totalbase.users WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
  }

  /**
   * `emailVerified`: the account's email counts as verified from the start -
   * an administrator creating it with a password vouches for it. Left out,
   * it is unverified (registration; an invitation or OAuth verifies later).
   */
  async create(
    input: { email?: string | null; name?: string | null; passwordHash?: string | null; owner?: boolean; emailVerified?: boolean },
    client: Queryable = this.database,
  ): Promise<User> {
    const email = validateEmail(input.email);
    const name = validateUserName(input.name) ?? null;
    try {
      const { rows } = await client.query<UserRow>(
        `INSERT INTO totalbase.users (email, name, password_hash, owner, email_verified_at)
         VALUES ($1, $2, $3, $4, CASE WHEN $5 THEN now() END)
         RETURNING ${SELECT_COLUMNS}`,
        [email, name, input.passwordHash ?? null, input.owner ?? false, input.emailVerified ?? false],
      );
      return toUser(rows[0]!);
    } catch (error) {
      mapEmailConflict(error);
    }
  }

  /**
   * Admin edit of a user's name and active flag. The instance owner and
   * the Workflows system account can't be deactivated - an instance must
   * keep its owner able to sign in, and workflows run as that account.
   * Deactivating also revokes every open session in the same transaction
   * (tokens stop validating on their own - UsersApisService checks the
   * user is active).
   */
  /** `actorId`: the admin making the change - they can't deactivate their own account. */
  async update(id: string, input: { name?: string | null; active?: boolean }, actorId?: string): Promise<User> {
    const user = await this.findById(id);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (input.active === false && actorId === id) {
      throw new TotalBaseError("PERMISSION_DENIED", "You can't deactivate your own account.");
    }
    if (input.active !== undefined && typeof input.active !== "boolean") {
      throw new TotalBaseError("INVALID_QUERY", "active must be true or false.");
    }
    if (input.active === false && user.owner) {
      throw new TotalBaseError("PERMISSION_DENIED", "The instance owner cannot be deactivated.");
    }
    if (input.active === false && user.email === WORKFLOWS_SYSTEM_USER_EMAIL) {
      throw new TotalBaseError("PERMISSION_DENIED", "The Workflows system user cannot be deactivated.");
    }
    const name = validateUserName(input.name);

    return this.database.transaction(async (client) => {
      const { rows } = await client.query<UserRow>(
        `UPDATE totalbase.users
         SET name = CASE WHEN $2 THEN $3 ELSE name END,
             active = coalesce($4, active),
             updated_at = now()
         WHERE id = $1
         RETURNING ${SELECT_COLUMNS}`,
        [id, name !== undefined, name ?? null, input.active ?? null],
      );
      // Deactivating revokes every session - PostgreSQL's job
      // (users_revoke_sessions_on_deactivate), for every writer.
      return toUser(rows[0]!);
    });
  }

  /**
   * An admin changes a user's email (the sign-in identity). PostgreSQL's
   * case-insensitive unique index decides duplicates (409). A real change
   * - not just different letter case - sets email_verified_at per the
   * admin's choice (now, or NULL until the user verifies the new address)
   * and retires every still-unused invitation / password-reset /
   * verification link, in the same transaction: those went to the old
   * address, and accepting an invitation would mark the new one verified.
   * Sessions and API tokens keep working - this isn't a credential change.
   * OAuth links are by provider subject, not email, so they're unaffected.
   */
  async changeEmail(id: string, email: string, options: { verified: boolean }): Promise<{ user: User; previousEmail: string | null; changed: boolean }> {
    const user = await this.findById(id);
    if (!user) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (user.email === WORKFLOWS_SYSTEM_USER_EMAIL) {
      throw new TotalBaseError("PERMISSION_DENIED", "The Workflows system user's email can't be changed.");
    }
    if (typeof options.verified !== "boolean") {
      throw new TotalBaseError("INVALID_QUERY", "verified must be true or false.");
    }
    const next = validateEmail(email);
    const changed = next.toLowerCase() !== (user.email ?? "").toLowerCase();

    try {
      return await this.database.transaction(async (client) => {
        const { rows } = await client.query<UserRow>(
          `UPDATE totalbase.users
           SET email = $2,
               email_verified_at = CASE WHEN NOT $3 THEN email_verified_at WHEN $4 THEN now() ELSE NULL END,
               updated_at = now()
           WHERE id = $1
           RETURNING ${SELECT_COLUMNS}`,
          [id, next, changed, options.verified],
        );
        if (changed) {
          await client.query(
            `UPDATE totalbase.emails_tokens SET used_at = now() WHERE "user" = $1 AND used_at IS NULL`,
            [id],
          );
        }
        return { user: toUser(rows[0]!), previousEmail: user.email, changed };
      });
    } catch (error) {
      mapEmailConflict(error);
    }
  }

  /**
   * Sets (or clears, with null) a user's avatar URL and returns the one it
   * replaced - read under the same row lock, so the caller can clean up a
   * replaced upload without racing a concurrent change.
   */
  async setAvatarUrl(id: string, url: string | null): Promise<{ previous: string | null }> {
    const { rows } = await this.database.query<{ previous: string | null }>(
      `WITH prev AS (SELECT avatar_url FROM totalbase.users WHERE id = $1 FOR UPDATE)
       UPDATE totalbase.users u SET avatar_url = $2, updated_at = now()
       FROM prev WHERE u.id = $1
       RETURNING prev.avatar_url AS previous`,
      [id, url],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    return { previous: rows[0].previous };
  }

  /** Active accounts that can sign in - people, not system accounts like the Workflows user (the dashboard's count). */
  async countActivePeople(): Promise<number> {
    const { rows } = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.users WHERE active AND can_login`,
    );
    return rows[0]!.count;
  }

  /** Accounts locked right now (too many failed sign-ins) - the Sign-ins insights' count. */
  async countLocked(): Promise<number> {
    const { rows } = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.users WHERE locked_until > now()`,
    );
    return rows[0]!.count;
  }

  /** An OAuth sign-in fills in the provider's picture only when the user has none - never overrides one they chose. */
  async setAvatarIfMissing(id: string, url: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.users SET avatar_url = $2, updated_at = now() WHERE id = $1 AND avatar_url IS NULL`,
      [id, url],
    );
  }

  /**
   * Rejects deleting the instance owner - an instance
   * can never be left without one - and the seeded Workflows system user
   * backed by a DB trigger too as a backstop
   * for any path that doesn't go through this service.
   */
  /** `actorId`: the admin deleting - an admin can't delete their own account (and lock themselves out). Whether there was such a user. */
  async delete(id: string, actorId?: string, client: Queryable = this.database): Promise<boolean> {
    if (actorId === id) throw new TotalBaseError("PERMISSION_DENIED", "You can't delete your own account.");
    const user = await this.findById(id);
    if (user?.owner) {
      throw new TotalBaseError("PERMISSION_DENIED", "The instance owner cannot be deleted.");
    }
    if (user?.email === WORKFLOWS_SYSTEM_USER_EMAIL) {
      throw new TotalBaseError("PERMISSION_DENIED", "The Workflows system user cannot be deleted.");
    }
    const { rowCount } = await client.query(`DELETE FROM totalbase.users WHERE id = $1`, [id]);
    return rowCount > 0;
  }

  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.users SET password_hash = $2, updated_at = now() WHERE id = $1`,
      [userId, passwordHash],
    );
  }

  /** Marks the email verified - a no-op for one already verified (its first verification time is kept). */
  async markEmailVerified(userId: string, client: Queryable = this.database): Promise<void> {
    await client.query(
      `UPDATE totalbase.users SET email_verified_at = now(), updated_at = now() WHERE id = $1 AND email_verified_at IS NULL`,
      [userId],
    );
  }

  /** The user's own display preferences - only the known keys. */
  async getPreferences(userId: string): Promise<UserPreferences> {
    const { rows } = await this.database.query<{ preferences: unknown }>(
      `SELECT preferences FROM totalbase.users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    return toUserPreferences(rows[0].preferences);
  }

  /**
   * Applies a parsed patch (parsePreferencesPatch) in one UPDATE: set keys
   * merge in, `null` keys are removed - never a read-modify-write, so two
   * concurrent changes to different keys both stick. A timezone must be
   * one PostgreSQL knows (pg_timezone_names); the column's CHECK decides
   * the rest.
   */
  async updatePreferences(userId: string, patch: UserPreferencesPatch): Promise<UserPreferences> {
    const stored = Object.entries(patch).map(([key, value]) => [STORED_PREFERENCE_KEYS[key as keyof UserPreferences], value] as const);
    const set = Object.fromEntries(stored.filter(([, value]) => value !== null));
    const clear = stored.filter(([, value]) => value === null).map(([key]) => key);
    if (typeof set.timezone === "string") {
      const { rows } = await this.database.query<{ known: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = $1) AS known`,
        [set.timezone],
      );
      if (!rows[0]?.known) throw new TotalBaseError("INVALID_QUERY", `Unknown timezone: ${set.timezone}.`);
    }
    const { rows } = await this.database.query<{ preferences: unknown }>(
      `UPDATE totalbase.users
       SET preferences = (preferences || $2::jsonb) - $3::text[], updated_at = now()
       WHERE id = $1
       RETURNING preferences`,
      [userId, JSON.stringify(set), clear],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    return toUserPreferences(rows[0].preferences);
  }

  /** A successful sign-in: stamps it and forgets any failed attempts before it. */
  async touchLastLogin(userId: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`,
      [userId],
    );
  }
}
