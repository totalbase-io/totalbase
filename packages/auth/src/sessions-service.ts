import type { Database } from "@totalbase/database";
import type { SettingsService } from "@totalbase/settings";
import { generateOpaqueToken, hashToken } from "./tokens.js";
import type { User } from "./users-service.js";

export interface Session {
  id: string;
  user: string;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** A session as the session lists return it - with its user's email and name. */
export interface SessionListItem extends Session {
  userEmail: string;
  userName: string | null;
}

interface SessionRow {
  id: string;
  user: string;
  ip: string | null;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
}

/** validate() reads the session beside u.* - its columns travel under this prefix. */
const SESSION_COLUMN_PREFIX = "__session_";

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    user: row.user,
    ip: row.ip,
    userAgent: row.user_agent,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

/**
 * Opaque bearer-token sessions. See Security.md §2.2, §2.5
 * (Authorization: Bearer <token>).
 *
 * Permissions are never embedded in the token; it is only a session
 * lookup key (Security.md §6.9).
 */
export type SessionStatusFilter = "ACTIVE" | "EXPIRED" | "REVOKED" | "ALL";

/**
 * When session `s` stops validating, given auth.session_idle_minutes bound
 * as `idle` (Security.md §2.2): its fixed `expires_at`, or earlier, once it
 * has gone unused that long. Every status - validation, the lists, the
 * counts, the per-user limit, the purge - reads this one expression, and
 * the session's `expiresAt` is its value.
 */
const sessionEnd = (idle: string) =>
  `CASE WHEN ${idle}::int > 0 THEN least(s.expires_at, s.last_seen_at + make_interval(mins => ${idle}::int)) ELSE s.expires_at END`;

function statusCondition(status: Exclude<SessionStatusFilter, "ALL">, idle: string): string {
  if (status === "REVOKED") return "s.revoked_at IS NOT NULL";
  return `s.revoked_at IS NULL AND ${sessionEnd(idle)} ${status === "ACTIVE" ? ">" : "<="} now()`;
}

export class SessionsService {
  constructor(
    private readonly database: Database,
    private readonly settings: Pick<SettingsService, "get">,
  ) {}

  private idleMinutes(): Promise<number> {
    return this.settings.get("auth.session_idle_minutes");
  }

  async create(input: {
    user: string;
    ip?: string | undefined;
    userAgent?: string | undefined;
    ttlHours: number;
    maxSessionsPerUser: number;
    /** The sign-in passed a second factor (Security.md §2.17) - recorded as `mfa_verified_at`. */
    mfaVerified?: boolean;
  }): Promise<{ token: string; session: Session }> {
    const token = generateOpaqueToken();
    const tokenHash = hashToken(token);

    const { rows } = await this.database.query<SessionRow>(
      `INSERT INTO totalbase.sessions ("user", token_hash, ip, user_agent, expires_at, mfa_verified_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(hours => $5), CASE WHEN $6::boolean THEN now() END)
       RETURNING id, "user", ip, user_agent, created_at, last_seen_at, expires_at, revoked_at`,
      [input.user, tokenHash, input.ip ?? null, input.userAgent ?? null, input.ttlHours, input.mfaVerified === true],
    );

    await this.enforceMaxSessions(input.user, input.maxSessionsPerUser);

    return { token, session: toSession(rows[0]!) };
  }

