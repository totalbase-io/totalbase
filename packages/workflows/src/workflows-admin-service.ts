import { randomUUID } from "node:crypto";
import { deleteVersionsBefore, publishVersion, type Database, type VersionsTable } from "@totalbase/database";
import { remapUniqueViolation, TotalBaseError } from "@totalbase/errors";
import { slugify, validateDescription, validateName, validateSlug } from "@totalbase/shared";
import { validateDefinitionLimits } from "./execution/definition-limits.js";
import { validateWorkflowGraph } from "./execution/graph-validation.js";

/**
 * Workflows follow the unified versioning model (Specification.md §13):
 * the workflow row holds identity + the DRAFT `definition`; every published
 * version is an immutable row of workflows_versions, and the live
 * (running) one is always MAX(version) - going back to an old version (Restore, then Publish) creates a new one, so
 * "latest" and "live" never diverge.
 */
export interface WorkflowRecord {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  revision: string;
  historyEnabled: boolean;
  historyLevel: "SUMMARY" | "DETAILED";
  enabled: boolean;
  consecutiveFailures: number;
  /** Id of the live version row - what a production run references; null = never published. */
  publishedVersion: string | null;
  /** The live version's number; null = never published. */
  liveVersion: number | null;
  /** The draft differs from the live version (or there's none yet) - Specification.md §13.5. */
  hasUnpublishedChanges: boolean;
  createdAt: Date;
  updatedAt: Date;
  triggerType?: string | null;
}
export interface WorkflowDraft { workflow: WorkflowRecord; definition: Record<string, unknown>; }
export interface WorkflowVersionRecord { id: string; version: number; restoredFromVersion: number | null; user: string | null; publishedAt: Date; note: string | null; }
export interface WorkflowVersionSnapshot extends WorkflowVersionRecord { definition: Record<string, unknown>; }
/** One other workflow with a `totalbase.execute-workflow` step pointing at this one - `listCallers()`'s own doc comment covers what `live`/`draftPending` mean. */
export interface WorkflowCallerRecord { id: string; name: string; slug: string; live: boolean; draftPending: boolean }

interface Row {
  id: string; name: string; description: string | null; slug: string; revision: string; history_enabled: boolean; history_level: "SUMMARY" | "DETAILED";
  enabled: boolean; consecutive_failures: number; definition: Record<string, unknown>; published_version: string | null; live_version: number | null;
  has_unpublished_changes: boolean; created_at: Date; updated_at: Date; trigger_type?: string | null;
}
const toRecord = (row: Row): WorkflowRecord => ({
  id: row.id, name: row.name, description: row.description, slug: row.slug, revision: row.revision, historyEnabled: row.history_enabled,
  historyLevel: row.history_level, enabled: row.enabled, consecutiveFailures: row.consecutive_failures, publishedVersion: row.published_version,
  liveVersion: row.live_version, hasUnpublishedChanges: row.has_unpublished_changes, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(row.trigger_type !== undefined ? { triggerType: row.trigger_type } : {}),
});
interface VersionRow { id: string; version: number; restored_from_version: number | null; user: string | null; published_at: Date; note: string | null; }
const toVersionRecord = (row: VersionRow): WorkflowVersionRecord => ({
  id: row.id, version: row.version, restoredFromVersion: row.restored_from_version, user: row.user, publishedAt: row.published_at, note: row.note,
});
const VERSION_COLUMNS = `id, version, restored_from_version, "user", published_at, note`;
/** The versions table as `@totalbase/database`'s shared versioning helpers see it. */
const WORKFLOW_VERSIONS: VersionsTable = { table: "totalbase.workflows_versions", owner: "workflow", ownerTable: "totalbase.workflows", columns: VERSION_COLUMNS };

function mapUniqueViolation(error: unknown): never {
  return remapUniqueViolation(
    error,
    [{ constraint: "workflows_slug_unique", code: "WORKFLOW_SLUG_CONFLICT", message: "A workflow with this slug already exists." }],
    { code: "WORKFLOW_NAME_CONFLICT", message: "A workflow with this name already exists." },
  );
}

/**
 * Every workflow read goes through this: the row plus its live version
 * (LATERAL latest row) - `published_version`/`live_version`, the live
 * definition, and the draft-vs-live comparison (jsonb equality ignores
 * key order).
 */
