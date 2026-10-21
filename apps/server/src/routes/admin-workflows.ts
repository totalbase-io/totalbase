import { UUID_PATTERN } from "@totalbase/shared";
import type { FastifyInstance } from "fastify";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "../context.js";
import { extractBearerToken, requireAdmin } from "../auth-guards.js";
import { resolveDataPrincipal } from "../data-principal.js";
import { signal } from "../invalidations.js";
import { OPERATION_HANDLERS, nextOccurrences, parseCronExpression, requestRunCancellation, runWorkflowManual, runWorkflowTest, validateExecutionReadiness } from "@totalbase/workflows";
import { OPERATION_CATALOG } from "@totalbase/tb-catalog";
import type { JsonSchema } from "@totalbase/openapi";
import { adminDoc, arrayOf, created, NO_CONTENT, object, ok, ref, UUID, UUID_PARAM } from "../openapi-admin-docs.js";
import { WORKFLOW_SCHEMAS } from "../openapi-admin-docs-workflows.js";
import { registerDeleteVersionsRoute } from "./delete-versions.js";
import { type DataBody, optionalData, publishNote, versionParam } from "../request-body.js";

function defined<T extends Record<string, unknown>>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as Partial<T>;
}



type HistoryLevel = "SUMMARY" | "DETAILED";
interface CreateWorkflowBody { name: string; description: string | null; slug: string; historyEnabled: boolean; historyLevel: HistoryLevel; startConfiguration: Record<string, unknown> }
interface UpdateWorkflowBody { revision: string; name: string; description: string | null; slug: string; historyEnabled: boolean; historyLevel: HistoryLevel; enabled: boolean }

const ID_PARAMS = { id: { ...UUID_PARAM, description: "The workflow's id." } };
const VERSION_PARAMS = { ...ID_PARAMS, version: { schema: { type: "integer", minimum: 1 }, description: "The version NUMBER (1, 2, ...), not its id." } };
const REVISION: JsonSchema = { type: "string", description: "The workflow's current `revision` (optimistic concurrency)." };
/** `{ data: <schema> }` - every request body (Data_API.md §2.5). */
const dataBody = (schema: JsonSchema): JsonSchema => object({ data: schema }, ["data"]);
const REVISION_BODY = dataBody(object({ revision: REVISION }, ["revision"]));
const TRIGGER_INPUT_BODY = object({
  data: { description: "Trigger input - what the Start step outputs as `{{start.data}}`. Defaults to null." },
});
const TEST_RUN_BODY = object({
  data: { description: "Trigger input - what the Start step outputs as `{{start.data}}`. Defaults to null." },
  emailRedirect: { type: "string", description: "One email address every Send email step of this run goes to instead of its recipients (to, cc and bcc). Absent: the steps' own recipients." },
});
/** `{ data: [...], meta: { total } }` - a paginated list. */
const paged = (items: JsonSchema) => ({
  status: "200" as const,
  schema: object({ data: arrayOf(items), meta: object({ total: { type: "integer", description: "Every matching row, across pages." } }, ["total"]) }, ["data", "meta"]),
});
const docs = (doc: Parameters<typeof adminDoc>[1]) => adminDoc("workflows", { ...doc, schemas: WORKFLOW_SCHEMAS });

