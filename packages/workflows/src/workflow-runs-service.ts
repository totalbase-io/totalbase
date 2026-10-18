import type { Database, DayZone } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

export type WorkflowRunTrigger = "MANUAL" | "DATA_EVENT" | "CRON" | "WEBHOOK";
export type WorkflowRunMode = "PRODUCTION" | "TEST";
export type WorkflowRunStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";
export type WorkflowRunStepStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "INTERRUPTED";

export interface WorkflowRunRecord {
  id: string;
  workflow: string;
  /** The version row it executed; null = a test run of the draft. */
  version: string | null;
  trigger: WorkflowRunTrigger;
  mode: WorkflowRunMode;
  status: WorkflowRunStatus;
  initiator: unknown;
  executor: unknown;
  result: unknown;
  error: unknown;
  /** The run followed at least one connected `error` output (Specification_Workflows.md §8.3) - it may still have SUCCEEDED. */
  hasHandledErrors: boolean;
  historyEnabled: boolean;
  historyLevel: "SUMMARY" | "DETAILED";
  startedAt: Date | null;
  finishedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface WorkflowRunStepRecord {
  id: string;
  run: string;
  operation: string;
  operationType: string;
  configurationVersion: number;
  sequence: number;
  predecessor: string | null;
  status: WorkflowRunStepStatus;
  selectedOutput: string | null;
  input: unknown;
  result: unknown;
  error: unknown;
  startedAt: Date;
  finishedAt: Date | null;
}

interface RunRow {
  id: string; workflow: string; version: string | null; trigger: WorkflowRunTrigger; mode: WorkflowRunMode; status: WorkflowRunStatus;
  initiator: unknown; executor: unknown; result: unknown; error: unknown; has_handled_errors: boolean;
  history_enabled: boolean; history_level: "SUMMARY" | "DETAILED";
  started_at: Date | null; finished_at: Date | null; expires_at: Date; created_at: Date;
}
interface StepRow {
  id: string; run: string; operation: string; operation_type: string; configuration_version: number; sequence: number;
  predecessor: string | null; status: WorkflowRunStepStatus; selected_output: string | null;
  input: unknown; result: unknown; error: unknown; started_at: Date; finished_at: Date | null;
}

const toRun = (row: RunRow): WorkflowRunRecord => ({
  id: row.id, workflow: row.workflow, version: row.version, trigger: row.trigger, mode: row.mode, status: row.status,
  initiator: row.initiator, executor: row.executor, result: row.result, error: row.error, hasHandledErrors: row.has_handled_errors,
  historyEnabled: row.history_enabled, historyLevel: row.history_level,
  startedAt: row.started_at, finishedAt: row.finished_at, expiresAt: row.expires_at, createdAt: row.created_at,
});
const toStep = (row: StepRow): WorkflowRunStepRecord => ({
  id: row.id, run: row.run, operation: row.operation, operationType: row.operation_type, configurationVersion: row.configuration_version,
  sequence: row.sequence, predecessor: row.predecessor, status: row.status, selectedOutput: row.selected_output,
  input: row.input, result: row.result, error: row.error, startedAt: row.started_at, finishedAt: row.finished_at,
});

/**
 * Persistence for workflows_runs/_steps - the runtime tables
 * (specs/Specification_Workflows.md §2, §8.3). Deliberately
 * has no control-flow logic of its own (no binding resolution, no graph
 * walking) - the execution engine (apps/server/src/workflow-execution/*,
 * which needs mutation-service.ts/query-engine/AppContext to actually run
 * operation handlers) calls this service purely to record what happened,
 * the same separation WorkflowsAdminService already has from the editor's
 * own tree logic.
 */
export class WorkflowRunsService {
  constructor(private readonly database: Database) {}

  async createRun(input: {
    workflow: string; version: string | null; trigger: WorkflowRunTrigger; mode: WorkflowRunMode;
    initiator: unknown; executor: unknown; historyEnabled: boolean; historyLevel: "SUMMARY" | "DETAILED"; expiresAt: Date;
  }): Promise<WorkflowRunRecord> {
    const { rows } = await this.database.query<RunRow>(
      `INSERT INTO totalbase.workflows_runs
         (workflow, version, trigger, mode, status, initiator, executor, history_enabled, history_level, started_at, expires_at)
       VALUES ($1, $2, $3, $4, 'RUNNING', $5::jsonb, $6::jsonb, $7, $8, now(), $9)
       RETURNING *`,
      [input.workflow, input.version, input.trigger, input.mode, JSON.stringify(input.initiator), JSON.stringify(input.executor), input.historyEnabled, input.historyLevel, input.expiresAt],
    );
    return toRun(rows[0]!);
  }

