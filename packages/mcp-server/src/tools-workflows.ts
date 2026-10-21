import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./admin-client.js";
import { ADDITIVE, defined, DESTRUCTIVE, filterForStorage, deleteEach, deleteTargets, IDEMPOTENT, NAME_RULE, READ_ONLY, result, roleId } from "./tool-helpers.js";

/**
 * Workflows (Workflows.md, Administration.md
 * §11.3): a draft definition - a tree of operations from one Start step -
 * saved whole under optimistic concurrency (`revision`), test-run for real,
 * published as an immutable version, enabled, and granted to the roles that
 * may invoke it. The server validates every save and publish; this layer
 * only lets an agent name operations by their step `key` instead of
 * inventing UUIDs. totalbase://guide/workflows has the operations and their
 * configuration.
 */

interface Workflow {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  revision: string;
  enabled: boolean;
  liveVersion: number | null;
  hasUnpublishedChanges: boolean;
  consecutiveFailures: number;
  triggerType?: string | null;
}
interface Operation { id: string; type: string; key?: string; label?: string; configuration_version?: number; configuration: Record<string, unknown>; parent?: string | null }
interface Definition { operations: Operation[]; connections: { source: string; output: string; target: string }[] }
interface RunStep { operation: string; operationType: string; sequence: number; status: string; selectedOutput: string | null; result: unknown; error: unknown }
interface RunOutcome { run: { id: string; status: string; mode: string; trigger: string; result: unknown; error: unknown; hasHandledErrors: boolean; startedAt: string | null; finishedAt: string | null }; steps: RunStep[] }

const summary = (w: Workflow) => ({
  id: w.id,
  name: w.name,
  slug: w.slug,
  ...(w.triggerType !== undefined && { trigger: w.triggerType }),
  enabled: w.enabled,
  liveVersion: w.liveVersion,
  hasUnpublishedChanges: w.hasUnpublishedChanges,
  revision: w.revision,
  ...(w.consecutiveFailures > 0 && { consecutiveFailures: w.consecutiveFailures }),
});

const LONG_TEXT = 500;
const LONG_LIST = 10;

/**
 * A step's result as an agent reads it by default: a long text (a PDF's base64, a file's content) as its size, a
 * long list as its first rows and a count - two test runs of an invoice workflow cost more context than building
 * it. `full` answers it all.
 */
function compact(value: unknown): unknown {
  if (typeof value === "string" && value.length > LONG_TEXT) {
    const kind = /^[A-Za-z0-9+/]+=*$/.test(value) ? "base64" : "text";
    return `<${kind}, ${value.length.toLocaleString("en")} characters - full: true for all of it>`;
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, LONG_LIST).map(compact);
    return value.length > LONG_LIST ? [...head, `<${(value.length - LONG_LIST).toLocaleString("en")} more - full: true for all of them>`] : head;
  }
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, compact(item)]));
  return value;
}

/** A run as the agent reads it: its outcome and each step by key. */
function outcome(data: RunOutcome, definition?: Definition, full = false) {
  const shown = full ? (value: unknown) => value : compact;
  const keys = new Map((definition?.operations ?? []).map((op) => [op.id, op.key ?? op.label ?? op.id]));
  return {
    run: data.run.id,
    status: data.run.status,
    mode: data.run.mode,
    trigger: data.run.trigger,
    ...(data.run.result !== null && { result: shown(data.run.result) }),
    ...(data.run.error !== null && { error: data.run.error }),
    ...(data.run.hasHandledErrors && { hasHandledErrors: true }),
    steps: data.steps.map((s) => ({
      step: keys.get(s.operation) ?? s.operation,
      type: s.operationType,
      status: s.status,
      ...(s.selectedOutput && { output: s.selectedOutput }),
      ...(s.result !== null && s.result !== undefined && { result: shown(s.result) }),
      ...(s.error !== null && s.error !== undefined && { error: s.error }),
    })),
  };
}

const operationInput = z.object({
  id: z.string().optional().describe("Keep the existing id when changing a saved operation; omit for a new one (generated)"),
  type: z.string().describe("An operation type of the catalog, e.g. totalbase.start, totalbase.read-records, totalbase.condition - totalbase://guide/workflows lists each with its configuration"),
  key: z.string().describe("Step key: letters, digits, underscores; unique; later steps read its result as {{key.data}}. Start's is 'start'"),
  label: z.string().optional(),
  configuration: z.record(z.string(), z.unknown()).default({}).describe("The operation's settings (totalbase://guide/workflows); resources by their id (list_resources)"),
  parent: z.string().nullable().optional().describe("Inside a loop's body: the For each / Process in batches step's key (or id)"),
});

