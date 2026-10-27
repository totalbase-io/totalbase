import { parseFilter } from "@totalbase/query-engine";
import { fixedExposure } from "./reconcile-resources.js";
import { SINGLE_COLUMN_KEY_SQL, syncRealtimePublication } from "./realtime-publication.js";
import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { getRelationDetail } from "@totalbase/pg-catalog";
import {
  COLUMN_PRESENTATION_KEYS,
  columnFormInput,
  columnInputsFor,
  columnPresentationOptions,
  columnValueKind,
  pickColumnPresentation,
  validateColumnPresentation,
  validateRowPresentation,
  type ColumnFormInput,
  type ColumnInputKey,
  type ColumnPresentation,
  type RowPresentation,
  type ForeignKeyTarget,
} from "@totalbase/tb-catalog";
import { suggestPresentation, type ColumnSuggestions, type RowSuggestion } from "./presentation-rules.js";

/** One column of a resource's default order (Foundations.md §11.7). */
export interface DefaultSortEntry {
  column: string;
  direction: "asc" | "desc";
}

/** The default order as sent, checked against the resource's columns - the clean list, or INVALID_QUERY naming the problem. */
export function validateDefaultSort(input: unknown, columns: readonly string[]): DefaultSortEntry[] {
  if (!Array.isArray(input)) throw new TotalBaseError("INVALID_QUERY", "defaultSort must be a list of { column, direction }.");
  const seen = new Set<string>();
  return input.map((entry) => {
    const column = typeof entry === "object" && entry !== null ? (entry as { column?: unknown }).column : undefined;
    const direction = typeof entry === "object" && entry !== null ? (entry as { direction?: unknown }).direction : undefined;
    if (typeof column !== "string" || !columns.includes(column)) throw new TotalBaseError("INVALID_QUERY", `defaultSort names a column the resource doesn't have: ${String(column)}.`);
    if (direction !== "asc" && direction !== "desc") throw new TotalBaseError("INVALID_QUERY", `defaultSort direction must be asc or desc (${column}).`);
    if (seen.has(column)) throw new TotalBaseError("INVALID_QUERY", `defaultSort names ${column} twice.`);
    seen.add(column);
    return { column, direction };
  });
}

export type DataApiMethod = "GET" | "POST" | "PATCH" | "DELETE" | "REALTIME";

/**
 * What the Data API offers per resource type (Foundations.md §11.5) - the ceiling `exposed_methods` can select
 * from: the HTTP verbs, and a table's realtime subscriptions (`REALTIME`, Data_API.md §16).
 */
export const APPLICABLE_METHODS: Record<"TABLE" | "VIEW" | "FUNCTION", DataApiMethod[]> = {
  TABLE: ["GET", "POST", "PATCH", "DELETE", "REALTIME"],
  VIEW: ["GET"],
  FUNCTION: ["POST"],
};

export interface AdminResource {
  id: string;
  postgresOid: number;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  status: "ACTIVE" | "MISSING";
  /** Which of APPLICABLE_METHODS[type] are actually mounted - a hard ceiling below role permissions, e.g. "DELETE never exists for this table, regardless of who's asking." A resource is exposed iff this is non-empty; there's no separate on/off flag. */
  exposedMethods: DataApiMethod[];
  /** TotalBase's own tables: their exposure is fixed by TotalBase (Security.md §10.1), access decided by grants alone - an administrator can't change `exposedMethods`. */
  exposureFixed: boolean;
  /** TotalBase's own metadata, not a PostgreSQL `COMMENT ON` - a plain column on `resources`. */
  description: string | null;
  functionClass: "UNCLASSIFIED" | "QUERY" | "ACTION" | null;
  auditRead: boolean;
  /** A TABLE's CREATE or a FUNCTION's EXECUTE needs an Idempotency-Key (Data_API.md §9.1). Always false on a VIEW. */
  requireIdempotencyKey: boolean;
  /** How a row of this table or view shows where a foreign key points at it, inherited by every such column (DataViews.md §15.5). Always `{}` on a FUNCTION. */
  rowPresentation: RowPresentation;
  /** The order its rows come in when nobody asks for one (Foundations.md §11.7): the Data API without `order_by`, a new DataView's default. Empty: the primary key. */
  defaultSort: DefaultSortEntry[];
  createdAt: Date;
  updatedAt: Date;
}

