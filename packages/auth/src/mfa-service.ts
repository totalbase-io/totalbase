import { createHash, randomBytes } from "node:crypto";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { decryptSecret, encryptSecret } from "@totalbase/secrets";
import type { SettingsService } from "@totalbase/settings";
import { generateOpaqueToken, hashToken } from "./tokens.js";
import { generateTotpSecret, matchTotp, otpauthUrl } from "./totp.js";

/** Which sign-in a challenge continues: the Data API's (`/api/auth/login`) or the portal's (`/admin/api/auth/login`). */
export type MfaSurface = "API" | "PORTAL";
/** VERIFY: enter the code. ENROLL: the instance requires a factor the user hasn't set up yet. */
export type ChallengePurpose = "VERIFY" | "ENROLL";

export interface MfaChallenge {
  challenge: string;
  purpose: ChallengePurpose;
  expiresAt: Date;
}

export interface MfaStatus {
  /** A confirmed factor: sign-in asks its code. */
  enabled: boolean;
  enabledAt: Date | null;
  /** Unused recovery codes left (0 when not enabled). */
  recoveryCodesLeft: number;
  /** `auth.mfa_required` covers this user - they can't turn it off. */
  required: boolean;
}

/** What an authenticator app needs: the secret (to type it in) and the `otpauth://` link (the QR code's content). */
export interface MfaEnrollment {
  secret: string;
  otpauthUrl: string;
}

export interface MfaServiceOptions {
  /** Whether the user holds the Administrators role - for `auth.mfa_required = ADMINISTRATORS`. */
  isAdministrator: (userId: string) => Promise<boolean>;
}

/** About five minutes to type a code (Security.md §2.17). */
const CHALLENGE_TTL_MINUTES = 5;
/** Wrong codes one challenge takes before it is spent - the account's lockout counts them too. */
const CHALLENGE_MAX_ATTEMPTS = 5;
export const RECOVERY_CODE_COUNT = 10;

const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** `xxxxx-xxxxx` from an alphabet without look-alikes (no 0/o, 1/l/i) - about 49 bits each. */
function generateRecoveryCode(): string {
  const bytes = randomBytes(10);
  const chars = [...bytes].map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** A recovery code's hash: case, spaces and dashes don't matter when it is typed. */
function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(code.toLowerCase().replace(/[\s-]/g, ""), "utf8").digest("hex");
}

interface FactorRow {
  id: string;
  secret: string;
  confirmed_at: Date | null;
  last_used_step: string | null;
}

/**
 * Multi-factor authentication (Security.md §2.17): TOTP factors in `totalbase.factors` (the secret encrypted
 * with the master key), their recovery codes, and the sign-in challenges. Every check that two requests could
 * race - a code used twice, a challenge completed twice, a recovery code spent twice - is one conditional
 * UPDATE PostgreSQL decides.
 */
export class MfaService {
  constructor(
    private readonly database: Database,
    private readonly settings: SettingsService,
    private readonly masterKey: string,
    private readonly options: MfaServiceOptions,
  ) {}

  /** Whether `auth.mfa_required` covers this user. */
  async required(userId: string): Promise<boolean> {
    const policy = await this.settings.get("auth.mfa_required");
    if (policy === "EVERYONE") return true;
    if (policy === "ADMINISTRATORS") return this.options.isAdministrator(userId);
    return false;
  }

  async status(userId: string): Promise<MfaStatus> {
    const { rows } = await this.database.query<{ confirmed_at: Date | null; codes: string }>(
      `SELECT f.confirmed_at,
              (SELECT count(*) FROM totalbase.factors_codes c WHERE c.factor = f.id AND c.used_at IS NULL) AS codes
       FROM totalbase.factors f WHERE f."user" = $1 AND f.type = 'TOTP' AND f.confirmed_at IS NOT NULL`,
      [userId],
    );
    const row = rows[0];
    return {
      enabled: row !== undefined,
      enabledAt: row?.confirmed_at ?? null,
      recoveryCodesLeft: row ? Number(row.codes) : 0,
      required: await this.required(userId),
    };
  }

