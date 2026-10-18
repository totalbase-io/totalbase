import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { checkConstraintValues, columnFormInput, columnValueKind, COLUMN_INPUT_KEYS, type ColumnInputKey } from "@totalbase/tb-catalog";
import type { AdminClient } from "./admin-client.js";
import { FULL_POLICY, refuseDestructive, type McpPolicy } from "./policy.js";
import { ADDITIVE, columnSchema, confirmFlag, DESTRUCTIVE, filterForStorage, findResource, IDEMPOTENT, READ_ONLY, result, schemaName, toColumnDefinition, type ResourceRow } from "./tool-helpers.js";

/**
 * A table's structure and presentation, read and changed
 * (Specification_Administration.md §11.3, Specification_DataViews.md §15):
 * describe_table before a change, alter_table for an ordered batch of changes
 * applied all or none by TotalBase's schema management, and how a column and
 * a row show wherever TotalBase displays them.
 */

interface CatalogColumn { name: string; dataType: string; domain?: string | null; nullable: boolean; isIdentity: boolean; isGenerated: boolean; defaultExpression: string | null }
interface CatalogRelationDetail {
  columns: CatalogColumn[];
  primaryKey: string[];
  relations: { name: string; sourceColumn: string; targetSchema: string; targetTable: string; targetColumn: string; message?: string | null }[];
  uniqueConstraints: string[][];
  uniqueConstraintNames: string[];
  uniqueConstraintMessages?: (string | null)[];
  checkConstraints: { name: string; expression: string; message?: string | null }[];
}
interface CatalogIndex { name: string; columns: string[]; isUnique: boolean; isPrimary: boolean; method: string; predicate?: string | null }
interface ColumnPresentation { columnName: string; presentation: Record<string, unknown>; inherited?: Record<string, unknown> }

/** A presentation as stored: its conditions' filters take values as text, as every stored filter does (filterForStorage). */
function presentationForStorage<P extends { conditions?: unknown }>(presentation: P): P {
  if (!Array.isArray(presentation.conditions)) return presentation;
  return {
    ...presentation,
    conditions: presentation.conditions.map((condition: unknown) =>
      condition && typeof condition === "object" && "where" in condition ? { ...condition, where: filterForStorage((condition as { where: unknown }).where) } : condition,
    ),
  };
}

/** A type the App edits only as text - no widget of its own (a range, an interval, a network address...) - though not a text type. */
function plainTextOnly(dataType: string, isForeignKey: boolean): boolean {
  if (isForeignKey || columnValueKind(dataType, null) !== "text") return false;
  return !/^(text|character varying|varchar|character|char|citext|name|uuid)\b/i.test(dataType);
}

const nonEmpty = (value: Record<string, unknown> | null | undefined) => (value && Object.keys(value).length > 0 ? value : undefined);

