import type { Database } from "@totalbase/database";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import type { RoleAssignmentsService, RolesService } from "@totalbase/permissions";
import type { SettingsService } from "@totalbase/settings";
import { validateDescription, validateName } from "@totalbase/shared";
import { generateUserApiKey, hashUserApiKey } from "./tokens.js";

export type UserApiPlane = "API" | "ADMIN";

/**
 * Why a token refuses a secret that is its own (Security.md §11.6): revoked, deactivated, past its expiry (or
 * its previous secret past the grace window), its user inactive, the address outside `allowed_ips`, or its
 * user's roles no longer granting its plane.
 */
export type TokenRefusal = "revoked" | "inactive" | "expired" | "user_inactive" | "ip_not_allowed" | "no_access";

export interface UserApi {
  id: string;
  user: string;
  name: string;
  description: string | null;
  plane: UserApiPlane;
  keyPrefix: string;
  active: boolean;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  rotatedAt: Date | null;
  /** Until when the secret replaced by the last regeneration still works - null when it stopped at once. */
  previousExpiresAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
  /** The addresses and CIDR ranges the token is accepted from (Security.md §3.5) - null: from anywhere. */
  allowedIps: string[] | null;
}

interface UserApiRow {
  id: string;
  user: string;
  name: string;
  description: string | null;
  plane: UserApiPlane;
  key_prefix: string;
  active: boolean;
  expires_at: Date | null;
  last_used_at: Date | null;
  rotated_at: Date | null;
  previous_expires_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
  allowed_ips: string[] | null;
}

const SELECT_COLUMNS = `id, "user", name, description, plane, key_prefix, active, expires_at, last_used_at, rotated_at, previous_expires_at, revoked_at, created_at, allowed_ips`;

function toUserApi(row: UserApiRow): UserApi {
  return {
    id: row.id,
    user: row.user,
    name: row.name,
    description: row.description,
    plane: row.plane,
    keyPrefix: row.key_prefix,
    active: row.active,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    rotatedAt: row.rotated_at,
    previousExpiresAt: row.previous_expires_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    allowedIps: row.allowed_ips,
  };
}

/** A token's name is unique per user, case-insensitively (tokens_user_name_unique) - PostgreSQL decides, this only words the error. */
function mapUniqueViolation(error: unknown, name: string): never {
  return remapUniqueViolation(error, [{ constraint: "tokens_user_name_unique", code: "USER_API_NAME_DUPLICATE", message: `This user already has a token named "${name}".` }]);
}

/**
 * `allowedIps` as the column takes it: a list of addresses and CIDR ranges, or null - an empty list is no
 * restriction. What an address is, PostgreSQL decides (inet): an entry it can't read is its own
 * `400 INVALID_TEXT_REPRESENTATION`, more than 50 the column's CHECK.
 */
function allowedIpsParameter(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
    throw new TotalBaseError("INVALID_QUERY", "allowedIps is a list of IP addresses and CIDR ranges.");
  }
  return value.length === 0 ? null : value.map((entry: string) => entry.trim());
}

/** Longest lifetime a token may be issued with - ten years. Every token expires. */
export const USER_API_MAX_TTL_DAYS = 3650;
/** How long a regenerated token's old secret can stay valid: seven days, like Stripe's longest roll. */
export const USER_API_MAX_GRACE_HOURS = 168;

/**
 * Personal access tokens. A token has no roles of
 * its own: plane='API' inherits the owning user's data-plane roles,
 * resolved LIVE at validate() time (not frozen at creation), so
 * revoking a role from the user instantly demotes every token they
 * hold. plane='ADMIN' requires the owning user to currently hold the
 * reserved "Administrators" role - checked both at creation and at
 * every validate() call, for the same live-revocation reason.
 */
export class UsersApisService {
  constructor(
    private readonly database: Database,
    private readonly settings: SettingsService,
    private readonly roles: RolesService,
    private readonly roleAssignments: RoleAssignmentsService,
  ) {}

