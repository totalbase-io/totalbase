import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { generateOpaqueToken, hashToken } from "./tokens.js";

/** See Specification_Security.md. */
export type AuthTokenType = "INVITATION" | "PASSWORD_RESET" | "EMAIL_VERIFICATION";

/**
 * Single-use tokens for invitation, password reset and email verification
 * flows. See Specification_Security.md.
 */
export class AuthTokensService {
  constructor(private readonly database: Database) {}

  async create(
    userId: string,
    type: AuthTokenType,
    ttlHours: number,
    client: Queryable = this.database,
  ): Promise<string> {
    const token = generateOpaqueToken();
    // make_interval()'s "hours" parameter is an integer and would reject a
    // fractional value (e.g. a 15-minute TTL expressed as 0.25 hours).
    // Interval-by-scalar multiplication accepts fractional hours instead.
    // Issuing a new link retires every still-unused one of the same type
    // for that user (marked used, in the same statement), so re-sending an
    // invitation or reset doesn't leave the older links working too.
    await client.query(
      `WITH retired AS (
         UPDATE totalbase.emails_tokens SET used_at = now()
         WHERE "user" = $1 AND type = $2 AND used_at IS NULL
       )
       INSERT INTO totalbase.emails_tokens ("user", type, token_hash, expires_at)
       VALUES ($1, $2, $3, now() + ($4 * interval '1 hour'))`,
      [userId, type, hashToken(token), ttlHours],
    );
    return token;
  }

  /** Retires every still-unused link of these types for a user (e.g. once an admin sets the password, pending invitation/reset links must stop working). */
  async retire(userId: string, types: AuthTokenType[]): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.emails_tokens SET used_at = now() WHERE "user" = $1 AND type = ANY($2) AND used_at IS NULL`,
      [userId, types],
    );
  }

  /**
   * Validates and consumes a token: it must exist, match the expected
   * type, not be expired, and not already be used.
   */
  async consume(token: string, type: AuthTokenType): Promise<string> {
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
