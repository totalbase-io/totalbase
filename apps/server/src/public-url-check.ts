import { connect, type PeerCertificate } from "node:tls";

/**
 * What the instance looks like from outside: a request to its own public URL (`system.public_url`), through the
 * reverse proxy in front of it, as a browser would make it (Administration.md §1.6). Two questions only - is the
 * certificate valid and not about to expire, and do the security headers (Foundations.md §4.7) survive the proxy.
 * At most once an hour per process; Status reads the last answer.
 */

/** The headers every answer carries, checked on `/health/live` - HSTS only when the public URL is https. */
const ANSWER_HEADERS = ["x-content-type-options", "referrer-policy", "permissions-policy", "cross-origin-opener-policy", "cross-origin-resource-policy"];
/** A certificate expiring within this many days is worth a warning. */
export const CERTIFICATE_WARNING_DAYS = 14;
const CHECK_INTERVAL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface PublicUrlCheck {
  /** The public URL checked. */
  url: string;
  /** False: the server couldn't reach its own public URL (a network that doesn't route back to it) - nothing else is known. */
  reachable: boolean;
  /** Only for an https URL: whether a browser would accept it, and when it ends. */
  certificate: { valid: boolean; error: string | null; validTo: Date | null } | null;
  /** The security headers a response through the public URL lacks - the reverse proxy removed them. */
  missingHeaders: string[];
  checkedAt: Date;
}

/** How a certificate stands: invalid (or expired), expiring within CERTIFICATE_WARNING_DAYS, or fine. */
export function certificateStatus(certificate: PublicUrlCheck["certificate"], now = Date.now()): "invalid" | "expiring" | "ok" | null {
  if (certificate === null) return null;
  if (!certificate.valid || (certificate.validTo !== null && certificate.validTo.getTime() <= now)) return "invalid";
  if (certificate.validTo !== null && certificate.validTo.getTime() - now <= CERTIFICATE_WARNING_DAYS * DAY_MS) return "expiring";
  return "ok";
}

/** The certificate the public URL's server presents, as a browser would judge it (the system's authorities). */
function readCertificate(url: URL): Promise<NonNullable<PublicUrlCheck["certificate"]>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port || 443), servername: url.hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS }, () => {
      const peer: PeerCertificate = socket.getPeerCertificate();
      const validTo = peer?.valid_to ? new Date(peer.valid_to) : null;
      resolve({ valid: socket.authorized, error: socket.authorized ? null : String(socket.authorizationError ?? "unknown"), validTo });
      socket.end();
    });
    socket.on("timeout", () => socket.destroy(new Error("timed out")));
    socket.on("error", reject);
  });
}

/** The response's headers for a path under the public URL - a redirect isn't followed: what answers there counts. */
async function headersAt(base: URL, path: string): Promise<Headers & { contentType: string }> {
  const response = await fetch(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  await response.body?.cancel();
  return Object.assign(response.headers, { contentType: response.headers.get("content-type") ?? "" });
}

export async function checkPublicUrl(publicUrl: string): Promise<PublicUrlCheck> {
  // A trailing slash keeps a path prefix (a proxy serving TotalBase under /totalbase/) in what's resolved against it.
  const base = new URL(publicUrl.endsWith("/") ? publicUrl : `${publicUrl}/`);
  const https = base.protocol === "https:";
  const checkedAt = new Date();
  let certificate: PublicUrlCheck["certificate"] = null;
  if (https) {
    try {
      certificate = await readCertificate(base);
    } catch {
      return { url: publicUrl, reachable: false, certificate: null, missingHeaders: [], checkedAt };
    }
  }
  try {
    const answer = await headersAt(base, "health/live");
    const expected = https ? [...ANSWER_HEADERS, "strict-transport-security"] : ANSWER_HEADERS;
    const missing = expected.filter((name) => !answer.has(name));
    // The admin's page carries the Content-Security-Policy - when the UI is served (an HTML answer) at all.
    const page = await headersAt(base, "");
    if (page.contentType.startsWith("text/html") && !page.has("content-security-policy")) missing.push("content-security-policy");
    return { url: publicUrl, reachable: true, certificate, missingHeaders: missing, checkedAt };
  } catch {
    // A certificate a browser refuses fails the request too: what's known is the certificate.
    return { url: publicUrl, reachable: certificate !== null && !certificate.valid, certificate, missingHeaders: [], checkedAt };
  }
}

/**
 * The last check of this process, refreshed in the background once it is an hour old or the public URL changed -
 * a caller never waits for the network. Null until the first check has answered.
 */
export class PublicUrlMonitor {
  private last: PublicUrlCheck | null = null;
  private running: Promise<void> | null = null;

  constructor(private readonly check: (publicUrl: string) => Promise<PublicUrlCheck> = checkPublicUrl) {}

  current(publicUrl: string, now = Date.now()): PublicUrlCheck | null {
    const stale = this.last === null || this.last.url !== publicUrl || now - this.last.checkedAt.getTime() >= CHECK_INTERVAL_MS;
    if (stale && this.running === null) {
      this.running = this.check(publicUrl)
        .then((result) => {
          this.last = result;
        })
        .catch(() => undefined)
        .finally(() => {
          this.running = null;
        });
    }
    return this.last !== null && this.last.url === publicUrl ? this.last : null;
  }

  /** Waits for a check under way - for tests, and for a caller that would rather wait. */
  async settled(): Promise<void> {
    await this.running;
  }
}