/** The relation as an agent needs it to plan a change - compact, every constraint named, with how each column shows. */
async function describeRelation(client: AdminClient, resource: ResourceRow & { row_presentation?: Record<string, unknown> }) {
  const base = { schema: resource.schema, name: resource.name, type: resource.type, exposedMethods: resource.exposed_methods, ...(resource.description && { description: resource.description }) };
  if (resource.type === "FUNCTION") {
    return { ...base, ...(await client.get<Record<string, unknown>>(`/catalog/function/${resource.id}`)) };
  }
  const isView = resource.type === "VIEW";
  const [detail, indexes, presentations, ddl] = await Promise.all([
    client.get<CatalogRelationDetail>(`/catalog/${isView ? "view" : "table"}/${resource.id}`),
    isView ? Promise.resolve([] as CatalogIndex[]) : client.get<CatalogIndex[]>(`/catalog/table/${resource.id}/indexes`),
    client.get<ColumnPresentation[]>(`/resources/${resource.id}/columns`).catch(() => [] as ColumnPresentation[]),
    isView ? client.get<{ ddl: string }>(`/catalog/view/${resource.id}/ddl`).catch(() => undefined) : Promise.resolve(undefined),
  ]);
  const byColumn = new Map(presentations.map((p) => [p.columnName, p]));
  const checks = detail.checkConstraints.map((k) => k.expression);
  const checkValues = (column: string) => checkConstraintValues(column, checks);
  const formInput = (c: CatalogRelationDetail["columns"][number]) => {
    const stored = byColumn.get(c.name);
    const input = columnFormInput({
      name: c.name,
      dataType: c.dataType,
      foreignKey: detail.relations.find((r) => r.sourceColumn === c.name) ?? null,
      checks: detail.checkConstraints.map((k) => ({ expression: k.expression, message: k.message ?? null })),
      input: (stored?.presentation?.["input"] ?? stored?.inherited?.["input"]) as string | undefined,
      linkType: (stored?.presentation?.["linkType"] ?? stored?.inherited?.["linkType"]) as string | undefined,
    });
    return { input: input.input, widget: input.widget, ...(Object.keys(input.props).length > 0 && { widgetProps: input.props }), inputReason: input.reason };
  };
  return {
    ...base,
    columns: detail.columns.map((c) => ({
      name: c.name,
      type: c.dataType,
      // A domain's column: `type` is its base type, edited as one; the domain's CHECK is PostgreSQL's.
      ...(c.domain && { domain: c.domain }),
      nullable: c.nullable,
      ...(c.defaultExpression !== null && { default: c.defaultExpression }),
      ...(c.isIdentity && { identity: true }),
      ...(c.isGenerated && { generated: true }),
      // The input every form edits it with - columnFormInput, as the server resolves a form field that follows its column (M26).
      ...formInput(c),
      // A CHECK (col IN (...)) list: a DataView's form edits it with a select of these values - whatever its stored widget says.
      ...(!isView && checkValues(c.name) && { values: checkValues(c.name) }),
      ...(plainTextOnly(c.dataType, detail.relations.some((r) => r.sourceColumn === c.name)) && { editedAs: "plain text - the App has no input of its own for this type; values are typed in PostgreSQL's literal form" }),
      ...(nonEmpty(byColumn.get(c.name)?.presentation) && { presentation: byColumn.get(c.name)!.presentation }),
      // A view's column that is a table's: what it shows from that column, under its own presentation.
      ...(nonEmpty(byColumn.get(c.name)?.inherited) && { inheritedPresentation: byColumn.get(c.name)!.inherited }),
    })),
    ...(!isView && {
      primaryKey: detail.primaryKey,
      foreignKeys: detail.relations.map((r) => ({ name: r.name, column: r.sourceColumn, references: `${r.targetSchema}.${r.targetTable}.${r.targetColumn}`, message: r.message ?? null })),
      unique: detail.uniqueConstraints.map((columns, i) => ({ name: detail.uniqueConstraintNames[i], columns, message: detail.uniqueConstraintMessages?.[i] ?? null })),
      checks: detail.checkConstraints.map((c) => ({ name: c.name, expression: c.expression, message: c.message ?? null })),
      // A partial index's WHERE: "unique (cliente) WHERE principal" is one principal contact per customer, not one contact.
      indexes: indexes.filter((i) => !i.isPrimary).map((i) => ({ name: i.name, columns: i.columns, unique: i.isUnique, method: i.method, ...(i.predicate && { where: i.predicate }) })),
    }),
    ...(nonEmpty(resource.row_presentation) && { rowPresentation: resource.row_presentation }),
    ...(ddl && { definition: ddl.ddl }),
  };
}

const identifier = z.string().describe("A PostgreSQL identifier: a letter or underscore, then letters, digits or underscores");

const operationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("rename_table"), new_name: identifier }),
  z.object({ kind: z.literal("add_column"), column: columnSchema }),
  z.object({
    kind: z.literal("alter_column"),
    column: z.string(),
    rename: identifier.optional(),
    data_type: z.string().optional().describe("New type (PostgreSQL's implicit cast, no USING) - fails if a value doesn't convert"),
    nullable: z.boolean().optional().describe("false: SET NOT NULL (fails if a row holds NULL); true: DROP NOT NULL"),
    default: z.string().nullable().optional().describe("New DEFAULT expression, or null to drop it"),
  }),
  z.object({ kind: z.literal("drop_column"), column: z.string(), cascade: z.boolean().optional() }),
  z.object({ kind: z.literal("set_primary_key"), columns: z.array(z.string()).min(1) }),
  z.object({ kind: z.literal("add_unique"), columns: z.array(z.string()).min(1).describe("Several columns: unique together"), name: z.string().optional() }),
  z.object({
    kind: z.literal("add_foreign_key"),
    column: z.string(),
    references_schema: z.string(),
    references_table: z.string(),
    references_column: z.string().default("id"),
    on_delete: z.enum(["CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"]).optional(),
    on_update: z.enum(["CASCADE", "RESTRICT", "SET NULL", "SET DEFAULT", "NO ACTION"]).optional(),
    name: z.string().optional(),
  }),
  z.object({
    kind: z.literal("add_check"),
    name: z.string(),
    expression: z.string().describe("A boolean SQL expression, e.g. 'price > 0' - never a full statement; existing rows must satisfy it"),
    message: z.string().optional().describe("What a user reads under the field when a write breaks it, e.g. 'The CUIT goes with hyphens: 30-12345678-9' - without one they read PostgreSQL's 'violates check constraint ...'"),
  }),
  z.object({ kind: z.literal("set_constraint_message"), name: z.string().describe("A CHECK, UNIQUE or FOREIGN KEY constraint's name - an inline column CHECK's too (describe_table lists them)"), message: z.string().nullable().describe("The message a user reads when a write breaks it; null removes it") }),
  z.object({ kind: z.literal("drop_constraint"), name: z.string().describe("A UNIQUE, FOREIGN KEY or CHECK constraint's name (describe_table lists them)") }),
  z.object({
    kind: z.literal("create_index"),
    columns: z.array(z.string()).min(1),
    name: z.string().optional(),
    method: z.enum(["btree", "hash", "gin", "gist", "brin"]).optional().describe("btree (default) for equality, ranges and sorting; gin for jsonb, arrays and full text; gist for geometry (point)"),
    unique: z.boolean().optional(),
    where: z.string().optional().describe("Partial index condition"),
    concurrently: z.boolean().optional().describe("Doesn't lock writes on a large table; can't run with other operations in the same batch"),
  }),
  z.object({ kind: z.literal("drop_index"), name: z.string(), concurrently: z.boolean().optional() }),
]);
type Operation = z.infer<typeof operationSchema>;

const DROPS = new Set<Operation["kind"]>(["drop_column", "drop_constraint", "drop_index"]);

/** The tool's operation (snake_case) as the Admin API's SchemaEditOperation (camelCase). */
function toEditOperation(op: Operation): Record<string, unknown> {
  switch (op.kind) {
    case "rename_table":
      return { kind: op.kind, newName: op.new_name };
    case "add_column":
      return { kind: op.kind, column: toColumnDefinition(op.column) };
    case "alter_column":
      return {
        kind: op.kind,
        column: op.column,
        patch: {
          ...(op.rename !== undefined && { rename: op.rename }),
          ...(op.data_type !== undefined && { dataType: op.data_type }),
          ...(op.nullable !== undefined && { nullable: op.nullable }),
          ...(op.default !== undefined && { default: op.default }),
        },
      };
    case "add_foreign_key":
      return {
        kind: op.kind,
        column: op.column,
        targetSchema: op.references_schema,
        targetTable: op.references_table,
        targetColumn: op.references_column,
        ...(op.on_delete && { onDelete: op.on_delete }),
        ...(op.on_update && { onUpdate: op.on_update }),
        ...(op.name && { name: op.name }),
      };
    default:
      return op;
  }
}

const OPTION_COLORS = ["primary", "secondary", "success", "info", "warning", "error", "neutral"] as const;