  /**
   * The second step due after a correct password: a VERIFY challenge when the user has a factor, an ENROLL one
   * when the instance requires a factor they don't have, else null (the session is created at once).
   */
  async secondStep(userId: string, surface: MfaSurface): Promise<MfaChallenge | null> {
    const factor = await this.confirmedFactor(this.database, userId);
    const purpose: ChallengePurpose | null = factor ? "VERIFY" : (await this.required(userId)) ? "ENROLL" : null;
    if (!purpose) return null;
    const challenge = generateOpaqueToken();
    const { rows } = await this.database.query<{ expires_at: Date }>(
      `INSERT INTO totalbase.challenges ("user", purpose, surface, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(mins => $5))
       RETURNING expires_at`,
      [userId, purpose, surface, hashToken(challenge), CHALLENGE_TTL_MINUTES],
    );
    return { challenge, purpose, expiresAt: rows[0]!.expires_at };
  }

  /**
   * Enrollment from My account: a new secret, kept unconfirmed until its first code (`confirmEnrollment`).
   * Starting again replaces an unconfirmed one; a confirmed factor must be turned off first.
   */
  async startEnrollment(userId: string, account: string): Promise<MfaEnrollment> {
    const secret = generateTotpSecret();
    const { rowCount } = await this.database.query(
      `INSERT INTO totalbase.factors ("user", type, secret) VALUES ($1, 'TOTP', $2)
       ON CONFLICT ("user", type) DO UPDATE SET secret = EXCLUDED.secret, last_used_step = NULL, created_at = now()
       WHERE totalbase.factors.confirmed_at IS NULL`,
      [userId, encryptSecret(this.masterKey, secret)],
    );
    if (rowCount === 0) throw new TotalBaseError("MFA_ALREADY_ENABLED", "Two-factor authentication is already on - turn it off first to set up another app.");
    return { secret, otpauthUrl: otpauthUrl({ secret, issuer: await this.issuer(), account }) };
  }

  /** The first code of a pending factor confirms it; the recovery codes are returned, once. */
  async confirmEnrollment(userId: string, code: unknown): Promise<string[]> {
    return this.database.transaction(async (client) => {
      const { rows } = await client.query<FactorRow>(
        `SELECT id, secret, confirmed_at, last_used_step FROM totalbase.factors WHERE "user" = $1 AND type = 'TOTP' FOR UPDATE`,
        [userId],
      );
      const factor = rows[0];
      if (!factor) throw new TotalBaseError("MFA_NOT_ENABLED", "Start setting up two-factor authentication first.");
      if (factor.confirmed_at) throw new TotalBaseError("MFA_ALREADY_ENABLED", "Two-factor authentication is already on.");
      await this.acceptCode(client, factor, code);
      await client.query(`UPDATE totalbase.factors SET confirmed_at = now() WHERE id = $1`, [factor.id]);
      return this.replaceRecoveryCodes(client, factor.id);
    });
  }

  /** Turns it off: the factor and its recovery codes go. Refused while `auth.mfa_required` covers the user. */
  async disable(userId: string, proof: { code?: unknown; recoveryCode?: unknown }): Promise<void> {
    if (await this.required(userId)) {
      throw new TotalBaseError("PERMISSION_DENIED", "This instance requires two-factor authentication for your account - it can't be turned off.");
    }
    await this.database.transaction(async (client) => {
      const factor = await this.lockedConfirmedFactor(client, userId);
      await this.acceptProof(client, factor, proof);
      await client.query(`DELETE FROM totalbase.factors WHERE id = $1`, [factor.id]);
    });
  }

  /**
   * Confirms the account's identity with a current code or an unused recovery code (re-authentication,
   * Security.md §2.19). `MFA_NOT_ENABLED` without a confirmed factor, `INVALID_MFA_CODE` for a wrong proof.
   */
  async confirm(userId: string, proof: { code?: unknown; recoveryCode?: unknown }): Promise<void> {
    await this.database.transaction(async (client) => {
      await this.acceptProof(client, await this.lockedConfirmedFactor(client, userId), proof);
    });
  }

  /** New recovery codes, the old ones dropped - with a current code. */
  async regenerateRecoveryCodes(userId: string, code: unknown): Promise<string[]> {
    return this.database.transaction(async (client) => {
      const factor = await this.lockedConfirmedFactor(client, userId);
      await this.acceptCode(client, factor, code);
      return this.replaceRecoveryCodes(client, factor.id);
    });
  }