  /**
   * Creates a DATA_EVENT run only if its admission claim is new
   * (Specification_Workflows.md §6.3.5): one statement inserts the claim
   * into `outbox_admissions` (ON CONFLICT DO NOTHING) and the run
   * only when the claim was inserted, so PostgreSQL decides atomically -
   * a retried outbox event, or two dispatchers racing over one, never
   * admit the same (event, workflow, item) twice. Null when it already was.
   */
  async createRunForOutboxEvent(
    input: Parameters<WorkflowRunsService["createRun"]>[0],
    claim: { event: string; item: number | null },
  ): Promise<WorkflowRunRecord | null> {
    const { rows } = await this.database.query<RunRow>(
      `WITH claim AS (
         INSERT INTO totalbase.outbox_admissions (event, workflow, item)
         VALUES ($10::uuid, $1::uuid, $11::integer)
         ON CONFLICT DO NOTHING
         RETURNING id
       )
       INSERT INTO totalbase.workflows_runs
         (workflow, version, trigger, mode, status, initiator, executor, history_enabled, history_level, started_at, expires_at)
       SELECT $1::uuid, $2::uuid, $3::text, $4::text, 'RUNNING', $5::jsonb, $6::jsonb, $7::boolean, $8::text, now(), $9::timestamptz FROM claim
       RETURNING *`,
      [input.workflow, input.version, input.trigger, input.mode, JSON.stringify(input.initiator), JSON.stringify(input.executor), input.historyEnabled, input.historyLevel, input.expiresAt, claim.event, claim.item],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /**
   * Finishes a run that is still RUNNING - conditional, so the engine and
   * the hourly recovery (`reclaimExpired`) never overwrite each other's
   * terminal status: whichever lands first wins. Returns false when the run
   * had already left RUNNING (e.g. recovery marked it INTERRUPTED).
   */
  async finishRun(id: string, input: { status: WorkflowRunStatus; result?: unknown; error?: unknown; hasHandledErrors?: boolean }): Promise<boolean> {
    // A step still RUNNING when its run ends (the engine threw past it) ends the way the run does - a SUCCEEDED run has none.
    const { rows } = await this.database.query<{ id: string }>(
      `WITH finished AS (
         UPDATE totalbase.workflows_runs
         SET status = $2, result = $3::jsonb, error = $4::jsonb, has_handled_errors = $5, finished_at = now()
         WHERE id = $1 AND status = 'RUNNING'
         RETURNING id
       ), steps AS (
         UPDATE totalbase.workflows_steps s
         SET status = CASE WHEN $2 IN ('CANCELLED', 'INTERRUPTED') THEN $2 ELSE 'FAILED' END, error = $4::jsonb, finished_at = now()
         FROM finished WHERE s.run = finished.id AND s.status = 'RUNNING'
       )
       SELECT id FROM finished`,
      [id, input.status, input.result !== undefined ? JSON.stringify(input.result) : null, input.error !== undefined ? JSON.stringify(input.error) : null, input.hasHandledErrors ?? false],
    );
    return rows.length > 0;
  }

  /**
   * The newest scheduled run of a CRON workflow still RUNNING within its
   * deadline (Specification_Workflows.md §6.4.3) - an occurrence is skipped
   * while one exists. On-demand runs of the same workflow (initiator a
   * person, not the schedule) and runs past their deadline (a dead process,
   * left for recovery) do not count.
   */
  async findRunningScheduledRun(workflowId: string): Promise<string | undefined> {
    const { rows } = await this.database.query<{ id: string }>(
      `SELECT id FROM totalbase.workflows_runs
       WHERE workflow = $1 AND trigger = 'CRON' AND status = 'RUNNING' AND initiator ->> 'type' = 'CRON' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1`,
      [workflowId],
    );
    return rows[0]?.id;
  }

  /**
   * A CRON workflow's last scheduled occurrence (Specification_Workflows.md
   * §6.4.3): the newest occurrence claim, or the newest scheduled run's
   * `scheduledAt` - whichever is later, since claims are purged after 2
   * days and runs per the history policy. Null when neither remains.
   */
  async lastScheduledOccurrence(workflowId: string): Promise<Date | null> {
    const { rows } = await this.database.query<{ last: Date | null }>(
      `SELECT GREATEST(
         (SELECT max(scheduled_at) FROM totalbase.workflows_crons WHERE workflow = $1),
         (SELECT max((initiator ->> 'scheduledAt')::timestamptz) FROM totalbase.workflows_runs
           WHERE workflow = $1 AND trigger = 'CRON' AND initiator ->> 'type' = 'CRON')
       ) AS last`,
      [workflowId],
    );
    return rows[0]?.last ?? null;
  }

  /** Runs that finished FAILED since `since` - the dashboard's "needs attention". */
  async countFailedSince(since: Date): Promise<number> {
    const { rows } = await this.database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM totalbase.workflows_runs WHERE status = 'FAILED' AND finished_at >= $1`,
      [since],
    );
    return rows[0]!.count;
  }

  /**
   * Finished runs per day over the last `days` days (today included), in
   * `zone` - succeeded and failed, zeros included, oldest first. Bounded by
   * finished_at, which the summary retention keeps for 30 days by default.
   */
  async countFinishedPerDay(days: number, zone: DayZone): Promise<Array<{ day: string; succeeded: number; failed: number }>> {
    const at = `$2::${zone.cast}`;
    const { rows } = await this.database.query<{ day: string; succeeded: number; failed: number }>(
      `WITH days AS (
         SELECT generate_series((now() AT TIME ZONE ${at})::date - ($1::int - 1), (now() AT TIME ZONE ${at})::date, interval '1 day')::date AS day
       ), counted AS (
         SELECT (finished_at AT TIME ZONE ${at})::date AS day,
                count(*) FILTER (WHERE status = 'SUCCEEDED')::int AS succeeded,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed
         FROM totalbase.workflows_runs
         WHERE finished_at >= date_trunc('day', now() AT TIME ZONE ${at}) AT TIME ZONE ${at} - make_interval(days => $1::int - 1)
           AND status IN ('SUCCEEDED', 'FAILED')
         GROUP BY 1
       )
       SELECT to_char(d.day, 'YYYY-MM-DD') AS day, coalesce(c.succeeded, 0) AS succeeded, coalesce(c.failed, 0) AS failed
       FROM days d LEFT JOIN counted c USING (day) ORDER BY d.day`,
      [days, zone.value],
    );
    return rows;
  }

  async getRun(id: string): Promise<WorkflowRunRecord> {
    const { rows } = await this.database.query<RunRow>(`SELECT * FROM totalbase.workflows_runs WHERE id = $1`, [id]);
    if (!rows[0]) throw new TotalBaseError("WORKFLOW_RUN_NOT_FOUND", "Workflow run not found.");
    return toRun(rows[0]);
  }

  /**
   * Paginated run history for the editor's own "Logs" sidebar - newest
   * first, optionally narrowed to one published VERSION row's id (the
   * same id `startedAt`/`workflows_runs.version` already
   * stores per run) when the caller has a specific version selected in
   * the Versions menu. 15-per-page is a UI choice (WorkflowLogsSlideover.
   * vue), not a registry setting - unlike `workflows.max_*` limits, this
   * is display pagination, not an execution guard.
   */
  /** A workflow's runs, newest first, narrowed by version, status, trigger, mode and when they started (§16.3). */
  async listRuns(
    workflowId: string,
    options: { version?: string; status?: WorkflowRunStatus; trigger?: WorkflowRunTrigger; mode?: WorkflowRunMode; from?: Date; to?: Date; page?: number; pageSize?: number } = {},
  ): Promise<{ runs: WorkflowRunRecord[]; total: number }> {
    const page = Math.max(1, options.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, options.pageSize ?? 15));
    const offset = (page - 1) * pageSize;
    const filterParams: unknown[] = [workflowId];
    let where = `workflow = $1`;
    const narrow = (clause: string, value: unknown) => {
      filterParams.push(value);
      where += ` AND ${clause.replace("?", `$${filterParams.length}`)}`;
    };
    if (options.version) narrow("version = ?", options.version);
    if (options.status) narrow("status = ?", options.status);
    if (options.trigger) narrow("trigger = ?", options.trigger);
    if (options.mode) narrow("mode = ?", options.mode);
    if (options.from) narrow("coalesce(started_at, created_at) >= ?", options.from);
    if (options.to) narrow("coalesce(started_at, created_at) < ?", options.to);
    const [{ rows }, { rows: countRows }] = await Promise.all([
      this.database.query<RunRow>(
        `SELECT * FROM totalbase.workflows_runs WHERE ${where} ORDER BY started_at DESC NULLS LAST, created_at DESC LIMIT $${filterParams.length + 1} OFFSET $${filterParams.length + 2}`,
        [...filterParams, pageSize, offset],
      ),
      this.database.query<{ count: string }>(`SELECT count(*) FROM totalbase.workflows_runs WHERE ${where}`, filterParams),
    ]);
    return { runs: rows.map(toRun), total: Number(countRows[0]!.count) };
  }

  async insertStep(input: {
    run: string; operation: string; operationType: string; configurationVersion: number; sequence: number;
    predecessor: string | null; input: unknown;
  }): Promise<WorkflowRunStepRecord> {
    const { rows } = await this.database.query<StepRow>(
      `INSERT INTO totalbase.workflows_steps
         (run, operation, operation_type, configuration_version, sequence, predecessor, status, input)
       VALUES ($1, $2, $3, $4, $5, $6, 'RUNNING', $7::jsonb)
       RETURNING *`,
      [input.run, input.operation, input.operationType, input.configurationVersion, input.sequence, input.predecessor, JSON.stringify(input.input ?? null)],
    );
    return toStep(rows[0]!);
  }

  async finishStep(id: string, input: { status: WorkflowRunStepStatus; selectedOutput: string | null; result?: unknown; error?: unknown }): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.workflows_steps
       SET status = $2, selected_output = $3, result = $4::jsonb, error = $5::jsonb, finished_at = now()
       WHERE id = $1 AND status = 'RUNNING'`,
      [id, input.status, input.selectedOutput, input.result !== undefined ? JSON.stringify(input.result) : null, input.error !== undefined ? JSON.stringify(input.error) : null],
    );
  }

  async listSteps(runId: string): Promise<WorkflowRunStepRecord[]> {
    const { rows } = await this.database.query<StepRow>(
      `SELECT * FROM totalbase.workflows_steps WHERE run = $1 ORDER BY sequence ASC`,
      [runId],
    );
    return rows.map(toStep);
  }

  /**
   * Fail-closed crash recovery (specs/Specification_Workflows.md §8.6):
   * a run/step still PENDING/RUNNING past its own
   * `expires_at` deadline means the process that was executing it died
   * (today's engine is purely synchronous - nothing else ever leaves a
   * run RUNNING once its own HTTP request returns) - marked INTERRUPTED,
   * never auto-retried/resumed (side effects may already have happened).
   */
  async reclaimExpired(): Promise<{ runs: number; steps: number }> {
    const { rows } = await this.database.query<{ id: string }>(
      `UPDATE totalbase.workflows_runs
       SET status = 'INTERRUPTED', finished_at = now()
       WHERE status IN ('PENDING', 'RUNNING') AND expires_at < now()
       RETURNING id`,
    );
    if (rows.length === 0) return { runs: 0, steps: 0 };
    const { rowCount } = await this.database.query(
      `UPDATE totalbase.workflows_steps
       SET status = 'INTERRUPTED', finished_at = now()
       WHERE run = ANY($1) AND status = 'RUNNING'`,
      [rows.map((r) => r.id)],
    );
    return { runs: rows.length, steps: rowCount };
  }

  /**
   * History retention (Specification_Workflows.md §9.4): a disabled-history run's whole row
   * is purged 24h after it finishes regardless of level; an enabled-
   * history run is purged after its own level's retention window
   * (SUMMARY/DETAILED have independently configured days - DETAILED's
   * default window is deliberately shorter since it carries payloads).
   * Steps cascade via their own FK's ON DELETE CASCADE.
   */
  async purgeFinished(cutoffs: { disabledHistory: Date; summary: Date; detailed: Date }): Promise<number> {
    const { rowCount } = await this.database.query(
      `DELETE FROM totalbase.workflows_runs
       WHERE status IN ('SUCCEEDED', 'FAILED', 'CANCELLED', 'INTERRUPTED')
         AND (
           (history_enabled = false AND finished_at < $1)
           OR (history_enabled = true AND history_level = 'SUMMARY' AND finished_at < $2)
           OR (history_enabled = true AND history_level = 'DETAILED' AND finished_at < $3)
         )`,
      [cutoffs.disabledHistory, cutoffs.summary, cutoffs.detailed],
    );
    return rowCount;
  }
}