const WORKFLOW_SELECT = `SELECT w.*, lv.id AS published_version, lv.version AS live_version, lv.definition_snapshot AS published_definition,
       (lv.id IS NULL OR lv.definition_snapshot <> w.definition) AS has_unpublished_changes
FROM totalbase.workflows w
LEFT JOIN LATERAL (
  SELECT v.id, v.version, v.definition_snapshot FROM totalbase.workflows_versions v
  WHERE v.workflow = w.id ORDER BY v.version DESC LIMIT 1
) lv ON true`;
// The Start node's configured `trigger`, from the draft - drives the sidebar's per-workflow icon (WorkflowsTree.vue).
const TRIGGER_TYPE_SELECT = `(SELECT op->'configuration'->>'trigger' FROM jsonb_array_elements(w.definition->'operations') op WHERE op->>'type' = 'totalbase.start' LIMIT 1) AS trigger_type`;
const startDefinition = (configuration: Record<string, unknown>) => ({ operations: [{ id: randomUUID(), type: "totalbase.start", configuration_version: 1, label: "Start", key: "start", configuration }], connections: [] });

/**
 * Design rules every saved draft must satisfy (Specification_Workflows.md
 * §3.3, §3.4, §3.6) - the definition limits first (they bound the work the
 * graph walk does), then the graph; never configuration completeness.
 */
function validateDefinition(definition: Record<string, unknown>): void {
  validateDefinitionLimits(definition);
  validateWorkflowGraph(definition);
}

/** What a data event is (Specification_Workflows.md §6.3.1): a table's row created, updated or deleted. */
const DATA_EVENTS = ["CREATE", "UPDATE", "DELETE"];
/** How long `hasEnabledPublishedDataEventStart()` trusts its last answer without an invalidation. */
const DATA_EVENT_START_CACHE_MS = 5_000;

export class WorkflowsAdminService {
  constructor(private readonly database: Database) {}

