/**
 * What a framed URL may be (DataViews.md §9.7, "EXTERNALFRAME
 * security"; Dashboards.md §5.11): the rule an EXTERNALFRAME
 * DataView, a page's Frame and a dashboard's Frame share. Plain functions
 * returning the problem, no error type: each owner raises its own code
 * (@totalbase/dataviews, @totalbase/dashboards).
 */

/** Longest framed URL accepted - a generous URL, not a document. */
export const FRAME_URL_MAX_LENGTH = 2048;

/**
 * An absolute https URL, no embedded credentials, and never TotalBase's own
 * origin - the frame's sandbox allows scripts + same-origin, which is only
 * safe because a same-origin document can never be framed. Its normalized
 * form (what the browser will load), or the problem.
 *
 * `ownOrigin` is the instance's public URL (any path is ignored); omitted,
 * the same-origin rule is skipped (a caller with no public URL to compare).
 */
export function checkFrameUrl(raw: unknown, ownOrigin?: string): { url: string } | { problem: string } {
  if (typeof raw !== "string" || raw.trim() === "") return { problem: "An external frame needs a URL." };
  const text = raw.trim();
  if (text.length > FRAME_URL_MAX_LENGTH) return { problem: `The URL is longer than ${FRAME_URL_MAX_LENGTH} characters.` };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { problem: "The URL is not a valid absolute URL." };
  }
  if (url.protocol !== "https:") return { problem: "Only https:// URLs can be embedded." };
  if (url.username || url.password) return { problem: "The URL must not contain a user name or password." };
  if (ownOrigin && sameOrigin(url, ownOrigin)) return { problem: "TotalBase's own pages can't be embedded in an external frame." };
  return { url: url.href };
}

function sameOrigin(url: URL, ownOrigin: string): boolean {
  try {
    return new URL(ownOrigin).origin === url.origin;
  } catch {
    return false;
  }
}

/**
 * A Frame's URL template: literal text whose only tokens are those `token`
 * matches (a RegExp source - a page's `FRAME_URL_TOKEN`, a dashboard's
 * `DASHBOARD_FRAME_URL_TOKEN`), each URL-encoded when it renders. With its
 * tokens filled in it must pass `checkFrameUrl`, and the site is never
 * data: everything before the first token is the whole origin and the `/`
 * after it, so a value can only land in the path, the query or the
 * fragment. Empty is allowed (a Frame just placed). `tokens` names them for
 * the message. The trimmed template, or the problem.
 */
export function checkFrameUrlTemplate(raw: unknown, token: string, tokens: string, ownOrigin?: string): { template: string } | { problem: string } {
  // A Frame just placed has no URL yet - it shows that it has none.
  if (raw === undefined || raw === null || raw === "") return { template: "" };
  if (typeof raw !== "string") return { problem: "A Frame's URL is text." };
  const template = raw.trim();
  if (!template) return { template: "" };
  const tokenPattern = new RegExp(token, "g");
  const filled = template.replace(tokenPattern, "x");
  if (filled.includes("{{") || filled.includes("}}")) return { problem: `The Frame's URL takes ${tokens} tokens only.` };
  const checked = checkFrameUrl(filled, ownOrigin);
  if ("problem" in checked) return { problem: `The Frame's URL: ${checked.problem}` };
  const first = template.search(tokenPattern);
  if (first >= 0 && !template.slice(0, first).toLowerCase().startsWith(`${new URL(checked.url).origin}/`)) {
    return { problem: "The Frame's site must be written out: a token can only come after the / that follows it (https://site.example/{{…}}), with no port 443 written." };
  }
  return { template };
}