  /** Revokes the oldest active sessions beyond auth.max_sessions_per_user. */
  private async enforceMaxSessions(userId: string, max: number): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.sessions
       SET revoked_at = now()
       WHERE id IN (
         SELECT s.id FROM totalbase.sessions s
         WHERE s."user" = $1 AND ${statusCondition("ACTIVE", "$3")}
         ORDER BY s.created_at DESC
         OFFSET $2
       )`,
      [userId, max, await this.idleMinutes()],
    );
  }

  /**
   * One page of the Admin API's session list, filtered and counted in
   * PostgreSQL - sessions grow with every sign-in, so the admin never
   * loads them all. `status`: ACTIVE (signed in), EXPIRED, REVOKED or ALL;
   * `q` matches the user's email/name, the IP or the user agent (a
   * case-insensitive substring, LIKE wildcards taken literally); `user`
   * narrows to one account. Most recently seen first. `counts` are per
   * status under the same `q`/`user`, so the filter shows its alternatives.
   * Without `limit`, every matching session.
   */
  async search(filter: {
    user?: string | undefined;
    status: SessionStatusFilter;
    q?: string | undefined;
    limit?: number | undefined;
    offset: number;
  }): Promise<{ sessions: SessionListItem[]; total: number; counts: Record<Exclude<SessionStatusFilter, "ALL">, number> }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const push = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const idle = push(await this.idleMinutes());
    if (filter.user) conditions.push(`s."user" = ${push(filter.user)}::uuid`);
    if (filter.q?.trim()) {
      const pattern = push(`%${filter.q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
      conditions.push(`(u.email ILIKE ${pattern} OR u.name ILIKE ${pattern} OR host(s.ip) ILIKE ${pattern} OR s.user_agent ILIKE ${pattern})`);
    }
    const base = `FROM totalbase.sessions s JOIN totalbase.users u ON u.id = s."user"`;
    const facetWhere = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const { rows: countRows } = await this.database.query<{ active: number; expired: number; revoked: number }>(
      `SELECT count(*) FILTER (WHERE ${statusCondition("ACTIVE", idle)})::int AS active,
              count(*) FILTER (WHERE ${statusCondition("EXPIRED", idle)})::int AS expired,
              count(*) FILTER (WHERE ${statusCondition("REVOKED", idle)})::int AS revoked
       ${base} ${facetWhere}`,
      params,
    );
    const counts = { ACTIVE: countRows[0]!.active, EXPIRED: countRows[0]!.expired, REVOKED: countRows[0]!.revoked };

    const where = [...conditions, ...(filter.status === "ALL" ? [] : [statusCondition(filter.status, idle)])];
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    // LIMIT NULL is no limit.
    const { rows } = await this.database.query<SessionRow & { user_email: string; user_name: string | null }>(
      `SELECT s.id, s."user", s.ip, s.user_agent, s.created_at, s.last_seen_at, ${sessionEnd(idle)} AS expires_at, s.revoked_at,
              u.email AS user_email, u.name AS user_name
       ${base} ${whereSql}
       ORDER BY s.last_seen_at DESC, s.id
       LIMIT ${push(filter.limit ?? null)}::int OFFSET ${push(filter.offset)}`,
      params,
    );
    const total = filter.status === "ALL" ? counts.ACTIVE + counts.EXPIRED + counts.REVOKED : counts[filter.status];
    return {
      sessions: rows.map((row) => ({ ...toSession(row), userEmail: row.user_email, userName: row.user_name })),
      total,
      counts,
    };
  }

  /**
   * Validates a bearer token and returns the associated user, or null if
   * the session does not exist, is expired - idle too long included - or
   * has been revoked.
   *
   * `userRow` is the user's whole row as PostgreSQL returns it (custom
   * columns included) - what `$USER.*` resolves from - read in the same
   * query, so the Data API needn't read it again after validating.
   */
  async validate(token: string): Promise<{ user: User; session: Session; userRow: Record<string, unknown> } | null> {
    const tokenHash = hashToken(token);
    const idleMinutes = await this.idleMinutes();

    // u.* first, then the session's columns under a prefix no user column
    // carries (both tables have `id` and `created_at`).
    const { rows } = await this.database.query<Record<string, unknown>>(
      `SELECT u.*,
         s.id AS __session_id, s."user" AS __session_user, s.ip AS __session_ip, s.user_agent AS __session_user_agent,
         s.created_at AS __session_created_at, s.last_seen_at AS __session_last_seen_at,
         ${sessionEnd("$2")} AS __session_expires_at, s.revoked_at AS __session_revoked_at
       FROM totalbase.sessions s
       JOIN totalbase.users u ON u.id = s."user"
       WHERE s.token_hash = $1
         AND ${statusCondition("ACTIVE", "$2")}
         AND u.active = true
         AND u.can_login = true`,
      [tokenHash, idleMinutes],
    );

    const row = rows[0];
    if (!row) return null;
    const userRow: Record<string, unknown> = {};
    const sessionRow: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(row)) {
      if (column.startsWith(SESSION_COLUMN_PREFIX)) sessionRow[column.slice(SESSION_COLUMN_PREFIX.length)] = value;
      else userRow[column] = value;
    }
    const session = toSession(sessionRow as unknown as SessionRow);