  /**
   * A DATA_EVENT Start that could never run is refused on save (M27): its resource a table - a view or a function
   * emits no data event (a function's EXECUTE comes later) - and its events among CREATE, UPDATE and DELETE.
   */
  private async assertDataEventStart(definition: Record<string, unknown>): Promise<void> {
    const operations = Array.isArray(definition.operations) ? (definition.operations as { type?: unknown; configuration?: Record<string, unknown> }[]) : [];
    const start = operations.find((op) => op.type === "totalbase.start");
    const configuration = start?.configuration ?? {};
    if (configuration.trigger !== "DATA_EVENT") return;
    const events = configuration.events;
    if (events !== undefined && events !== null) {
      const wrong = Array.isArray(events) ? events.filter((e) => typeof e !== "string" || !DATA_EVENTS.includes(e)) : [events];
      if (wrong.length) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Start (DATA_EVENT): events are ${DATA_EVENTS.join(", ")} - got ${wrong.map((e) => JSON.stringify(e)).join(", ")}.`);
    }
    const resource = configuration.resource;
    if (typeof resource !== "string" || !resource) return;
    const { rows } = await this.database.query<{ type: string; schema: string; name: string }>(
      `SELECT type, "schema", name FROM totalbase.resources WHERE id::text = $1`,
      [resource],
    );
    const found = rows[0];
    if (found && found.type !== "TABLE") {
      throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", `Start (DATA_EVENT): ${found.schema}.${found.name} is a ${found.type} - a data event comes from a TABLE (its rows created, updated or deleted).`);
    }
  }

  async list(): Promise<WorkflowRecord[]> {
    const { rows } = await this.database.query<Row>(`SELECT * FROM (${WORKFLOW_SELECT}) s, LATERAL (SELECT ${TRIGGER_TYPE_SELECT.replaceAll("w.definition", "s.definition")}) t ORDER BY s.name`);
    return rows.map(toRecord);
  }

  async get(id: string): Promise<WorkflowRecord> {
    const { rows } = await this.database.query<Row>(`${WORKFLOW_SELECT} WHERE w.id = $1`, [id]);
    if (!rows[0]) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "Workflow not found.");
    return toRecord(rows[0]);
  }

  /** Creates the workflow with a draft only - publishing is always explicit (Specification.md §13.1). */
  async create(input: { name: string; description?: string | null; slug?: string; historyEnabled?: boolean; historyLevel?: "SUMMARY" | "DETAILED"; startConfiguration?: Record<string, unknown>; definition?: Record<string, unknown> }): Promise<WorkflowRecord> {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const slug = validateSlug(input.slug?.trim() ? input.slug : slugify(name));
    const definition = input.definition ?? startDefinition(input.startConfiguration ?? { trigger: "MANUAL" });
    validateDefinition(definition);
    await this.assertDataEventStart(definition);
    try {
      const { rows } = await this.database.query<{ id: string }>(
        `INSERT INTO totalbase.workflows (name, description, slug, history_enabled, history_level, enabled, definition)
         VALUES ($1, $2, $3, $4, $5, false, $6::jsonb) RETURNING id`,
        [name, description, slug, input.historyEnabled ?? true, input.historyLevel ?? "SUMMARY", JSON.stringify(definition)],
      );
      return this.get(rows[0]!.id);
    } catch (error) {
      mapUniqueViolation(error);
    }
  }

  async update(id: string, input: { revision: string; name?: string; description?: string | null; slug?: string; historyEnabled?: boolean; historyLevel?: "SUMMARY" | "DETAILED"; enabled?: boolean }): Promise<WorkflowRecord> {
    const current = await this.get(id);
    if (current.revision !== input.revision) throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
    // Specification_Workflows.md §10.3: "Activating a workflow is allowed only when it has a
    // published version" - enabled with no version would accept trigger
    // admissions against nothing.
    if ((input.enabled ?? current.enabled) && !current.publishedVersion) {
      throw new TotalBaseError("WORKFLOW_NOT_ACTIVATABLE", "This workflow has no published version yet - publish it before enabling it.");
    }
    const name = input.name === undefined ? current.name : validateName(input.name);
    const description = input.description === undefined ? current.description : validateDescription(input.description);
    const slug = input.slug === undefined ? current.slug : validateSlug(input.slug);
    // A manual re-enable gives the workflow a fresh consecutive-failure
    // streak - recordRunOutcome() deliberately leaves the counter at its
    // tripped value when auto-disabling; this is the one place it's cleared.
    const resetFailureStreak = input.enabled === true && !current.enabled;
    let rowCount: number;
    try {
      ({ rowCount } = await this.database.query(
        `UPDATE totalbase.workflows SET name = $3, description = $4, slug = $5, history_enabled = $6, history_level = $7, enabled = $8,
           consecutive_failures = CASE WHEN $9 THEN 0 ELSE consecutive_failures END, revision = revision + 1, updated_at = now()
         WHERE id = $1 AND revision = $2`,
        [id, input.revision, name, description, slug, input.historyEnabled ?? current.historyEnabled, input.historyLevel ?? current.historyLevel, input.enabled ?? current.enabled, resetFailureStreak],
      ));
    } catch (error) {
      mapUniqueViolation(error);
    }
    if (rowCount === 0) throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
    this.forgetDataEventStartCache();
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const { rowCount } = await this.database.query(`DELETE FROM totalbase.workflows WHERE id = $1`, [id]);
    if (rowCount === 0) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "Workflow not found.");
    this.forgetDataEventStartCache();
  }

  /**
   * Called by engine.ts's runWorkflow() after a SUCCEEDED or FAILED run. One
   * atomic UPDATE: SUCCEEDED resets the streak; FAILED increments it and,
   * at `threshold` (`workflows.auto_disable_after_consecutive_failures`),
   * disables the workflow in the same statement. The counter is left at its
   * tripped value so the editor can tell "auto-disabled" from a manual
   * disable.
   */
  async recordRunOutcome(id: string, status: "SUCCEEDED" | "FAILED", threshold: number): Promise<void> {
    await this.database.query(
      `UPDATE totalbase.workflows
       SET consecutive_failures = CASE WHEN $2 = 'SUCCEEDED' THEN 0 ELSE consecutive_failures + 1 END,
           enabled = CASE WHEN $2 = 'FAILED' AND consecutive_failures + 1 >= $3 THEN false ELSE enabled END
       WHERE id = $1`,
      [id, status, threshold],
    );
    if (status === "FAILED") this.forgetDataEventStartCache(); // it may just have auto-disabled
  }

  /** The live version's definition - what production runs execute. `workflow.publishedVersion` is its id. */
  async getPublished(id: string): Promise<WorkflowDraft> {
    const { rows } = await this.database.query<Row & { published_definition: Record<string, unknown> | null }>(`${WORKFLOW_SELECT} WHERE w.id = $1`, [id]);
    const row = rows[0];
    if (!row) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "Workflow not found.");
    if (!row.published_definition) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "This workflow has no published version.");
    return { workflow: toRecord(row), definition: row.published_definition };
  }

  /**
   * Every workflow that can accept an automatic admission (Specification_Workflows.md §10.3:
   * published AND enabled) - the scan set the CRON/DATA_EVENT dispatchers
   * filter their own Start-configuration match against.
   */
  async listEnabledPublished(): Promise<WorkflowDraft[]> {
    const { rows } = await this.database.query<Row & { published_definition: Record<string, unknown> }>(
      `${WORKFLOW_SELECT} WHERE w.enabled = true AND lv.id IS NOT NULL`,
    );
    return rows.map((row) => ({ workflow: toRecord(row), definition: row.published_definition }));
  }

  /**
   * The enabled, published workflows whose LIVE Start node is of one kind -
   * a CRON, or a DATA_EVENT on one resource - decided by PostgreSQL over the
   * published definition's JSON (the draft's Start doesn't run), so a tick or
   * an outbox event loads only the definitions it can admit, not every
   * workflow's draft and live definition. The Start's finer matching (events,
   * filters, the cron expression) stays with the dispatcher.
   */
  async listEnabledPublishedByStart(start: { trigger: "CRON" } | { trigger: "DATA_EVENT"; resource: string }): Promise<WorkflowDraft[]> {
    const { rows } = await this.database.query<Row & { published_definition: Record<string, unknown> }>(
      `${WORKFLOW_SELECT}
       WHERE w.enabled = true AND lv.id IS NOT NULL
         AND EXISTS (SELECT 1 FROM jsonb_array_elements(lv.definition_snapshot->'operations') op
                     WHERE op->>'type' = 'totalbase.start' AND op->'configuration'->>'trigger' = $1
                       AND ($2::text IS NULL OR op->'configuration'->>'resource' = $2))`,
      [start.trigger, start.trigger === "DATA_EVENT" ? start.resource : null],
    );
    return rows.map((row) => ({ workflow: toRecord(row), definition: row.published_definition }));
  }

  /**
   * Whether any enabled, published workflow starts on a data event at all -
   * the DATA_EVENT dispatcher's short-circuit, asked once per outbox event
   * (every write produces events, most installations have few or no
   * DATA_EVENT workflows). One cheap EXISTS, remembered for a few seconds:
   * this service invalidates it whenever it changes what is live or enabled,
   * and the expiry covers a write it can't see (`enabled` flipped through
   * the Data API, or another process) within a few seconds.
   */
  async hasEnabledPublishedDataEventStart(): Promise<boolean> {
    const now = Date.now();
    if (this.dataEventStartCache && this.dataEventStartCache.expiresAt > now) return this.dataEventStartCache.value;
    const { rows } = await this.database.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM totalbase.workflows w
         JOIN LATERAL (SELECT v.definition_snapshot FROM totalbase.workflows_versions v WHERE v.workflow = w.id ORDER BY v.version DESC LIMIT 1) lv ON true
         WHERE w.enabled = true
           AND EXISTS (SELECT 1 FROM jsonb_array_elements(lv.definition_snapshot->'operations') op
                       WHERE op->>'type' = 'totalbase.start' AND op->'configuration'->>'trigger' = 'DATA_EVENT')
       ) AS exists`,
    );
    const value = rows[0]?.exists === true;
    this.dataEventStartCache = { value, expiresAt: now + DATA_EVENT_START_CACHE_MS };
    return value;
  }
  private dataEventStartCache: { value: boolean; expiresAt: number } | null = null;