export function registerAdminWorkflowsRoutes(app: FastifyInstance, context: AppContext): void {
  const preHandler = requireAdmin(context);
  app.get("/admin/api/workflows", {
    preHandler,
    ...docs({
      summary: "List workflows",
      description: "Every workflow, by name, with its draft Start step's trigger type.",
      response: ok(arrayOf(ref("WorkflowListItem"))),
    }),
  }, async () => ({ data: await context.workflowsAdmin.list() }));
  // Registered before the ":id" GET below - a couple of routes want a
  // literal second segment ("operation-types") rather than a workflow id
  // there, so they need to win the match regardless of router priority.
  app.get("/admin/api/workflows/operation-types", {
    preHandler,
    ...docs({
      summary: "Operation types that can be published",
      description: "Sorted type names (e.g. `totalbase.read-records`) with a runtime handler - a draft using any other type can be saved but not published.",
      response: ok(arrayOf({ type: "string" })),
    }),
  }, async () => ({
    // The catalog's operations that run: a handler's, and the loops the
    // engine runs itself (Start is every workflow's own, never added).
    data: OPERATION_CATALOG.filter((op) => op.type !== "totalbase.start" && (op.runs === "engine" || OPERATION_HANDLERS[op.type])).map((op) => op.type).sort(),
  }));
  // Preview - the trigger config form calls this live while the author is
  // still typing an expression, before the workflow is even saved, so it's
  // its own literal path rather than nested under a workflow id; an
  // optional `workflow` adds that workflow's last scheduled occurrence.
  // `cron.ts`'s `parseCronExpression`/`nextOccurrences` - the exact
  // schedule-matching logic `cron-dispatcher.ts` uses - is the one place
  // this grammar is implemented; the admin's validator
  // (utils/cron-expression.ts) mirrors it for instant feedback only.
  app.get<{ Querystring: { expression?: string; timezone?: string; count?: string; workflow?: string } }>("/admin/api/workflows/cron/preview", {
    preHandler,
    ...docs({
      summary: "Preview a cron schedule's next occurrences",
      description:
        "Parses a 5-field cron expression (minute hour day-of-month month day-of-week; JAN-DEC/SUN-SAT names allowed) the way the CRON dispatcher does. " +
        "With `workflow`, also answers that workflow's last scheduled occurrence. 400 WORKFLOW_INVALID_DESIGN for an invalid expression or timezone.",
      parameters: [
        { name: "expression", in: "query", required: true, schema: { type: "string" }, description: "e.g. `0 9 * * 1`." },
        { name: "timezone", in: "query", required: true, schema: { type: "string" }, description: "IANA time zone, e.g. `Europe/Madrid`." },
        { name: "count", in: "query", schema: { type: "integer", minimum: 1, maximum: 10, default: 5 } },
        { name: "workflow", in: "query", schema: UUID, description: "A workflow id: adds its `lastOccurrence`." },
      ],
      response: ok(object({
        occurrences: arrayOf({ type: "string", format: "date-time" }),
        lastOccurrence: { type: ["string", "null"], format: "date-time", description: "The `workflow`'s last scheduled occurrence (the newest occurrence claim or scheduled run); null when none remains or no `workflow` was given." },
      }, ["occurrences", "lastOccurrence"])),
    }),
  }, async (request) => {
    const expression = request.query.expression?.trim();
    const timezone = request.query.timezone?.trim();
    if (!expression || !timezone) throw new TotalBaseError("WORKFLOW_INVALID_DESIGN", "Both \"expression\" and \"timezone\" are required.");
    const count = Math.min(Math.max(Number(request.query.count) || 5, 1), 10);
    const schedule = parseCronExpression(expression);
    const occurrences = nextOccurrences(schedule, timezone, new Date(), count);
    const workflow = request.query.workflow;
    if (workflow !== undefined && !UUID_PATTERN.test(workflow)) throw new TotalBaseError("INVALID_QUERY", "workflow must be a workflow id.");
    const last = workflow === undefined ? null : await context.workflowRuns.lastScheduledOccurrence(workflow);
    return { data: { occurrences: occurrences.map((d) => d.toISOString()), lastOccurrence: last?.toISOString() ?? null } };
  });
  app.get<{ Params: { id: string } }>("/admin/api/workflows/:id", {
    preHandler,
    ...docs({ summary: "Get a workflow", pathParameters: ID_PARAMS, response: ok(ref("Workflow")) }),
  }, async (request) => ({ data: await context.workflowsAdmin.get(request.params.id) }));
  app.get<{ Params: { id: string } }>("/admin/api/workflows/:id/draft", {
    preHandler,
    ...docs({
      summary: "Get a workflow's draft",
      description: "The editable definition - what a test run executes. Production runs execute the live version (see /versions).",
      pathParameters: ID_PARAMS,
      response: ok(ref("WorkflowDraft")),
    }),
  }, async (request) => ({ data: await context.workflowsAdmin.getDraft(request.params.id) }));
  app.post<{ Body: DataBody<CreateWorkflowBody> }>("/admin/api/workflows", {
    preHandler,
    ...docs({
      summary: "Create a workflow",
      description: "Created disabled, with a draft holding only a Start step configured by `startConfiguration` (default `{ \"trigger\": \"MANUAL\" }`). Nothing is published. 409 WORKFLOW_NAME_CONFLICT / WORKFLOW_SLUG_CONFLICT; 422 WORKFLOW_LIMIT_EXCEEDED when the Start configuration passes a definition limit (specs/Workflows.md §3.6).",
      requestBody: {
        schema: dataBody(object({
          name: { type: "string", maxLength: 32 },
          description: { type: ["string", "null"], maxLength: 128 },
          slug: { type: "string", maxLength: 32, description: "Defaults to the slugified name." },
          historyEnabled: { type: "boolean", default: true },
          historyLevel: { type: "string", enum: ["SUMMARY", "DETAILED"], default: "SUMMARY" },
          startConfiguration: {
            type: "object",
            additionalProperties: true,
            description: "The Start step's configuration, stored as is in the definition: `trigger` (MANUAL, CRON, WEBHOOK, DATA_EVENT) and its trigger settings (e.g. cron_expression, timezone, execute_as) - specs/Workflows.md §7, §6.",
          },
        }, ["name"])),
      },
      response: created(ref("Workflow")),
    }),
  }, async (request, reply) => {
    const body = optionalData<CreateWorkflowBody>(request.body);
    const workflow = await context.workflowsAdmin.create({ name: body.name ?? "", ...defined({ description: body.description, slug: body.slug, historyEnabled: body.historyEnabled, historyLevel: body.historyLevel, startConfiguration: body.startConfiguration }) });
    reply.code(201); return { data: workflow };
  });
  app.patch<{ Params: { id: string }; Body: DataBody<UpdateWorkflowBody> }>("/admin/api/workflows/:id", {
    preHandler,
    ...docs({
      summary: "Update a workflow's settings, or enable/disable it",
      description:
        "Metadata only (the graph is saved with PUT /draft). `enabled: true` requires a published version (422 WORKFLOW_NOT_ACTIVATABLE) " +
        "and resets the failure streak. 409 WORKFLOW_REVISION_CONFLICT on a stale `revision`.",
      pathParameters: ID_PARAMS,
      requestBody: {
        schema: dataBody(object({
          revision: REVISION,
          name: { type: "string", maxLength: 32 },
          description: { type: ["string", "null"], maxLength: 128 },
          slug: { type: "string", maxLength: 32 },
          historyEnabled: { type: "boolean" },
          historyLevel: { type: "string", enum: ["SUMMARY", "DETAILED"] },
          enabled: { type: "boolean" },
        }, ["revision"])),
      },
      response: ok(ref("Workflow")),
    }),
  }, async (request) => {
    const body = optionalData<UpdateWorkflowBody>(request.body);
    return { data: await context.workflowsAdmin.update(request.params.id, { revision: body.revision ?? "", ...defined({ name: body.name, description: body.description, slug: body.slug, historyEnabled: body.historyEnabled, historyLevel: body.historyLevel, enabled: body.enabled }) }) };
  });
  app.put<{ Params: { id: string }; Body: DataBody<{ revision: string; definition: Record<string, unknown> }> }>("/admin/api/workflows/:id/draft", {
    preHandler,
    ...docs({
      summary: "Save the draft",
      description:
        "Replaces the whole draft definition under optimistic concurrency (409 WORKFLOW_REVISION_CONFLICT on a stale `revision` - reload, " +
        "never force). The graph rules are checked here (400 WORKFLOW_INVALID_DESIGN, naming the operation): exactly one Start with no " +
        "incoming connection, connections between existing operations through a valid output of their source, one target per output, " +
        "one incoming connection per operation, no cycles, no loop inside another loop's body, unique step keys. The definition limits come " +
        "first (422 WORKFLOW_LIMIT_EXCEEDED naming the limit and the operation): 100 operations including Start, 200 connections, 64 KiB per " +
        "operation's serialized configuration, 1 MiB for the definition, configuration nesting depth 20, 100 fields per object, 1,024 " +
        "characters per template path. Incomplete configuration " +
        "is valid; runtime readiness is checked on publish. Never changes what runs in production.",
      pathParameters: ID_PARAMS,
      requestBody: { schema: dataBody(object({ revision: REVISION, definition: ref("WorkflowDefinition") }, ["revision", "definition"])) },
      response: ok(ref("WorkflowDraft")),
    }),
  }, async (request) => {
    const body = optionalData<{ revision: string; definition: Record<string, unknown> }>(request.body);
    return { data: await context.workflowsAdmin.saveDraft(request.params.id, body.revision ?? "", body.definition as Record<string, unknown>) };
  });
  app.delete<{ Params: { id: string } }>("/admin/api/workflows/:id", {
    preHandler,
    ...docs({ summary: "Delete a workflow", description: "With its versions and run history.", pathParameters: ID_PARAMS, response: NO_CONTENT }),
  }, async (request, reply) => { await context.workflowsAdmin.remove(request.params.id); reply.code(204).send(); });

  // Publish (Workflows.md §10.2 + Foundations.md §13): validates
  // execution readiness against the registered native handler set, then
  // snapshots the draft as the next version. Does not enable the workflow -
  // that's a separate PATCH (enabled: true), refused without a published
  // version (WORKFLOW_NOT_ACTIVATABLE).
  app.post<{ Params: { id: string }; Body: DataBody<{ revision: string; note?: string }> }>("/admin/api/workflows/:id/publish", {
    preHandler,
    ...docs({
      summary: "Publish the draft as the next version",
      description:
        "Snapshots the draft as a new immutable version, which becomes the live one. A draft equal to the live version is a no-op " +
        "answering the workflow unchanged. Re-checks the definition limits (422 WORKFLOW_LIMIT_EXCEEDED), the graph rules (400 WORKFLOW_INVALID_DESIGN) and execution readiness (422 " +
        "WORKFLOW_NOT_PUBLISHABLE: an operation type without a runtime handler). Doesn't enable the workflow - PATCH `enabled: true` " +
        "separately. 409 WORKFLOW_REVISION_CONFLICT.",
      pathParameters: ID_PARAMS,
      requestBody: { schema: dataBody(object({ revision: REVISION, note: { type: "string", maxLength: 128, description: "What this version changes - the publisher's note, shown in the object's Versions." } }, ["revision"])) },
      response: ok(ref("Workflow")),
    }),
  }, async (request) => ({
    data: await context.workflowsAdmin.publish(request.params.id, optionalData<{ revision: string }>(request.body).revision ?? "", (definition) => validateExecutionReadiness(definition, context), request.admin?.id ?? null, publishNote(request.body)),
  }));

  // Runs the current DRAFT synchronously, as the requesting admin - "Probar"
  // in the visual editor (specs/Workflows.md §10:
  // test runs are always manual/synchronous and never touch `published`).
  // Resolves a full DataPrincipal (not just the Admin from requireAdmin)
  // because the run's own operation handlers re-check real Data API
  // permissions per step, same as an ordinary Data API request would.
  app.post<{ Params: { id: string }; Body: { data?: unknown; emailRedirect?: unknown } }>("/admin/api/workflows/:id/test-run", {
    preHandler,
    ...docs({
      summary: "Test-run the draft",
      description:
        "Runs the current DRAFT synchronously as the calling admin (mode TEST, version null), enabled or not, without the INVOKE check. " +
        "Every step re-checks the admin's real Data API permissions - its writes are real. The response carries live, unredacted " +
        "results whatever the history level; TEST runs don't count toward auto-disable. `emailRedirect` sends every email of the run to " +
        "one address instead (422 WORKFLOW_VALIDATION_FAILED if it isn't one).",
      pathParameters: ID_PARAMS,
      requestBody: { schema: TEST_RUN_BODY, required: false },
      response: ok(ref("WorkflowRunOutcome")),
    }),
  }, async (request) => {
    const token = extractBearerToken(request);
    const dataPrincipal = await resolveDataPrincipal(context, token);
    return { data: await runWorkflowTest(context, dataPrincipal, request.params.id, request.body?.data ?? null, { emailRedirect: request.body?.emailRedirect }) };
  });

  // Production MANUAL run (Workflows.md §11.2: "Production manual... runs
  // require an enabled published version") - distinct from test-run above
  // in every dimension that matters: runs the published snapshot (never
  // the draft), mode: PRODUCTION, requires enabled = true, and enforces
  // WORKFLOW_INVOKE (runWorkflowManual's own doc comment explains why
  // test-run deliberately doesn't).
  app.post<{ Params: { id: string }; Body: { data?: unknown } }>("/admin/api/workflows/:id/run", {
    preHandler,
    ...docs({
      summary: "Run the published version (production)",
      description:
        "A synchronous production run of the live version: requires `enabled` (409 WORKFLOW_DISABLED), an INVOKE grant for the caller's " +
        "roles (403 ACTION_DENIED) and a MANUAL or CRON trigger (409 WORKFLOW_NOT_RUNNABLE). A MANUAL workflow runs as the calling admin " +
        "with the request's input (trigger MANUAL). A CRON workflow runs exactly as its schedule would - as its `execute_as`, with the " +
        "schedule object `{ scheduled_at, started_at, timezone }` as Start data (the request's input is not used) - recorded with trigger " +
        "CRON and the admin as initiator. A failed run is still 200 - read `run.status`.",
      pathParameters: ID_PARAMS,
      requestBody: { schema: TRIGGER_INPUT_BODY, required: false },
      response: ok(ref("WorkflowRunOutcome")),
    }),
  }, async (request) => {
    const token = extractBearerToken(request);
    const dataPrincipal = await resolveDataPrincipal(context, token);
    return { data: await runWorkflowManual(context, dataPrincipal, request.params.id, request.body?.data ?? null) };
  });

  // WORKFLOW_INVOKE grants (Workflows.md §12) - which roles may
  // trigger this workflow on demand (the run route, an AUTHENTICATED
  // webhook, Execute workflow toward a MANUAL target). The picker always
  // saves the complete set - ALLOW and DENY - never one grant at a time.
  // Object access, as a DataView's and a Dashboard's roles (Security.md §7): the complete set, replaced.
  app.get<{ Params: { id: string } }>("/admin/api/workflows/:id/roles", {
    preHandler,
    ...docs({
      summary: "The roles that may invoke the workflow",
      description: "WORKFLOW_INVOKE (Workflows.md §12): who may run it through /api/workflows/{slug}/run, an AUTHENTICATED webhook or Execute workflow. Administrators always may. Never grants data.",
      pathParameters: ID_PARAMS,
      response: ok(arrayOf(UUID)),
    }),
  }, async (request) => {
    await context.workflowsAdmin.get(request.params.id); // 404 for an unknown workflow
    return { data: await context.workflowPermissions.listRoles(request.params.id) };
  });
  app.put<{ Params: { id: string }; Body: DataBody<{ roleIds: string[] }> }>("/admin/api/workflows/:id/roles", {
    preHandler,
    ...docs({
      summary: "Replace the roles that may invoke the workflow",
      description: "Sets the complete set in one transaction: the listed roles get (or keep) their grant, every other loses it. `[]` leaves the workflow to administrators only. Returns the role ids set.",
      pathParameters: ID_PARAMS,
      requestBody: { schema: dataBody(object({ roleIds: arrayOf(UUID) }, ["roleIds"])) },
      response: ok(arrayOf(UUID)),
    }),
  }, async (request) => {
    const { roleIds } = optionalData<{ roleIds: unknown }>(request.body);
    if (!Array.isArray(roleIds) || !roleIds.every((role) => typeof role === "string")) {
      throw new TotalBaseError("INVALID_QUERY", "roleIds must be a list of role ids.");
    }
    await context.workflowsAdmin.get(request.params.id); // 404 for an unknown workflow
    return { data: await context.workflowPermissions.setRoles(request.params.id, roleIds) };
  });

  // Versions - same shape as dataviews/dashboards (Foundations.md §13.6),
  // addressed by version NUMBER. A version's `id` is what runs reference (Logs filter by it).
  app.get<{ Params: { id: string } }>("/admin/api/workflows/:id/versions", {
    preHandler,
    ...docs({
      summary: "List published versions",
      description: "Newest first; the first is the live one. A version's `id` is what runs reference.",
      pathParameters: ID_PARAMS,
      response: ok(arrayOf(ref("WorkflowVersion"))),
    }),
  }, async (request) => ({
    data: await context.workflowsAdmin.listVersions(request.params.id),
  }));
  app.get<{ Params: { id: string; version: string } }>("/admin/api/workflows/:id/versions/:version", {
    preHandler,
    ...docs({ summary: "Get one version with its definition", pathParameters: VERSION_PARAMS, response: ok(ref("WorkflowVersionSnapshot")) }),
  }, async (request) => ({
    data: await context.workflowsAdmin.getVersion(request.params.id, versionParam(request.params.version)),
  }));
  registerDeleteVersionsRoute(app, context, preHandler, "workflows", (id, before) => context.workflowsAdmin.deleteVersionsBefore(id, before));

  app.post<{ Params: { id: string; version: string }; Body: DataBody<{ revision: string }> }>("/admin/api/workflows/:id/versions/:version/restore", {
    preHandler,
    ...docs({
      summary: "Restore a version into the draft",
      description: "The version's definition replaces the draft (unsaved draft changes are lost). Publishes nothing - publish afterwards to make it live.",
      pathParameters: VERSION_PARAMS,
      requestBody: { schema: REVISION_BODY },
      response: ok(ref("Workflow")),
    }),
  }, async (request) => ({
    data: await context.workflowsAdmin.restore(request.params.id, optionalData<{ revision: string }>(request.body).revision ?? "", versionParam(request.params.version)),
  }));
  app.post<{ Params: { id: string; version: string }; Body: DataBody<{ name: string; slug: string }> }>("/admin/api/workflows/:id/versions/:version/duplicate", {
    preHandler,
    ...docs({
      summary: "Save a version as a new workflow",
      description: "A new workflow whose draft is the version's definition: history settings copied; disabled, unpublished, no INVOKE grants. 409 WORKFLOW_NAME_CONFLICT / WORKFLOW_SLUG_CONFLICT.",
      pathParameters: VERSION_PARAMS,
      requestBody: {
        schema: dataBody(object({
          name: { type: "string", maxLength: 32 },
          slug: { type: "string", maxLength: 32, description: "Defaults to the slugified name." },
        }, ["name"])),
      },
      response: created(ref("Workflow")),
    }),
  }, async (request, reply) => {
    const body = optionalData<{ name: string; slug: string }>(request.body);
    const workflow = await context.workflowsAdmin.duplicateVersion(request.params.id, versionParam(request.params.version), {
      name: body.name ?? "",
      ...(body.slug !== undefined ? { slug: body.slug } : {}),
    });
    reply.code(201);
    return { data: workflow };
  });

  // "Called by" badge - other workflows with an execute-workflow step
  // targeting this one (workflowsAdmin.listCallers()'s own doc comment).
  app.get<{ Params: { id: string } }>("/admin/api/workflows/:id/called-by", {
    preHandler,
    ...docs({
      summary: "Workflows that call this one",
      description: "Other workflows with an Execute workflow step targeting it, in their live version or only in their draft. Callers through the HTTP run route leave no trace here.",
      pathParameters: ID_PARAMS,
      response: ok(arrayOf(ref("WorkflowCaller"))),
    }),
  }, async (request) => ({
    data: await context.workflowsAdmin.listCallers(request.params.id),
  }));

  // Logs (the editor's own "Logs" sidebar): paginated run history for one
  // workflow, optionally narrowed to one version id (the Versions menu's
  // current selection, when there is one); a single run's own detail plus
  // its steps, for the sidebar's second/third drill-down screens.
  const RUN_STATUSES = ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] as const;
  const RUN_TRIGGERS = ["MANUAL", "DATA_EVENT", "CRON", "WEBHOOK"] as const;
  const RUN_MODES = ["PRODUCTION", "TEST"] as const;
  const oneOf = <T extends string>(name: string, values: readonly T[], value: string | undefined): T | undefined => {
    if (value === undefined) return undefined;
    if (!(values as readonly string[]).includes(value)) throw new TotalBaseError("INVALID_QUERY", `${name} must be one of ${values.join(", ")}.`);
    return value as T;
  };
  const instant = (name: string, value: string | undefined): Date | undefined => {
    if (value === undefined) return undefined;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TotalBaseError("INVALID_QUERY", `${name} must be an ISO 8601 instant.`);
    return date;
  };
  app.get<{ Params: { id: string }; Querystring: { version?: string; status?: string; trigger?: string; mode?: string; from?: string; to?: string; page?: string; pageSize?: string } }>("/admin/api/workflows/:id/runs", {
    preHandler,
    ...docs({
      summary: "A workflow's run history",
      description: "Newest first, paged; the total in `meta`. Narrowed by version, status, trigger, mode and when the run started. What each run stored depends on its history level (SUMMARY: no payloads).",
      pathParameters: ID_PARAMS,
      parameters: [
        { name: "version", in: "query", schema: UUID, description: "Only runs of this version id (from /versions)." },
        { name: "status", in: "query", schema: { type: "string", enum: [...RUN_STATUSES] } },
        { name: "trigger", in: "query", schema: { type: "string", enum: [...RUN_TRIGGERS] } },
        { name: "mode", in: "query", schema: { type: "string", enum: [...RUN_MODES] } },
        { name: "from", in: "query", schema: { type: "string", format: "date-time" }, description: "Runs started at or after this instant." },
        { name: "to", in: "query", schema: { type: "string", format: "date-time" }, description: "Runs started before this instant." },
        { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
        { name: "pageSize", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 15 } },
      ],
      response: paged(ref("WorkflowRun")),
    }),
  }, async (request) => {
    await context.workflowsAdmin.get(request.params.id); // 404 for an unknown workflow
    const q = request.query;
    const { runs, total } = await context.workflowRuns.listRuns(request.params.id, {
      ...(q.version !== undefined ? { version: q.version } : {}),
      ...(q.status !== undefined ? { status: oneOf("status", RUN_STATUSES, q.status)! } : {}),
      ...(q.trigger !== undefined ? { trigger: oneOf("trigger", RUN_TRIGGERS, q.trigger)! } : {}),
      ...(q.mode !== undefined ? { mode: oneOf("mode", RUN_MODES, q.mode)! } : {}),
      ...(q.from !== undefined ? { from: instant("from", q.from)! } : {}),
      ...(q.to !== undefined ? { to: instant("to", q.to)! } : {}),
      ...(q.page !== undefined ? { page: Number(q.page) || 1 } : {}),
      ...(q.pageSize !== undefined ? { pageSize: Number(q.pageSize) || 15 } : {}),
    });
    return { data: runs, meta: { total } };
  });
  // Cancel from Logs (Workflows.md §8.5): cooperative - the
  // running step finishes, no further step starts, the run ends CANCELLED.
  // A run executing in this process is stopped here; a RUNNING one within
  // its deadline is executing in another process, which the RUN_CANCEL
  // signal reaches (invalidations.ts). Any other run (finished, or left
  // RUNNING past its deadline by a process that died - recovery marks it
  // INTERRUPTED) answers 409.
  app.post<{ Params: { runId: string } }>("/admin/api/workflows/runs/:runId/cancel", {
    preHandler,
    ...docs({
      summary: "Cancel a running run",
      description:
        "Requests cooperative cancellation: the step in progress finishes, no further step starts and the run ends CANCELLED shortly " +
        "after (committed work is never rolled back). Answers 202 with the run as it is now - still RUNNING. 409 " +
        "WORKFLOW_RUN_NOT_CANCELLABLE when the run is not executing; 404 WORKFLOW_RUN_NOT_FOUND for an unknown run.",
      pathParameters: { runId: UUID_PARAM },
      response: { status: "202", schema: object({ data: ref("WorkflowRun") }, ["data"]) },
    }),
  }, async (request, reply) => {
    const run = await context.workflowRuns.getRun(request.params.runId);
    const executing = run.status === "RUNNING" && run.expiresAt.getTime() > Date.now();
    if (!executing) {
      throw new TotalBaseError("WORKFLOW_RUN_NOT_CANCELLABLE", `This run is ${run.status === "RUNNING" ? "no longer executing" : run.status.toLowerCase()} and cannot be canceled.`);
    }
    if (!requestRunCancellation(run.id)) await signal(context, { topic: "RUN_CANCEL", run: run.id });
    reply.code(202);
    return { data: run };
  });
  app.get<{ Params: { runId: string } }>("/admin/api/workflows/runs/:runId", {
    preHandler,
    ...docs({
      summary: "One run with its steps",
      description: "As stored under the run's history policy - steps in execution order. 404 WORKFLOW_RUN_NOT_FOUND for an unknown run.",
      pathParameters: { runId: UUID_PARAM },
      response: ok(ref("WorkflowRunOutcome")),
    }),
  }, async (request) => {
    const [run, steps] = await Promise.all([
      context.workflowRuns.getRun(request.params.runId),
      context.workflowRuns.listSteps(request.params.runId),
    ]);
    return { data: { run, steps } };
  });
}
