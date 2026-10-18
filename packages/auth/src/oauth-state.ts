import { decryptSecret, encryptSecret } from "@totalbase/secrets";
import { TotalBaseError } from "@totalbase/errors";

/**
 * The OAuth `state` round-trip, made stateless: rather than a server-side
 * table (a migration, plus a cleanup job for abandoned flows), the state
 * value itself is an AES-256-GCM envelope (the same primitive
 * totalbase.secrets uses, keyed by TOTALBASE_MASTER_KEY) carrying
 * everything the callback needs to finish the flow. The provider hands
 * it back verbatim, so tampering fails the GCM auth tag closed rather
 * than decrypting into garbage, and a stale/replayed state is caught by
 * `issuedAt` below.
 */
export interface OAuthStatePayload {
  /** The provider slug the flow was started for - checked against the callback's own :provider param so a state can't be replayed against a different provider. */
  provider: string;
  /** PKCE code_verifier generated at the start of the flow (RFC 7636). */
  codeVerifier: string;
  /** OIDC nonce, echoed back inside the id_token for providers that issue one (Google, generic OIDC - not GitHub). */
  nonce: string;
  /** Where to send the caller's own end user once login succeeds - validated against that provider's allowed_redirect_urls before the flow even starts. */
  redirectTo: string;
  /** The portal's own sign-in (redirectTo is its callback page): the callback then requires portal access, not API access. */
  portal?: boolean;
  /** Epoch ms the flow started - bounds how long a state value is redeemable. */
  issuedAt: number;
}

/** Long enough to get through a provider's own login/consent screen, short enough to bound replay risk if a state value ever leaked (e.g. via a referrer header). */
const STATE_TTL_MS = 10 * 60 * 1000;

export function signOAuthState(masterKey: string, payload: OAuthStatePayload): string {
  return encryptSecret(masterKey, JSON.stringify(payload));
}

export function verifyOAuthState(masterKey: string, state: string): OAuthStatePayload {
  let payload: OAuthStatePayload;
  try {
    payload = JSON.parse(decryptSecret(masterKey, state)) as OAuthStatePayload;
  } catch {
    throw new TotalBaseError("INVALID_OAUTH_STATE", "OAuth state is invalid or was tampered with.");
  }
  if (Date.now() - payload.issuedAt > STATE_TTL_MS) {
    throw new TotalBaseError("INVALID_OAUTH_STATE", "OAuth login expired before it was completed - please try again.");
  }
  return payload;
}
