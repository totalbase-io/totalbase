import { TotalBaseError } from "@totalbase/errors";

/**
 * Validates the `redirect_to` a caller's own app supplies to start an
 * OAuth flow against that provider's admin-configured allowlist - the
 * open-redirect / token-leak boundary of the whole feature (spec: "the
 * customer's system, not TotalBase"). Fails closed: no entries, or no
 * match, means the flow never starts.
 *
 * An entry ending in "/*" matches any URL under that prefix (path and
 * querystring included) - e.g. "https://app.example.com/*" matches
 * "https://app.example.com/auth/callback?x=1". Anything else must match
 * exactly. Matching is on the literal string, not a parsed URL, so an
 * entry always includes its scheme (http/https) explicitly.
 */
export function assertRedirectAllowed(allowedRedirectUrls: string[], redirectTo: string): void {
  const allowed = allowedRedirectUrls.some((entry) => {
    if (entry.endsWith("/*")) {
      return redirectTo.startsWith(entry.slice(0, -1));
    }
    return redirectTo === entry;
  });
  if (!allowed) {
    throw new TotalBaseError(
      "OAUTH_REDIRECT_NOT_ALLOWED",
      `redirect_to is not in this provider's allowed redirect URLs: ${redirectTo}`,
    );
  }
}
