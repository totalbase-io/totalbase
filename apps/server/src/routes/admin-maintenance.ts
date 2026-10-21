import type { FastifyInstance } from "fastify";
import { getMaintenanceOverview, listMaintenanceIndexes, type MaintenanceTarget } from "@totalbase/pg-catalog";
import { MAINTENANCE_OPERATIONS, type MaintenanceOperation } from "@totalbase/schema";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { requireAdmin } from "../auth-guards.js";
import { dataEnvelope } from "@totalbase/openapi";
import { ADMIN_SCHEMAS, adminDoc, arrayOf, object, ok, ref, UUID } from "../openapi-admin-docs.js";

/**
 * PostgreSQL maintenance (Administration.md §6) - Settings >
 * General > Maintenance. Sizes and vacuum/analyze state from PostgreSQL's
 * own statistics; VACUUM / ANALYZE / REINDEX CONCURRENTLY queued - one
 * table, or a batch of them - to the dedicated maintenance worker
 * (maintenance-executor.ts). The queue, the one-batch-at-a-time rule and a
 * batch's state are @totalbase/executions' MaintenanceService; these routes
 * parse the request and answer.
 */
const OPERATION_BY_PATH: Record<string, MaintenanceOperation> = { vacuum: "VACUUM", analyze: "ANALYZE", reindex: "REINDEX" };
const RECENT_RUNS = 20;
const MAX_BATCH_TARGETS = 2000;

function parseOid(raw: unknown, what: string): number {
  const oid = Number(raw);
  if (!Number.isInteger(oid) || oid <= 0) throw new TotalBaseError("INVALID_QUERY", `Expected ${what} OID.`);
  return oid;
}

/** A path's table OID: one that can't be an OID names no table - 404, like one that matches nothing. */
function pathOid(raw: string): number {
  const oid = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(oid) || oid <= 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", `No such table (OID ${raw}).`);
  return oid;
}

function parseOperation(raw: unknown): MaintenanceOperation {
  const operation = typeof raw === "string" ? (OPERATION_BY_PATH[raw.toLowerCase()] ?? null) : null;
  if (!operation || !MAINTENANCE_OPERATIONS.includes(operation)) {
    throw new TotalBaseError("INVALID_QUERY", "operation must be vacuum, analyze or reindex.");
  }
  return operation;
}

