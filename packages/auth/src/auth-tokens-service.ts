import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { generateOpaqueToken, hashToken } from "./tokens.js";

/** See Security.md. */
export type AuthTokenType = "INVITATION" | "PASSWORD_RESET" | "EMAIL_VERIFICATION";

/**
 * Single-use tokens for invitation, password reset and email verification
 * flows. See Security.md.
 */
export class AuthTokensService {
  constructor(private readonly database: Database) {}

  async create(
    userId: string,
    type: AuthTokenType,
    ttlHours: number,
    client: Queryable = this.database,
    options: { retireEarlier?: boolean } = {},
  ): Promise<string> {
    const token = generateOpaqueToken();
    // make_interval()'s "hours" parameter is an integer and would reject a
    // fractional value (e.g. a 15-minute TTL expressed as 0.25 hours).
    // Interval-by-scalar multiplication accepts fractional hours instead.
    // Issuing a new link retires every still-unused one of the same type
    // for that user (marked used, in the same statement), so re-sending an
    // invitation or reset doesn't leave the older links working too - unless
    // `retireEarlier` is false: a request anyone may make (createUnlessRecent)
    // never cancels the link its owner is using.
    await client.query(
      `WITH retired AS (
         UPDATE totalbase.emails_tokens SET used_at = now()
         WHERE "user" = $1 AND type = $2 AND used_at IS NULL AND $5
       )
       INSERT INTO totalbase.emails_tokens ("user", type, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 hour'))`,
      [userId, type, hashToken(token), ttlHours, options.retireEarlier ?? true],
    );
    return token;
  }

  /**
   * A new link, unless a still-unused one of this type was issued to the user within `cooldownSeconds` - then null,
   * nothing issued, the earlier link kept working (Security.md §2.8). An earlier link keeps working either way, until
   * it expires or one of them is used: anyone may make this request, so it never cancels the owner's link. Checked and issued under one lock per user and
   * type, so requests arriving together issue one link, not several.
   */
  async createUnlessRecent(userId: string, type: AuthTokenType, ttlHours: number, cooldownSeconds: number): Promise<string | null> {
    return this.database.transaction(async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('totalbase.emails_tokens:' || $1 || ':' || $2))`, [userId, type]);
      const { rows } = await client.query(
        `SELECT 1 FROM totalbase.emails_tokens WHERE "user" = $1 AND type = $2 AND used_at IS NULL AND created_at > now() - ($3 * interval '1 second') LIMIT 1`,
        [userId, type, cooldownSeconds],
      );
      if (rows.length > 0) return null;
      return this.create(userId, type, ttlHours, client, { retireEarlier: false });
    });
  }

  /** Retires every still-unused link of these types for a user (e.g. once an admin sets the password, pending invitation/reset links must stop working). */
  async retire(userId: string, types: AuthTokenType[]): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.emails_tokens SET used_at = now() WHERE "user" = $1 AND type = ANY($2) AND used_at IS NULL`,
      [userId, types],
    );
  }

  /** Whose link this is, without using it - null for one that wouldn't be accepted. */
  async peek(token: string, type: AuthTokenType): Promise<string | null> {
    if (typeof token !== "string") return null;
    const { rows } = await this.database.query<{ user: string }>(
      `SELECT "user" FROM totalbase.emails_tokens WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()`,
      [hashToken(token), type],
    );
    return rows[0]?.user ?? null;
  }

  /**
   * Validates and consumes a token: it must exist, match the expected
   * type, not be expired, and not already be used.
   */
  async consume(token: string, type: AuthTokenType): Promise<string> {
    // A body without it (or with another JSON type) is a token nothing issued.
    if (typeof token !== "string") throw new TotalBaseError("INVALID_TOKEN", "Token is invalid, expired, or already used.");
    return this.database.transaction(async (client) => {
      const { rows } = await client.query<{ id: string; user: string }>(
        `SELECT id, "user" FROM totalbase.emails_tokens
         WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()
         FOR UPDATE`,
        [hashToken(token), type],
      );

      const row = rows[0];
      if (!row) {
        throw new TotalBaseError("INVALID_TOKEN", "Token is invalid, expired, or already used.");
      }

      await client.query(`UPDATE totalbase.emails_tokens SET used_at = now() WHERE id = $1`, [
        row.id,
      ]);

      return row.user;
    });
  }
}
