import type { FastifyInstance, preHandlerHookHandler } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import { UUID_PATTERN } from "@totalbase/shared";

/**
 * The path parameters that name a TotalBase row - every `totalbase` table's id is a UUID (Foundations.md §10.2).
 * `:resource`, `:pk`, `:slug` and the rest name other things (a resource's name, a row of the caller's table).
 */
const ID_PARAMS = ["id", "role", "widgetId", "fieldId", "viewId", "runId", "fileId", "recipientId"] as const;

/**
 * An id in the path that can't be one names nothing: 404, like an id that matches no row (Data_API.md §2.4) - never
 * PostgreSQL's 400 for a malformed uuid. Installed before the routes, so it covers each one that names these params;
 * it runs after the route's own guards, so a caller without access still gets their 401/403 first.
 */
export function registerPathIdHook(app: FastifyInstance): void {
  app.addHook("onRoute", (route) => {
    // A resource's id there may also be its PostgreSQL OID - resourceByPathId's own rule, 404 included.
    if (/^\/admin\/api\/(catalog|schema)\//.test(route.url)) return;
    const params = ID_PARAMS.filter((name) => new RegExp(`/:${name}(?=/|$)`).test(route.url));
    if (params.length === 0) return;
    const check: preHandlerHookHandler = (request, _reply, done) => {
      const values = request.params as Record<string, string | undefined>;
      const bad = params.find((name) => values[name] !== undefined && !UUID_PATTERN.test(values[name]!));
      done(bad ? new TotalBaseError("ROW_NOT_FOUND", `No record has the id ${values[bad]}.`) : undefined);
    };
    const existing = route.preHandler;
    route.preHandler = existing ? [...(Array.isArray(existing) ? existing : [existing]), check] : [check];
  });
}

