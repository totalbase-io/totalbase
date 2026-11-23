import { createHash, timingSafeEqual } from "node:crypto";
import { BlockList, isIPv4 } from "node:net";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import qs from "qs";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { isServerRequest, routePath } from "./admin-ui.js";
import { assertSameOrigin, readSessionCookie } from "./session-cookie.js";

/**
 * Where the hardening hooks read their settings from - the settings
 * service, on every request (Data_API.md §12,
 * Administration.md §7.5, §7.8). Reads are served from its
 * in-process cache and a change through the Admin API invalidates it, so
 * a new limit, origin list or rate applies to the next request, without a
 * restart. Only `security.trust_proxy` is a Fastify construction option
 * and still needs one (server.ts).
 */
export type HardeningSettingsSource = Pick<SettingsService, "get">;

/** Fastify's own body limit - only a ceiling; the live one is api.max_body_bytes, enforced by the preParsing hook below. */
export const FASTIFY_BODY_LIMIT_CEILING = Number.MAX_SAFE_INTEGER;

/** Room for the method, path and every other header next to the query string (Node's own default is 16 KiB for all of it). */
export const HEADER_HEADROOM_BYTES = 16_384;

/**
 * Node's maxHeaderSize (request line + headers) for a given
 * api.max_query_string_bytes: the query string plus headroom (so always
 * above Node's 16 KiB default). Node rejects a request past it with a raw 431 before any
 * hook runs, so the server sets it at startup from the setting's value
 * then - a query string up to the setting gets QUERY_STRING_TOO_LARGE in
 * the error envelope instead (Data_API.md §12.1).
 */
export function maxHeaderSizeFor(maxQueryStringBytes: number): number {
  return maxQueryStringBytes + HEADER_HEADROOM_BYTES;
}

/** The most `key=value` pairs, and so array items, a query string holds before qs refuses it. */
export const QUERY_STRING_PAIR_LIMIT = 1000;
/** The most bracket levels a key holds (`where[_or][0][_and][1][name][_eq]` is six). */
export const QUERY_STRING_DEPTH_LIMIT = 64;

/**
 * The query string parser (server.ts's `routerOptions.querystringParser`): PHP-style bracket nesting for the
 * query language (`where[price][_gt]=100`). qs's own defaults reshape a query instead of refusing
 * it - a 21st array item turns the array into an object keyed "0".."20", a sixth bracket level
 * becomes a literal key - so a valid-looking `where[_or]` failed as unknown field names. Here its
 * bounds are wide and past them it refuses with the stable errors; `api.max_query_parameters`,
 * `api.max_query_nodes` and `api.max_filter_depth` still apply after it (Data_API.md §12).
 */
export function parseQueryString(queryString: string): Record<string | symbol, unknown> {
  try {
    return qs.parse(queryString, {
      arrayLimit: QUERY_STRING_PAIR_LIMIT,
      parameterLimit: QUERY_STRING_PAIR_LIMIT,
      depth: QUERY_STRING_DEPTH_LIMIT,
      strictDepth: true,
      throwOnLimitExceeded: true,
    }) as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    // Fastify doesn't route a parser's exception to the error handler (the request hangs), so the
    // refusal travels in the parsed query and the onRequest hook below throws it, before any route.
    return {
      [QUERY_STRING_REFUSAL]: error.message.includes("depth")
        ? new TotalBaseError("QUERY_DEPTH_LIMIT_EXCEEDED", "Query string nesting exceeds the limit.")
        : new TotalBaseError("QUERY_PARAMETER_LIMIT_EXCEEDED", "Too many query parameters."),
    };
  }
}

const QUERY_STRING_REFUSAL = Symbol("queryStringRefusal");

/** Headers a browser may send cross-origin (the preflight's Access-Control-Allow-Headers). */
const CORS_ALLOWED_HEADERS = "authorization, content-type, idempotency-key, x-totalbase-timezone, x-totalbase-on-behalf-of";

function bodyTooLarge(): TotalBaseError {
  return new TotalBaseError("REQUEST_BODY_TOO_LARGE", "Request body exceeds the configured size limit.");
}

