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

/** The session cookie's value, if the request carries one. */
export function readSessionCookie(request: FastifyRequest): string | undefined {
  const header = request.headers.cookie;
  if (!header) return undefined;
  for (const pair of header.split(";")) {
    const separator = pair.indexOf("=");
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE && name !== SECURE_SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    if (value) return decodeURIComponent(value);
  }
  return undefined;
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
