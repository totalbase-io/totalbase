import { z } from "zod";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { whereParams, type AdminClient } from "./admin-client.js";

/** What the tools share: the column shape, the resource lookup, annotations, described parameters, the result envelope. */

export const columnSchema = z.object({
  name: z.string().describe("Column name - a PostgreSQL identifier, snake_case"),
  data_type: z
    .string()
    .describe("PostgreSQL type: 'text', 'uuid', 'integer', 'bigint', 'numeric(12,2)', 'boolean', 'date', 'timestamptz', 'jsonb', 'point' (written as {lng, lat}), 'text[]' (totalbase://guide/modeling)"),
  nullable: z.boolean().optional().describe("Default true; false adds NOT NULL"),
  default: z.string().optional().describe("Raw SQL default expression, e.g. \"gen_random_uuid()\", \"now()\" or \"'ACTIVE'\" (quotes included for text)"),
  primary_key: z.boolean().optional(),
  unique: z.boolean().optional().describe("A single-column UNIQUE constraint"),
  check: z.string().optional().describe("A boolean SQL expression over the row, e.g. \"price >= 0\" or \"status IN ('OPEN','CLOSED')\" - an IN list shows as a select in DataViews"),
  check_message: z.string().optional().describe("What a user reads when a write breaks the check, e.g. 'The CUIT goes with hyphens: 30-12345678-9' - instead of PostgreSQL's 'violates check constraint'"),
  unique_message: z.string().optional().describe("What a user reads when a value repeats, e.g. 'That CUIT already has a customer'"),
  identity: z.enum(["ALWAYS", "BY DEFAULT"]).optional().describe("An identity column (integer/bigint): PostgreSQL numbers each row - an order number. ALWAYS refuses a written value. Not with default or generated"),
  generated: z.string().optional().describe("A stored generated column: PostgreSQL computes it from the row - \"quantity * price\", \"total - paid\"; never written. Not with default or identity"),
  foreign_key: z
    .object({
      references_schema: z.string(),
      references_table: z.string(),
      references_column: z.string().default("id"),
      on_delete: z.enum(["CASCADE", "RESTRICT", "SET NULL", "NO ACTION"]).optional().describe("CASCADE for owned rows (lines of an order), SET NULL for an optional link, RESTRICT to forbid deleting a referenced row"),
      message: z.string().optional().describe("What a user reads when the referenced row doesn't exist, or when deleting it is refused"),
    })
    .optional()
    .describe("The column's type must match the referenced column's (uuid for an id)"),
});

/**
 * The tool's column (its own snake_case input) as the Admin API's column
 * definition: camelCase, inside the request's `{ data }`
 * (Data_API.md §2.5).
 */
export function toColumnDefinition(column: z.infer<typeof columnSchema>) {
  return {
    name: column.name,
    dataType: column.data_type,
    nullable: column.nullable,
    default: column.default,
    primaryKey: column.primary_key,
    unique: column.unique,
    check: column.check,
    checkMessage: column.check_message,
    uniqueMessage: column.unique_message,
    foreignKeyMessage: column.foreign_key?.message,
    identity: column.identity,
    generated: column.generated,
    ...(column.foreign_key && {
      foreignKey: {
        targetSchema: column.foreign_key.references_schema,
        targetTable: column.foreign_key.references_table,
        targetColumn: column.foreign_key.references_column,
        onDelete: column.foreign_key.on_delete,
      },
    }),
  };
}

export const EXPOSE_METHODS = ["GET", "POST", "PATCH", "DELETE"] as const;

/**
 * MCP tool annotations - what a client reads to decide which calls it may
 * approve on its own. Hints, never security: TotalBase decides what is allowed.
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };
/** Changes something, but setting the same thing twice changes nothing more (a grant, an exposure, a presentation). */
export const IDEMPOTENT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Adds something new each time (a table, a row, a draft, a version). */
export const ADDITIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** May destroy data or access - guarded by confirm=true as well. */
export const DESTRUCTIVE: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

