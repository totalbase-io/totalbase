import type { Queryable } from "@totalbase/database";

export type ExecutionStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
export type ExecutionPrincipalType = "USER" | "API_KEY";

export interface ExecutionError {
  code: string;
  status?: number;
  message: string;
}

export interface ExecutionRecord {
  id: string;
  type: string;
  resource: string | null;
  status: ExecutionStatus;
  principalType: ExecutionPrincipalType;
  principal: string;
  request: unknown;
  result: unknown;
  error: ExecutionError | null;
  attempt: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

export interface CreateExecutionInput {
  type: string;
  resource?: string | undefined;
  principalType: ExecutionPrincipalType;
  principal: string;
  /** Must never contain secrets/credentials/tokens (Data_API.md §10.1). */
  request?: unknown;
}

interface ExecutionRow {
  id: string;
  type: string;
  resource: string | null;
  status: ExecutionStatus;
  principal_type: ExecutionPrincipalType;
  principal: string;
  request: unknown;
  result: unknown;
  error: ExecutionError | null;
  attempt: number;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

function toRecord(row: ExecutionRow): ExecutionRecord {
  return {
    id: row.id,
    type: row.type,
    resource: row.resource,
    status: row.status,
    principalType: row.principal_type,
    principal: row.principal,
    request: row.request,
    result: row.result,
    error: row.error,
    attempt: row.attempt,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

const SELECT_COLUMNS = `id, type, resource, status, principal_type, principal, request, result, error, attempt, created_at, started_at, completed_at`;

/**
 * CRUD side of Executions (Data_API.md §10).
 * Claiming/processing pending rows is ExecutionsWorker's job, not this
 * service's - same separation as WebhooksService (CRUD) vs OutboxConsumer
 * (delivery).
 */
export class ExecutionsService {
  constructor(private readonly database: Queryable) {}

  async create(input: CreateExecutionInput): Promise<ExecutionRecord> {
    const { rows } = await this.database.query<ExecutionRow>(
      `INSERT INTO totalbase.executions (type, resource, principal_type, principal, request)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING ${SELECT_COLUMNS}`,
      [input.type, input.resource ?? null, input.principalType, input.principal, JSON.stringify(input.request ?? null)],
    );
    return toRecord(rows[0]!);
  }

  async get(id: string): Promise<ExecutionRecord | undefined> {
    const { rows } = await this.database.query<ExecutionRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.executions WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  /**
   * "Still running": renews a running execution's lock so
   * ExecutionsWorker.reclaimStale() doesn't take it for a crashed one.
   * For executors that may legitimately outlast async_executions.stale_timeout_ms.
   */
  async heartbeat(id: string): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.executions SET locked_at = now() WHERE id = $1 AND status = 'RUNNING'`,
      [id],
    );
  }

  /**
   * The latest executions of one type, newest first - for an admin-only
   * surface that owns that type (e.g. MAINTENANCE, Settings > Maintenance).
   * Never behind a Data API route: callers there only see their own
   * (belongsTo, Data_API.md §10.3).
   */
  async listByType(type: string, limit: number): Promise<ExecutionRecord[]> {
    const { rows } = await this.database.query<ExecutionRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.executions WHERE type = $1 ORDER BY created_at DESC LIMIT $2`,
      [type, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Every execution of one type whose request carries `key` = `value`
   * (e.g. a maintenance batch's batchId), oldest first - one query for a
   * whole group. Admin-only surfaces, like listByType().
   */
  async listByRequestValue(type: string, key: string, value: string): Promise<ExecutionRecord[]> {
    const { rows } = await this.database.query<ExecutionRow>(
      `SELECT ${SELECT_COLUMNS} FROM totalbase.executions
       WHERE type = $1 AND request->>$2 = $3 ORDER BY created_at, id`,
      [type, key, value],
    );
    return rows.map(toRecord);
  }

  /** The principal that created an execution may query it; no unrestricted list (Data_API.md §10.3). */
  belongsTo(execution: Pick<ExecutionRecord, "principalType" | "principal">, principalType: string, principal: string): boolean {
    return execution.principalType === principalType && execution.principal === principal;
  }
}
