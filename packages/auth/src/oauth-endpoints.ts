import { TotalBaseError } from "@totalbase/errors";
import type { AuthProvider } from "./auth-providers-service.js";

export interface OAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  defaultScopes: string[];
  /** Present for providers that issue a verifiable id_token (Google, OIDC) - absent for GitHub, which has none and is identified via its REST API instead (see oauth-identity.ts). */
  jwks?: { issuer: string; jwksUri: string };
}

async function fetchJson(url: string): Promise<Record<string, unknown>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `Could not fetch ${url} (${response.status}).`);
  }
  return response.json() as Promise<Record<string, unknown>>;
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