  /** Something that decides which Starts are live changed (publish, enable/disable, delete, restore...): forget the short-circuit. */
  private forgetDataEventStartCache(): void {
    this.dataEventStartCache = null;
  }

  /** The WEBHOOK/run-by-slug lookup - same enabled+published gate, narrowed to one slug. */
  async getEnabledPublishedBySlug(slug: string): Promise<WorkflowDraft | undefined> {
    const { rows } = await this.database.query<Row & { published_definition: Record<string, unknown> }>(
      `${WORKFLOW_SELECT} WHERE w.enabled = true AND lv.id IS NOT NULL AND w.slug = $1`,
      [slug],
    );
    const row = rows[0];
    return row ? { workflow: toRecord(row), definition: row.published_definition } : undefined;
  }

  /** The draft - what the editor shows and what a test run executes. */
  async getDraft(id: string): Promise<WorkflowDraft> {
    const { rows } = await this.database.query<Row>(`${WORKFLOW_SELECT} WHERE w.id = $1`, [id]);
    if (!rows[0]) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "Workflow not found.");
    return { workflow: toRecord(rows[0]), definition: rows[0].definition };
  }

  /** Saves the draft (optimistic concurrency on `revision`). Versions are never touched here. */
  async saveDraft(id: string, revision: string, definition: Record<string, unknown>): Promise<WorkflowDraft> {
    validateDefinition(definition);
    await this.assertDataEventStart(definition);
    const { rowCount } = await this.database.query(
      `UPDATE totalbase.workflows SET definition = $3::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2`,
      [id, revision, JSON.stringify(definition)],
    );
    if (rowCount === 0) {
      await this.get(id); // 404 if it's gone, otherwise it's a conflict
      throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
    }
    return this.getDraft(id);
  }

  /**
   * Publishing (Specification_Workflows.md §10.2): a draft equal to the live
   * version is a no-op answering the workflow as it is (like DataViews and
   * Dashboards, Specification.md §13.4). Otherwise it re-checks the graph
   * rules, then execution readiness (the injected `validate`: which
   * operation types have a runtime handler), and snapshots the draft as the
   * next version. Does not enable the workflow; that's a separate PATCH.
   */
  async publish(id: string, revision: string, validate: (definition: Record<string, unknown>) => void | Promise<void>, userId: string | null = null, note: string | null = null): Promise<WorkflowRecord> {
    const { workflow, definition } = await this.getDraft(id);
    if (workflow.revision !== revision) throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
    if (!workflow.hasUnpublishedChanges) return workflow;
    validateDefinition(definition);
    await this.assertDataEventStart(definition);
    await validate(definition);
    // `@totalbase/database`'s `publishVersion` locks the workflow's row, then snapshots the validated definition
    // (MAX + 1, `restored_from_version` when it equals an older version); the revision bump inside the snapshot
    // callback is the editor's optimistic-concurrency check, under that same lock.
    await this.database.transaction((client) =>
      publishVersion(client, WORKFLOW_VERSIONS, id, userId, async () => {
        const { rowCount } = await client.query(
          `UPDATE totalbase.workflows SET revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2`,
          [id, revision],
        );
        if (rowCount === 0) throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
        return [{ column: "definition_snapshot", value: JSON.stringify(definition), cast: "jsonb" }];
      }, note),
    );
    this.forgetDataEventStartCache();
    return this.get(id);
  }

  /** Newest first, summary only. `id` is what a run references (Logs filter by it). */
  async listVersions(id: string): Promise<WorkflowVersionRecord[]> {
    await this.get(id);
    const { rows } = await this.database.query<VersionRow>(
      `SELECT ${VERSION_COLUMNS} FROM totalbase.workflows_versions WHERE workflow = $1 ORDER BY version DESC`,
      [id],
    );
    return rows.map(toVersionRecord);
  }

  /**
   * Deletes every version before `before` (Specification.md §13.4) - never the live (latest) one, so the next Publish stays latest + 1
   * and a number is never reused. A version deleted can't be restored.
   * One that still has runs in the history is kept and reported: a run's
   * foreign key to its version cascades, so deleting it would delete them.
   */
  async deleteVersionsBefore(id: string, before: number): Promise<{ deleted: number[]; kept: { version: number; runs: number }[] }> {
    await this.get(id);
    return this.database.transaction(async (client) => {
      const { rows: kept } = await client.query<{ version: number; runs: number }>(
        `SELECT v.version, count(r.id)::int AS runs
           FROM totalbase.workflows_versions v
           JOIN totalbase.workflows_runs r ON r.version = v.id
          WHERE v.workflow = $1 AND v.version < $2
          GROUP BY v.version ORDER BY v.version`,
        [id, before],
      );
      const deleted = await deleteVersionsBefore(client, WORKFLOW_VERSIONS, id, before, `NOT EXISTS (SELECT 1 FROM totalbase.workflows_runs r WHERE r.version = v.id)`);
      return { deleted, kept };
    });
  }

  /** One version's definition - the editor's read-only preview, and the source of Restore / Save as. */
  async getVersion(id: string, version: number): Promise<WorkflowVersionSnapshot> {
    const { rows } = await this.database.query<VersionRow & { definition_snapshot: Record<string, unknown> }>(
      `SELECT ${VERSION_COLUMNS}, definition_snapshot FROM totalbase.workflows_versions WHERE workflow = $1 AND version = $2`,
      [id, version],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("WORKFLOW_NOT_FOUND", "Workflow version not found.");
    return { ...toVersionRecord(row), definition: row.definition_snapshot };
  }

  /**
   * Restore (Specification.md §13.4): version `version`'s definition replaces the draft.
   * Publishes nothing - what runs stays the live version until publish(),
   * which records `restored_from_version` if the draft is still that
   * version's definition. The UI confirms first when the draft had
   * unpublished changes.
   */
  async restore(id: string, revision: string, version: number): Promise<WorkflowRecord> {
    const target = await this.getVersion(id, version);
    const { rowCount } = await this.database.query(
      `UPDATE totalbase.workflows SET definition = $3::jsonb, revision = revision + 1, updated_at = now() WHERE id = $1 AND revision = $2`,
      [id, revision, JSON.stringify(target.definition)],
    );
    if (rowCount === 0) throw new TotalBaseError("WORKFLOW_REVISION_CONFLICT", "Workflow was changed by another request.");
    return this.get(id);
  }

  /**
   * Save as (Specification.md §13.4): a NEW workflow whose draft is version `version`'s
   * definition - history settings copied, disabled, unpublished, and no
   * invoke-role grants (starts admin-only).
   */
  async duplicateVersion(id: string, version: number, input: { name: string; slug?: string | undefined }): Promise<WorkflowRecord> {
    const source = await this.get(id);
    const target = await this.getVersion(id, version);
    return this.create({
      name: input.name,
      ...(input.slug !== undefined ? { slug: input.slug } : {}),
      description: source.description,
      historyEnabled: source.historyEnabled,
      historyLevel: source.historyLevel,
      definition: target.definition,
    });
  }

  /**
   * The editor's "Called by" badge: every OTHER workflow with a
   * `totalbase.execute-workflow` step targeting this one. Static analysis
   * only - a caller through `/api/workflows/{slug}/run` leaves no trace in
   * any definition (the Logs sidebar's per-run `initiator` covers that).
   * `live` = the reference is in that caller's live version; `draftPending`
   * = only in its unpublished draft.
   */
  async listCallers(id: string): Promise<WorkflowCallerRecord[]> {
    await this.get(id); // 404 for an unknown workflow
    const { rows } = await this.database.query<{
      id: string; name: string; slug: string; definition: Record<string, unknown>; published_definition: Record<string, unknown> | null;
    }>(`${WORKFLOW_SELECT} WHERE w.id != $1`, [id]);
    const referencesTarget = (definition: Record<string, unknown> | null): boolean => {
      if (!definition) return false;
      const operations = (definition.operations as { type?: unknown; configuration?: { workflow?: unknown } }[] | undefined) ?? [];
      return operations.some((op) => op.type === "totalbase.execute-workflow" && op.configuration?.workflow === id);
    };
    const callers: WorkflowCallerRecord[] = [];
    for (const row of rows) {
      const inDraft = referencesTarget(row.definition);
      const inPublished = referencesTarget(row.published_definition);
      if (!inDraft && !inPublished) continue;
      callers.push({ id: row.id, name: row.name, slug: row.slug, live: inPublished, draftPending: inDraft && !inPublished });
    }
    return callers;
  }
}
