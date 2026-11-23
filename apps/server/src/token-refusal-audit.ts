import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppContext } from "./context.js";
import { clientIp } from "./client-ip.js";
import { routePath } from "./admin-ui.js";

/**
 * A personal access token that was refused, in the audit log (Security.md §11.6, `auth.token_refused`): a
 * revoked, deactivated or expired token still in use, one whose user was deactivated or lost the access its
 * plane needs, or one presented from outside its allowed addresses (§3.5) - what an operator wants to know
 * about: a program nobody updated, or a leaked secret being tried.
 *
 * Only a secret that IS some token's is recorded - an invented one names nothing, and logging each would let
 * anyone fill the log; those are counted by the rate limiter (Administration.md §7.8). And once a minute per
 * token and reason in this process: a program retrying a dead token in a loop is one line a minute, as
 * `last_used_at` is one write a minute.
 *
 * Written after the response, as an access event is (access-audit.ts): the lookup costs the refused request
 * nothing, and a request that was let through never pays it.
 */

/** The answers a refused token gets: an unknown credential, or one outside its allowed addresses. */
const REFUSAL_CODES = new Set(["AUTHENTICATION_REQUIRED", "TOKEN_IP_NOT_ALLOWED"]);
const THROTTLE_MS = 60_000;
const THROTTLE_MAX_KEYS = 10_000;

type Flagged = FastifyRequest & { refusedTokenCode?: string; tokenRefusalStartedAt?: Date };

/** The bearer a request carries, when it has a personal access token's shape (`tb_...`). */
function presentedToken(request: FastifyRequest): string | null {
  const match = /^Bearer\s+(tb_\S+)$/i.exec(request.headers.authorization ?? "");
  return match?.[1] ?? null;
}

export function registerTokenRefusalAudit(app: FastifyInstance, context: AppContext): void {
  /** token id + reason -> when it was last recorded. */
  const recorded = new Map<string, number>();

  app.addHook("onRequest", async (request) => {
    (request as Flagged).tokenRefusalStartedAt = new Date();
  });

  // The code the caller got - onResponse no longer sees the payload.
  app.addHook("onSend", async (request, reply, payload) => {
    if ((reply.statusCode === 401 || reply.statusCode === 403) && typeof payload === "string" && presentedToken(request) !== null) {
      try {
        const code = (JSON.parse(payload) as { errors?: Array<{ code?: string }> }).errors?.[0]?.code;
        if (code !== undefined && REFUSAL_CODES.has(code)) (request as Flagged).refusedTokenCode = code;
      } catch {
        // Not JSON - not a refusal of ours.
      }
    }
    return payload;
  });

  app.addHook("onResponse", async (request, reply) => {
    const code = (request as Flagged).refusedTokenCode;
    const token = presentedToken(request);
    if (code === undefined || token === null) return;
    try {
      const refusal = await context.usersApis.refusalOf(token, clientIp(request));
      if (!refusal) return;
      const key = `${refusal.id}:${refusal.reason}`;
      const now = Date.now();
      if (now - (recorded.get(key) ?? 0) < THROTTLE_MS) return;
      if (recorded.size >= THROTTLE_MAX_KEYS) recorded.clear();
      recorded.set(key, now);
      await context.audit.record(context.database, {
        requestId: request.id,
        // The token itself, as its accepted requests are logged (Security.md §3.2); the actor is its owner.
        principal: { type: "API_KEY", id: refusal.id },
        action: "AUTH",
        status: "DENIED",
        source: routePath(request).startsWith("/admin/") ? "admin" : "auth",
        ip: request.ip,
        userAgent: request.headers["user-agent"],
        metadata: {
          event: "auth.token_refused",
          reason: refusal.reason,
          plane: refusal.plane,
          user_id: refusal.userId,
          method: request.method,
          // The route's pattern, never the URL: a query string may carry data.
          route: request.routeOptions.url ?? null,
          statusCode: reply.statusCode,
        },
        error: { code, message: "The token was refused." },
        startedAt: (request as Flagged).tokenRefusalStartedAt ?? new Date(),
        finishedAt: new Date(),
      });
    } catch (err) {
      request.log.error({ err }, "Could not write the refused token's audit entry");
    }
  });
}