  /** An administrator's Reset (a lost phone): the factor goes, the user sets one up again. False when there was none. */
  async reset(userId: string): Promise<boolean> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.factors WHERE "user" = $1 AND confirmed_at IS NOT NULL`, [userId]);
    return rowCount > 0;
  }

  /** An ENROLL challenge's first step: a secret for the user's app, pending until `completeChallenge` confirms it. */
  async startChallengeEnrollment(challenge: unknown): Promise<MfaEnrollment> {
    const row = await this.openChallenge(this.database, challenge);
    if (row.purpose !== "ENROLL") throw invalidChallenge();
    const { rows } = await this.database.query<{ email: string }>(`SELECT email FROM totalbase.users WHERE id = $1`, [row.user]);
    return this.startEnrollment(row.user, rows[0]?.email ?? "");
  }

  /**
   * The second step of a sign-in. VERIFY takes a current code or an unused recovery code; ENROLL takes the
   * pending factor's first code, confirms it and returns its recovery codes. A wrong code counts toward the
   * account's lockout and the challenge's own attempts; a locked or inactive account spends the challenge.
   * The surface's own access rule is the caller's to check again (roles may have changed since the password).
   */
  async completeChallenge(input: {
    challenge: unknown;
    surface: MfaSurface;
    code?: unknown;
    recoveryCode?: unknown;
    onWrongCode: (userId: string) => Promise<void>;
  }): Promise<{ userId: string; recoveryCodes: string[] | null; usedRecoveryCode: boolean }> {
    const wrong: { userId?: string; spend?: boolean } = {};
    try {
      return await this.database.transaction(async (client) => {
        const challenge = await this.openChallenge(client, input.challenge, { lock: true });
        if (challenge.surface !== input.surface) throw invalidChallenge();
        const { rows: users } = await client.query<{ usable: boolean }>(
          `SELECT active AND can_login AND NOT coalesce(locked_until > now(), false) AS usable FROM totalbase.users WHERE id = $1`,
          [challenge.user],
        );
        if (!users[0]?.usable) {
          wrong.spend = true;
          throw invalidChallenge();
        }
        try {
          if (challenge.purpose === "ENROLL") {
            const { rows } = await client.query<FactorRow>(
              `SELECT id, secret, confirmed_at, last_used_step FROM totalbase.factors WHERE "user" = $1 AND type = 'TOTP' FOR UPDATE`,
              [challenge.user],
            );
            const pending = rows[0];
            if (!pending || pending.confirmed_at) throw invalidChallenge();
            await this.acceptCode(client, pending, input.code);
            await client.query(`UPDATE totalbase.factors SET confirmed_at = now() WHERE id = $1`, [pending.id]);
            await this.spend(client, challenge.id);
            return { userId: challenge.user, recoveryCodes: await this.replaceRecoveryCodes(client, pending.id), usedRecoveryCode: false };
          }
          const factor = await this.lockedConfirmedFactor(client, challenge.user).catch(() => {
            throw invalidChallenge(); // reset by an administrator meanwhile
          });
          const usedRecoveryCode = await this.acceptProof(client, factor, { code: input.code, recoveryCode: input.recoveryCode });
          await this.spend(client, challenge.id);
          return { userId: challenge.user, recoveryCodes: null, usedRecoveryCode };
        } catch (error) {
          if (error instanceof TotalBaseError && error.code === "INVALID_MFA_CODE") wrong.userId = challenge.user;
          throw error;
        }
      });
    } catch (error) {
      // Outside the rolled-back transaction, so they stay: a spent challenge, a wrong code counted.
      if (wrong.spend) {
        await this.database.query(`UPDATE totalbase.challenges SET used_at = now() WHERE token_hash = $1`, [hashToken(String(input.challenge))]);
      }
      if (wrong.userId) {
        await this.database.query(
          `UPDATE totalbase.challenges SET attempts = attempts + 1, used_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE used_at END
           WHERE token_hash = $1`,
          [hashToken(String(input.challenge)), CHALLENGE_MAX_ATTEMPTS],
        );
        await input.onWrongCode(wrong.userId);
      }
      throw error;
    }
  }

  /** Challenges that ended (used or expired) a day ago and more - the retention job's. */
  async purgeChallenges(): Promise<number> {
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.challenges WHERE coalesce(used_at, expires_at) < now() - interval '1 day'`,
    );
    return rowCount;
  }

  private async issuer(): Promise<string> {
    return (await this.settings.get("system.instance_name")) || "TotalBase";
  }

  private async confirmedFactor(client: Queryable, userId: string): Promise<{ id: string } | null> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM totalbase.factors WHERE "user" = $1 AND type = 'TOTP' AND confirmed_at IS NOT NULL`,
      [userId],
    );
    return rows[0] ?? null;
  }

  private async lockedConfirmedFactor(client: Queryable, userId: string): Promise<FactorRow> {
    const { rows } = await client.query<FactorRow>(
      `SELECT id, secret, confirmed_at, last_used_step FROM totalbase.factors
       WHERE "user" = $1 AND type = 'TOTP' AND confirmed_at IS NOT NULL FOR UPDATE`,
      [userId],
    );
    if (!rows[0]) throw new TotalBaseError("MFA_NOT_ENABLED", "Two-factor authentication isn't on for this account.");
    return rows[0];
  }

  /** A code from the app, or an unused recovery code. True when a recovery code was spent. */
  private async acceptProof(client: Queryable, factor: FactorRow, proof: { code?: unknown; recoveryCode?: unknown }): Promise<boolean> {
    if (typeof proof.recoveryCode === "string" && proof.recoveryCode.trim()) {
      const { rowCount } = await client.query(
        `UPDATE totalbase.factors_codes SET used_at = now() WHERE factor = $1 AND code_hash = $2 AND used_at IS NULL`,
        [factor.id, hashRecoveryCode(proof.recoveryCode)],
      );
      if (rowCount === 0) throw new TotalBaseError("INVALID_MFA_CODE", "That recovery code isn't valid, or was already used.");
      return true;
    }
    await this.acceptCode(client, factor, proof.code);
    return false;
  }

  /** A current TOTP code, never one already used: `last_used_step` only moves forward, in one UPDATE. */
  private async acceptCode(client: Queryable, factor: FactorRow, code: unknown): Promise<void> {
    const secret = decryptSecret(this.masterKey, factor.secret);
    const lastUsed = factor.last_used_step === null ? null : Number(factor.last_used_step);
    const step = typeof code === "string" ? matchTotp(secret, code, lastUsed) : null;
    const { rowCount } = step === null
      ? { rowCount: 0 }
      : await client.query(
          `UPDATE totalbase.factors SET last_used_step = $2 WHERE id = $1 AND (last_used_step IS NULL OR last_used_step < $2)`,
          [factor.id, step],
        );
    if (rowCount === 0) throw new TotalBaseError("INVALID_MFA_CODE", "That code isn't valid - check your authenticator app and try the current one.");
  }

  private async replaceRecoveryCodes(client: Queryable, factorId: string): Promise<string[]> {
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await client.query(`DELETE FROM totalbase.factors_codes WHERE factor = $1`, [factorId]);
    await client.query(
      `INSERT INTO totalbase.factors_codes (factor, code_hash) SELECT $1, unnest($2::text[])`,
      [factorId, codes.map(hashRecoveryCode)],
    );
    return codes;
  }

  private async openChallenge(client: Queryable, challenge: unknown, options: { lock?: boolean } = {}) {
    if (typeof challenge !== "string" || !challenge) throw invalidChallenge();
    const { rows } = await client.query<{ id: string; user: string; purpose: ChallengePurpose; surface: MfaSurface }>(
      `SELECT id, "user", purpose, surface FROM totalbase.challenges
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()${options.lock ? " FOR UPDATE" : ""}`,
      [hashToken(challenge)],
    );
    if (!rows[0]) throw invalidChallenge();
    return rows[0];
  }

  private async spend(client: Queryable, challengeId: string): Promise<void> {
    await client.query(`UPDATE totalbase.challenges SET used_at = now() WHERE id = $1`, [challengeId]);
  }
}

function invalidChallenge(): TotalBaseError {
  return new TotalBaseError("INVALID_MFA_CHALLENGE", "This sign-in step expired or is no longer valid - sign in again.");
}