/** In-memory fixed-window counter per key (a client IP, a user's bucket). Counted per process: behind N processes a client gets up to N times the limit (Foundations.md §4.6); the sign-in lockout that holds across them is PostgreSQL's (Security.md §2.4). */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  /** How many windows it keeps in memory. */
  get size(): number {
    return this.windows.size;
  }

  /** Returns true when the request is allowed, false when the caller is over `limitPerMinute` (read per request - a change applies to the current window). */
  consume(key: string, limitPerMinute: number, now = Date.now()): boolean {
    const windowMs = 60_000;
    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (existing.count >= limitPerMinute) {
      return false;
    }
    existing.count += 1;
    return true;
  }

  /** Whether `key` has used up `limitPerMinute` in its current window - a check that counts nothing. */
  exhausted(key: string, limitPerMinute: number, now = Date.now()): boolean {
    const window = this.windows.get(key);
    return window !== undefined && window.resetAt > now && window.count >= limitPerMinute;
  }

  /** Whole seconds until `key`'s window resets - a refusal's Retry-After (RFC 9110 §10.2.3). */
  retryAfterSeconds(key: string, now = Date.now()): number {
    const window = this.windows.get(key);
    return window ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 1;
  }

  /** Drops expired windows so the map doesn't grow unbounded under many distinct clients. */
  sweep(now = Date.now()): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * Registers the defensive request-size/complexity guards (Data_API.md §12)
 * plus rate limiting and CORS (Administration.md §7.7, §7.8) as global hooks. Must
 * run before route handlers so oversized/abusive requests are rejected
 * "before expensive SQL compilation or execution" (Data_API.md §12).
 */
/**
 * The routes that check a credential (a password, a second factor, an
 * emailed token): their failed attempts - a 4xx other than 429 - count per
 * IP in security.rate_limit_sign_in_per_minute, always on (0 turns it off;
 * Administration.md §7.7). A correct sign-in counts nothing, so a whole
 * office signing in at nine never meets it. Each account's own lockout
 * (Security.md §2.4) applies whatever this says.
 */
const SIGN_IN_PATHS = new Set([
  "/api/auth/login",
  "/admin/api/auth/login",
  "/api/auth/mfa/verify",
  "/admin/api/auth/mfa/verify",
  "/api/auth/password/renew",
  "/admin/api/auth/password/renew",
  "/api/auth/password/reset",
  "/api/auth/invitations/accept",
  "/api/auth/email/verify",
]);

/**
 * Whether a sign-in's failures count against its address: always (security.rate_limit_sign_in_per_minute > 0), except
 * a request through a proxy TotalBase doesn't trust - its address is the proxy's, every caller's, and anyone's failed
 * attempts would refuse everyone's sign-in - unless the per-address limit is on, which counts it as it is. A caller
 * can't claim to be that case: it needs X-Forwarded-For and a private network's peer (behindUntrustedProxy).
 */
function countsSignIns(request: FastifyRequest, rateLimitEnabled: boolean, signInPerMinute: number): boolean {
  return signInPerMinute > 0 && isSignIn(request) && (rateLimitEnabled || !behindUntrustedProxy(request));
}

function isSignIn(request: FastifyRequest): boolean {
  return request.method === "POST" && SIGN_IN_PATHS.has(routePath(request));
}

/** The header an in-process request carries (the MCP endpoint's calls to the APIs), with a key made at boot that never leaves the process. */
export const INTERNAL_REQUEST_HEADER = "x-totalbase-internal";

/** The boot-time key, compared in constant time. */
function isInternalRequest(header: string | string[] | undefined, key: string): boolean {
  if (typeof header !== "string" || header.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(key));
}

/** Methods that change nothing - never held to the same origin. */
/**
 * The bucket that refuses a request, or null to let it through (Administration.md §7.8). With a credential: its
 * user's bucket - or the credential's own until it has validated once - under security.rate_limit_per_user_per_minute
 * (0 turns it off), and, with security.rate_limit_enabled, its address's bucket already used up. Without one: the
 * address's bucket, with security.rate_limit_enabled only.
 */