export function registerAdminMaintenanceRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);

  app.get("/admin/api/maintenance/tables", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "Tables with their size and maintenance state",
      description:
        "Every table, partitioned table and materialized view outside PostgreSQL's own schemas, largest first, with the " +
        "database's size. `canMaintain` says whether the configured role may VACUUM/ANALYZE/REINDEX it.",
      response: ok(ref("MaintenanceOverview")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => ({ data: await getMaintenanceOverview(context.database) }));

  app.get<{ Params: { oid: string } }>("/admin/api/maintenance/tables/:oid/indexes", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "A table's indexes",
      description: "404 when no maintainable table (table, partitioned table, materialized view) has this OID.",
      pathParameters: { oid: { description: "The table's PostgreSQL OID.", schema: { type: "integer" } } },
      response: ok(arrayOf(ref("MaintenanceIndex"))),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request) => {
    return { data: await listMaintenanceIndexes(context.database, pathOid(request.params.oid)) };
  });

  app.post<{ Params: { oid: string; operation: string }; Body: { data?: { index?: unknown } } | undefined }>(
    "/admin/api/maintenance/tables/:oid/:operation",
    {
      preHandler,
      ...adminDoc("maintenance", {
        summary: "Queue VACUUM, ANALYZE or REINDEX on one table",
        description:
          "`operation` is `vacuum` (VACUUM (ANALYZE)), `analyze` or `reindex` (REINDEX TABLE CONCURRENTLY, or " +
          "REINDEX INDEX CONCURRENTLY with `index`). Runs in the background maintenance worker; follow it with GET " +
          "/admin/api/maintenance/runs. 403 PERMISSION_DENIED when TotalBase's role can't maintain the table; 409 " +
          "ASYNC_EXECUTIONS_DISABLED, MAINTENANCE_BATCH_RUNNING or MAINTENANCE_ALREADY_QUEUED.",
        pathParameters: {
          oid: { description: "The table's PostgreSQL OID.", schema: { type: "integer" } },
          operation: { schema: { type: "string", enum: ["vacuum", "analyze", "reindex"] } },
        },
        requestBody: {
          schema: dataEnvelope(object({ index: { type: "integer", description: "REINDEX only: one index's OID." } })),
          required: false,
        },
        response: { status: "202", schema: { type: "object", properties: { data: ref("MaintenanceRun") } } },
        schemas: ADMIN_SCHEMAS,
      }),
    },
    async (request, reply) => {
      const operation = parseOperation(request.params.operation);
      const tableOid = pathOid(request.params.oid);
      const index = request.body?.data?.index;
      const indexOid = index === undefined || index === null ? undefined : parseOid(index, "an index");
      const target = await context.maintenance.resolveTarget(operation, tableOid, indexOid);
      reply.code(202);
      return { data: await context.maintenance.queue(operation, target, request.admin!.id) };
    },
  );

  app.get("/admin/api/maintenance/runs", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "Recent maintenance runs",
      description: `The last ${RECENT_RUNS} VACUUM/ANALYZE/REINDEX runs, newest first; a running one carries its progress from pg_stat_progress_*.`,
      response: ok(arrayOf(ref("MaintenanceRun"))),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => ({ data: await context.maintenance.listRuns(RECENT_RUNS) }));

  // --- Batches: one operation over many tables (or indexes), one table at a time ---

  app.post<{ Body: { data?: { operation?: unknown; targets?: unknown } } }>("/admin/api/maintenance/batches", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "Start a maintenance batch",
      description:
        "One operation over a list of targets - e.g. every table with dead rows, every invalid index, a selection - " +
        "run one at a time by the maintenance worker. Every target is checked first (it exists, TotalBase's role may " +
        "maintain it); one that fails refuses the whole batch. One batch at a time: 409 MAINTENANCE_BATCH_RUNNING.",
      requestBody: {
        schema: dataEnvelope(object(
          {
            operation: { type: "string", enum: ["vacuum", "analyze", "reindex"] },
            targets: arrayOf(object({ table: { type: "integer" }, index: { type: "integer", description: "REINDEX only." } }, ["table"])),
          },
          ["operation", "targets"],
        )),
      },
      response: { status: "202", schema: { type: "object", properties: { data: ref("MaintenanceBatch") } } },
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request, reply) => {
    const operation = parseOperation(request.body?.data?.operation);
    const rawTargets = request.body?.data?.targets;
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) throw new TotalBaseError("INVALID_QUERY", "targets must be a non-empty list.");
    if (rawTargets.length > MAX_BATCH_TARGETS) throw new TotalBaseError("INVALID_QUERY", `A batch holds at most ${MAX_BATCH_TARGETS} targets.`);

    const targets: MaintenanceTarget[] = [];
    for (const raw of rawTargets as Array<{ table?: unknown; index?: unknown }>) {
      const tableOid = parseOid(raw?.table, "a table");
      const indexOid = raw?.index === undefined || raw?.index === null ? undefined : parseOid(raw.index, "an index");
      targets.push(await context.maintenance.resolveTarget(operation, tableOid, indexOid));
    }
    reply.code(202);
    return { data: await context.maintenance.queueBatch(operation, targets, request.admin!.id) };
  });

  app.get("/admin/api/maintenance/batches/current", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "The running batch, if any",
      description: "The batch still pending or running (at most one), or null. The admin reopens its progress from this after a reload.",
      response: ok({ oneOf: [ref("MaintenanceBatch"), { type: "null" }] }),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async () => {
    const batchId = await context.maintenance.activeBatchId();
    return { data: batchId ? await context.maintenance.loadBatch(batchId) : null };
  });

  app.get<{ Params: { id: string } }>("/admin/api/maintenance/batches/:id", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "A batch's progress",
      pathParameters: { id: { schema: UUID } },
      response: ok(ref("MaintenanceBatch")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request) => ({ data: await context.maintenance.loadBatch(request.params.id) }));

  app.post<{ Params: { id: string } }>("/admin/api/maintenance/batches/:id/stop", {
    preHandler,
    ...adminDoc("maintenance", {
      summary: "Stop a batch",
      description:
        "Cancels every target not started yet. A running VACUUM or ANALYZE is cancelled too (pg_cancel_backend - safe, " +
        "nothing is left half done); a running REINDEX CONCURRENTLY is left to finish, since cancelling it leaves an " +
        "invalid index behind.",
      pathParameters: { id: { schema: UUID } },
      response: ok(ref("MaintenanceBatch")),
      schemas: ADMIN_SCHEMAS,
    }),
  }, async (request) => {
    const batch = await context.maintenance.stopBatch(request.params.id);
    try {
      await context.audit.record(context.database, {
        requestId: request.id,
        principal: { type: "ADMIN", id: request.admin!.id },
        action: "MAINTENANCE",
        status: "EXECUTED",
        source: "admin",
        metadata: { batch: batch.id, stopped: true },
        startedAt: new Date(),
        finishedAt: new Date(),
      });
    } catch {
      // best-effort
    }
    return { data: batch };
  });
}
