import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";

/**
 * Registers /health/live and /health/ready.
 * See Foundations.md §17.
 */
export function registerHealthRoutes(app: FastifyInstance, database: Database): void {
  // Live: process alive, Fastify responds. No dependency checks.
  app.get("/health/live", async () => ({ status: "live" }));

  // Ready: PostgreSQL reachable, internal schema valid, migrations current,
  // master key valid, catalog initialized.
  //
  // Bootstrap already asserted these once at startup; here we re-check the
  // one thing that can regress at runtime without a restart: connectivity.
  app.get("/health/ready", async (_request, reply) => {
    try {
      await database.ping();
      return { status: "ready" };
    } catch (error) {
      reply.code(503);
      return {
        status: "not_ready",
        reason: error instanceof Error ? error.message : "unknown error",
      };
    }
  });
}
