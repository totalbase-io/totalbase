import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { decryptSecret, encryptSecret } from "./crypto.js";

/** Metadata only - never the value or ciphertext. This is what any Admin-facing surface may return. */
export interface SecretMetadata {
  key: string;
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
 * Secrets are reusable by design: an administrator creates one named
 * secret (e.g. "afip-bearer-token") independently of any feature, and
 * multiple Integrations (or, later, OAuth providers, SMTP, webhook
 * auth) can reference the same key rather than each holding their own copy.
 */
export class SecretsService {
  constructor(
    private readonly database: Queryable,
    private readonly masterKey: string,
  ) {}

  async list(): Promise<SecretMetadata[]> {
    const { rows } = await this.database.query<{ key: string; created_at: Date; updated_at: Date }>(
      `SELECT key, created_at, updated_at FROM totalbase.secrets ORDER BY key`,
    );
    return rows.map((r) => ({ key: r.key, createdAt: r.created_at, updatedAt: r.updated_at }));
  }

  async exists(key: string): Promise<boolean> {
    const { rows } = await this.database.query(`SELECT 1 FROM totalbase.secrets WHERE key = $1`, [key]);
    return rows.length > 0;
  }

  /** Create or replace (spec: "Puede permitirse reemplazarlo"). Never returns the value. */
  async set(rawKey: string, plaintext: string): Promise<SecretMetadata> {
    const key = validateSecretKey(rawKey);
    const ciphertext = encryptSecret(this.masterKey, plaintext);
    const { rows } = await this.database.query<{ key: string; created_at: Date; updated_at: Date }>(
      `INSERT INTO totalbase.secrets (key, ciphertext)
       VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now()
       RETURNING key, created_at, updated_at`,
      [key, ciphertext],
    );
    return { key: rows[0]!.key, createdAt: rows[0]!.created_at, updatedAt: rows[0]!.updated_at };
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
  async decrypt(key: string): Promise<string> {
    const { rows } = await this.database.query<{ ciphertext: string }>(
      `SELECT ciphertext FROM totalbase.secrets WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("SECRET_NOT_FOUND", `Secret not found: ${key}`);
    return decryptSecret(this.masterKey, row.ciphertext);
  }
}
