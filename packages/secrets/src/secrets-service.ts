import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { decryptSecret, encryptSecret } from "./crypto.js";

/**
 * The one feature a secret serves (Security.md §12.3): each decrypts only its own, so a setting aimed at another
 * feature's key can't send that credential where the setting points.
 */
export const SECRET_SCOPES = ["SMTP", "S3", "DASHBOARD_EMBEDS", "AUTH_PROVIDERS", "WORKFLOWS"] as const;
export type SecretScope = (typeof SECRET_SCOPES)[number];

export function validateSecretScope(raw: unknown): SecretScope {
  if (typeof raw === "string" && (SECRET_SCOPES as readonly string[]).includes(raw)) return raw as SecretScope;
  throw new TotalBaseError("INVALID_SECRET_SCOPE", `A secret's scope is one of ${SECRET_SCOPES.join(", ")}.`);
}

/** Metadata only - never the value or ciphertext. This is what any Admin-facing surface may return. */
export interface SecretMetadata {
  key: string;
  scope: SecretScope;
  createdAt: Date;
  updatedAt: Date;
}

const KEY_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export function validateSecretKey(rawKey: string): string {
  const key = rawKey.trim();
  if (key.length === 0 || key.length > 200 || !KEY_PATTERN.test(key)) {
    throw new TotalBaseError(
      "INVALID_SECRET_KEY",
      "Secret key must be lowercase alphanumeric with '.', '_', or '-' separators, e.g. 'mail.password' or 'afip-bearer-token'.",
    );
  }
  return key;
}

/**
 * Central, reusable secret storage (totalbase.secrets). Secrets are
 * write-only from any administrative surface: create/replace/delete and
 * list metadata are the only operations exposed outward. `decrypt()` is
 * for internal use by the feature that actually needs the credential at
 * the moment of use (e.g. the Integrations HTTP Execution Core) -
 * it must never be reachable from an API route directly.
 *
 * A secret serves one feature (its scope): an administrator creates one
 * named secret (e.g. "afip-bearer-token") and every use within that feature
 * (several workflows' steps, several providers) references the same key;
 * `decrypt()` answers only to the feature it serves.
 */
interface MetadataRow {
  key: string;
  scope: SecretScope;
  created_at: Date;
  updated_at: Date;
}

const toMetadata = (row: MetadataRow): SecretMetadata => ({ key: row.key, scope: row.scope, createdAt: row.created_at, updatedAt: row.updated_at });

export class SecretsService {
  constructor(
    private readonly database: Queryable,
    private readonly masterKey: string,
  ) {}

  /** Every secret, or one feature's. */
  async list(scope?: SecretScope): Promise<SecretMetadata[]> {
    const { rows } = await this.database.query<MetadataRow>(
      `SELECT key, scope, created_at, updated_at FROM totalbase.secrets WHERE $1::text IS NULL OR scope = $1 ORDER BY key`,
      [scope ?? null],
    );
    return rows.map(toMetadata);
  }

  /** Whether `key` is a secret of `scope`. */
  async exists(key: string, scope: SecretScope): Promise<boolean> {
    const { rows } = await this.database.query(`SELECT 1 FROM totalbase.secrets WHERE key = $1 AND scope = $2`, [key, scope]);
    return rows.length > 0;
  }

  /**
   * Create or replace, value and scope together - a secret never moves to another feature keeping its value
   * (PostgreSQL's `secrets_scope_moves_with_value` trigger holds that for every path). Never returns the value.
   */
  async set(rawKey: string, plaintext: string, scope: SecretScope): Promise<SecretMetadata> {
    const key = validateSecretKey(rawKey);
    const ciphertext = encryptSecret(this.masterKey, plaintext, `secret:${validateSecretScope(scope)}`);
    const { rows } = await this.database.query<MetadataRow>(
      `INSERT INTO totalbase.secrets (key, ciphertext, scope)
       VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, scope = EXCLUDED.scope, updated_at = now()
       RETURNING key, scope, created_at, updated_at`,
      [key, ciphertext, validateSecretScope(scope)],
    );
    return toMetadata(rows[0]!);
  }

  /** Whether a secret was there to delete. */
  async delete(key: string): Promise<boolean> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.secrets WHERE key = $1`, [key]);
    return rowCount > 0;
  }

  /**
   * Internal use only - decrypts and returns the plaintext value.
   * Callers must never forward this to an API response, log line, or
   * audit record (TotalBase secrets architecture, "Seguridad y logs").
   */
  async decrypt(key: string, scope: SecretScope): Promise<string> {
    const { rows } = await this.database.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM totalbase.secrets WHERE key = $1 AND scope = $2`,
      [key, scope],
    );
    const row = rows[0];
    // Another feature's secret is, to this one, a secret that isn't there.
    if (!row) throw new TotalBaseError("SECRET_NOT_FOUND", `Secret not found: ${key} (${scope})`);
    return decryptSecret(this.masterKey, row.ciphertext, `secret:${scope}`);
  }
}
