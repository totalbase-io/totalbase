import { createHmac, timingSafeEqual } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";
import { UUID_PATTERN } from "@totalbase/shared";

/**
 * Signed dashboard embed tokens (Dashboards.md §9.5) - JWTs,
 * HS256 only, built with node:crypto. Two kinds:
 *
 * - a portal's token, signed by its backend with the instance's embedding
 *   secret, naming one SIGNED embed (never the dashboard) and the values of
 *   the variables that embed locks for each visitor:
 *     { "resource": { "embed": "<uuid>" }, "params": { "cliente": "acme" }, "exp": 1767225600 }
 * - a preview token, signed by TotalBase itself for an administrator's
 *   drawer with a key derived from the master key, carrying the embed being
 *   designed: { "preview": { "dashboard", "display", "variables" }, "exp" }.
 *
 * A JWT is signed, not encrypted: whatever is in it, its holder can read.
 */
export interface EmbedClaims {
  embed: string;
  params: Record<string, unknown>;
  exp: number;
}

export interface EmbedPreviewClaims {
  dashboard: string;
  display: Record<string, unknown>;
  variables: Record<string, unknown>;
  /** The one widget it shows - null, the whole dashboard. */
  widget: string | null;
  exp: number;
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(input: string, key: string): Buffer {
  return createHmac("sha256", key).update(input).digest();
}

function invalid(message: string): TotalBaseError {
  return new TotalBaseError("EMBED_TOKEN_INVALID", message);
}

function encode(payload: object, key: string): string {
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64url(JSON.stringify(payload));
  return `${header}.${body}.${base64url(sign(`${header}.${body}`, key))}`;
}

/** A value as a variable takes one: plain, a list (a multiple SELECT), or one level of plain fields (a DATE_RANGE's { from, to }). */
export function isEmbedVariableValue(value: unknown): boolean {
  const plain = (v: unknown) => v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  if (plain(value)) return true;
  if (Array.isArray(value)) return value.every(plain);
  return typeof value === "object" && value !== null && Object.values(value).every(plain);
}

/** The payload, unverified - only to tell which kind of token it is before verifying it with that kind's key. */
export function isPreviewToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
    return !!payload && typeof payload === "object" && "preview" in payload;
  } catch {
    return false;
  }
}

/**
 * Verifies a JWT's form, header (`alg` exactly HS256 - never `none`), its
 * signature in constant time and its `exp` (future, at most `maxTtlSeconds`
 * away). Returns the payload object.
 */
function verify(token: string, key: string, maxTtlSeconds: number, nowSeconds: number): Record<string, unknown> & { exp: number } {
  if (!key) throw invalid("Embedding is not set up on this instance.");
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) throw invalid("The embed token is malformed.");
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  let header: unknown;
  let payload: unknown;
  try {
    header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  } catch {
    throw invalid("The embed token is malformed.");
  }
  if (!header || typeof header !== "object" || (header as { alg?: unknown }).alg !== "HS256") {
    throw invalid("The embed token must be signed with HS256.");
  }
  const expected = sign(`${headerPart}.${payloadPart}`, key);
  const given = Buffer.from(signaturePart, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid("The embed token's signature doesn't match.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw invalid("The embed token's payload is not an object.");
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) throw invalid("The embed token needs an expiry (exp).");
  if (exp <= nowSeconds) throw invalid("The embed token has expired.");
  if (exp - nowSeconds > maxTtlSeconds) throw invalid(`The embed token lives too long - at most ${Math.floor(maxTtlSeconds / 60)} minutes (dashboards.embed_max_ttl_minutes).`);
  return payload as Record<string, unknown> & { exp: number };
}

/** Signs a portal's embed token - what its backend does; here for tests. */
export function signEmbedToken(claims: EmbedClaims, secret: string): string {
  return encode({ resource: { embed: claims.embed }, params: claims.params, exp: claims.exp }, secret);
}

/** Verifies a portal's embed token. 401 EMBED_TOKEN_INVALID otherwise - one code, the reason in the message. */
export function verifyEmbedToken(token: string, secret: string, maxTtlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): EmbedClaims {
  const payload = verify(token, secret, maxTtlSeconds, nowSeconds);
  const embed = (payload.resource as { embed?: unknown } | undefined)?.embed;
  if (typeof embed !== "string" || !UUID_PATTERN.test(embed)) throw invalid("The embed token names no embed (resource.embed).");
  const params = payload.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) throw invalid("The embed token's params must be an object.");
  for (const [name, value] of Object.entries(params)) {
    if (!isEmbedVariableValue(value)) throw invalid(`The embed token's param "${name}" must be a plain value, a list of them, or an object of them ({ from, to }).`);
  }
  return { embed, params: params as Record<string, unknown>, exp: payload.exp };
}

/** The key preview tokens are signed with - derived from the master key, never stored, never a setting. */
export function embedPreviewKey(masterKey: string): string {
  return createHmac("sha256", masterKey).update("totalbase:dashboard-embed-preview").digest("hex");
}

/** Signs an administrator's preview of an embed being designed (the drawer). */
export function signEmbedPreviewToken(claims: EmbedPreviewClaims, key: string): string {
  return encode({ preview: { dashboard: claims.dashboard, display: claims.display, variables: claims.variables, widget: claims.widget }, exp: claims.exp }, key);
}

export function verifyEmbedPreviewToken(token: string, key: string, maxTtlSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): EmbedPreviewClaims {
  const payload = verify(token, key, maxTtlSeconds, nowSeconds);
  const preview = payload.preview as { dashboard?: unknown; display?: unknown; variables?: unknown; widget?: unknown } | undefined;
  if (!preview || typeof preview.dashboard !== "string" || !UUID_PATTERN.test(preview.dashboard)) throw invalid("The preview token is malformed.");
  const object = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
  const widget = typeof preview.widget === "string" && UUID_PATTERN.test(preview.widget) ? preview.widget : null;
  return { dashboard: preview.dashboard, display: object(preview.display), variables: object(preview.variables), widget, exp: payload.exp };
}
