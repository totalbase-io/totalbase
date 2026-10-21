import type { JsonSchema } from "@totalbase/openapi";
import { arrayOf, DATE_TIME, object, ref, UUID } from "./openapi-admin-docs.js";

/**
 * Component schemas for the workflows Admin API (routes/admin-workflows.ts),
 * mirroring @totalbase/workflows' WorkflowsAdminService / WorkflowRunsService
 * records and the engine's WorkflowRunOutcome. Every name is `Workflow`-prefixed
 * so it can't collide with another area's components.
 */

const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [schema.type as string, "null"] });
const ANY: JsonSchema = { description: "Any JSON value (null when absent)." };
const HISTORY_LEVEL: JsonSchema = { type: "string", enum: ["SUMMARY", "DETAILED"] };

export const WORKFLOW_SCHEMAS: Record<string, JsonSchema> = {
  Workflow: object({
    id: UUID,
    name: { type: "string" },
    description: nullable({ type: "string" }),
    slug: { type: "string", description: "URL-safe identifier - the `/api/workflows/{slug}/run` and webhook routes address the workflow by it." },
    revision: { type: "string", description: "Optimistic-concurrency token (a decimal bigint). Send it back on every write; a stale one answers 409 WORKFLOW_REVISION_CONFLICT." },
    historyEnabled: { type: "boolean" },
    historyLevel: { ...HISTORY_LEVEL, description: "SUMMARY stores no payloads; DETAILED stores them redacted and size-capped." },
    enabled: { type: "boolean", description: "Accepts admissions (triggers, production runs). Requires a published version." },
    consecutiveFailures: { type: "integer", description: "Current failed-run streak; at workflows.auto_disable_after_consecutive_failures the workflow is disabled." },
    publishedVersion: { ...nullable(UUID), description: "Id of the live version row - what production runs reference. Null = never published." },
    liveVersion: { type: ["integer", "null"], description: "The live version's number. Null = never published." },
    hasUnpublishedChanges: { type: "boolean", description: "The draft differs from the live version (or there is none yet)." },
    createdAt: DATE_TIME,
    updatedAt: DATE_TIME,
  }),
  WorkflowListItem: {
    allOf: [
      ref("Workflow"),
      object({ triggerType: { type: ["string", "null"], description: "The draft Start step's `trigger` (MANUAL, CRON, WEBHOOK, DATA_EVENT)." } }),
    ],
  },
  WorkflowOperation: {
    type: "object",
    required: ["id", "type", "configuration"],
    additionalProperties: true,
    description: "One step of the graph. Each operation type's `configuration` is described in specs/Workflows.md §5.",
    properties: {
      id: UUID,
      type: { type: "string", description: "An operation type, e.g. `totalbase.start`, `totalbase.read-records` - see GET /admin/api/workflows/operation-types." },
      key: { type: "string", description: "Name later steps bind this step's result by, e.g. `{{read.data[0].name}}`." },
      label: { type: ["string", "null"] },
      configuration_version: { type: "integer" },
      configuration: { type: "object", additionalProperties: true },
      parent: { ...UUID, description: "The owning For each / Process in batches operation, for a step inside a loop body (no nested loops)." },
    },
  },
  WorkflowConnection: object(
    {
      source: UUID,
      target: UUID,
      output: { type: "string", description: "One of the source's output ports: `next`, `error`; a Condition's `true`/`false`; a loop's `item`/`batch`/`done`; a Select case's case names and `default`." },
    },
    ["source", "target", "output"],
  ),
  WorkflowDefinition: {
    type: "object",
    required: ["operations", "connections"],
    additionalProperties: true,
    description:
      "The workflow graph, a tree rooted at the one `totalbase.start` operation (its configuration holds the trigger): each output has " +
      "at most one target, each operation at most one incoming connection, no cycles, and a loop operation can't sit inside another " +
      "loop's body. See specs/Workflows.md §3.",
    properties: {
      operations: arrayOf(ref("WorkflowOperation")),
      connections: arrayOf(ref("WorkflowConnection")),
    },
  },
  WorkflowDraft: object({ workflow: ref("Workflow"), definition: ref("WorkflowDefinition") }),
  WorkflowVersion: object({
    id: { ...UUID, description: "What runs reference (`version` on a run)." },
    version: { type: "integer" },
    restoredFromVersion: { type: ["integer", "null"], description: "The older version this one republished, after a Restore." },
    user: nullable(UUID),
    publishedAt: DATE_TIME,
    note: { type: ["string", "null"], description: "The publisher's note on what this version changes." },
  }),
  WorkflowVersionSnapshot: {
    allOf: [ref("WorkflowVersion"), object({ definition: ref("WorkflowDefinition") })],
  },
  WorkflowCaller: object({
    id: UUID,
    name: { type: "string" },
    slug: { type: "string" },
    live: { type: "boolean", description: "The reference is in the caller's live version." },
    draftPending: { type: "boolean", description: "Only the caller's unpublished draft references it." },
  }),
  WorkflowRun: object({
    id: UUID,
    workflow: UUID,
    version: { ...nullable(UUID), description: "The version row it executed; null = a test run of the draft." },
    trigger: { type: "string", enum: ["MANUAL", "DATA_EVENT", "CRON", "WEBHOOK"] },
    mode: { type: "string", enum: ["PRODUCTION", "TEST"] },
    status: { type: "string", enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] },
    initiator: { ...ANY, description: "What admitted the run: a principal (`{ type, id }`), a CRON occurrence (`{ type: \"CRON\", scheduledAt }`), a data event, a webhook, a calling workflow." },
    executor: { ...ANY, description: "The principal whose permissions the run executes under." },
    result: ANY,
    error: { ...ANY, description: "`{ code, message }` when the run failed, was interrupted (deadline) or was skipped." },
    hasHandledErrors: { type: "boolean", description: "The run followed at least one connected `error` output - it may still have SUCCEEDED." },
    historyEnabled: { type: "boolean" },
    historyLevel: HISTORY_LEVEL,
    startedAt: nullable(DATE_TIME),
    finishedAt: nullable(DATE_TIME),
    expiresAt: { ...DATE_TIME, description: "Deadline: no step starts after it, and a run still RUNNING past it ends INTERRUPTED." },
    createdAt: DATE_TIME,
  }),
  WorkflowRunStep: object({
    id: UUID,
    run: UUID,
    operation: UUID,
    operationType: { type: "string" },
    configurationVersion: { type: "integer" },
    sequence: { type: "integer" },
    predecessor: nullable(UUID),
    status: { type: "string", enum: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] },
    selectedOutput: { type: ["string", "null"], description: "The control output the step took (`next`, `error`, `true`, ...)." },
    input: ANY,
    result: ANY,
    error: ANY,
    startedAt: DATE_TIME,
    finishedAt: nullable(DATE_TIME),
  }),
  WorkflowRunOutcome: {
    ...object({ run: ref("WorkflowRun"), steps: arrayOf(ref("WorkflowRunStep")) }),
    description:
      "A run and its steps in execution order. Answered by a test-run/run, `run.result`/`run.error` and the steps' payloads are the live, " +
      "unredacted values (null when there is none); read back later, they are what the history level stored.",
  },
};
