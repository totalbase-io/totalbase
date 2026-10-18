import { errorResponses, operationId } from "./common-components.js";
import type { JsonSchema, OperationObject, PathItem } from "./openapi-types.js";

/**
 * One enabled, published workflow the viewer may invoke (its INVOKE grant
 * resolved by the caller), reduced to what its HTTP surface depends on -
 * the Start step's trigger configuration.
 */
export interface WorkflowEndpoint {
  slug: string;
  name: string;
  description: string | null;
  /** MANUAL/CRON -> POST .../run; WEBHOOK -> .../webhook with its own method/access/response mode. */
  trigger: "MANUAL" | "CRON" | "WEBHOOK";
  method: "GET" | "POST";
  access: "PUBLIC" | "AUTHENTICATED";
  responseMode: "SYNC" | "ASYNC";
}

const TAG = "workflows";

/**
 * A run's outcome, as the run, synchronous webhook and run-result routes
 * return it (@totalbase/workflows WorkflowRunResult) - never its steps
 * (Specification_Workflows.md §13).
 */
const RUN_RESULT: JsonSchema = {
  type: "object",
  required: ["id", "status", "result", "error"],
  properties: {
    id: { type: "string", format: "uuid" },
    status: { type: "string", enum: ["PENDING", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"] },
    result: { description: "What the workflow's Finish step returned; null when it failed or was canceled." },
    error: {
      type: ["object", "null"],
      properties: { code: { type: "string" }, message: { type: "string" } },
      description: "The failure, `{ code, message }`; null unless the run failed.",
    },
  },
};

const RUN_RESULT_RESPONSE = { type: "object", properties: { data: { $ref: "#/components/schemas/WorkflowRunResult" } } } as const;

const outcome = (status: "200" | "202"): OperationObject["responses"][string] =>
  status === "202"
    ? {
        description: "Accepted - the run continues in the background; poll its result with the run id.",
        content: { "application/json": { schema: { type: "object", properties: { data: { type: "object", properties: { run: { type: "string", format: "uuid" } } } } } } },
      }
    : { description: "OK - the run's outcome; a failed run is still 200 (read `status`).", content: { "application/json": { schema: RUN_RESULT_RESPONSE } } };

/**
 * Paths for the workflows a viewer may invoke - one concrete path per
 * workflow (its slug, not a `{slug}` template), the same way each table is
 * its own path. The run-result route is added once any listed workflow can
 * produce a run the caller could later look up.
 */
export function buildWorkflowPaths(workflows: WorkflowEndpoint[]): { paths: Record<string, PathItem>; schemas: Record<string, JsonSchema> } {
  const paths: Record<string, PathItem> = {};
  const describe = (workflow: WorkflowEndpoint) => ({
    summary: workflow.name,
    ...(workflow.description ? { description: workflow.description } : {}),
    tags: [TAG],
  });

  for (const workflow of workflows) {
    if (workflow.trigger === "WEBHOOK") {
      const method = workflow.method.toLowerCase() as "get" | "post";
      paths[`/api/workflows/${workflow.slug}/webhook`] = {
        [method]: {
          operationId: operationId("webhook", workflow.slug),
          ...describe(workflow),
          ...(method === "post"
            ? { requestBody: { required: false, content: { "application/json": { schema: { type: ["object", "array"] } } } } }
            : {}),
          responses: {
            ...errorResponses(["409", "422", "413"]),
            ...(workflow.responseMode === "SYNC"
              ? {
                  "504": {
                    description:
                      "WORKFLOW_SYNC_TIMEOUT: the run didn't finish within the configured wait; it keeps going (or is cancelled, per the workflow's timeout action). `meta.run` is its id.",
                    content: {
                      "application/json": {
                        schema: {
                          allOf: [
                            { $ref: "#/components/schemas/Error" },
                            { type: "object", properties: { meta: { type: "object", properties: { run: { type: "string", format: "uuid" } } } } },
                          ],
                        },
                      },
                    },
                  },
                }
              : {}),
            [workflow.responseMode === "ASYNC" ? "202" : "200"]: outcome(workflow.responseMode === "ASYNC" ? "202" : "200"),
          },
          ...(workflow.access === "PUBLIC" ? { security: [] } : {}),
        },
      };
    } else {
      paths[`/api/workflows/${workflow.slug}/run`] = {
        post: {
          operationId: operationId("run", workflow.slug),
          ...describe(workflow),
          // { data: input } - the workflow reads it as {{start.data}}.
          requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { data: {} } } } } },
          responses: { ...errorResponses(["409", "422", "413"]), "200": outcome("200") },
        },
      };
    }
  }

  if (workflows.length > 0) {
    paths["/api/workflows/runs/{runId}/result"] = {
      get: {
        operationId: "get_workflow_run_result",
        summary: "Get the final result of a run you started",
        description: "Available to the run's initiator for 24 hours.",
        tags: [TAG],
        parameters: [{ name: "runId", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
        responses: {
          ...errorResponses(),
          "200": { description: "OK", content: { "application/json": { schema: RUN_RESULT_RESPONSE } } },
        },
      },
    };
  }

  return { paths, schemas: workflows.length > 0 ? { WorkflowRunResult: RUN_RESULT } : {} };
}
