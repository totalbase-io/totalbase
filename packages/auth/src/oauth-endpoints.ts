import { TotalBaseError } from "@totalbase/errors";
import type { AuthProvider } from "./auth-providers-service.js";

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  /** Present for providers that issue a verifiable id_token (Google, OIDC) - absent for GitHub, which has none and is identified via its REST API instead (see oauth-identity.ts). */
  jwks?: { issuer: string; jwksUri: string };
}

/** How long a provider has to answer one call, and how much of an answer is read (Security.md §2.11). */
const PROVIDER_TIMEOUT_MS = 10_000;
const PROVIDER_MAX_RESPONSE_BYTES = 1024 * 1024;

/**
 * One call to an identity provider - its discovery document, token endpoint, profile: answered within
 * PROVIDER_TIMEOUT_MS and read up to PROVIDER_MAX_RESPONSE_BYTES, else OAUTH_UPSTREAM_ERROR - so a slow or endless
 * answer never holds a sign-in, or the process's memory. JSON, or null when the status isn't 2xx.
 */
export async function providerJson(url: string, init: RequestInit = {}): Promise<{ status: number; json: unknown } | { status: number; json: null }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch (error) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `The identity provider didn't answer (${new URL(url).host}): ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { status: response.status, json: null };
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = reader ? await reader.read() : { done: true as const, value: undefined };
    if (next.done) break;
    size += next.value.byteLength;
    if (size > PROVIDER_MAX_RESPONSE_BYTES) {
      await reader?.cancel().catch(() => undefined);
      throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `The identity provider's answer is larger than ${PROVIDER_MAX_RESPONSE_BYTES} bytes.`);
    }
    chunks.push(next.value);
  }
  try {
    return { status: response.status, json: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", "The identity provider's answer isn't JSON.");
  }
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const { status, json } = await providerJson(url);
  if (json === null || typeof json !== "object") {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `Could not fetch ${url} (${status}).`);
  }
  return json as Record<string, unknown>;
}

const GOOGLE_ENDPOINTS: OAuthEndpoints = {
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  defaultScopes: ["openid", "email", "profile"],
  jwks: { issuer: "https://accounts.google.com", jwksUri: "https://www.googleapis.com/oauth2/v3/certs" },
};

const GITHUB_ENDPOINTS: OAuthEndpoints = {
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  defaultScopes: ["read:user", "user:email"],
};

/**
 * Fixed endpoints for GOOGLE/GITHUB; OIDC is resolved from the admin's
 * configured `issuer` via the standard discovery document
 * (.well-known/openid-configuration) rather than asking the admin to
 * hand-fill each individual endpoint URL.
 *
 * Re-fetches the discovery document on every call rather than caching it
 * - simple and correct; if this ever shows up as a hot path, cache by
 * issuer with a TTL then, not before (AGENTS.md section 3 - no
 * speculative complexity).
 */
export async function resolveOAuthEndpoints(provider: AuthProvider): Promise<OAuthEndpoints> {
  if (provider.type === "GOOGLE") return GOOGLE_ENDPOINTS;
  if (provider.type === "GITHUB") return GITHUB_ENDPOINTS;

  const issuer = provider.configuration.issuer;
  if (!issuer) {
    throw new TotalBaseError("INVALID_AUTH_PROVIDER_PAYLOAD", "This OIDC provider has no issuer configured.");
  }
  const discovery = await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  const authorizationEndpoint = discovery["authorization_endpoint"];
  const tokenEndpoint = discovery["token_endpoint"];
  const jwksUri = discovery["jwks_uri"];
  if (typeof authorizationEndpoint !== "string" || typeof tokenEndpoint !== "string" || typeof jwksUri !== "string") {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `${issuer}'s OpenID discovery document is missing required endpoints.`);
  }
  return {
    authorizationEndpoint,
    tokenEndpoint,
    defaultScopes: ["openid", "email", "profile"],
    jwks: { issuer: typeof discovery["issuer"] === "string" ? discovery["issuer"] : issuer, jwksUri },
  };
}