/** Described parameters, so every tool says where an id comes from. */
export const roleId = () => z.string().describe("A role's id (list_roles)");
export const schemaName = () => z.string().default("public").describe("PostgreSQL schema, 'public' unless the table was created elsewhere; TotalBase's own tables are in 'totalbase'");
export const tableName = () => z.string().describe("Table name as in PostgreSQL, e.g. 'orders' (list_resources lists them)");
/** A delete tool's target: one id, or several in one call (clearing an instance took one call per DataView). */
export const deleteTargets = () => ({
  id: z.string().optional().describe("One object's id"),
  ids: z.array(z.string()).min(1).optional().describe("Several, deleted one after the other in one call - stops at the first that fails, answering which went"),
});

/**
 * Deletes `id` or each of `ids` under `base`, in order. Not one transaction - each is its own Admin API delete -
 * so a failure says what was already deleted and what wasn't reached.
 */
export async function deleteEach(client: AdminClient, base: string, target: { id?: string | undefined; ids?: string[] | undefined }) {
  if ((target.id === undefined) === (target.ids === undefined)) throw new Error("Give id (one) or ids (several), not both.");
  const ids = target.ids ?? [target.id!];
  const deleted: string[] = [];
  for (const id of ids) {
    try {
      await client.delete(`${base}/${encodeURIComponent(id)}`);
    } catch (error) {
      if (ids.length === 1) throw error;
      throw new Error(`${error instanceof Error ? error.message : String(error)} - deleting ${id}. Deleted before it: ${deleted.join(", ") || "none"}; not reached: ${ids.slice(deleted.length + 1).join(", ") || "none"}.`);
    }
    deleted.push(id);
  }
  return target.ids ? { deleted } : { deleted: target.id };
}

/** The name rule every named object shares (validateName, Foundations.md §9.3) - said up front, not learned from a refusal. */
export const NAME_RULE = "1-32 characters: letters, digits, spaces and - _ . , : ; ( ) ' & + (no / or other symbols)";
export const confirmFlag = () => z.boolean().optional().describe("Must be true for this destructive call - ask the user first");

/** A resources row, as the Data API returns it. */
export interface ResourceRow {
  id: string;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  status: "ACTIVE" | "MISSING";
  exposed_methods: string[];
  description?: string | null;
}

export const RESOURCES = "/totalbase/table/resources";

/**
 * The ACTIVE resource of that name: a dropped table's resource stays as
 * MISSING beside the new one created with the same name, so the name alone
 * is not an identity (Foundations.md §11.3).
 */
export async function findResource(client: AdminClient, schema: string, name: string, type?: ResourceRow["type"]): Promise<ResourceRow> {
  const resources = await client.data<ResourceRow[]>("GET", RESOURCES, {
    query: whereParams({ schema: { _eq: schema }, name: { _eq: name }, status: { _eq: "ACTIVE" }, ...(type && { type: { _eq: type } }) }),
  });
  const resource = resources[0];
  if (!resource) {
    throw new Error(
      `No resource found for ${schema}.${name}${type ? ` (${type})` : ""}. If it was just created outside these tools, run sync_catalog; list_resources lists what exists.`,
    );
  }
  return resource;
}

/** A resource as the tools answer it. */
export const resourceSummary = (r: ResourceRow) => ({ id: r.id, schema: r.schema, name: r.name, type: r.type, status: r.status, exposedMethods: r.exposed_methods });

/** A tool's result: compact JSON - what the agent acts on next, not whole objects (Administration.md §11.3). */
export function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value ?? { ok: true }, null, 2) }] };
}

/** Keeps only the keys whose value isn't undefined - a PATCH body sends only what changes. */
export function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * A filter object as the grammar stores it (parseFilter): every value a
 * string, as on the wire - `true` is "true", 7 is "7", a list for _in /
 * _nin / _between comma-joined - the same spelling whereParams gives a
 * query. PostgreSQL casts each to its column's type. Anything else (a
 * nested group, an operator's object) is walked as is.
 */
export function filterForStorage(filter: unknown): unknown {
  if (Array.isArray(filter)) return filter.map(filterForStorage);
  if (filter === null || typeof filter !== "object") return filter;
  return Object.fromEntries(
    Object.entries(filter as Record<string, unknown>).map(([key, value]) => {
      if (key.startsWith("_") && key !== "_and" && key !== "_or" && key !== "_not") {
        if (Array.isArray(value)) return [key, value.map(String).join(",")];
        if (typeof value === "number" || typeof value === "boolean") return [key, String(value)];
        return [key, value];
      }
      return [key, filterForStorage(value)];
    }),
  );
}