export function refusedBucket(
  limiter: RateLimiter,
  owners: CredentialOwners,
  request: { ip: string; credential: string | null; enabled: boolean; perMinute: number; perUserPerMinute: number },
): string | null {
  const { ip, credential, enabled, perMinute, perUserPerMinute } = request;
  if (credential === null) return enabled && !limiter.consume(ip, perMinute) ? ip : null;
  if (enabled && limiter.exhausted(ip, perMinute)) return ip;
  if (perUserPerMinute <= 0) return null;
  const bucket = owners.bucketOf(credential);
  // A credential no validation vouched for yet opens no bucket of its own: one per invented bearer would fill memory
  // with nothing to stop it while the per-address limit is off (SEC-114). Its request runs and authentication answers;
  // refused, it counts against its address like an anonymous one, with that limit on. Once it validates, its user's.
  if (bucket === credential) return null;
  return limiter.consume(bucket, perUserPerMinute) ? null : bucket;
}

/** How long a credential's user is remembered after it last validated, and how many are remembered at most. */
const OWNER_TTL_MS = 10 * 60_000;
const OWNERS_MAX = 50_000;

/**
 * Which user each credential that validated lately belongs to, by its bucket (never the credential itself): the
 * session and token services tell it (`onValidated`), the rate limiter - which runs before authentication - asks
 * it. In memory, per process, like the limiter itself.
 */
export class CredentialOwners {
  private readonly owners = new Map<string, { user: string; until: number }>();

  readonly remember = (credential: string, userId: string, kind: "TOKEN" | "SESSION_ID" = "TOKEN"): void => {
    const bucket = kind === "SESSION_ID" ? sessionIdBucket(credential) : credentialBucket(credential);
    this.owners.delete(bucket);
    this.owners.set(bucket, { user: userId, until: Date.now() + OWNER_TTL_MS });
    // Oldest first: a Map keeps insertion order, and a renewed entry moved to the end above.
    if (this.owners.size > OWNERS_MAX) this.owners.delete(this.owners.keys().next().value!);
  };

  /** The user's bucket for a credential's bucket, or the credential's own while its user isn't known. */
  bucketOf(credentialBucket: string, now = Date.now()): string {
    const owner = this.owners.get(credentialBucket);
    return owner !== undefined && owner.until > now ? `user:${owner.user}` : credentialBucket;
  }

  sweep(now = Date.now()): void {
    for (const [bucket, owner] of this.owners) {
      if (owner.until <= now) this.owners.delete(bucket);
    }
  }
}

/** Loopback and private ranges: where a reverse proxy in front of TotalBase connects from. */
const PROXY_NETWORKS = new BlockList();
for (const [network, prefix] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16]] as const) PROXY_NETWORKS.addSubnet(network, prefix, "ipv4");
PROXY_NETWORKS.addSubnet("::1", 128, "ipv6");
PROXY_NETWORKS.addSubnet("fc00::", 7, "ipv6");

/**
 * A request a reverse proxy forwarded (`X-Forwarded-For`) from a private address the server doesn't trust: its
 * address is the proxy's, so every caller shares one - in the per-address limits, the sign-in lockout's addresses,
 * the audit (Administration.md §7.8). Status says so (§1.6). A header sent straight from the internet doesn't count:
 * it doesn't come from a private address.
 */
export function behindUntrustedProxy(request: FastifyRequest): boolean {
  if (request.headers["x-forwarded-for"] === undefined) return false;
  const remote = request.socket.remoteAddress;
  // A trusted proxy's request has the caller's address, not the proxy's.
  if (remote === undefined || request.ip !== remote) return false;
  const peer = remote.startsWith("::ffff:") && isIPv4(remote.slice(7)) ? remote.slice(7) : remote;
  return PROXY_NETWORKS.check(peer, isIPv4(peer) ? "ipv4" : "ipv6");
}

/**
 * The credential a request carries, as the rate limiter keys a bucket on it (Administration.md §7.8): a hash of
 * the bearer, or of the session cookie - the limiter runs before authentication; CredentialOwners turns it into the
 * user's bucket once the credential has validated. Null: an anonymous request, counted per address.
 */
function credentialKey(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  const bearer = typeof header === "string" ? header.match(/^Bearer\s+(\S+)/i)?.[1] : undefined;
  const credential = bearer ?? readSessionCookie(request);
  return credential ? credentialBucket(credential) : null;
}

/** A credential's rate-limit bucket - never the credential itself, kept in memory. */
export function credentialBucket(credential: string): string {
  return `credential:${createHash("sha256").update(credential).digest("base64url").slice(0, 32)}`;
}

/**
 * A session id's bucket - a WebSocket opened with a ticket holds only the id. Apart from credentialBucket: an id
 * isn't a secret (whoever reads `sessions` sees it), and no request's bearer lands here, so presenting a session's id
 * never spends its owner's limit (SEC-113).
 */
