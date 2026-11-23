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
/**
 * An allowlist entry an administrator saves (Security.md §2.11): an absolute http(s) URL with a host - exact, or
 * ending in `/*` after its host - never a relative path (`/*` would match `//evil.example`) or anything but text.
 * Returns the problem, or null.
 */
export function redirectEntryProblem(entry: unknown): string | null {
  if (typeof entry !== "string") return "Each allowed redirect URL is text.";
  const base = entry.endsWith("/*") ? entry.slice(0, -1) : entry;
  try {
    const url = new URL(base);
    const origin = `${url.protocol}//${url.host}`;
    const web = url.protocol === "https:" || url.protocol === "http:";
    if (web && url.host !== "" && (base === origin || base.startsWith(`${origin}/`))) return null;
  } catch {
    // not a URL: refused below
  }
  return `"${entry}" is not an absolute http(s) URL - e.g. https://app.example.com/callback, or https://app.example.com/* for every path under it.`;
}

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
