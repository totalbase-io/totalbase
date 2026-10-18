import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { SessionStatusFilter } from "@totalbase/auth";
import type { AppContext } from "../context.js";
import { parseUserFilter } from "./user-filter.js";
import { requireAdmin } from "../auth-guards.js";
import { adminDoc, arrayOf, object, ref, UUID } from "../openapi-admin-docs.js";
import { listEnvelope, SESSIONS_SCHEMAS } from "../openapi-admin-docs-users.js";

const MAX_PAGE_SIZE = 200;
const SESSION_STATUSES: readonly SessionStatusFilter[] = ["ACTIVE", "EXPIRED", "REVOKED", "ALL"];

/** See Specification_Administration.md §1 (Sessions). */
export function registerAdminSessionsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  // `?user=<id>` narrows the list to one user (their page's Sessions tab).
  // Filtered and counted in PostgreSQL - `?status=` ACTIVE (default) /
  // EXPIRED / REVOKED / ALL, `?q=` email, name, IP or user agent - one
  // page with `?limit=` (1-200) and `?offset=`, every match without it;
  // always with meta.total and meta.counts per status. Each row says
  // whether it's the caller's own session.
  app.get<{ Querystring: { user?: string; status?: string; q?: string; limit?: string; offset?: string } }>(
    "/admin/api/sessions",
    {
      preHandler,
      ...adminDoc("sessions", {
        summary: "List sessions",
        description:
          "Most recently seen first, filtered by `status` and `q`, with `meta.total` and `meta.counts` per status (under " +
          "the same `q`/`user`). Without `limit`, every matching session. `current` marks the caller's own session. " +
          "To revoke one, update its row through the Data API.",
        parameters: [
          { name: "user", in: "query", description: "Only this user's sessions.", schema: UUID },
          { name: "limit", in: "query", description: "Page size (1-200); every match when omitted.", schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "offset", in: "query", schema: { type: "integer", minimum: 0, default: 0 } },
          { name: "status", in: "query", schema: { type: "string", enum: ["ACTIVE", "EXPIRED", "REVOKED", "ALL"], default: "ACTIVE" } },
          { name: "q", in: "query", description: "Case-insensitive substring of the user's email or name, the IP or the user agent.", schema: { type: "string" } },
        ],
        response: {
          status: "200",
          schema: listEnvelope(arrayOf(ref("SessionsSession")), object({
            total: { type: "integer" },
            counts: object({ ACTIVE: { type: "integer" }, EXPIRED: { type: "integer" }, REVOKED: { type: "integer" } }),
          }, ["total", "counts"]), true),
        },
        schemas: SESSIONS_SCHEMAS,
      }),
    },
    async (request) => {
      const user = parseUserFilter(request.query.user);
      const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
      const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE)) {
        throw new TotalBaseError("INVALID_QUERY", `limit must be between 1 and ${MAX_PAGE_SIZE}.`);
      }
      if (!Number.isInteger(offset) || offset < 0) throw new TotalBaseError("INVALID_QUERY", "offset must be 0 or more.");
      const status = (request.query.status ?? "ACTIVE") as SessionStatusFilter;
      if (!SESSION_STATUSES.includes(status)) {
        throw new TotalBaseError("INVALID_QUERY", `status must be one of ${SESSION_STATUSES.join(", ")}.`);
      }
      const page = await context.auth.sessions.search({ user, status, q: request.query.q, limit, offset });
      return {
        data: page.sessions.map((session) => ({ ...session, current: session.id === request.adminSession })),
        meta: { total: page.total, counts: page.counts },
      };
    },
  );

}