const connectionInput = z.object({
  source: z.string().describe("The source step's key (or id)"),
  output: z.string().describe("Its output port: next, error, true, false, item, done, batch, or a Select case name"),
  target: z.string().describe("The target step's key (or id)"),
});

/**
 * A step's configuration with its filters stored as the grammar takes them -
 * every value text (Workflows.md §5.2: "as on the wire"): a
 * where, a Condition's or a data event's filter, a Select case's and a
 * Validate data rule's filter, a Read records query's where.
 */
function storedConfiguration(configuration: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...configuration };
  for (const key of ["where", "filter", "old_filter"]) if (out[key] && typeof out[key] === "object") out[key] = filterForStorage(out[key]);
  if (out["query"] && typeof out["query"] === "object") {
    const query = { ...(out["query"] as Record<string, unknown>) };
    if (query["where"]) query["where"] = filterForStorage(query["where"]);
    out["query"] = query;
  }
  for (const key of ["cases", "rules"]) {
    if (Array.isArray(out[key])) out[key] = (out[key] as Record<string, unknown>[]).map((item) => (item?.["filter"] ? { ...item, filter: filterForStorage(item["filter"]) } : item));
  }
  return out;
}

const invokeRoles = z
  .array(roleId())
  .describe("Replaces the roles that may run it on demand (the App, /api/workflows/{slug}/run, an AUTHENTICATED webhook) - the complete set. Administrators always may");

