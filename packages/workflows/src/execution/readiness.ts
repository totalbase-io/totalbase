import { TotalBaseError } from "@totalbase/errors";
import type { WorkflowEngineContext } from "./context.js";
import { operationDefinition, missingConfiguration } from "@totalbase/tb-catalog";
import { assertWhereRequirement, OPERATION_HANDLERS } from "./handlers.js";
import { parseCronExpression, wallClockInZone } from "./cron.js";
import { resolveWorkflowResource } from "./resource-resolution.js";
import { parseFilter } from "@totalbase/query-engine";

interface DefinitionOperation {
  id: string;
  type: string;
  key?: string;
  configuration?: Record<string, unknown>;
}
interface DefinitionConnection {
  source: string;
  target: string;
  output?: string;
}

/** A configuration value that is set: a non-empty string, a list, an object, a number or a boolean. */
function present(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  return true;
}

const TEMPLATE_ROOT = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * Publish-time execution readiness (Specification_Workflows.md §3.5, §10.2):
 * a stricter gate than a draft save's (which only wants a well-shaped graph
 * with exactly one Start). Every issue is collected and reported at once
 * (`WORKFLOW_NOT_PUBLISHABLE`, one line each), so the author fixes them in
 * one pass rather than publish by publish:
 *
 * - an operation type the catalog doesn't have, or with no runtime handler;
 * - a step's required configuration missing (the catalog's `required`);
 * - Update/Delete records without a `where` while the Data API requires one;
 * - a table, view or function it names that no longer exists (or isn't one);
 * - a secret its headers name that Settings > Secrets doesn't hold;
 * - a `{{key...}}` template naming a step that doesn't run before it;
 * - a For each / Process in batches with no body connected;
 * - a connection to an operation that no longer exists.
 *
 * Draft saves stay permissive; a stored resource reference is never rewritten
 * by name.
 */
export async function validateExecutionReadiness(definition: Record<string, unknown>, context: Pick<WorkflowEngineContext, "settings" | "database">): Promise<void> {
  const operations = (definition.operations as DefinitionOperation[] | undefined) ?? [];
  const connections = (definition.connections as DefinitionConnection[] | undefined) ?? [];
  const opIds = new Set(operations.map((op) => op.id));
  const issues: string[] = [];
  const label = (op: DefinitionOperation) => `Step "${op.key ?? op.id}"`;

  for (const connection of connections) {
    if (!opIds.has(connection.source) || !opIds.has(connection.target)) {
      issues.push("A connection references an operation that no longer exists.");
      break;
    }
  }

  // The steps that run before each one: its ancestors along the connections.
  const parents = new Map<string, string[]>();
  for (const c of connections) parents.set(c.target, [...(parents.get(c.target) ?? []), c.source]);
  const keyById = new Map(operations.map((op) => [op.id, op.key]));
  const typeById = new Map(operations.map((op) => [op.id, op.type]));
  /** A loop's body - every step reached from its `item`/`batch` output; a step after the loop may read them. */
  const bodyOf = (loopId: string): string[] => {
    const body: string[] = [];
    const bodyOutput = operationDefinition(typeById.get(loopId) ?? "")?.bodyOutput;
    const queue = connections.filter((c) => c.source === loopId && c.output === bodyOutput).map((c) => c.target);
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (body.includes(next)) continue;
      body.push(next);
      queue.push(...connections.filter((c) => c.source === next).map((c) => c.target));
    }
    return body;
  };
  const ancestorKeys = (id: string): Set<string> => {
    const seen = new Set<string>();
    const keys = new Set<string>();
    const queue = [...(parents.get(id) ?? [])];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const key = keyById.get(next);
      if (key) keys.add(key);
      queue.push(...(parents.get(next) ?? []));
      if (operationDefinition(typeById.get(next) ?? "")?.bodyOutput) queue.push(...bodyOf(next).filter((b) => b !== id));
    }
    return keys;
  };
  const stepKeys = new Set(operations.map((op) => op.key).filter((k): k is string => !!k));

  for (const op of operations) {
    const configuration = op.configuration ?? {};
    const definition = operationDefinition(op.type);
    if (definition?.bodyOutput) {
      if (!connections.some((c) => c.source === op.id && c.output === definition.bodyOutput)) issues.push(`${label(op)}: its loop has no body connected.`);
      continue;
    }
    if (op.type === "totalbase.start") {
      // A DATA_EVENT Start's own filters (§6.3.1) - the one filter grammar.
      if (configuration.trigger === "DATA_EVENT") {
        const [maxFilterDepth, maxRelationDepth] = await Promise.all([context.settings.get("api.max_filter_depth"), context.settings.get("api.max_relation_depth")]);
        for (const [key, name] of [["filter", "filter"], ["old_filter", "filter on the row before"]] as const) {
          const raw = configuration[key];
          if (raw === undefined || raw === null || (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0)) continue;
          try {
            parseFilter(raw as Record<string, unknown>, { maxFilterDepth, maxRelationDepth }, 0);
          } catch (error) {
            issues.push(`${label(op)}: its ${name} is invalid - ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (configuration.for_each !== undefined && configuration.for_each !== "ROW" && configuration.for_each !== "STATEMENT") issues.push(`${label(op)}: For each must be ROW or STATEMENT.`);
      }
      // A Schedule the dispatcher would skip on every tick (cron-dispatcher.ts): refused now instead.
      if (configuration.trigger === "CRON") issues.push(...(await scheduleIssues(configuration, context)).map((issue) => `${label(op)}: ${issue}`));
      continue;
    }
    if (!definition || !OPERATION_HANDLERS[op.type]) {
      issues.push(`Operation type "${op.type}" has no execution handler yet and cannot be published.`);
      continue;
    }
    for (const missing of missingConfiguration(op.type, configuration)) issues.push(`${label(op)}: ${missing}.`);
    try {
      await assertWhereRequirement(context, op.type, configuration);
    } catch (error) {
      issues.push(`${label(op)}: ${error instanceof Error ? error.message : String(error)}`);
    }

    // A resource it names still there, and of a kind it takes.
    const resourceId = definition.resource ? configuration[definition.resource.field] : undefined;
    if (definition.resource && typeof resourceId === "string" && resourceId) {
      try {
        await resolveWorkflowResource(context as WorkflowEngineContext, resourceId, definition.resource.types);
      } catch {
        issues.push(`${label(op)}: the ${definition.resource.noun} it names no longer exists.`);
      }
    }

    // The secrets its headers name exist (Settings > Secrets) - else its first run would be the one to find out.
    const secretKeys = (Array.isArray(configuration.secretHeaders) ? configuration.secretHeaders as Array<{ secret?: unknown }> : [])
      .map((entry) => entry?.secret).filter((key): key is string => typeof key === "string" && key !== "");
    if (secretKeys.length > 0) {
      const { rows } = await context.database.query<{ key: string }>(`SELECT key FROM totalbase.secrets WHERE key = ANY($1::text[])`, [secretKeys]);
      const found = new Set(rows.map((row) => row.key));
      for (const key of new Set(secretKeys)) if (!found.has(key)) issues.push(`${label(op)}: no secret "${key}" in Settings > Secrets.`);
    }

    // Templates name steps that run before this one (`item` and `error` are the engine's own).
    if (definition.templates === "configuration") {
      const before = ancestorKeys(op.id);
      const roots = new Set([...JSON.stringify(configuration).matchAll(TEMPLATE_ROOT)].map((m) => m[1]!));
      for (const root of roots) {
        if (root === "item" || root === "error" || before.has(root)) continue;
        issues.push(stepKeys.has(root)
          ? `${label(op)}: {{${root}...}} names a step that doesn't run before it.`
          : `${label(op)}: {{${root}...}} names no step.`);
      }
    }
  }

  if (issues.length > 0) throw new TotalBaseError("WORKFLOW_NOT_PUBLISHABLE", issues.join("\n"));
}

/** What a Schedule start can't run without: a valid expression, a known time zone, an active "Execute as" user. */
async function scheduleIssues(configuration: Record<string, unknown>, context: Pick<WorkflowEngineContext, "database">): Promise<string[]> {
  const issues: string[] = [];
  const expression = configuration.cron_expression;
  if (!present(expression)) issues.push("no schedule expression.");
  else {
    try {
      parseCronExpression(String(expression));
    } catch (error) {
      issues.push(`its schedule is invalid - ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const timezone = configuration.timezone;
  if (!present(timezone)) issues.push("no time zone.");
  else {
    try {
      wallClockInZone(new Date(), String(timezone));
    } catch {
      issues.push(`unknown time zone "${String(timezone)}".`);
    }
  }
  const executeAs = configuration.execute_as;
  if (!present(executeAs)) issues.push("no \"Execute as\" user.");
  else {
    const { rows } = await context.database.query<{ active: boolean }>(
      `SELECT active FROM totalbase.users WHERE id::text = $1`,
      [String(executeAs)],
    );
    if (!rows[0]?.active) issues.push("its \"Execute as\" user no longer exists or is inactive.");
  }
  return issues;
}
