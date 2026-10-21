import { randomUUID } from "node:crypto";
import { resolveMaintenanceTarget, type MaintenanceTarget } from "@totalbase/pg-catalog";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { MaintenanceOperation } from "@totalbase/schema";
import type { SettingsService } from "@totalbase/settings";
import { ExecutionsService, type ExecutionRecord } from "./executions-service.js";
import { EXECUTION_CANCELLED } from "./executor-error.js";

/**
 * PostgreSQL maintenance (Administration.md §6): VACUUM /
 * ANALYZE / REINDEX CONCURRENTLY queued - one table, or a batch of them -
 * as MAINTENANCE executions for the dedicated maintenance worker, their
 * progress read back from pg_stat_progress_*. This service owns the queue:
 * what a request holds, the one-batch-at-a-time rule, a batch's state and
 * its stop. Running one is the worker's executor (apps/server's
 * maintenance-executor.ts); the HTTP routes only parse and answer.
 */

/** What POST /admin/api/maintenance/... enqueues (a executions row of type MAINTENANCE). */
export interface MaintenanceRequest {
  operation: MaintenanceOperation;
  tableOid: number;
  indexOid?: number | undefined;
  /** "schema.table" (or "schema.index") at the time it was queued - for display only; the OIDs are what runs. */
  label: string;
  /** Set for one table of a batch (Vacuum tables with dead rows, a selection, ...) - its executions share it. */
  batchId?: string | undefined;
}

export const MAINTENANCE_EXECUTION_TYPE = "MAINTENANCE";

/** Error code of a batch item an administrator stopped - its execution ends CANCELLED (Data_API.md §10.5). */
export const MAINTENANCE_CANCELLED = EXECUTION_CANCELLED;

export interface MaintenanceProgress {
  phase: string;
  /** 0-100, null while the phase has no measurable total. */
  percent: number | null;
}

