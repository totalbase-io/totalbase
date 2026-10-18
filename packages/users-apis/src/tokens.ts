import { createHash, randomBytes } from "node:crypto";

const KEY_PREFIX = "tb_";

/** Generates a new plaintext personal access token. Only its hash is ever persisted. */
export function generateUserApiKey(): { plainKey: string; keyPrefix: string; keyHash: string } {
  const secret = randomBytes(24).toString("base64url");
  const plainKey = `${KEY_PREFIX}${secret}`;
  return {
    plainKey,
    // Safe to display in the Admin UI to help identify a token (e.g. "tb_ab12cd34...").
    keyPrefix: plainKey.slice(0, 12),
    keyHash: hashUserApiKey(plainKey),
  };
}

export function hashUserApiKey(plainKey: string): string {
  return createHash("sha256").update(plainKey, "utf8").digest("hex");
}