    // last_seen_at is minute-grained: written only when the stored value is
    // older than a minute, so a busy session costs one write a minute, not
    // one per request (the column is indexed, so each write is a full new
    // row version). The idle timeout reads it, so under a timeout of less
    // than five minutes it is written once a fifth of the timeout instead -
    // a session in use never looks idle.
    await this.database.query(
      `UPDATE totalbase.sessions SET last_seen_at = now()
       WHERE id = $1
         AND last_seen_at < now() - CASE WHEN $2::int BETWEEN 1 AND 4 THEN make_interval(secs => $2::int * 12) ELSE interval '1 minute' END`,
      [session.id, idleMinutes],
    );

    return {
      user: {
        id: userRow.id as string,
        email: userRow.email as string,
        name: userRow.name as string | null,
        avatarUrl: userRow.avatar_url as string | null,
        active: userRow.active as boolean,
        owner: userRow.owner as boolean,
        canLogin: userRow.can_login as boolean,
        emailVerifiedAt: userRow.email_verified_at as Date | null,
        createdAt: userRow.created_at as Date,
      },
      session,
      userRow,
    };
  }

  /** The session's user just confirmed their identity again (Security.md §2.19). */
  async markReauthenticated(sessionId: string, userId: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.sessions SET reauthenticated_at = now() WHERE id = $1 AND "user" = $2`,
      [sessionId, userId],
    );
  }

  /** Whether the session signed in, or re-authenticated, within the last `minutes` - PostgreSQL's clock decides. */
  async authenticatedWithin(sessionId: string, minutes: number): Promise<boolean> {
    const { rows } = await this.database.query<{ recent: boolean }>(
      `SELECT greatest(created_at, coalesce(reauthenticated_at, created_at)) > now() - make_interval(mins => $2::int) AS recent
       FROM totalbase.sessions WHERE id = $1`,
      [sessionId, minutes],
    );
    return rows[0]?.recent ?? false;
  }

  async revokeByToken(token: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
      [hashToken(token)],
    );
  }

  async revokeById(sessionId: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`,
      [sessionId],
    );
  }

  /** Revokes one of `userId`'s own sessions (My account) - false when it isn't theirs or doesn't exist. */
  async revokeOwn(sessionId: string, userId: string): Promise<boolean> {
    const { rows } = await this.database.query<{ id: string }>(
      `UPDATE totalbase.sessions SET revoked_at = coalesce(revoked_at, now())
       WHERE id = $1 AND "user" = $2
       RETURNING id`,
      [sessionId, userId],
    );
    return rows.length > 0;
  }

  /**
   * Deletes sessions that ended - revoked, or expired - more than
   * `retentionDays` ago (auth.session_retention_days; 0 keeps them all).
   * Sessions grow with every sign-in and each new one past
   * auth.max_sessions_per_user revokes the oldest, so without this the
   * table only grows. Returns how many were deleted.
   */
  async purgeEnded(retentionDays: number): Promise<number> {
    if (retentionDays <= 0) return 0;
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.sessions s
       WHERE coalesce(s.revoked_at, ${sessionEnd("$2")}) < now() - make_interval(days => $1)`,
      [retentionDays, await this.idleMinutes()],
    );
    return rowCount ?? 0;
  }

  /** Sessions started in the last `days` days, counted per user agent (the Sign-ins insights' devices - the admin names them). */
  async userAgentsSince(days: number): Promise<Array<{ userAgent: string | null; count: number }>> {
    const { rows } = await this.database.query<{ userAgent: string | null; count: number }>(
      `SELECT user_agent AS "userAgent", count(*)::int AS count FROM totalbase.sessions
       WHERE created_at >= now() - make_interval(days => $1::int)
       GROUP BY 1 ORDER BY 2 DESC LIMIT 200`,
      [days],
    );
    return rows;
  }

  /** Sessions still signed in - not revoked, not expired (the Users panel's count). */
  async countActive(): Promise<number> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM totalbase.sessions s WHERE ${statusCondition("ACTIVE", "$1")}`,
      [await this.idleMinutes()],
    );
    return Number(rows[0]!.count);
  }

  /** `exceptSessionId` keeps one session alive - the caller's own, when they change their own password. */
  async revokeAllForUser(userId: string, exceptSessionId?: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.sessions SET revoked_at = now()
       WHERE "user" = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
      [userId, exceptSessionId ?? null],
    );
  }
}
