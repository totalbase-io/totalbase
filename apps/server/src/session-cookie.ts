import type { FastifyReply, FastifyRequest } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { JsonSchema } from "@totalbase/openapi";
import type { AppContext } from "./context.js";

/**
 * The session cookie (Security.md §2.18): the same opaque session as a
 * bearer token, carried in an HttpOnly cookie so the page's JavaScript
 * never holds it. `__Host-` under https - the browser then refuses it
 * without Secure, with a Domain or off Path=/ - plain over http (local
 * development).
 */
export const SESSION_COOKIE = "tb_session";
const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

export type SessionMode = "json" | "session";

/** A sign-in body's `mode`, as the generated OpenAPI documents it. */
export const SESSION_MODE: JsonSchema = {
  type: "string",
  enum: ["json", "session"],
  description: "json (default): the token in the response. session: the token in an HttpOnly cookie, for this instance's own pages.",
};

/** A sign-in response's `token`, as the generated OpenAPI documents it. */
export const SESSION_TOKEN: JsonSchema = {
  type: ["string", "null"],
  description: "The session token - null with mode session, where the cookie carries it.",
};

/** A sign-in body's `mode`: `json` (the default, the token in the body) or `session` (the cookie). */
export function sessionModeOf(body: unknown): SessionMode {
  const mode = body && typeof body === "object" ? (body as { mode?: unknown }).mode : undefined;
  if (mode === undefined || mode === null || mode === "json") return "json";
  if (mode === "session") return "session";
  throw new TotalBaseError("INVALID_FIELD", "mode must be json or session.");
}

/**
 * The session cookie's value, if the request carries one (Security.md §2.18). The `__Host-` one wins whenever it is
 * there: only this instance's own https origin can set it, while a plain `tb_session` can be planted by a sibling
 * subdomain or over plain http - read first, it would sign the browser in to someone else's account. A value that
 * isn't valid percent-encoding is no cookie, never a failed request.
 */
export function readSessionCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  let plain: string | undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;
    let value: string;
    try {
      value = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      continue;
    }
    if (!value) continue;
    if (name === SECURE_SESSION_COOKIE) return value;
    plain ??= value;
  }
  return plain;
}

const isHttps = (publicUrl: string) => publicUrl.startsWith("https://");

function cookie(publicUrl: string, value: string, maxAgeSeconds: number): string {
  const secure = isHttps(publicUrl);
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Sets the session cookie, living as long as the session may (auth.session_ttl_hours). */
export function setSessionCookie(reply: FastifyReply, publicUrl: string, token: string, ttlHours: number): void {
  reply.header("set-cookie", cookie(publicUrl, token, Math.round(ttlHours * 3600)));
}

/** Removes the session cookie - on sign-out. */
export function clearSessionCookie(reply: FastifyReply, publicUrl: string): void {
  reply.header("set-cookie", cookie(publicUrl, "", 0));
}

/**
 * Whether the request comes from TotalBase's own pages: the browser's
 * `Sec-Fetch-Site: same-origin` (no page can forge it), else an `Origin`
 * equal to `system.public_url`'s. A request carrying neither is refused -
 * every browser a cookie session serves sends one of them on a write.
 */
export function isSameOrigin(request: FastifyRequest, publicUrl: string): boolean {
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  const origin = request.headers.origin;
  if (!origin || !publicUrl) return false;
  try {
    return new URL(publicUrl).origin === origin;
  } catch {
    return false;
  }
}

/** CSRF (Security.md §2.18): a cookie-authenticated write, or a cookie being set, only from TotalBase's own pages. */
export function assertSameOrigin(request: FastifyRequest, publicUrl: string): void {
  if (!isSameOrigin(request, publicUrl)) {
    throw new TotalBaseError("CROSS_SITE_REQUEST_REFUSED", "A session cookie is only accepted from this instance's own pages.");
  }
}

/**
 * A sign-in request's `mode`, read before anything is created: `session`
 * only from this instance's own pages - a cookie set by another site's
 * form would sign the visitor in to someone else's account (login CSRF).
 */
export async function requestedSessionMode(context: Pick<AppContext, "auth">, request: FastifyRequest): Promise<SessionMode> {
  const mode = sessionModeOf(request.body);
  if (mode === "session") assertSameOrigin(request, await context.auth.mailer.publicUrl());
  return mode;
}

/**
 * A sign-in's answer for its `mode`: `json` returns the token for the body;
 * `session` sets the cookie and returns null, so the body never carries
 * the token.
 */
export async function deliverSession(
  context: Pick<AppContext, "settings" | "auth">,
  reply: FastifyReply,
  mode: SessionMode,
  token: string,
): Promise<string | null> {
  if (mode === "json") return token;
  const publicUrl = await context.auth.mailer.publicUrl();
  setSessionCookie(reply, publicUrl, token, await context.settings.get("auth.session_ttl_hours"));
  return null;
}

/**
 * The OAuth sign-in's browser binding (Security.md §2.11): a random value the start route sets in this cookie and
 * whose hash the `state` carries, so only the browser that started a sign-in completes it. HttpOnly, SameSite=Lax (the
 * provider's redirect back is a top-level navigation, which sends it), for the OAuth routes only, ten minutes - the
 * state's own life. Under https it is `__Host-tb_oauth` (Secure, `Path=/`, no Domain), and only that name is read:
 * a sibling subdomain can't plant its own binding in someone's browser and hand them the callback of a sign-in it
 * started (login CSRF).
 */
const OAUTH_BINDING_COOKIE = "tb_oauth";

function oauthBindingCookie(publicUrl: string, value: string, maxAgeSeconds: number): string {
  const secure = isHttps(publicUrl);
  return secure
    ? `__Host-${OAUTH_BINDING_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}; Secure`
    : `${OAUTH_BINDING_COOKIE}=${value}; Path=/api/auth/oauth; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function setOAuthBindingCookie(reply: FastifyReply, publicUrl: string, value: string): void {
  reply.header("set-cookie", oauthBindingCookie(publicUrl, encodeURIComponent(value), 600));
}

export function clearOAuthBindingCookie(reply: FastifyReply, publicUrl: string): void {
  reply.header("set-cookie", oauthBindingCookie(publicUrl, "", 0));
}

export function readOAuthBindingCookie(request: FastifyRequest, publicUrl: string): string | undefined {
  const name = isHttps(publicUrl) ? `__Host-${OAUTH_BINDING_COOKIE}` : OAUTH_BINDING_COOKIE;
  for (const pair of (request.headers.cookie ?? "").split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0 || pair.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(pair.slice(separator + 1).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}
