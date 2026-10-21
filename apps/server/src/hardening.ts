import { timingSafeEqual } from "node:crypto";
import { Transform } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import qs from "qs";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";

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
 * The query string parser (server.ts's `querystringParser`): PHP-style bracket nesting for the
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
const CORS_ALLOWED_HEADERS = "authorization, content-type, idempotency-key, x-totalbase-timezone";

function bodyTooLarge(): TotalBaseError {
  return new TotalBaseError("REQUEST_BODY_TOO_LARGE", "Request body exceeds the configured size limit.");
}

/** In-memory fixed-window counter per client IP. Single-process V1 scope - a multi-instance deployment needs a shared store (e.g. Postgres/Redis), out of scope here. */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

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
/** The header an in-process request carries (the MCP endpoint's calls to the APIs), with a key made at boot that never leaves the process. */
export const INTERNAL_REQUEST_HEADER = "x-totalbase-internal";

/** The boot-time key, compared in constant time. */
function isInternalRequest(header: string | string[] | undefined, key: string): boolean {
  if (typeof header !== "string" || header.length !== key.length) return false;
  return timingSafeEqual(Buffer.from(header), Buffer.from(key));
}

export function registerHardeningHooks(app: FastifyInstance, settings: HardeningSettingsSource, options: { internalKey?: string } = {}): void {
  const rateLimiter = new RateLimiter();
  const sweepInterval = setInterval(() => rateLimiter.sweep(), 60_000);
  sweepInterval.unref();
  app.addHook("onClose", (_instance, done) => {
    clearInterval(sweepInterval);
    done();
  });

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Admin UI asset/HMR traffic (everything under /admin/ except the
    // Admin API itself, at /admin/api/*) isn't API traffic these guards
    // were sized for - a `nuxt dev` page load alone fires far more than
    // security.rate_limit_per_minute in module/HMR requests through the
    // dev proxy (admin-ui.ts), tripping RATE_LIMIT_EXCEEDED on the UI
    // itself rather than on abusive API use.
    if (request.url.startsWith("/admin/") && !request.url.startsWith("/admin/api")) {
      return;
    }

    const [corsEnabled, corsOrigins, maxQueryStringBytes, maxQueryParameters, rateLimitEnabled, rateLimitPerMinute] = await Promise.all([
      settings.get("security.cors_enabled"),
      settings.get("security.cors_origins"),
      settings.get("api.max_query_string_bytes"),
      settings.get("api.max_query_parameters"),
      settings.get("security.rate_limit_enabled"),
      settings.get("security.rate_limit_per_minute"),
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
      reply.code(204).send();
      return;
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
    const mcpWithToken = (request.url === "/mcp" || request.url.startsWith("/mcp?")) && /^Bearer\s+\S/i.test(request.headers.authorization ?? "");
    if (rateLimitEnabled && !internal && !mcpWithToken && !rateLimiter.consume(request.ip, rateLimitPerMinute)) {
      reply.header("retry-after", String(rateLimiter.retryAfterSeconds(request.ip)));
      throw new TotalBaseError("RATE_LIMIT_EXCEEDED", "Too many requests. Please slow down.");
    }
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
