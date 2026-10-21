import type { WorkflowEngineContext } from "./context.js";
import { resolveDataPrincipalForConfiguredUser } from "./context.js";
import { cronStartData, matchesCron, parseCronExpression, wallClockInZone } from "./cron.js";
import { recordSuppressedAdmission, runWorkflow } from "./engine.js";

interface DefinitionOperation {
  id: string;
  type: string;
  configuration: Record<string, unknown>;
}

/**
 * CRON admission (specs/Workflows.md §6.4): ticked
 * on a fixed interval (apps/server/src/index.ts) rather than computing and
 * sleeping until each workflow's own next occurrence - "Scheduler scans use
 * the database clock; on restart they compute only future occurrences and
 * never catch up past ones" is satisfied for free by only ever asking "does
 * *this* UTC minute match," never looking backward, so a restart just
 * resumes ticking with no catch-up logic to get wrong.
 *
 * `scheduledAt` is truncated to the current UTC minute once per tick and
 * reused for every workflow checked in that tick, so two workflows that
 * both fire in the same minute share one clock reading. Idempotent
 * admission (workers/restarts within the same minute must not double-fire)
 * is a claim against `workflows_crons` - see that
 * table's own migration comment on why it's a dedicated claim table
 * instead of a column on workflows_runs.
 */
export async function runCronTick(context: WorkflowEngineContext, options: { now?: Date } = {}): Promise<Promise<unknown>[]> {
  const scheduledAt = new Date(options.now ?? Date.now());
  scheduledAt.setUTCSeconds(0, 0);
  // The runs this tick admitted, still executing: the tick never waits for
  // them, so a long run neither delays other workflows' occurrences nor
  // the next tick (which then sees it RUNNING - §6.4.3's overlap rule).
  const admitted: Promise<unknown>[] = [];

  // Only the workflows whose live Start is a CRON (PostgreSQL filters the published JSON) - the tick is every 15 s.
  const candidates = await context.workflowsAdmin.listEnabledPublishedByStart({ trigger: "CRON" });
  for (const { workflow, definition } of candidates) {
    const start = ((definition.operations as DefinitionOperation[] | undefined) ?? []).find((op) => op.type === "totalbase.start");
    const config = start?.configuration ?? {};
    if (config.trigger !== "CRON") continue;

    const expression = config.cron_expression as string | undefined;
    const timezone = config.timezone as string | undefined;
    const executeAs = config.execute_as as string | undefined;
    if (!expression || !timezone || !executeAs) {
      context.logger.warn({ workflowId: workflow.id }, "CRON workflow is missing cron_expression/timezone/execute_as, skipping admission");
      continue;
    }

    let matches: boolean;
    try {
      matches = matchesCron(parseCronExpression(expression), wallClockInZone(scheduledAt, timezone));
    } catch (error) {
      context.logger.warn({ error, workflowId: workflow.id }, "CRON workflow has an invalid cron_expression/timezone, skipping admission");
      continue;
    }
    if (!matches) continue;

    const { rowCount } = await context.database.query(
      `INSERT INTO totalbase.workflows_crons (workflow, scheduled_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [workflow.id, scheduledAt],
    );
    if (rowCount === 0) continue; // already admitted this occurrence (another tick, or a restart within the same minute).

    const initiator = { type: "CRON", scheduledAt: scheduledAt.toISOString() };

    // Overlap (Workflows.md §6.4.3): while the previous
    // scheduled run is still running, this occurrence is skipped - not
    // queued - and recorded as a visible FAILED run like any suppressed
    // admission (§6.6), without counting toward auto-disable.
    const running = await context.workflowRuns.findRunningScheduledRun(workflow.id);
    if (running) {
      await recordSuppressedAdmission(
        context, workflow, definition,
        { trigger: "CRON", initiator },
        { code: "WORKFLOW_LIMIT_EXCEEDED", message: `Occurrence skipped: the previous scheduled run (${running}) is still running.` },
        { countsTowardAutoDisable: false },
      );
      continue;
    }

    // The configured execution user is revalidated at admission
    // (Workflows.md §7.2), never cached from when the
    // workflow was last saved.
    let executor;
    try {
      executor = await resolveDataPrincipalForConfiguredUser(context, executeAs);
    } catch (error) {
      context.logger.warn({ error, workflowId: workflow.id }, "CRON workflow's execute_as user could not be resolved, skipping admission");
      await recordSuppressedAdmission(
        context, workflow, definition,
        { trigger: "CRON", initiator },
        { code: "WORKFLOW_INVALID_DESIGN", message: `This workflow's execution user could not be resolved: ${error instanceof Error ? error.message : String(error)}` },
      );
      continue;
    }

    // Admission is the moment the run row exists (§8.1): wait for that, so
    // the next workflow's overlap check - and the next tick's - sees it.
    let admittedRun!: () => void;
    const isAdmitted = new Promise<void>((resolve) => { admittedRun = resolve; });
    const execution = runWorkflow(
      context,
      executor,
      workflow,
      workflow.publishedVersion!,
      definition,
      { trigger: "CRON", mode: "PRODUCTION", initiator },
      cronStartData(timezone, scheduledAt),
      { onAdmitted: () => admittedRun() },
    ).catch((error: unknown) => {
      context.logger.error({ error, workflowId: workflow.id }, "CRON workflow run failed");
    }).finally(() => admittedRun());
    await isAdmitted;
    admitted.push(execution);
  }
  return admitted;
}
