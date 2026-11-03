import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { ADMIN_SCHEMAS, adminDoc, ok, ref } from "../openapi-admin-docs.js";
import { TOTALBASE_VERSION } from "../version.js";

/**
 * What this instance runs (Administration.md §7.10) - Settings > General > General's "About this instance":
 * TotalBase's version, the environment, and the PostgreSQL it talks to. Read once per visit; nothing to edit.
 */
export function registerAdminSystemRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/admin/api/system", {
    preHandler: requireAdmin(context),
    ...adminDoc("system", {
      summary: "This instance: TotalBase's version, the environment and its PostgreSQL",
      response: ok(ref("SystemInfo")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => {
    const { rows } = await context.database.query<{ version: string; database: string }>(
      `SELECT split_part(current_setting('server_version'), ' ', 1) AS version, current_database() AS database`,
    );
    const postgres = rows[0]!;
    return { data: { version: TOTALBASE_VERSION, environment: context.nodeEnv, postgres: { version: postgres.version, database: postgres.database } } };
  });
}
