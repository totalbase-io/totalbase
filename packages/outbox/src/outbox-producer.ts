import type { Queryable } from "@totalbase/database";

export type OutboxEvent = "CREATE" | "UPDATE" | "DELETE" | "EXECUTE";

export interface OutboxEventInput {
  requestId: string;
  resource: string;
  event: OutboxEvent;
  payload: unknown;
  /** UPDATE: the row before the write - for matching only (Specification_Workflows.md §6.3.2). */
  oldPayload?: unknown;
  /** UPDATE: the columns whose value changed. */
  changedColumns?: string[];
  /** Where the write came from - the audit log's source (api, admin, workflow...). Defaults to "api". */
  source?: string;
  /**
   * A workflow's write (`source: "workflow"`): the workflow ids that led to it, outermost first - the DATA_EVENT
   * dispatcher's loop and depth protection (Specification_Workflows.md §6.3.4). `null` when the step opted out of
   * emitting events; omitted on any other source.
   */
  workflowAncestry?: string[] | null;
}

/**
 * Enqueues one `totalbase.outbox` row. Callers MUST pass the same
 * transaction client used for the business mutation itself ("business
 * mutation + audit + outbox event = same transaction").
 *
 * Split out of the (now-removed) `@totalbase/triggers` package into its
 * own home: the producer side (this file) is independent of whoever
 * consumes the queue - `mutation-service.ts`/`data-function.ts` don't
 * need to know or care that Workflow (not the old Triggers system) is
 * the consumer going forward.
 */
export async function enqueueOutboxEvent(client: Queryable, input: OutboxEventInput): Promise<string> {
  const [id] = await enqueueOutboxEvents(client, [input]);
  return id!;
}

/**
 * `enqueueOutboxEvent` for every row one operation wrote, in ONE statement
 * (Pre_Beta_Review 2.7). Returns the new rows' ids in the order given - the
 * eager dispatch after commit needs each one. The ids are generated in the
 * `input` CTE and read back from it, so their order is the input's by
 * construction rather than whatever `RETURNING` emits.
 */
export async function enqueueOutboxEvents(client: Queryable, inputs: OutboxEventInput[]): Promise<string[]> {
  if (inputs.length === 0) return [];
  const docs = inputs.map((input) => ({
    requestId: input.requestId,
    resource: input.resource,
    event: input.event,
    // The jsonb documents travel as JSON strings so a payload that is itself
    // `null` and an absent old payload (NULL column) stay distinct.
    payload: JSON.stringify(input.payload),
    oldPayload: input.oldPayload === undefined ? null : JSON.stringify(input.oldPayload),
    changedColumns: input.changedColumns ?? null,
    source: input.source ?? "api",
    workflowAncestry: input.workflowAncestry ?? null,
  }));
  const { rows } = await client.query<{ id: string }>(
    `WITH input AS (
       SELECT gen_random_uuid() AS id, e.ord, e.doc
       FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS e(doc, ord)
     ), inserted AS (
       INSERT INTO totalbase.outbox (id, request_id, resource, event, payload, old_payload, changed_columns, source, workflow_ancestry)
       SELECT id, (doc ->> 'requestId')::uuid, (doc ->> 'resource')::uuid, doc ->> 'event',
              (doc ->> 'payload')::jsonb, (doc ->> 'oldPayload')::jsonb,
              CASE WHEN doc -> 'changedColumns' IS NULL OR jsonb_typeof(doc -> 'changedColumns') = 'null' THEN NULL
                   ELSE ARRAY(SELECT jsonb_array_elements_text(doc -> 'changedColumns')) END,
              doc ->> 'source',
              CASE WHEN doc -> 'workflowAncestry' IS NULL OR jsonb_typeof(doc -> 'workflowAncestry') = 'null' THEN NULL
                   ELSE ARRAY(SELECT jsonb_array_elements_text(doc -> 'workflowAncestry'))::uuid[] END
       FROM input
       ORDER BY ord
     )
     SELECT id FROM input ORDER BY ord`,
    [JSON.stringify(docs)],
  );
  return rows.map((row) => row.id);
}
