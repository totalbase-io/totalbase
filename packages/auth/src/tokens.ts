import { createHash, randomBytes } from "node:crypto";

/**
 * Generates an opaque bearer token (session tokens, auth_tokens,
 * invitation links, etc). Only the hash is ever persisted.
 */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Non-reversible hash used to look up/validate opaque tokens without
 * storing them in plaintext. See Security.md:
 * sessions.token_hash, auth_tokens.token_hash, api_keys.key_hash.
 */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
