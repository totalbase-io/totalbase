import { createHash, randomBytes } from "node:crypto";

/** RFC 7636 PKCE - used for every provider, not just ones that require it, since it costs nothing and closes the authorization-code-interception attack outright. */
export function generateCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function toCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}