export function sessionIdBucket(sessionId: string): string {
  return `session-id:${createHash("sha256").update(sessionId).digest("base64url").slice(0, 32)}`;
}

/**
 * Counts one operation a WebSocket carries (a GraphQL operation, a realtime subscribe) as one request of the
 * credential that runs it - refused with RATE_LIMIT_EXCEEDED past the limit (Administration.md §7.7). The upgrade
 * counted once; without this, every operation after it ran free. A token's bucket is its HTTP requests' too; a
 * session's isn't: HTTP knows its cookie, a socket opened with a ticket only its id, so a signed-in browser gets the
 * per-user limit once over HTTP and once over its sockets.
 */
export type OperationRateLimit = (ip: string, credential: { token: string } | { session: string } | null) => Promise<void>;

declare module "fastify" {
  interface FastifyInstance {
    operationRateLimit?: OperationRateLimit;
    /** Told by the session and token services which user each credential is (server.ts). */
    credentialOwners?: CredentialOwners;
    /** When this process last saw a request forwarded by a proxy it doesn't trust (behindUntrustedProxy) - null: never. */
    untrustedProxySeenAt?: number | null;
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * The browser features a page of this origin may use (Foundations.md §4.7): the camera (the code scanner) and the
 * location (a map's "my location") for its own pages, nothing else that reaches a device or the visitor. Only features
 * browsers recognize: an unknown one (`bluetooth`, `browsing-topics` in Chrome) is a console error on every page.
 */
export const PERMISSIONS_POLICY = [
  "camera=(self)",
  "geolocation=(self)",
  "microphone=()",
  "display-capture=()",
  "payment=()",
  "usb=()",
  "serial=()",
  "hid=()",
  "midi=()",
  "accelerometer=()",
  "gyroscope=()",
  "magnetometer=()",
].join(", ");

/**
 * The headers every answer carries (Foundations.md §4.7): no MIME sniffing,
 * no full URL leaving in a Referer (links carry `?token=`), HSTS once the
 * public URL is https; the device features of PERMISSIONS_POLICY; a window of
 * its own, never shared with another site's (`Cross-Origin-Opener-Policy`); an
 * answer another site can't load into its page (`Cross-Origin-Resource-Policy`)
 * unless its route allowed it - a stored file's content (file-response.ts); an
 * API answer in JSON - a session, a record, personal data - kept out of every
 * cache unless its route set its own policy.
 */
function securityHeaders(request: FastifyRequest, reply: FastifyReply, publicUrl: string): void {
  reply.header("x-content-type-options", "nosniff");
  reply.header("referrer-policy", "strict-origin-when-cross-origin");
  reply.header("permissions-policy", PERMISSIONS_POLICY);
  reply.header("cross-origin-opener-policy", "same-origin");
  if (!reply.hasHeader("cross-origin-resource-policy")) reply.header("cross-origin-resource-policy", "same-origin");
  if (publicUrl.startsWith("https://")) reply.header("strict-transport-security", "max-age=31536000");
  if (isServerRequest(request) && !reply.hasHeader("cache-control") && String(reply.getHeader("content-type") ?? "").startsWith("application/json")) {
    reply.header("cache-control", "no-store");
  }
}

export function registerHardeningHooks(
  app: FastifyInstance,
  settings: HardeningSettingsSource,
  options: { internalKey?: string; publicUrl?: () => Promise<string> } = {},
): void {
  const publicUrl = options.publicUrl ?? (async () => "");
  const rateLimiter = new RateLimiter();
  const owners = new CredentialOwners();
  app.decorate("credentialOwners", owners);
  app.decorate("untrustedProxySeenAt", null);
  const operationRateLimit: OperationRateLimit = async (ip, credential) => {
    const [enabled, perMinute, perUserPerMinute] = await Promise.all([
      settings.get("security.rate_limit_enabled"),
      settings.get("security.rate_limit_per_minute"),
      settings.get("security.rate_limit_per_user_per_minute"),
    ]);
    const bucket = credential === null ? null : "token" in credential ? credentialBucket(credential.token) : sessionIdBucket(credential.session);
    const refused = refusedBucket(rateLimiter, owners, { ip, credential: bucket, enabled, perMinute, perUserPerMinute });
    if (refused !== null) throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down.");
  };
  app.decorate("operationRateLimit", operationRateLimit);
  const signInFailures = new RateLimiter();
  const sweepInterval = setInterval(() => {
    rateLimiter.sweep();
    signInFailures.sweep();
    owners.sweep();
  }, 60_000);
  sweepInterval.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweepInterval);
    done();
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Admin UI asset/HMR traffic (every path outside the server's own,
    // admin-ui.ts's isServerRequest) isn't API traffic these guards
    // were sized for - a `nuxt dev` page load alone fires far more than
    // security.rate_limit_per_minute in module/HMR requests through the
    // dev proxy (admin-ui.ts), tripping RATE_LIMIT_EXCEEDED on the UI
    // itself rather than on abusive API use.
    if (!isServerRequest(request)) {
      return;
    }
    if (behindUntrustedProxy(request)) app.untrustedProxySeenAt = Date.now();

    const [corsEnabled, corsOrigins, maxQueryStringBytes, maxQueryParameters, rateLimitEnabled, rateLimitPerMinute, signInPerMinute, rateLimitPerUserPerMinute] = await Promise.all([
      settings.get("security.cors_enabled"),
      settings.get("security.cors_origins"),
      settings.get("api.max_query_string_bytes"),
      settings.get("api.max_query_parameters"),
      settings.get("security.rate_limit_enabled"),
      settings.get("security.rate_limit_per_minute"),
      settings.get("security.rate_limit_sign_in_per_minute"),
      settings.get("security.rate_limit_per_user_per_minute"),
    ]);

    // --- CORS (Administration.md §7.8) ---
    const origin = request.headers.origin;
    if (corsEnabled && origin && corsOrigins.includes(origin)) {
      reply.header("access-control-allow-origin", origin);
      reply.header("access-control-allow-credentials", "true");
      reply.header("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      reply.header("access-control-allow-methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS");
      reply.header("access-control-allow-headers", CORS_ALLOWED_HEADERS);
      return reply.code(204).send();
    }

    // --- CSRF (Security.md §2.18) ---
    // The browser sends the session cookie by itself, so a write it
    // authenticates - no Authorization header - must come from this
    // instance's own pages. A bearer token is never sent by itself: no check.
    // A public route (a sign-in, a password reset) isn't authenticated by the
    // cookie at all: nothing to hold - a cookie sign-in checks its own origin.
    const config = request.routeOptions.config as { public?: boolean; openapi?: { access?: string } } | undefined;
    const publicRoute = config?.public === true || config?.openapi?.access === "public";
    if (!SAFE_METHODS.has(request.method) && !publicRoute && request.headers.authorization === undefined && readSessionCookie(request)) {
      assertSameOrigin(request, await publicUrl());
    }

    // --- QUERY_STRING_TOO_LARGE / QUERY_PARAMETER_LIMIT_EXCEEDED (Data_API.md §12) ---
    // Node's maxHeaderSize is set at startup above the setting's value
    // (maxHeaderSizeFor, server.ts), so a query string past the limit
    // reaches this hook instead of Node's raw 431.
    const rawUrl = request.raw.url ?? "";
    const queryStringStart = rawUrl.indexOf("?");
    const queryString = queryStringStart >= 0 ? rawUrl.slice(queryStringStart + 1) : "";
    if (Buffer.byteLength(queryString, "utf8") > maxQueryStringBytes) {
      throw new TotalBaseError("QUERY_STRING_TOO_LARGE", "Query string exceeds the configured size limit.");
    }
    const refusal = (request.query as Record<symbol, unknown> | undefined)?.[QUERY_STRING_REFUSAL];
    if (refusal) throw refusal;
    const paramCount = Object.keys(request.query as Record<string, unknown>).length;
    if (paramCount > maxQueryParameters) {
      throw new TotalBaseError("QUERY_PARAMETER_LIMIT_EXCEEDED", "Too many query parameters.");
    }

    // --- Rate limiting (Administration.md §7.7's ip resolution, honored via Fastify's trustProxy option) ---
    // An in-process request (app.inject) from the MCP endpoint - whose own requests are limited per token there - is not
    // counted again against the caller's IP. Only a request bearing the boot-time key, which no client can know, is.
    const internal = options.internalKey !== undefined && isInternalRequest(request.headers[INTERNAL_REQUEST_HEADER], options.internalKey);
    // A request to /mcp with a token counts once: against that token's own limit (mcp.rate_limit_per_minute, the MCP
    // endpoint's), never the API's per-IP one - an agent's build is several hundred calls a minute. Without a token
    // it is an anonymous request like any other, counted per IP.
    const mcpWithToken = routePath(request) === "/mcp" &&/^Bearer\s+\S/i.test(request.headers.authorization ?? "");
    // A request with a credential counts in its user's bucket (security.rate_limit_per_user_per_minute, always on):
    // every session and token of one person shares it, whatever address they come from - so it holds behind a proxy
    // nobody trusts too. Until a credential has validated once, its user isn't known and it isn't counted per user.
    // An anonymous request counts per address (security.rate_limit_enabled), as does a credential that is refused (the
    // onResponse hook below), so a flood of invented tokens exhausts its address's bucket.
    if (!internal && !mcpWithToken) {
      // A public route (a sign-in, a reset or verification request, a registration) never checks a credential: one it
      // carries opens no bucket of its own - an invented `Bearer` per request would otherwise never meet a limit.
      const credential = publicRoute ? null : credentialKey(request);
      const refused = refusedBucket(rateLimiter, owners, { ip: request.ip, credential, enabled: rateLimitEnabled, perMinute: rateLimitPerMinute, perUserPerMinute: rateLimitPerUserPerMinute });
      if (refused !== null) {
        reply.header("retry-after", String(rateLimiter.retryAfterSeconds(refused)));
        throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down.");
      }
    }
    if (countsSignIns(request, rateLimitEnabled, signInPerMinute) && signInFailures.exhausted(request.ip, signInPerMinute)) {
      reply.header("retry-after", String(signInFailures.retryAfterSeconds(request.ip)));
      throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many failed sign-in attempts from this address. Please wait a minute.");
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    securityHeaders(request, reply, await publicUrl());
    return payload;
  });

  // A failed attempt on a credential route counts once it's answered (SIGN_IN_PATHS); a credential the request
  // carried that was refused (401) counts against the address, as an anonymous request would have.
  app.addHook("onResponse", async (request, reply) => {
    const refusedCredential = reply.statusCode === 401 && credentialKey(request) !== null;
    const failedSignIn = isSignIn(request) && reply.statusCode >= 400 && reply.statusCode < 500 && reply.statusCode !== 429;
    if (!refusedCredential && !failedSignIn) return;
    const [rateLimitEnabled, signInPerMinute, rateLimitPerMinute] = await Promise.all([
      settings.get("security.rate_limit_enabled"),
      settings.get("security.rate_limit_sign_in_per_minute"),
      settings.get("security.rate_limit_per_minute"),
    ]);
    if (failedSignIn && countsSignIns(request, rateLimitEnabled, signInPerMinute)) signInFailures.consume(request.ip, signInPerMinute);
    if (refusedCredential && rateLimitEnabled) rateLimiter.consume(request.ip, rateLimitPerMinute);
  });

  // --- REQUEST_BODY_TOO_LARGE (Data_API.md §12) ---
  // api.max_body_bytes, read per request: a declared Content-Length over
  // it is refused before the body is read, and the body stream is counted
  // as it arrives, so a body without one (chunked) is cut off at the limit
  // too. Fastify's own bodyLimit is only a ceiling (FASTIFY_BODY_LIMIT_CEILING).
  // A multipart upload is left alone: its parser reads the raw request
  // itself, and files.max_file_size_bytes is its limit (§10.4 of
  // Administration.md).
  app.addHook("preParsing", async (request, _reply, payload) => {
    if (request.headers["content-type"]?.toLowerCase().startsWith("multipart/")) return payload;
    // A WebSocket upgrade (/api/realtime) has no body: @fastify/websocket hands no stream to count.
    if (typeof (payload as { pipe?: unknown } | undefined)?.pipe !== "function") return payload;
    const limit = await settings.get("api.max_body_bytes");
    const declared = Number(request.headers["content-length"]);
    if (Number.isFinite(declared) && declared > limit) throw bodyTooLarge();
    let received = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > limit) callback(bodyTooLarge());
        else callback(null, chunk);
      },
    });
    payload.on("error", (error) => counted.destroy(error));
    return payload.pipe(counted);
  });
}