/**
 * A column's presentation as an editor sent it, checked for a column of
 * `dataType` (a foreign key's, by its target) - the clean value, or
 * INVALID_COLUMN_PRESENTATION naming every problem. Add Column calls it
 * before creating the column, so a bad presentation never leaves a column
 * behind.
 */
/** A condition's filter - as deep as a request's may go. */
const CONDITION_FILTER_LIMITS = { maxFilterDepth: 10, maxRelationDepth: 3 };

export function parseColumnPresentation(input: unknown, dataType: string, foreignKey: ForeignKeyTarget | null): ColumnPresentation {
  const { presentation, errors } = validateColumnPresentation(input, columnValueKind(dataType, foreignKey));
  // A condition's filter is the Data API's `where` grammar - checked by its own parser, the one that runs it.
  for (const condition of presentation.conditions ?? []) {
    try {
      parseFilter(condition.where, CONDITION_FILTER_LIMITS, 0);
    } catch (error) {
      errors.push(`Condition "${condition.name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", errors.join(" "));
  return presentation;
}

/** A column's row in totalbase.resources_columns, as the Columns tab reads it. */
export interface ResourceColumn {
  columnName: string;
  /** Its presentation - its control (`input`, a COLUMN_INPUTS key) among it; `password` marks a password column. */
  presentation: ColumnPresentation;
  /** A view's column that is a table's column: that column's presentation, which it shows under its own (T67 first step). */
  inherited?: ColumnPresentation;
  /**
   * The input the rule gives it (`columnFormInput`, DataViews.md §15.2) - what Automatic edits it
   * with: the catalog entry, its widget and props, and why. Its presentation's own choice aside.
   */
  automatic?: ColumnFormInput;
  /** The catalog entries that edit it - what its Control select offers (a password column: only its own). */
  inputs?: ColumnInputKey[];
}

/**
 * A password column stays one (Security.md §2.3): its writes are hashed and its value never read, by
 * its presentation's `input` - chosen when it is created (Add Column), never changed after: another control would
 * expose the hashes, and an existing column's plain values would read as hashes.
 */
function assertPasswordInput(columnName: string, before: unknown, after: unknown): void {
  if (before === "password" && after !== "password") {
    throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", `"${columnName}" is a password column - its input stays password (its values are hashes).`);
  }
  if (before !== "password" && after === "password") {
    throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", `"${columnName}" isn't a password column - a password column is created as one (Add Column).`);
  }
}

/** Suggest presentation's review of one table or view (DataViews.md §15.6): what its types and constraints suggest. */
export interface PresentationReview {
  resourceId: string;
  columns: ColumnSuggestions[];
  /** Its row presentation, when it has none. */
  row: RowSuggestion | null;
}

/** What a reviewer accepted: per column, the keys to set (their values possibly edited); the row presentation. */
export interface PresentationReviewChoice {
  columns?: Record<string, Partial<ColumnPresentation>>;
  row?: RowPresentation;
}

interface ResourceRow {
  id: string;
  postgres_oid: number;
  schema: string;
  name: string;
  type: "TABLE" | "VIEW" | "FUNCTION";
  status: "ACTIVE" | "MISSING";
  exposed_methods: DataApiMethod[];
  description: string | null;
  function_class: "UNCLASSIFIED" | "QUERY" | "ACTION" | null;
  audit_read: boolean;
  require_idempotency_key: boolean;
  row_presentation: RowPresentation;
  default_sort: DefaultSortEntry[];
  created_at: Date;
  updated_at: Date;
}

function toAdminResource(row: ResourceRow): AdminResource {
  return {
    id: row.id,
    postgresOid: row.postgres_oid,
    schema: row.schema,
    name: row.name,
    type: row.type,
    status: row.status,
    exposedMethods: row.exposed_methods,
    exposureFixed: fixedExposure(row.schema, row.name) !== null,
    description: row.description,
    functionClass: row.function_class,
    auditRead: row.audit_read,
    requireIdempotencyKey: row.require_idempotency_key,
    rowPresentation: row.row_presentation,
    defaultSort: row.default_sort ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface UpdateResourceInput {
  exposedMethods?: DataApiMethod[] | undefined;
  /** undefined = leave untouched; null = clear it; string = set it. */
  description?: string | null | undefined;
  functionClass?: "UNCLASSIFIED" | "QUERY" | "ACTION" | undefined;
  auditRead?: boolean | undefined;
  requireIdempotencyKey?: boolean | undefined;
}

/**
 * Admin management of totalbase.resources exposure state (Administration.md §1.5:
 * "Resources" - GET/PATCH). Identity fields (postgres_oid,
 * schema, name, type, status) are never writable here; they only change
 * through reconcileResources following real PostgreSQL DDL.
 */
export class ResourcesAdminService {
  constructor(private readonly database: Database) {}

  /**
   * The application's resources - every schema but TotalBase's own
   * (`totalbase`, never exposable): how many exist, how many are exposed,
   * and how many are MISSING (their PostgreSQL object is gone - a catalog
   * refresh reconciles them).
   */
  async summary(): Promise<{ total: number; exposed: number; missing: number }> {
    const { rows } = await this.database.query<{ total: number; exposed: number; missing: number }>(
      `SELECT count(*) FILTER (WHERE status = 'ACTIVE')::int AS total,
              count(*) FILTER (WHERE status = 'ACTIVE' AND exposed_methods <> '{}')::int AS exposed,
              count(*) FILTER (WHERE status = 'MISSING')::int AS missing
       FROM totalbase.resources
       WHERE "schema" <> 'totalbase'`,
    );
    return rows[0]!;
  }

  async list(filter?: {
    schema?: string | undefined;
    type?: "TABLE" | "VIEW" | "FUNCTION" | undefined;
  }): Promise<AdminResource[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter?.schema !== undefined) {
      params.push(filter.schema);
      conditions.push(`"schema" = $${params.length}`);
    }
    if (filter?.type !== undefined) {
      params.push(filter.type);
      conditions.push(`type = $${params.length}`);
    }
    const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
    const { rows } = await this.database.query<ResourceRow>(
      `SELECT * FROM totalbase.resources${whereSql} ORDER BY "schema", name`,
      params,
    );
    return rows.map(toAdminResource);
  }

  async get(id: string): Promise<AdminResource> {
    const { rows } = await this.database.query<ResourceRow>(
      `SELECT * FROM totalbase.resources WHERE id = $1`,
      [id],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${id}`);
    return toAdminResource(row);
  }

  /** Looked up by postgres_oid (stable across renames) - used by per-object detail pages, whose route keys on the oid rather than the internal UUID. */
  async getByOid(postgresOid: number): Promise<AdminResource> {
    const { rows } = await this.database.query<ResourceRow>(
      `SELECT * FROM totalbase.resources WHERE postgres_oid = $1`,
      [postgresOid],
    );
    const row = rows[0];
    if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: oid ${postgresOid}`);
    return toAdminResource(row);
  }

  /**
   * Each column's row in totalbase.resources_columns: the widget picked for
   * it and its presentation (DataViews.md §15)
   * - keyed by column name, since every caller already has the
   * column's name from the same catalog read. A column with no row yet
   * (pg-sync hasn't seen it) is simply absent.
   */
  async listColumns(resourceId: string): Promise<ResourceColumn[]> {
    const { rows } = await this.database.query<{ name: string; config: unknown }>(
      `SELECT name, config FROM totalbase.resources_columns WHERE resource = $1`,
      [resourceId],
    );
    // A view's columns that are a table's: what they inherit from it, as PostgreSQL records each one's origin.
    const { rows: inherited } = await this.database.query<{ name: string; config: unknown }>(
      `SELECT a.attname::text AS name, totalbase.resource_column_presentation(source.id) -> sa.attname::text AS config
         FROM totalbase.resources r
         CROSS JOIN LATERAL totalbase.view_column_origins(r.postgres_oid) o
         JOIN pg_catalog.pg_attribute a ON a.attrelid = r.postgres_oid AND a.attnum = o.attnum
         JOIN totalbase.resources source ON source.postgres_oid = o.origin_relid AND source.status = 'ACTIVE'
         JOIN pg_catalog.pg_attribute sa ON sa.attrelid = o.origin_relid AND sa.attnum = o.origin_attnum
        WHERE r.id = $1 AND r.type = 'VIEW'`,
      [resourceId],
    );
    const inheritedBy = new Map(inherited.filter(row => row.config).map(row => [row.name, pickColumnPresentation(row.config)]));
    const columns: ResourceColumn[] = rows.map(row => ({
      columnName: row.name,
      presentation: pickColumnPresentation(row.config),
      ...(inheritedBy.has(row.name) && { inherited: inheritedBy.get(row.name)! }),
    }));
    for (const [name, presentation] of inheritedBy) {
      if (!columns.some(column => column.columnName === name)) columns.push({ columnName: name, presentation: {}, inherited: presentation });
    }
    // What Automatic edits each one with - the rule over its live PostgreSQL facts (its type, foreign key, CHECKs).
    const resource = await this.get(resourceId).catch(() => null);
    if (resource && resource.status === "ACTIVE" && resource.type !== "FUNCTION") {
      const detail = await getRelationDetail(this.database, resource.postgresOid);
      for (const column of columns) {
        const pg = detail.columns.find(c => c.name === column.columnName);
        if (!pg) continue;
        const relation = detail.relations.find(r => r.sourceColumn === pg.name);
        const facts = {
          name: pg.name,
          dataType: pg.dataType,
          foreignKey: relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable } : null,
          checks: detail.checkConstraints,
          linkType: column.presentation.linkType ?? column.inherited?.linkType,
        };
        column.automatic = columnFormInput(facts);
        // A password column keeps its input; no other column takes it (assertPasswordInput).
        const own = column.presentation.input ?? column.inherited?.input;
        column.inputs = own === "password" ? ["password"] : columnInputsFor(facts).filter(key => key !== "password");
      }
    }
    return columns;
  }

  /**
   * Replaces a column's presentation - what the editor sends is all of it:
   * an option left out is unset, so the views inheriting it fall back to
   * their own default. Checked against the column's current PostgreSQL type
   * (a format only on a number or a date...). Writes the row when the
   * column has none yet (a view's column, or one pg-sync hasn't seen).
   * A password column's input never changes (assertPasswordInput). Only presentation keys are replaced;
   * nothing else in `config` is touched.
   */
  async updateColumnPresentation(resourceId: string, columnName: string, input: unknown): Promise<ResourceColumn> {
    return (await this.updateColumnPresentations(resourceId, { [columnName]: input }))[0]!;
  }

  /**
   * Several columns' presentations at once (M17) - each replaced as
   * updateColumnPresentation does, every one checked before any is written,
   * all in one transaction: all or none.
   */
  async updateColumnPresentations(resourceId: string, inputs: Record<string, unknown>): Promise<ResourceColumn[]> {
    const resource = await this.get(resourceId);
    if (resource.type === "FUNCTION") {
      throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", "A function has no columns.");
    }
    if (resource.status !== "ACTIVE") {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource is missing from PostgreSQL: ${resource.schema}.${resource.name}`);
    }
    const detail = await getRelationDetail(this.database, resource.postgresOid);
    const parsed = Object.entries(inputs).map(([columnName, input]) => {
      const column = detail.columns.find(c => c.name === columnName);
      if (!column) throw new TotalBaseError("UNDEFINED_COLUMN", `Column not found: ${columnName}`);
      const relation = detail.relations.find(r => r.sourceColumn === columnName);
      const foreignKey: ForeignKeyTarget | null = relation ? { targetSchema: relation.targetSchema, targetTable: relation.targetTable } : null;
      return { column, foreignKey, presentation: parseColumnPresentation(input, column.dataType, foreignKey) };
    });

    const { rows: current } = await this.database.query<{ name: string; input: string | null }>(
      `SELECT name, config ->> 'input' AS input FROM totalbase.resources_columns WHERE resource = $1`,
      [resourceId],
    );
    const inputBefore = new Map(current.map(row => [row.name, row.input]));
    for (const { column, presentation } of parsed) {
      const before = inputBefore.get(column.name) ?? undefined;
      // A presentation sent without its input keeps a password column's (an edit of its label, its help).
      if (before === "password" && presentation.input === undefined) presentation.input = "password";
      assertPasswordInput(column.name, before, presentation.input);
    }

    return this.database.transaction(async (client) => {
      const saved: ResourceColumn[] = [];
      for (const { column, presentation } of parsed) {
        const { rows } = await client.query<{ name: string; config: unknown }>(
          `INSERT INTO totalbase.resources_columns (resource, attnum, name, config)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (resource, attnum)
           DO UPDATE SET name = EXCLUDED.name,
                         config = (totalbase.resources_columns.config - $5::text[]) || EXCLUDED.config,
                         updated_at = now()
           RETURNING name, config`,
          [resourceId, column.attnum, column.name, JSON.stringify(presentation), [...COLUMN_PRESENTATION_KEYS]],
        );
        const row = rows[0]!;
        saved.push({ columnName: row.name, presentation: pickColumnPresentation(row.config) });
      }
      return saved;
    });
  }

  /**
   * Suggest presentation (DataViews.md §15.6, T69): what each column's type and constraints suggest
   * beyond TotalBase's defaults - never by its name, never in a language (presentation-rules.ts). Every
   * difference with the column's own presentation is listed: one it lacks to fill, one it has marked a change.
   * A view's column that is a table's shows that column's presentation: nothing is suggested for it.
   */
  async suggestColumnPresentations(resourceId: string): Promise<PresentationReview> {
    const resource = await this.get(resourceId);
    if (resource.type === "FUNCTION") {
      throw new TotalBaseError("INVALID_COLUMN_PRESENTATION", "A function has no columns.");
    }
    if (resource.status !== "ACTIVE") {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource is missing from PostgreSQL: ${resource.schema}.${resource.name}`);
    }
    const detail = await getRelationDetail(this.database, resource.postgresOid);
    const columns = await this.listColumns(resourceId);
    const { rows: comments } = await this.database.query<{ name: string; comment: string }>(
      `SELECT a.attname::text AS name, col_description(a.attrelid, a.attnum) AS comment
         FROM pg_catalog.pg_attribute a
        WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped AND col_description(a.attrelid, a.attnum) IS NOT NULL`,
      [resource.postgresOid],
    );
    const { rows: rowPresentation } = await this.database.query<{ row_presentation: RowPresentation | null }>(
      `SELECT row_presentation FROM totalbase.resources WHERE id = $1`,
      [resourceId],
    );
    const review = suggestPresentation({
      detail,
      comments: Object.fromEntries(comments.map(c => [c.name, c.comment])),
      current: Object.fromEntries(columns.map(c => [c.columnName, c.presentation])),
      inherited: new Set(columns.filter(c => c.inherited).map(c => c.columnName)),
      row: rowPresentation[0]?.row_presentation ?? null,
      isView: resource.type === "VIEW",
    });
    return { resourceId, ...review };
  }

  /**
   * Applies what a reviewer accepted: each column's keys merged into its own presentation (a key set to `null`
   * unsets it), checked as any presentation is, all in one transaction; then the row presentation when given.
   */
  async applyPresentationReview(resourceId: string, choice: PresentationReviewChoice): Promise<ResourceColumn[]> {
    const current = new Map((await this.listColumns(resourceId)).map(c => [c.columnName, c.presentation]));
    const merged: Record<string, unknown> = {};
    for (const [column, keys] of Object.entries(choice.columns ?? {})) {
      const next: Record<string, unknown> = { ...(current.get(column) ?? {}) };
      for (const [key, value] of Object.entries(keys ?? {})) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      merged[column] = next;
    }
    const saved = Object.keys(merged).length > 0 ? await this.updateColumnPresentations(resourceId, merged) : [];
    if (choice.row) await this.updateRowPresentation(resourceId, choice.row);
    return saved;
  }

  /**
   * Every application table and view's review, in a line each - how many values it would fill and change -
   * for whoever installs TotalBase over an existing database (DataViews.md §15.6).
   */
  async suggestPresentationEverywhere(): Promise<{ resourceId: string; schema: string; name: string; type: "TABLE" | "VIEW"; fills: number; changes: number; row: boolean }[]> {
    const { rows } = await this.database.query<{ id: string; schema: string; name: string; type: "TABLE" | "VIEW" }>(
      `SELECT id, "schema", name, type FROM totalbase.resources
       WHERE status = 'ACTIVE' AND type IN ('TABLE', 'VIEW') AND "schema" <> 'totalbase'
       ORDER BY "schema", name`,
    );
    const summary = [];
    for (const resource of rows) {
      const review = await this.suggestColumnPresentations(resource.id);
      const all = review.columns.flatMap(c => c.suggestions);
      summary.push({
        resourceId: resource.id,
        schema: resource.schema,
        name: resource.name,
        type: resource.type,
        fills: all.filter(s => !s.replaces).length,
        changes: all.filter(s => s.replaces).length,
        row: review.row !== null,
      });
    }
    return summary;
  }

  /**
   * Fills what each column lacks, never changing a value it has - every application table and view, or those
   * of `resourceIds`; and a row presentation where there is none. The catalog sync's `autoPresentation`, and
   * Suggest presentation for a whole schema. Returns how many columns got something.
   */
  async applyPresentationFills(resourceIds?: string[]): Promise<number> {
    const ids = resourceIds ?? (await this.suggestPresentationEverywhere()).map(r => r.resourceId);
    let presented = 0;
    for (const id of ids) {
      const review = await this.suggestColumnPresentations(id);
      const columns = Object.fromEntries(review.columns
        .map(c => [c.columnName, Object.fromEntries(c.suggestions.filter(s => !s.replaces).map(s => [s.key, s.value]))] as const)
        .filter(([, keys]) => Object.keys(keys).length > 0));
      presented += (await this.applyPresentationReview(id, { columns, ...(review.row && { row: { displayField: review.row.displayField } }) })).length;
    }
    return presented;
  }

  /**
   * Replaces a table's or a view's row presentation - what the editor sends
   * is all of it, `{}` clears it. Checked against its current columns.
   * DataViews read it live on a draft and froze it on publish.
   */
  async updateRowPresentation(resourceId: string, input: unknown): Promise<RowPresentation> {
    const resource = await this.get(resourceId);
    if (resource.type === "FUNCTION") {
      throw new TotalBaseError("INVALID_ROW_PRESENTATION", "A function has no rows to present.");
    }
    if (resource.status !== "ACTIVE") {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource is missing from PostgreSQL: ${resource.schema}.${resource.name}`);
    }
    const detail = await getRelationDetail(this.database, resource.postgresOid);
    const { presentation, errors } = validateRowPresentation(input, detail.columns.map(c => c.name));
    if (errors.length > 0) throw new TotalBaseError("INVALID_ROW_PRESENTATION", errors.join(" "));
    const { rows } = await this.database.query<{ row_presentation: RowPresentation }>(
      `UPDATE totalbase.resources SET row_presentation = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING row_presentation`,
      [resourceId, JSON.stringify(presentation)],
    );
    return rows[0]!.row_presentation;
  }

  /**
   * Replaces a table's or a view's default order (Foundations.md §11.7) - every entry a column it has, each at most
   * once, `asc` or `desc`; `[]` clears it (the primary key orders then). Validated against PostgreSQL's current columns.
   */
  async updateDefaultSort(resourceId: string, input: unknown): Promise<DefaultSortEntry[]> {
    const resource = await this.get(resourceId);
    if (resource.type === "FUNCTION") throw new TotalBaseError("INVALID_QUERY", "A function has no rows to order.");
    if (resource.status !== "ACTIVE") {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource is missing from PostgreSQL: ${resource.schema}.${resource.name}`);
    }
    const detail = await getRelationDetail(this.database, resource.postgresOid);
    const sort = validateDefaultSort(input, detail.columns.map((c) => c.name));
    const { rows } = await this.database.query<{ default_sort: DefaultSortEntry[] }>(
      `UPDATE totalbase.resources SET default_sort = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING default_sort`,
      [resourceId, JSON.stringify(sort)],
    );
    return rows[0]!.default_sort;
  }

  async update(id: string, input: UpdateResourceInput): Promise<AdminResource> {
    const existing = await this.get(id);
    if (input.functionClass !== undefined && existing.type !== "FUNCTION") {
      throw new TotalBaseError("INVALID_QUERY", "functionClass only applies to FUNCTION resources.");
    }

    let exposedMethods = input.exposedMethods;
    if (exposedMethods !== undefined && existing.schema === "totalbase") {
      throw new TotalBaseError(
        "PERMISSION_DENIED",
        "The exposure of TotalBase's own tables is fixed - access to them is decided by permissions.",
      );
    }
    if (exposedMethods !== undefined) {
      const applicable = APPLICABLE_METHODS[existing.type];
      const invalid = exposedMethods.filter((m) => !applicable.includes(m));
      if (invalid.length > 0) {
        throw new TotalBaseError(
          "INVALID_QUERY",
          `exposedMethods ${JSON.stringify(invalid)} do not apply to ${existing.type} resources (allowed: ${applicable.join(", ")}).`,
        );
      }
    }

    const realtimeChanges = exposedMethods !== undefined && exposedMethods.includes("REALTIME") !== existing.exposedMethods.includes("REALTIME");
    // Subscribing is reading, and a change names its rows by a single-column primary key (Data_API.md §16.2).
    if (exposedMethods?.includes("REALTIME") && !exposedMethods.includes("GET")) {
      throw new TotalBaseError("INVALID_QUERY", "REALTIME needs GET: subscribing to a table is reading it.");
    }
    if (exposedMethods?.includes("REALTIME") && realtimeChanges) {
      if (existing.status !== "ACTIVE") throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource is missing from PostgreSQL: ${existing.schema}.${existing.name}`);
      const { rows } = await this.database.query<{ keyed: boolean }>(`SELECT ${SINGLE_COLUMN_KEY_SQL("$1::oid")} AS keyed`, [existing.postgresOid]);
      if (!rows[0]?.keyed) throw new TotalBaseError("INVALID_QUERY", "REALTIME needs a single-column primary key: a change names its rows by it.");
    }

    if (input.requireIdempotencyKey === true && existing.type === "VIEW") {
      throw new TotalBaseError("INVALID_QUERY", "requireIdempotencyKey only applies to TABLE and FUNCTION resources - a view has no write.");
    }

    const descriptionProvided = input.description !== undefined;

    await this.database.transaction(async (client) => {
      await client.query(
        `UPDATE totalbase.resources
         SET exposed_methods = coalesce($2, exposed_methods),
             function_class = coalesce($3, function_class),
             audit_read = coalesce($4, audit_read),
             description = CASE WHEN $5 THEN $6 ELSE description END,
             require_idempotency_key = coalesce($7, require_idempotency_key),
             updated_at = now()
         WHERE id = $1`,
        [
          id,
          exposedMethods ?? null,
          input.functionClass ?? null,
          input.auditRead ?? null,
          descriptionProvided,
          input.description ?? null,
          input.requireIdempotencyKey ?? null,
        ],
      );
      // The publication follows REALTIME in the same transaction: PostgreSQL refusing the table (the role
      // doesn't own it) leaves the exposure as it was.
      if (realtimeChanges) await syncRealtimePublication(client);
    });

    return this.get(id);
  }
}