/** One queued, running or finished maintenance action, as GET /admin/api/maintenance/runs lists them. */
export interface MaintenanceRun {
  id: string;
  operation: MaintenanceOperation;
  tableOid: number;
  indexOid: number | null;
  label: string;
  batchId: string | null;
  status: ExecutionRecord["status"];
  progress: MaintenanceProgress | null;
  error: string | null;
  queuedBy: string;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export type MaintenanceBatchItemStatus = "PENDING" | "RUNNING" | "DONE" | "FAILED" | "CANCELLED";

export interface MaintenanceBatchItem {
  id: string;
  tableOid: number;
  indexOid: number | null;
  label: string;
  status: MaintenanceBatchItemStatus;
  error: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface MaintenanceBatch {
  id: string;
  operation: MaintenanceOperation;
  active: boolean;
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  pending: number;
  current: { label: string; progress: MaintenanceProgress | null } | null;
  startedBy: string;
  createdAt: Date;
  items: MaintenanceBatchItem[];
}

const labelOf = (target: MaintenanceTarget) => `${target.schema}.${target.index?.name ?? target.table}`;

/** Every queuer of this instance takes it inside its transaction, so two batches started at once can't both find no batch running. */
const QUEUE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('totalbase_maintenance_queue'))`;

/** True while any batch of this instance is still pending or running - the "one batch at a time" rule, as PostgreSQL evaluates it. */
const ACTIVE_BATCH_SQL = `EXISTS (
  SELECT 1 FROM totalbase.executions
  WHERE type = $1 AND status IN ('PENDING', 'RUNNING') AND request ? 'batchId'
)`;

function itemStatus(execution: ExecutionRecord): MaintenanceBatchItemStatus {
  if (execution.status === "PENDING") return "PENDING";
  if (execution.status === "RUNNING") return "RUNNING";
  if (execution.status === "COMPLETED") return "DONE";
  return execution.status === "CANCELLED" ? "CANCELLED" : "FAILED";
}

export class MaintenanceService {
  private readonly executions: ExecutionsService;

  constructor(
    private readonly database: Database,
    private readonly settings: Pick<SettingsService, "get">,
  ) {
    this.executions = new ExecutionsService(database);
  }

  /** Resolves one target and refuses one TotalBase's role may not maintain - the admin hears why at once. */
  async resolveTarget(operation: MaintenanceOperation, tableOid: number, indexOid: number | undefined): Promise<MaintenanceTarget> {
    if (indexOid !== undefined && operation !== "REINDEX") throw new TotalBaseError("INVALID_QUERY", "Only reindex targets a single index.");
    const target = await resolveMaintenanceTarget(this.database, tableOid, indexOid);
    if (!target) throw new TotalBaseError("RESOURCE_NOT_FOUND", `No such table or index (OID ${indexOid ?? tableOid}).`);
    if (!target.canMaintain) {
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        `${target.schema}.${target.table} belongs to ${target.owner}. Only its owner can ${operation} it - or, on PostgreSQL 17+, a role granted MAINTAIN on it.`,
      );
    }
    return target;
  }

  /** Maintenance runs in the background executions worker - nothing queues while it is off. */
  private async assertEnabled(): Promise<void> {
    if (!(await this.settings.get("async_executions.enabled"))) {
      throw new TotalBaseError("ASYNC_EXECUTIONS_DISABLED", "Maintenance runs in the background executions worker, which is off (Settings > Async executions).");
    }
  }

  /**
   * Queues one operation on one resolved target, for `principal` (an
   * administrator's user id). One statement decides whether it may be
   * queued: not while a batch runs, and not while the same operation on
   * the same table is already pending or running - PostgreSQL evaluates
   * both against the rows as they are, never a prior SELECT. 409
   * MAINTENANCE_BATCH_RUNNING or MAINTENANCE_ALREADY_QUEUED when it refused.
   */
  async queue(operation: MaintenanceOperation, target: MaintenanceTarget, principal: string): Promise<MaintenanceRun> {
    await this.assertEnabled();
    const request: MaintenanceRequest = {
      operation,
      tableOid: target.tableOid,
      ...(target.index ? { indexOid: target.index.oid } : {}),
      label: labelOf(target),
    };
    const execution = await this.database.transaction(async (client) => {
      await client.query(QUEUE_LOCK_SQL);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO totalbase.executions (type, principal_type, principal, request)
         SELECT $1, 'USER', $2, $3::jsonb
         WHERE NOT ${ACTIVE_BATCH_SQL}
           AND NOT EXISTS (
             SELECT 1 FROM totalbase.executions
             WHERE type = $1 AND status IN ('PENDING', 'RUNNING')
               AND request->>'operation' = $4 AND (request->>'tableOid')::bigint = $5
           )
         RETURNING id`,
        [MAINTENANCE_EXECUTION_TYPE, principal, JSON.stringify(request), operation, target.tableOid],
      );
      if (!rows[0]) {
        // Refused: which rule, for the message - the insert already decided.
        if (await this.activeBatchId(client)) throw new TotalBaseError("MAINTENANCE_BATCH_RUNNING", "A maintenance batch is running - wait for it to finish, or stop it.");
        throw new TotalBaseError("MAINTENANCE_ALREADY_QUEUED", `A ${operation} of ${target.schema}.${target.table} is already queued or running.`);
      }
      return (await new ExecutionsService(client).get(rows[0].id))!;
    });
    return this.toRun(execution, null);
  }

  /**
   * Queues one operation over many resolved targets as one batch, run one
   * at a time by the maintenance worker. One INSERT ... SELECT writes every
   * item or none: its WHERE refuses the whole batch while another is still
   * pending or running (409 MAINTENANCE_BATCH_RUNNING).
   */
  async queueBatch(operation: MaintenanceOperation, targets: MaintenanceTarget[], principal: string): Promise<MaintenanceBatch> {
    await this.assertEnabled();
    const batchId = randomUUID();
    const requests: MaintenanceRequest[] = targets.map((target) => ({
      operation,
      tableOid: target.tableOid,
      ...(target.index ? { indexOid: target.index.oid } : {}),
      label: labelOf(target),
      batchId,
    }));
    await this.database.transaction(async (client) => {
      await client.query(QUEUE_LOCK_SQL);
      const { rowCount } = await client.query(
        `INSERT INTO totalbase.executions (type, principal_type, principal, request)
         SELECT $1, 'USER', $2, item.request
         FROM jsonb_array_elements($3::jsonb) WITH ORDINALITY AS item(request, ord)
         WHERE NOT ${ACTIVE_BATCH_SQL}
         ORDER BY item.ord`,
        [MAINTENANCE_EXECUTION_TYPE, principal, JSON.stringify(requests)],
      );
      if (rowCount === 0) throw new TotalBaseError("MAINTENANCE_BATCH_RUNNING", "A maintenance batch is running - wait for it to finish, or stop it.");
    });
    return this.loadBatch(batchId);
  }

  /** The last `limit` runs, newest first; a running one carries its progress from pg_stat_progress_*. */
  async listRuns(limit: number): Promise<MaintenanceRun[]> {
    const executions = await this.executions.listByType(MAINTENANCE_EXECUTION_TYPE, limit);
    const progress = executions.some((e) => e.status === "RUNNING") ? await this.readProgress() : new Map<number, MaintenanceProgress>();
    return executions.map((execution) => {
      const request = execution.request as MaintenanceRequest;
      return this.toRun(execution, execution.status === "RUNNING" ? (progress.get(request.tableOid) ?? null) : null);
    });
  }

  /** The batch still pending or running - at most one (queueBatch refuses a second). */
  async activeBatchId(on: Queryable = this.database): Promise<string | null> {
    const { rows } = await on.query<{ batch: string }>(
      `SELECT request->>'batchId' AS batch FROM totalbase.executions
       WHERE type = $1 AND status IN ('PENDING', 'RUNNING') AND request ? 'batchId'
       ORDER BY created_at LIMIT 1`,
      [MAINTENANCE_EXECUTION_TYPE],
    );
    return rows[0]?.batch ?? null;
  }

  /** A batch with its items and counts - RESOURCE_NOT_FOUND for an unknown id. */
  async loadBatch(batchId: string): Promise<MaintenanceBatch> {
    const executions = await this.executions.listByRequestValue(MAINTENANCE_EXECUTION_TYPE, "batchId", batchId);
    if (executions.length === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", "Batch not found.");
    const items: MaintenanceBatchItem[] = executions.map((execution) => {
      const request = execution.request as MaintenanceRequest;
      return {
        id: execution.id,
        tableOid: request.tableOid,
        indexOid: request.indexOid ?? null,
        label: request.label,
        status: itemStatus(execution),
        error: execution.error && execution.error.code !== MAINTENANCE_CANCELLED ? execution.error.message : null,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
      };
    });
    const count = (status: MaintenanceBatchItemStatus) => items.filter((item) => item.status === status).length;
    const runningItem = items.find((item) => item.status === "RUNNING");
    const progress = runningItem ? ((await this.readProgress()).get(runningItem.tableOid) ?? null) : null;
    const first = executions[0]!;
    return {
      id: batchId,
      operation: (first.request as MaintenanceRequest).operation,
      active: items.some((item) => item.status === "PENDING" || item.status === "RUNNING"),
      total: items.length,
      done: count("DONE"),
      failed: count("FAILED"),
      cancelled: count("CANCELLED"),
      pending: count("PENDING"),
      current: runningItem ? { label: runningItem.label, progress } : null,
      startedBy: first.principal,
      createdAt: first.createdAt,
      items,
    };
  }

  /**
   * Stops a batch: every item not started yet is cancelled, and a running
   * VACUUM or ANALYZE is cancelled too (pg_cancel_backend - safe, nothing
   * is left half done). A running REINDEX CONCURRENTLY is left to finish,
   * since cancelling it leaves an invalid index behind. RESOURCE_NOT_FOUND
   * for an unknown batch.
   */
  async stopBatch(batchId: string): Promise<MaintenanceBatch> {
    await this.loadBatch(batchId);
    await this.database.query(
      `UPDATE totalbase.executions
       SET status = 'CANCELLED', completed_at = now(), error = $3
       WHERE type = $1 AND request->>'batchId' = $2 AND status = 'PENDING'`,
      [MAINTENANCE_EXECUTION_TYPE, batchId, JSON.stringify({ code: MAINTENANCE_CANCELLED, message: "Stopped by an administrator." })],
    );
    const { rows: running } = await this.database.query<{ table_oid: string; operation: string }>(
      `SELECT request->>'tableOid' AS table_oid, request->>'operation' AS operation FROM totalbase.executions
       WHERE type = $1 AND request->>'batchId' = $2 AND status = 'RUNNING'`,
      [MAINTENANCE_EXECUTION_TYPE, batchId],
    );
    for (const row of running) {
      if (row.operation === "REINDEX") continue;
      await this.database.query(
        `SELECT pg_cancel_backend(pid) FROM (
           SELECT pid FROM pg_catalog.pg_stat_progress_vacuum WHERE relid = $1 AND datname = current_database()
           UNION SELECT pid FROM pg_catalog.pg_stat_progress_analyze WHERE relid = $1 AND datname = current_database()
         ) maintenance`,
        [Number(row.table_oid)],
      );
    }
    return this.loadBatch(batchId);
  }

  /** A stopped batch has at least one item cancelled - set by stopBatch. */
  async isBatchStopped(batchId: string): Promise<boolean> {
    const { rows } = await this.database.query(
      `SELECT 1 FROM totalbase.executions
       WHERE type = $1 AND request->>'batchId' = $2 AND status = 'CANCELLED'
       LIMIT 1`,
      [MAINTENANCE_EXECUTION_TYPE, batchId],
    );
    return rows.length > 0;
  }

  /**
   * What PostgreSQL itself reports about maintenance running right now in
   * this database, by table OID: VACUUM (pg_stat_progress_vacuum), ANALYZE
   * (pg_stat_progress_analyze, PostgreSQL 13+) and REINDEX CONCURRENTLY
   * (pg_stat_progress_create_index).
   */
  async readProgress(): Promise<Map<number, MaintenanceProgress>> {
    const { rows } = await this.database.query<{ relid: number; phase: string; done: string | null; total: string | null }>(
      `SELECT relid, phase, heap_blks_scanned AS done, heap_blks_total AS total FROM pg_catalog.pg_stat_progress_vacuum WHERE datname = current_database()
       UNION ALL
       SELECT relid, phase, sample_blks_scanned, sample_blks_total FROM pg_catalog.pg_stat_progress_analyze WHERE datname = current_database()
       UNION ALL
       SELECT relid, phase, blocks_done, blocks_total FROM pg_catalog.pg_stat_progress_create_index WHERE datname = current_database()`,
    );
    const progress = new Map<number, MaintenanceProgress>();
    for (const row of rows) {
      const total = Number(row.total ?? 0);
      progress.set(row.relid, { phase: row.phase, percent: total > 0 ? Math.min(100, Math.round((Number(row.done ?? 0) / total) * 100)) : null });
    }
    return progress;
  }

  private toRun(execution: ExecutionRecord, progress: MaintenanceProgress | null): MaintenanceRun {
    const request = execution.request as MaintenanceRequest;
    return {
      id: execution.id,
      operation: request.operation,
      tableOid: request.tableOid,
      indexOid: request.indexOid ?? null,
      label: request.label,
      batchId: request.batchId ?? null,
      status: execution.status,
      progress,
      error: execution.error?.message ?? null,
      queuedBy: execution.principal,
      createdAt: execution.createdAt,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
    };
  }
}