const PRESENTATION_KEYS = {
  label: z.string().optional().describe("The column's display name, e.g. 'Due date' for due_at"),
  shortLabel: z.string().max(32).optional().describe("A list's header where room is short, e.g. 'Qty.' (32) - filters, exports and forms keep the label"),
  description: z.string().optional().describe("What the column holds - under the field's label in forms (256)"),
  help: z
    .string()
    .optional()
    .describe("Text under the input, in every form that edits it (256) - not a tooltip. A page's form field shows it unless it sets help \"\" (none)"),
  placeholder: z.string().optional(),
  icon: z.string().optional().describe("A Lucide icon, e.g. 'i-lucide-mail'"),
  iconPosition: z.enum(["leading", "trailing"]).optional(),
  displayFormat: z.string().optional().describe("A date-fns pattern for dates ('dd/MM/yyyy'); for numbers a pattern: '#,##0.00', '0' (no thousands separator), '$ #,##0.00', 'CURRENCY:ARS', '0.0%' (the value already in percent - % never multiplies), '#,##0.00;(#,##0.00);\"-\"' (positive;negative;zero) - totalbase://guide/dataviews"),
  emptyText: z.string().optional().describe("Shown instead of an empty value, e.g. '—'"),
  booleanLabels: z.object({ true: z.string(), false: z.string() }).optional().describe("e.g. {true:'Paid', false:'Pending'}"),
  linkType: z.enum(["url", "email", "tel"]).optional().describe("Shows the value as a link"),
  align: z.enum(["left", "center", "right"]).optional(),
  fontSize: z.enum(["xs", "sm", "base", "lg"]).optional(),
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  mono: z.boolean().optional(),
  underline: z.boolean().optional(),
  strike: z.boolean().optional(),
  color: z.string().optional().describe("A palette hue for its cells' text: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose"),
  options: z
    .record(z.string(), z.object({ label: z.string().optional(), color: z.enum(OPTION_COLORS).optional(), icon: z.string().optional() }))
    .optional()
    .describe("For a column with a CHECK IN list: how each value shows, e.g. {\"OPEN\":{\"label\":\"Open\",\"color\":\"info\"},\"DONE\":{\"label\":\"Done\",\"color\":\"success\"}}"),
  background: z.string().optional().describe("A palette hue tinting its cells' background - the same hues as color"),
  conditions: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe("How it looks when something holds, first that holds wins: [{\"name\":\"Overdue\",\"where\":{\"due_at\":{\"_lt\":\"$CURRENT_DATE\"}},\"applyTo\":\"cell\"|\"row\",\"style\":{\"color\":\"red\",\"bold\":true}}] - totalbase://guide/dataviews"),
  input: z
    .enum(COLUMN_INPUT_KEYS as unknown as [ColumnInputKey, ...ColumnInputKey[]])
    .optional()
    .describe(`Its control - every form edits it with it, a form field follows it unless it picks its own: one of the column input catalog that edits its type (totalbase://guide/modeling, "Column controls"): ${COLUMN_INPUT_KEYS.join(", ")}. Unset: Automatic - by type and constraints (a foreign key relation-search, a CHECK list choice, a whole number in a CHECK range up to 100 number-stepper, another number number-field, a text by its link type or CHECK pattern email/url, else text). describe_table says which (input, inputReason). password only at creation. A wrong one is refused with the valid ones`),
};
/** Each key may be null - with merge: true, a null unsets it (M22). */
const presentationSchema = z
  .object(Object.fromEntries(Object.entries(PRESENTATION_KEYS).map(([key, schema]) => [key, schema.nullable()])) as {
    [K in keyof typeof PRESENTATION_KEYS]: z.ZodNullable<(typeof PRESENTATION_KEYS)[K]>;
  })
  // Not stripped: a key it doesn't know reaches the server, which refuses it naming the valid ones.
  .loose()
  .describe("Replaces the column's whole presentation - send every key it should keep; {} clears it");