  async listForUser(userId: string): Promise<UserApi[]> {
    const { rows } = await this.database.query<UserApiRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.tokens WHERE "user" = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(toUserApi);
  }

  async list(): Promise<UserApi[]> {
    const { rows } = await this.database.query<UserApiRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.tokens ORDER BY created_at DESC`,
    );
    return rows.map(toUserApi);
  }

  /** Tokens that still authenticate - active, not revoked, not expired (the Users panel's count). */
  async countUsable(): Promise<number> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM totalbase.tokens
       WHERE active AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`,
    );
    return Number(rows[0]!.count);
  }

  /** Usable tokens that stop working within `days` (api_keys.rotation_warning_days) - the dashboard's "expiring" reminder. */
  async countExpiringWithin(days: number): Promise<number> {
    const { rows } = await this.database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM totalbase.tokens
       WHERE active AND revoked_at IS NULL AND expires_at > now() AND expires_at <= now() + make_interval(days => $1::int)`,
      [days],
    );
    return Number(rows[0]!.count);
  }

  async listByIds(ids: string[]): Promise<UserApi[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.database.query<UserApiRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.tokens WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return rows.map(toUserApi);
  }

  async findById(id: string): Promise<UserApi | null> {
    const { rows } = await this.database.query<UserApiRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.tokens WHERE id = $1`,
      [id],
    );
    return rows[0] ? toUserApi(rows[0]) : null;
  }

  /** Returns the plaintext token exactly once, at creation time. */
  async create(input: {
    userId: string;
    name: string;
    description?: string | null | undefined;
    plane: UserApiPlane;
    ttlDays?: number | undefined;
    allowedIps?: string[] | null | undefined;
  }): Promise<{ plainKey: string; userApi: UserApi }> {
    await this.assertUserCanHoldTokens(input.userId);
    if (input.plane === "ADMIN") {
      await this.assertUserIsAdministrator(input.userId);
    } else {
      await this.assertUserHasApiAccess(input.userId);
    }

    const { plainKey, keyPrefix, keyHash } = generateUserApiKey();
    const ttlDays = await this.resolveTtlDays(input.ttlDays);
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const allowedIps = allowedIpsParameter(input.allowedIps);

    try {
      const { rows } = await this.database.query<UserApiRow>(
        `INSERT INTO totalbase.tokens ("user", name, description, plane, key_prefix, key_hash, expires_at, allowed_ips)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(days => $7), $8::inet[])
         RETURNING ${SELECT_COLUMNS}`,
        [input.userId, name, description, input.plane, keyPrefix, keyHash, ttlDays, allowedIps],
      );
      return { plainKey, userApi: toUserApi(rows[0]!) };
    } catch (error) {
      mapUniqueViolation(error, name);
    }
  }

  /**
   * Validates a presented token. Resolves the owning user's active roles
   * LIVE and requires them to still grant the token's plane - admin
   * access for plane='ADMIN', API access for plane='API' - so a role
   * change kills the token immediately, not just at its next creation.
   *
   * `clientIp` is the address the request came from, and it is not optional: a token with `allowed_ips` is
   * accepted only from one of them (Security.md §3.5) - PostgreSQL compares - and a caller that knows no
   * address (undefined) is refused for such a token, never let through. `403 TOKEN_IP_NOT_ALLOWED`.
   */
  async validate(plainKey: string, clientIp: string | undefined): Promise<{ id: string; userId: string; plane: UserApiPlane; roleIds: string[] } | null> {
    const row = await this.lookup(plainKey, clientIp);
    if (!row) return null;
    if (row.refusal === "ip_not_allowed") {
      throw new TotalBaseError("TOKEN_IP_NOT_ALLOWED", "This token is not accepted from this address.");
    }
    if (row.refusal !== null) return null;

    // Re-checked live on every use, not just at creation: losing the
    // role (or the flag on it) kills every outstanding token at once.
    const roleIds = await this.roleAssignments.listEffectiveRolesForUser(row.user);
    const access = await this.roles.effectiveAccess(roleIds);
    if (row.plane === "ADMIN" ? !(await this.roles.holdsAdministratorsRole(roleIds)) : !access.apiAccess) return null;

    // last_used_at is minute-grained: one write a minute per busy token, not
    // one per request. The apis trigger leaves updated_at
    // alone for this column - using a token doesn't change it.
    await this.database.query(
      `UPDATE totalbase.tokens SET last_used_at = now()
       WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
      [row.id],
    );

    return { id: row.id, userId: row.user, plane: row.plane, roleIds };
  }

  /**
   * The token a presented secret belongs to - its current secret or the one its last regeneration replaced -
   * and why the token itself refuses it, if it does: one statement, PostgreSQL's clock and PostgreSQL's
   * comparison of the address (`<<=`). Null: no token has that secret.
   */
  private async lookup(plainKey: string, clientIp: string | undefined): Promise<{ id: string; user: string; plane: UserApiPlane; refusal: Exclude<TokenRefusal, "no_access"> | null } | null> {
    const { rows } = await this.database.query<{ id: string; user: string; plane: UserApiPlane; refusal: Exclude<TokenRefusal, "no_access"> | null }>(
      `SELECT a.id, a."user", a.plane,
              CASE
                WHEN a.revoked_at IS NOT NULL THEN 'revoked'
                WHEN a.active IS NOT TRUE THEN 'inactive'
                -- The current secret past its expiry, or the previous one past the grace window its regeneration left (§3.3).
                -- IS NOT TRUE, not NOT: with no previous secret the second half is NULL, and NULL must refuse.
                WHEN ((a.key_hash = $1 AND (a.expires_at IS NULL OR a.expires_at > now()))
                   OR (a.previous_key_hash = $1 AND a.previous_expires_at > now())) IS NOT TRUE THEN 'expired'
                -- The owning user must be active too - deactivating a user stops their tokens at once, the same way
                -- their sessions stop validating - and a person (can_login), never a system account.
                WHEN (u.active AND u.can_login) IS NOT TRUE THEN 'user_inactive'
                WHEN (a.allowed_ips IS NULL OR $2::inet <<= ANY(a.allowed_ips)) IS NOT TRUE THEN 'ip_not_allowed'
              END AS refusal
         FROM totalbase.tokens a
         JOIN totalbase.users u ON u.id = a."user"
        WHERE a.key_hash = $1 OR a.previous_key_hash = $1
        ORDER BY (a.key_hash = $1) DESC
        LIMIT 1`,
      [hashUserApiKey(plainKey), clientIp ?? null],
    );
    return rows[0] ?? null;
  }

  /**
   * Why a presented secret is refused, for the audit log (Security.md §11.6, `auth.token_refused`): the token it
   * belongs to and the reason - or null when no token has that secret (an invented one: nothing to name) or
   * when the token is in order (the request was refused for something else). Changes nothing.
   */
  async refusalOf(plainKey: string, clientIp: string | undefined): Promise<{ id: string; userId: string; plane: UserApiPlane; reason: TokenRefusal } | null> {
    const row = await this.lookup(plainKey, clientIp);
    if (!row) return null;
    if (row.refusal !== null) return { id: row.id, userId: row.user, plane: row.plane, reason: row.refusal };
    const roleIds = await this.roleAssignments.listEffectiveRolesForUser(row.user);
    const access = await this.roles.effectiveAccess(roleIds);
    const holdsPlane = row.plane === "ADMIN" ? await this.roles.holdsAdministratorsRole(roleIds) : access.apiAccess;
    return holdsPlane ? null : { id: row.id, userId: row.user, plane: row.plane, reason: "no_access" };
  }

  /**
   * Regenerates a token (GitHub's model): a new secret and a new expiry -
   * `ttlDays` from now, the setting's default when omitted - keeping the
   * token itself (name, access, audit history). The old secret stops
   * working at once - unless `graceHours` keeps it valid that much longer
   * (Stripe's "roll key", at most USER_API_MAX_GRACE_HOURS, never past its
   * own expiry), so a deployment can switch without downtime. Works on an
   * expired token - renewing it is the usual reason to regenerate - but
   * never on a revoked one: revocation is final.
   */
  async rotate(id: string, ttlDays?: number, graceHours = 0): Promise<{ plainKey: string; userApi: UserApi }> {
    const days = await this.resolveTtlDays(ttlDays);
    if (!Number.isInteger(graceHours) || graceHours < 0 || graceHours > USER_API_MAX_GRACE_HOURS) {
      throw new TotalBaseError("INVALID_TOKEN_EXPIRY", `The old secret can stay valid 0 to ${USER_API_MAX_GRACE_HOURS} hours.`);
    }
    const { plainKey, keyPrefix, keyHash } = generateUserApiKey();
    const { rows } = await this.database.query<UserApiRow>(
      `UPDATE totalbase.tokens
       SET key_prefix = $2, key_hash = $3, expires_at = now() + make_interval(days => $4), rotated_at = now(), updated_at = now(),
           -- The old secret's grace window - none when it was already expired or no grace asked.
           previous_key_hash = CASE WHEN $5 > 0 AND (expires_at IS NULL OR expires_at > now()) THEN key_hash END,
           previous_expires_at = CASE WHEN $5 > 0 AND (expires_at IS NULL OR expires_at > now())
                                      THEN LEAST(now() + make_interval(hours => $5), COALESCE(expires_at, 'infinity')) END
       WHERE id = $1 AND revoked_at IS NULL AND active
       RETURNING ${SELECT_COLUMNS}`,
      [id, keyPrefix, keyHash, days, graceHours],
    );
    if (!rows[0]) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", "Token not found or revoked - a revoked token can't be regenerated.");
    }
    return { plainKey, userApi: toUserApi(rows[0]) };
  }

  /** Every token expires: 1 to USER_API_MAX_TTL_DAYS days, `api_keys.default_ttl_days` when not given. */
  private async resolveTtlDays(ttlDays: number | undefined): Promise<number> {
    const days = ttlDays ?? (await this.settings.get("api_keys.default_ttl_days"));
    if (!Number.isInteger(days) || days < 1 || days > USER_API_MAX_TTL_DAYS) {
      throw new TotalBaseError("INVALID_TOKEN_EXPIRY", `A token must expire in 1 to ${USER_API_MAX_TTL_DAYS} days.`);
    }
    return days;
  }

  async revoke(id: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.tokens SET active = false, revoked_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async delete(id: string): Promise<void> {
    await this.database.query(`DELETE FROM totalbase.tokens WHERE id = $1`, [id]);
  }

  private async isUserAdministrator(userId: string): Promise<boolean> {
    const roleIds = await this.roleAssignments.listEffectiveRolesForUser(userId);
    return this.roles.holdsAdministratorsRole(roleIds);
  }

  /**
   * A token is a person's credential: a system account (can_login =
   * false, e.g. the Workflows account) holds none - one would be an
   * unattributable credential that outlives whoever issued it.
   */
  private async assertUserCanHoldTokens(userId: string): Promise<void> {
    const { rows } = await this.database.query<{ can_login: boolean }>(
      `SELECT can_login FROM totalbase.users WHERE id = $1`,
      [userId],
    );
    if (!rows[0]) throw new TotalBaseError("RESOURCE_NOT_FOUND", "User not found.");
    if (!rows[0].can_login) {
      throw new TotalBaseError("PERMISSION_DENIED", "System accounts can't hold tokens.");
    }
  }

  private async assertUserHasApiAccess(userId: string): Promise<void> {
    const roleIds = await this.roleAssignments.listEffectiveRolesForUser(userId);
    if (!(await this.roles.effectiveAccess(roleIds)).apiAccess) {
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        "Only a user whose roles grant API access can hold a plane=\"API\" token.",
      );
    }
  }

  private async assertUserIsAdministrator(userId: string): Promise<void> {
    if (!(await this.isUserAdministrator(userId))) {
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        "Only a member of the Administrators role can hold a plane=\"ADMIN\" token.",
      );
    }
  }
}