export function registerWorkflowTools(server: McpServer, client: AdminClient): void {
  // Settings > Secrets (Administration.md §9): write-only - a value goes in, never comes back out.
  server.registerTool(
    "list_secrets",
    {
      title: "List secrets",
      description: "The instance's secrets by key (Settings > Secrets) - metadata only, never a value. A step's secretHeaders, a SOAP step's or a signature's secret names one of these keys.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => result(await client.get("/secrets")),
  );

  server.registerTool(
    "set_secret",
    {
      title: "Set secret",
      description: "Store a secret encrypted under the instance's master key, for a workflow step to reference by key (secretHeaders [{name, secret}]). Its value is never returned by anything. An existing key is replaced only with replace: true - something may already depend on its value. Ask the person for the value; never invent one.",
      inputSchema: {
        key: z.string().describe("Lowercase letters, digits, dots, hyphens and underscores, e.g. 'accounting.api_key'"),
        value: z.string().describe("The secret itself"),
        replace: z.boolean().optional().describe("Replace the key's value when it exists already"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ key, value, replace }) => {
      if (!replace && (await client.get<{ key: string }[]>("/secrets")).some((secret) => secret.key === key)) {
        throw new Error(`Secret ${key} exists already - pass replace: true to change its value.`);
      }
      return result(await client.put(`/secrets/${encodeURIComponent(key)}`, { data: { value } }));
    },
  );

  server.registerTool(
    "list_workflows",
    {
      title: "List workflows",
      description: "Every workflow: id, name, slug, trigger (MANUAL, CRON, WEBHOOK, DATA_EVENT), enabled, live version (null: never published), unpublished changes and its revision.",
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => result((await client.get<Workflow[]>("/workflows")).map(summary)),
  );

  server.registerTool(
    "get_workflow",
    {
      title: "Get workflow",
      description: "A workflow's draft: its settings, revision (save_workflow and publish_workflow need it), definition (operations and connections) and the roles that may invoke it. Read it before changing a workflow.",
      inputSchema: { id: z.string().describe("The workflow's id (list_workflows)") },
      annotations: READ_ONLY,
    },
    async ({ id }) => {
      const [draft, roles] = await Promise.all([
        client.get<{ workflow: Workflow; definition: Definition }>(`/workflows/${id}/draft`),
        client.get<string[]>(`/workflows/${id}/roles`),
      ]);
      return result({ ...summary(draft.workflow), description: draft.workflow.description, definition: draft.definition, roleIds: roles });
    },
  );

  server.registerTool(
    "create_workflow",
    {
      title: "Create workflow",
      description:
        "Create a workflow, disabled, with a draft holding only its Start step configured with the trigger (totalbase://guide/workflows): MANUAL (run on demand; optional input_fields form), CRON (cron_expression, timezone, execute_as), WEBHOOK (method, access PUBLIC/AUTHENTICATED, execute_as, response_mode), DATA_EVENT (resource, events, execute_as, filter...). Then save_workflow with its steps, run_workflow mode=test, publish_workflow.",
      inputSchema: {
        name: z.string().max(32).describe(NAME_RULE),
        description: z.string().max(128).optional(),
        slug: z.string().max(32).optional().describe("Addresses it in /api/workflows/{slug}/run; proposed from the name"),
        start: z.record(z.string(), z.unknown()).default({ trigger: "MANUAL" }).describe("The Start step's configuration, e.g. {\"trigger\":\"MANUAL\"} or {\"trigger\":\"CRON\",\"cron_expression\":\"0 9 * * MON-FRI\",\"timezone\":\"America/Argentina/Buenos_Aires\",\"execute_as\":\"<user id>\"}"),
        history_level: z.enum(["SUMMARY", "DETAILED"]).optional().describe("DETAILED keeps each step's (redacted) payloads in the run history; SUMMARY (default) only statuses"),
      },
      annotations: ADDITIVE,
    },
    async ({ name, description, slug, start, history_level }) => {
      const created = await client.post<Workflow>("/workflows", { data: { name, ...defined({ description, slug, historyLevel: history_level }), startConfiguration: storedConfiguration(start) } });
      const draft = await client.get<{ definition: Definition }>(`/workflows/${created.id}/draft`);
      return result({ ...summary(created), definition: draft.definition });
    },
  );

  server.registerTool(
    "save_workflow",
    {
      title: "Save workflow",
      description:
        "Replace a workflow's whole draft definition: every operation (Start included - keep its id from get_workflow) and every connection. Name steps and connect them by key; new operations get their ids here. The server checks the graph (a tree from Start, one target per output, valid ports, unique keys, no loop in a loop) and the limits; incomplete configuration is still a valid draft - publish checks readiness. Needs the current revision (get_workflow); a stale one is WORKFLOW_REVISION_CONFLICT - read it again, never overwrite blindly. Answers the new revision and the saved definition.",
      inputSchema: {
        id: z.string(),
        revision: z.string().describe("The workflow's current revision (get_workflow / the last save)"),
        operations: z.array(operationInput).min(1),
        connections: z.array(connectionInput).default([]),
      },
      annotations: IDEMPOTENT,
    },
    async ({ id, revision, operations, connections }) => {
      const ids = new Map<string, string>();
      const withIds = operations.map((op) => {
        const opId = op.id ?? randomUUID();
        ids.set(op.key, opId);
        ids.set(opId, opId);
        return { ...op, id: opId };
      });
      const resolve = (ref: string) => ids.get(ref) ?? ref;
      const definition: Definition = {
        operations: withIds.map((op) => ({
          id: op.id,
          type: op.type,
          key: op.key,
          label: op.label ?? op.key,
          configuration_version: 1,
          configuration: storedConfiguration(op.configuration),
          ...(op.parent && { parent: resolve(op.parent) }),
        })),
        connections: connections.map((c) => ({ source: resolve(c.source), output: c.output, target: resolve(c.target) })),
      };
      const saved = await client.put<{ workflow: Workflow; definition: Definition }>(`/workflows/${id}/draft`, { data: { revision, definition } });
      return result({ ...summary(saved.workflow), definition: saved.definition });
    },
  );

  server.registerTool(
    "run_workflow",
    {
      title: "Run workflow",
      description:
        "Run a workflow and answer its outcome: status, result or error, and each step (by key) with its output port, result (a long text - a PDF's base64 - as its size, a long list as its first 10 rows, unless full: true) and error. mode=test runs the DRAFT as you (enabled or not) - its writes are real; mode=production runs the live version, which must be published and enabled (a CRON one runs as its schedule would). A failed run still answers - read status and the failed step's error.",
      inputSchema: {
        id: z.string(),
        mode: z.enum(["test", "production"]).default("test"),
        input: z.unknown().optional().describe("The trigger input - {{start.data}} in the steps (MANUAL: the object its input_fields describe)"),
        full: z.boolean().optional().describe("Every result whole; by default a long text (a PDF's base64) is its size and a long list its first 10 rows"),
        email_redirect: z.string().optional().describe("mode=test only: one address every Send email step sends to instead of its recipients - to see a real email when the data holds @example.com addresses"),
      },
      annotations: ADDITIVE,
    },
    async ({ id, mode, input, full, email_redirect }) => {
      const [data, draft] = await Promise.all([
        mode === "test"
          ? client.post<RunOutcome>(`/workflows/${id}/test-run`, { data: input ?? null, ...(email_redirect && { emailRedirect: email_redirect }) })
          : client.post<RunOutcome>(`/workflows/${id}/run`, { data: input ?? null }),
        client.get<{ definition: Definition }>(`/workflows/${id}/draft`).catch(() => undefined),
      ]);
      return result(outcome(data, draft?.definition, full));
    },
  );

  server.registerTool(
    "get_workflow_runs",
    {
      title: "Get workflow runs",
      description: "A workflow's run history, newest first (15 per page) - or one run with its steps when run_id is given. What a run kept depends on its history level (SUMMARY: statuses, no payloads).",
      inputSchema: {
        id: z.string().optional().describe("The workflow's id - its history"),
        run_id: z.string().optional().describe("One run, with its steps"),
        page: z.number().int().min(1).default(1),
        full: z.boolean().optional().describe("run_id: every result whole; by default a long text is its size and a long list its first 10 rows"),
      },
      annotations: READ_ONLY,
    },
    async ({ id, run_id, page, full }) => {
      if (run_id) return result(outcome(await client.get<RunOutcome>(`/workflows/runs/${run_id}`), undefined, full));
      if (!id) throw new Error("Pass id (a workflow's history) or run_id (one run).");
      const runs = await client.get<RunOutcome["run"][]>(`/workflows/${id}/runs?page=${page}`);
      return result(runs.map((r) => ({ run: r.id, status: r.status, mode: r.mode, trigger: r.trigger, startedAt: r.startedAt, finishedAt: r.finishedAt, ...(r.error !== null && { error: r.error }) })));
    },
  );

  server.registerTool(
    "publish_workflow",
    {
      title: "Publish workflow",
      description:
        "Publish the draft as the next immutable version - the live one - after the server checks it is ready (every step configured, templates name earlier steps, resources exist; WORKFLOW_NOT_PUBLISHABLE lists every issue). enabled=true then turns it on (triggers and production runs only reach an enabled workflow); role_ids sets who may run it on demand. Needs the current revision.",
      inputSchema: {
        id: z.string(),
        revision: z.string().describe("The workflow's current revision"),
        enabled: z.boolean().optional().describe("true: enable it after publishing; false: disable it"),
        role_ids: invokeRoles.optional(),
        note: z.string().max(128).optional().describe("What this version changes - shown in the workflow's Versions"),
      },
      annotations: ADDITIVE,
    },
    async ({ id, revision, enabled, role_ids, note }) => {
      let workflow = await client.post<Workflow>(`/workflows/${id}/publish`, { data: { revision, ...(note && { note }) } });
      if (enabled !== undefined && enabled !== workflow.enabled) workflow = await client.patch<Workflow>(`/workflows/${id}`, { data: { revision: workflow.revision, enabled } });
      const roles = role_ids ? await client.put<string[]>(`/workflows/${id}/roles`, { data: { roleIds: role_ids } }) : undefined;
      return result({ ...summary(workflow), ...(roles && { roleIds: roles }) });
    },
  );

  server.registerTool(
    "set_workflow_enabled",
    {
      title: "Enable or disable workflow",
      description:
        "Turn a published workflow on or off without publishing its draft: enabled, its trigger admits runs (a schedule, a data event, a webhook, a manual run); disabled, nothing new starts - its runs and versions stay. Enabling needs a published version (WORKFLOW_NOT_ACTIVATABLE) and resets its failure streak.",
      inputSchema: { id: z.string(), enabled: z.boolean() },
      annotations: IDEMPOTENT,
    },
    async ({ id, enabled }) => {
      const current = await client.get<Workflow>(`/workflows/${id}`);
      const workflow = current.enabled === enabled ? current : await client.patch<Workflow>(`/workflows/${id}`, { data: { revision: current.revision, enabled } });
      return result(summary(workflow));
    },
  );

  server.registerTool(
    "delete_workflow",
    {
      title: "Delete workflow",
      description: "Delete a workflow with its versions and run history. Irreversible - requires confirm=true; ask the user first. To stop it without losing it, set_workflow_enabled enabled=false.",
      inputSchema: { ...deleteTargets(), confirm: z.literal(true).describe("Must be true") },
      annotations: DESTRUCTIVE,
    },
    async ({ id, ids }) => result(await deleteEach(client, "/workflows", { id, ids })),
  );
}