export function registerSchemaTools(server: McpServer, client: AdminClient, policy: McpPolicy = FULL_POLICY): void {
  server.registerTool(
    "describe_table",
    {
      title: "Describe table",
      description:
        "A table's, view's or function's structure. Table: columns (type, nullable, default, identity/generated, input - its control, a column input catalog entry, with the widget and widgetProps it is and inputReason: chosen, file, relation, check-list, small-range, number, link-type, pattern or default -, presentation, values - a CHECK IN list's, which a DataView's form shows as a select), primary key, foreign keys, UNIQUE and CHECK constraints (named - drop_constraint takes the name), indexes, row presentation and exposed methods. View: its columns and definition. Function: its parameters and return shape. Read it before changing a table or building on it.",
      inputSchema: { schema: schemaName(), name: z.string().describe("Table, view or function name") },
      annotations: READ_ONLY,
    },
    async ({ schema, name }) => result(await describeRelation(client, await findResource(client, schema, name))),
  );

  server.registerTool(
    "alter_table",
    {
      title: "Alter table",
      description:
        "Change an existing table: an ordered list of operations - rename_table, add_column, alter_column, drop_column, set_primary_key, add_unique, add_foreign_key, add_check (with its message), set_constraint_message, drop_constraint, create_index, drop_index - applied in one transaction, all or none, by PostgreSQL's own rules (a NOT NULL column without a default can't be added to a table with rows; a CHECK or UNIQUE fails if existing rows break it). The table keeps its resource, exposure and grants (same OID) - but a new column must be granted to roles that should see it (grant_permission fields). preview=true answers the SQL without running it. A list with a drop (drop_column, drop_constraint, drop_index) needs confirm=true. Answers what it applied and the table's columns, constraints and indexes by name (the names PostgreSQL generated included) - verbose=true (or describe_table) for the whole structure.",
      inputSchema: {
        schema: schemaName(),
        name: z.string(),
        operations: z.array(operationSchema).min(1),
        preview: z.boolean().optional().describe("Answer the statements without running them"),
        confirm: confirmFlag().describe("Required when the list drops something - ask the user first"),
        verbose: z.boolean().optional().describe("Answer the whole structure afterwards, as describe_table"),
      },
      annotations: DESTRUCTIVE,
    },
    async ({ schema, name, operations, preview, confirm, verbose }) => {
      const drops = operations.filter((op) => DROPS.has(op.kind)).map((op) => op.kind);
      if (!preview && drops.length > 0) refuseDestructive(policy, `Dropping (${drops.join(", ")})`);
      if (!preview && drops.length > 0 && confirm !== true) {
        throw new Error(`This list drops something (${drops.join(", ")}) - irreversible: pass confirm=true, or preview=true to see the SQL first.`);
      }
      const path = `/schema/${encodeURIComponent(schema)}/tables/${encodeURIComponent(name)}/edit`;
      const body = { data: { operations: operations.map(toEditOperation) } };
      if (preview) return result(await client.post(`${path}/preview`, body));
      await client.post(path, body);
      const renamed = operations.reduce<string>((current, op) => (op.kind === "rename_table" ? op.new_name : current), name);
      const resource = await findResource(client, schema, renamed, "TABLE");
      const table = await describeRelation(client, resource);
      if (verbose || !("columns" in table)) return result(table);
      // Every column's input and widget for each of a dozen alter_table calls cost 3-5k tokens apiece: the names
      // say what changed and what PostgreSQL called it; describe_table has the rest.
      const names = (list: { name?: string | undefined }[] | undefined) => (list ?? []).map((item) => item.name);
      return result({
        table: `${schema}.${renamed}`,
        resourceId: resource.id,
        applied: operations.map((op) => op.kind),
        columns: table.columns.map((c) => c.name),
        ...("primaryKey" in table && {
          primaryKey: table.primaryKey,
          foreignKeys: names(table.foreignKeys),
          unique: names(table.unique),
          checks: names(table.checks),
          indexes: names(table.indexes),
        }),
      });
    },
  );

  server.registerTool(
    "create_schema",
    {
      title: "Create schema",
      description: "Create a PostgreSQL schema, to group a module's tables apart from 'public' (e.g. 'sales', 'hr'). Its tables are addressed as schema + name everywhere; dashboard SQL must qualify them (\"sales\".orders).",
      inputSchema: { name: identifier },
      annotations: ADDITIVE,
    },
    async ({ name }) => result(await client.post("/schema", { data: { name } })),
  );

  server.registerTool(
    "set_column_presentation",
    {
      title: "Set column presentation",
      description:
        "How a column shows wherever TotalBase displays it - its label, help, format, empty text, the labels and colors of a CHECK list's values, link type, alignment, emphasis. Every DataView shows it (drafts at once, published ones when republished) - a DataView's column has none of its own; a form field may set its own label, description and help. Presentation only: what values are valid stays PostgreSQL's (NOT NULL, CHECK). Set it after creating a table so its screens read well: a label per column, options for each status value.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("Table or view name"),
        column: z.string(),
        presentation: presentationSchema,
        merge: z.boolean().optional().describe("true: only the keys given change, the rest of its presentation stays (a key set to null is unset); default: the presentation given is all of it"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ schema, name, column, presentation: given, merge }) => {
      const resource = await findResource(client, schema, name);
      const presentation = presentationForStorage(given);
      const saved = merge
        ? (await client.post<ColumnPresentation[]>(`/resources/${resource.id}/columns/suggested-presentation`, { data: { columns: { [column]: presentation } } }))[0]!
        : await client.put<ColumnPresentation>(`/resources/${resource.id}/columns/${encodeURIComponent(column)}/presentation`, { data: { presentation } });
      return result({ resource: `${schema}.${name}`, column: saved.columnName, presentation: saved.presentation });
    },
  );

  server.registerTool(
    "suggest_presentation",
    {
      title: "Suggest presentation",
      description:
        "What a table's or view's columns' types and constraints suggest for their presentation - never their names: a unique whole number monospaced (a code: 3000, not 3.000), a nullable column's empty text, an example a CHECK pattern accepts, an email or URL pattern's link and icon, each CHECK list value's label, COMMENT ON COLUMN as the description - and its row presentation (its first unique, required text) when it has none. Nothing is applied: each suggestion has its reason, and `replaces` when the column has its own value (a change - ask the user). Apply the ones wanted with set_column_presentation merge: true (or set_column_presentations). Labels: a column's name humanized is already its default - set one only to say something else.",
      inputSchema: { schema: schemaName(), name: z.string().describe("Table or view name") },
      annotations: READ_ONLY,
    },
    async ({ schema, name }) => {
      const resource = await findResource(client, schema, name);
      return result(await client.get(`/resources/${resource.id}/columns/suggested-presentation`));
    },
  );

  server.registerTool(
    "set_column_presentations",
    {
      title: "Set column presentations",
      description:
        "set_column_presentation for several columns of one table in one call - each column's whole presentation, or with merge: true only the keys given; every one checked before any is written (all or none). A column left out is untouched. The way to present a new table: a label per column, options for each CHECK list.",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("Table or view name"),
        columns: z.record(z.string(), presentationSchema).describe("Each column's name → its presentation"),
        merge: z.boolean().optional().describe("true: only the keys given change in each column, the rest of its presentation stays (a key set to null is unset); default: each presentation given is all of it"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ schema, name, columns: given, merge }) => {
      const resource = await findResource(client, schema, name);
      const columns = Object.fromEntries(Object.entries(given).map(([column, presentation]) => [column, presentationForStorage(presentation)]));
      const saved = merge
        ? await client.post<ColumnPresentation[]>(`/resources/${resource.id}/columns/suggested-presentation`, { data: { columns } })
        : await client.put<ColumnPresentation[]>(`/resources/${resource.id}/columns/presentation`, { data: { columns } });
      // Merged: what each column's presentation became. Replaced: the columns it wrote - their presentations are the
      // ones just given, echoed back for every column of a table otherwise (describe_table reads them).
      return result({ resource: `${schema}.${name}`, columns: merge ? saved.map((c) => ({ column: c.columnName, presentation: c.presentation })) : saved.map((c) => c.columnName) });
    },
  );

  server.registerTool(
    "set_row_presentation",
    {
      title: "Set row presentation",
      description:
        "How a row of this table shows wherever a foreign key points at it - in a select, a grid cell, a card: one column (display_field, e.g. 'name') or a template over several ('{{name}} ({{country}})'). Without it a foreign key shows the referenced row's key. Set it on every table other tables point at (customers, products, stages).",
      inputSchema: {
        schema: schemaName(),
        name: z.string().describe("The referenced table or view"),
        display_field: z.string().optional().describe("The column shown instead of the key"),
        display_template: z.string().optional().describe("Several columns, e.g. '{{code}} - {{name}}'; wins over display_field"),
      },
      annotations: IDEMPOTENT,
    },
    async ({ schema, name, display_field, display_template }) => {
      const resource = await findResource(client, schema, name);
      const saved = await client.put(`/resources/${resource.id}/row-presentation`, {
        data: { ...(display_field && { displayField: display_field }), ...(display_template && { displayTemplate: display_template }) },
      });
      return result({ resource: `${schema}.${name}`, rowPresentation: saved });
    },
  );
}
