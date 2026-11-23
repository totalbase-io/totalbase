import { TotalBaseError } from "@totalbase/errors";
import type { WorkflowEngineContext } from "./context.js";
import { operationDefinition, missingConfiguration } from "@totalbase/tb-catalog";
import { assertWhereRequirement, OPERATION_HANDLERS } from "./handlers.js";
import { parseCronExpression, wallClockInZone } from "./cron.js";
import { resolveWorkflowResource } from "./resource-resolution.js";
import { assertFilterPathsResolve, filterFieldPaths, parseFilter, parseQuery, type FilterNode } from "@totalbase/query-engine";

/** Whether a parsed filter names $USER.* or $PERIOD.* anywhere - a value or an item of a list (`_in: "a,$USER.id"`). */
function usesSessionVariable(node: FilterNode): boolean {
  if (node.type === "and" || node.type === "or" || node.type === "not") return node.children.some(usesSessionVariable);
  const value = (node as { value?: unknown }).value;
  const isSession = (v: unknown) => typeof v === "object" && v !== null && ["user", "period"].includes((v as { kind?: string }).kind ?? "");
  return Array.isArray(value) ? value.some(isSession) : isSession(value);
}

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
 * Publish-time execution readiness (Workflows.md §3.5, §10.2):
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
  const idByKey = new Map(operations.filter((op) => op.key).map((op) => [op.key!, op.id]));
  /** Whether `target` is reached from `from` through the given first connections, then any. */
  const reaches = (first: DefinitionConnection[], target: string): boolean => {
    const seen = new Set<string>();
    const queue = first.map((c) => c.target);
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (next === target) return true;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...connections.filter((c) => c.source === next).map((c) => c.target));
    }
    return false;
  };
  /** A step `id` reaches only through `key`'s error output: there `key` failed, with no result to read. */
  const onlyAfterFailure = (key: string, id: string): boolean => {
    const source = idByKey.get(key);
    if (!source) return false;
    const out = connections.filter((c) => c.source === source);
    return reaches(out.filter((c) => c.output === "error"), id) && !reaches(out.filter((c) => c.output !== "error"), id);
  };

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
            // Evaluated with no database session (§6.3.1): no user to read, no period to compute.
            if (usesSessionVariable(parseFilter(raw as Record<string, unknown>, { maxFilterDepth, maxRelationDepth }, 0))) issues.push(`${label(op)}: its ${name} can't use $USER.* or $PERIOD.* - nothing resolves them for a data event.`);
          } catch (error) {
            issues.push(`${label(op)}: its ${name} is invalid - ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        if (configuration.for_each !== undefined && configuration.for_each !== "ROW" && configuration.for_each !== "STATEMENT") issues.push(`${label(op)}: For each must be ROW or STATEMENT.`);
      }
      // A Webhook's allowed addresses (§6.5): PostgreSQL reads them as it will compare them (inet).
      if (configuration.trigger === "WEBHOOK" && configuration.allowed_ips !== undefined && configuration.allowed_ips !== null) {
        const allowedIps = configuration.allowed_ips;
        if (!Array.isArray(allowedIps) || allowedIps.some((entry) => typeof entry !== "string")) issues.push(`${label(op)}: its allowed addresses must be a list of IP addresses and CIDR ranges.`);
        else if (allowedIps.length > 50) issues.push(`${label(op)}: at most 50 allowed addresses.`);
        else {
          try {
            await context.database.query(`SELECT $1::inet[]`, [allowedIps]);
          } catch (error) {
            issues.push(`${label(op)}: its allowed addresses are invalid - ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      // A PUBLIC webhook's shared secret (§6.5): a Workflows secret that exists, a mode and a header it can be read from.
      if (configuration.trigger === "WEBHOOK" && configuration.secret !== undefined && configuration.secret !== null && configuration.secret !== "") {
        const key = configuration.secret;
        if (typeof key !== "string") issues.push(`${label(op)}: its secret must name a secret.`);
        else if ((await context.database.query(`SELECT 1 FROM totalbase.secrets WHERE key = $1 AND scope = 'WORKFLOWS'`, [key])).rows.length === 0) {
          issues.push(`${label(op)}: no workflow secret "${key}" in Settings > Secrets.`);
        }
        if ((configuration.access ?? "PUBLIC") !== "PUBLIC") issues.push(`${label(op)}: a secret is for a public webhook - an authenticated one has its caller's credential.`);
        if (configuration.secret_mode !== undefined && configuration.secret_mode !== "TOKEN" && configuration.secret_mode !== "HMAC_SHA256") issues.push(`${label(op)}: the secret's check must be TOKEN or HMAC_SHA256.`);
        // A GET has no body: its HMAC would be one fixed value, replayable with any query string.
        if (configuration.secret_mode === "HMAC_SHA256" && configuration.method === "GET") issues.push(`${label(op)}: an HMAC signature signs the body - a GET webhook has none; use a token.`);
        const header = configuration.secret_header;
        if (header !== undefined && header !== null && header !== "" && (typeof header !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(header))) issues.push(`${label(op)}: the secret's header must be a header name (letters, digits and hyphens).`);
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
      let resource: Awaited<ReturnType<typeof resolveWorkflowResource>> | undefined;
      try {
        resource = await resolveWorkflowResource(context as WorkflowEngineContext, resourceId, definition.resource.types);
      } catch {
        issues.push(`${label(op)}: the ${definition.resource.noun} it names no longer exists.`);
      }
      // A Read records query read as a run reads it, and the paths it names on the table - else the first run fails.
      if (resource && op.type === "totalbase.read-records" && configuration.query !== undefined) {
        const issue = await queryIssue(configuration.query, resource, context);
        if (issue) issues.push(`${label(op)}: its query - ${issue}`);
      }
      // An Update / Delete records filter the same way: the author's grammar, its paths on the table - a `where` that is
      // itself a {{...}} would take its grammar from the run (a webhook's body), refused here and at run time.
      if (resource && (op.type === "totalbase.update-records" || op.type === "totalbase.delete-records") && configuration.where !== undefined && configuration.where !== null) {
        const issue = await filterIssue(configuration.where, resource, context);
        if (issue) issues.push(`${label(op)}: its where - ${issue}`);
      }
    }

    // The secrets its headers name exist (Settings > Secrets) - else its first run would be the one to find out.
    const secretKeys = (Array.isArray(configuration.secretHeaders) ? configuration.secretHeaders as Array<{ secret?: unknown }> : [])
      .map((entry) => entry?.secret).filter((key): key is string => typeof key === "string" && key !== "");
    if (secretKeys.length > 0) {
      const { rows } = await context.database.query<{ key: string }>(`SELECT key FROM totalbase.secrets WHERE key = ANY($1::text[]) AND scope = 'WORKFLOWS'`, [secretKeys]);
      const found = new Set(rows.map((row) => row.key));
      for (const key of new Set(secretKeys)) if (!found.has(key)) issues.push(`${label(op)}: no workflow secret "${key}" in Settings > Secrets.`);
    }

    // Templates name steps that run before this one (`item` and `error` are the engine's own).
    if (definition.templates === "configuration") {
      const before = ancestorKeys(op.id);
      const roots = new Set([...JSON.stringify(configuration).matchAll(TEMPLATE_ROOT)].map((m) => m[1]!));
      for (const root of roots) {
        if (root === "item" || root === "error") continue;
        if (before.has(root)) {
          if (onlyAfterFailure(root, op.id)) issues.push(`${label(op)}: {{${root}...}} runs only after "${root}" failed, which leaves no result - its error is {{error.message}}.`);
          continue;
        }
        issues.push(stepKeys.has(root)
          ? `${label(op)}: {{${root}...}} names a step that doesn't run before it.`
          : `${label(op)}: {{${root}...}} names no step.`);
      }
    }
  }

  if (issues.length > 0) throw new TotalBaseError("WORKFLOW_NOT_PUBLISHABLE", issues.join("\n"));
}

