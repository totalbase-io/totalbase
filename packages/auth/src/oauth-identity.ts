import { createRemoteJWKSet, jwtVerify } from "jose";
import { TotalBaseError } from "@totalbase/errors";
import type { AuthProvider } from "./auth-providers-service.js";
import type { OAuthEndpoints } from "./oauth-endpoints.js";

export interface OAuthTokenResponse {
  access_token: string;
  id_token?: string;
  token_type?: string;
}

export interface OAuthIdentity {
  /** Stable per-provider user id - GitHub's numeric id, Google/OIDC's `sub`. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  username: string | null;
  avatarUrl: string | null;
}

/** Standard OAuth2 authorization_code exchange (RFC 6749 §4.1.3 + PKCE's code_verifier, RFC 7636). `Accept: application/json` matters for GitHub specifically - its token endpoint replies form-encoded without it. */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  params: { clientId: string; clientSecret: string; code: string; redirectUri: string; codeVerifier: string },
): Promise<OAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!response.ok) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `Token exchange with the provider failed (${response.status}).`);
  }
  return response.json() as Promise<OAuthTokenResponse>;
}

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  avatar_url: string | null;
}
interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

async function fetchGitHubIdentity(accessToken: string): Promise<OAuthIdentity> {
  const headers = { authorization: `Bearer ${accessToken}`, "user-agent": "TotalBase", accept: "application/vnd.github+json" };
  const profileResponse = await fetch("https://api.github.com/user", { headers });
  if (!profileResponse.ok) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", `Could not fetch the GitHub profile (${profileResponse.status}).`);
  }
  const profile = (await profileResponse.json()) as GitHubUser;

  // A public profile email is exposed by GitHub only once the user has
  // verified it and made it public, so its mere presence here already
  // means verified=true; otherwise fall back to /user/emails (requires
  // the user:email scope) for the account's primary address.
  let email = profile.email;
  let emailVerified = email !== null;
  if (!email) {
    const emailsResponse = await fetch("https://api.github.com/user/emails", { headers });
    if (emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as GitHubEmail[];
      const primary = emails.find((e) => e.primary) ?? emails[0];
      email = primary?.email ?? null;
      emailVerified = primary?.verified ?? false;
    }
  }

  return {
    subject: String(profile.id),
    email,
    emailVerified,
    username: profile.login,
    avatarUrl: profile.avatar_url,
  };
}

/**
 * Google and generic OIDC both issue a signed id_token - verifying it
 * against the issuer's own JWKS (rather than trusting the unsigned JSON
 * body) is what makes this safe to base account identity/linking on.
 * `createRemoteJWKSet` is created fresh per call (its own in-memory
 * cache doesn't persist across requests this way) - acceptable for now,
 * see resolveOAuthEndpoints's comment on the same tradeoff for discovery
 * documents.
 */
async function verifyIdTokenIdentity(
  idToken: string,
  jwks: { issuer: string; jwksUri: string },
  clientId: string,
  expectedNonce: string,
): Promise<OAuthIdentity> {
  const keySet = createRemoteJWKSet(new URL(jwks.jwksUri));
  const { payload } = await jwtVerify(idToken, keySet, { issuer: jwks.issuer, audience: clientId });

  if (payload["nonce"] !== expectedNonce) {
    throw new TotalBaseError("INVALID_OAUTH_STATE", "The provider's id_token does not match this login attempt (nonce mismatch).");
  }
  if (typeof payload.sub !== "string") {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", "The provider's id_token has no subject claim.");
  }

  return {
    subject: payload.sub,
    email: typeof payload["email"] === "string" ? payload["email"] : null,
    emailVerified: payload["email_verified"] === true,
    username: typeof payload["name"] === "string" ? payload["name"] : null,
    avatarUrl: typeof payload["picture"] === "string" ? payload["picture"] : null,
  };
}

export async function fetchOAuthIdentity(
  provider: AuthProvider,
  endpoints: OAuthEndpoints,
  tokens: OAuthTokenResponse,
  expectedNonce: string,
): Promise<OAuthIdentity> {
  if (provider.type === "GITHUB") {
    return fetchGitHubIdentity(tokens.access_token);
  }
  if (!tokens.id_token) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", "The provider did not return an id_token.");
  }
  if (!endpoints.jwks) {
    throw new TotalBaseError("OAUTH_UPSTREAM_ERROR", "This provider has no JWKS to verify its id_token against.");
  }
  return verifyIdTokenIdentity(tokens.id_token, endpoints.jwks, provider.configuration.client_id, expectedNonce);
}