/**
 * What a Read records query would fail its first run with: its shape (parseQuery - an unknown parameter too), then
 * the fields and filter paths it names on the table (assertFilterPathsResolve). A path with a `{{...}}` is left to
 * the run, which resolves it.
 */
async function queryIssue(query: unknown, resource: { postgresOid: number; name: string }, context: Pick<WorkflowEngineContext, "settings" | "database">): Promise<string | null> {
  if (typeof query !== "object" || query === null || Array.isArray(query)) return "it must be an object of query parameters.";
  try {
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([context.settings.get("api.max_filter_depth"), context.settings.get("api.max_relation_depth")]);
    const ast = parseQuery(query as Record<string, unknown>, { maxFilterDepth, maxRelationDepth });
    const paths = [
      ...(ast.fields ?? []).map((field) => field.path.join(".")),
      ...filterFieldPaths(ast.where),
      // An order may name an aggregate's alias instead of a column.
      ...(ast.orderBy ?? []).map((order) => order.path.join(".")).filter((path) => !(ast.aggregates ?? []).some((aggregate) => aggregate.alias === path)),
    ].filter((path) => !path.includes("{{"));
    await assertFilterPathsResolve(context.database, resource.postgresOid, resource.name, [...new Set(paths)]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** An Update / Delete records `where` as a run parses it, and the paths it names on the table (a `{{...}}` path skipped). */
async function filterIssue(where: unknown, resource: { postgresOid: number; name: string }, context: Pick<WorkflowEngineContext, "settings" | "database">): Promise<string | null> {
  if (typeof where === "object" && where !== null && !Array.isArray(where) && Object.keys(where).length === 0) return null;
  try {
    const [maxFilterDepth, maxRelationDepth] = await Promise.all([context.settings.get("api.max_filter_depth"), context.settings.get("api.max_relation_depth")]);
    const node = parseFilter(where, { maxFilterDepth, maxRelationDepth }, 0);
    const paths = filterFieldPaths(node).filter((path) => !path.includes("{{"));
    await assertFilterPathsResolve(context.database, resource.postgresOid, resource.name, [...new Set(paths)]);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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

/** What a step does that a stranger shouldn't be able to set off: writes, calls out, sends, runs code or another workflow. */
const ACTING_OPERATIONS = new Set([
  "totalbase.create-records", "totalbase.update-records", "totalbase.delete-records", "totalbase.execute-function", "totalbase.execute-sql",
  "totalbase.execute-javascript", "totalbase.execute-workflow", "totalbase.http-request", "totalbase.soap-request", "totalbase.send-email", "totalbase.create-file",
]);

/**
 * A published definition's advice (Workflows.md §6.5) - never a refusal: a PUBLIC webhook with neither a secret nor
 * allowed addresses runs, for anyone who learns its URL, as its `execute_as`; said when a step acts (writes, calls
 * out, sends), louder when that user is an administrator.
 */
export async function publishAdvisories(definition: Record<string, unknown>, context: Pick<WorkflowEngineContext, "database">): Promise<string[]> {
  const operations = (definition.operations as DefinitionOperation[] | undefined) ?? [];
  const start = operations.find((op) => op.type === "totalbase.start")?.configuration ?? {};
  if (start.trigger !== "WEBHOOK" || (start.access ?? "PUBLIC") !== "PUBLIC") return [];
  if (present(start.secret) || (Array.isArray(start.allowed_ips) && start.allowed_ips.length > 0)) return [];
  const acting = operations.filter((op) => ACTING_OPERATIONS.has(op.type)).map((op) => op.key ?? op.id);
  if (acting.length === 0) return [];
  const executeAs = typeof start.execute_as === "string" ? start.execute_as : null;
  const { rows } = executeAs
    ? await context.database.query<{ administrator: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM totalbase.users_roles a JOIN totalbase.roles r ON r.id = a.role WHERE a."user" = $1::uuid AND r.admin_access) AS administrator`,
      [executeAs],
    )
    : { rows: [] };
  const who = rows[0]?.administrator ? "an administrator - everything they may do" : "its Execute as user, with that user's permissions";
  return [`This webhook is public with no secret and no allowed addresses: anyone who learns its URL runs ${acting.map((key) => `"${key}"`).join(", ")} as ${who}. Add a secret (Settings › Secrets) or allowed addresses, or make it AUTHENTICATED.`];
}

