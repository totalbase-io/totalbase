import type { JsonSchema } from "@totalbase/openapi";
import { arrayOf, object, ref } from "./openapi-admin-docs.js";

/**
 * `config.openapi` pieces for the Database area of the Admin API: raw
 * PostgreSQL catalog browsing (admin-catalog.ts, tag "catalog") and
 * structured DDL (admin-schema.ts, tag "schema"). Schemas mirror
 * @totalbase/pg-catalog's and @totalbase/schema's return/input types; every
 * component name is prefixed `Catalog`/`Schema` so it can't collide with
 * another area's.
 */

const STRING: JsonSchema = { type: "string" };
const BOOLEAN: JsonSchema = { type: "boolean" };
const INTEGER: JsonSchema = { type: "integer" };

/** validateIdentifier() in @totalbase/schema - unquoted-style names only, PostgreSQL quotes them. */
export const IDENTIFIER: JsonSchema = {
  type: "string",
  pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
  maxLength: 63,
  description: "A PostgreSQL identifier: starts with a letter or underscore, then letters/digits/underscores, at most 63 characters. Case is kept (TotalBase quotes it).",
};

const SQL_EXPRESSION_RULES =
  "A single SQL expression, 1-2000 characters - never a statement. Rejected: `;`, SQL comments (`--`, `/* */`), dollar-quoting (`$$`), " +
  "unbalanced parentheses and DDL/DML keywords (DROP, ALTER, CREATE, GRANT, INSERT, UPDATE, DELETE, SET, EXECUTE, ...). " +
  "TotalBase builds the surrounding DDL itself.";

const DATA_TYPE: JsonSchema = {
  type: "string",
  maxLength: 100,
  description:
    "A plain PostgreSQL type name, optionally with `(precision[,scale])` and/or `[]`: `text`, `integer`, `uuid`, `timestamptz`, " +
    "`numeric(12,2)`, `character varying(255)`, `text[]`, a user-defined enum/domain name. No expressions.",
};

const FK_ACTION: JsonSchema = { type: "string", enum: ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"] };

/** `?cascade=true` on the DROP routes. */
export const CASCADE_PARAM = {
  name: "cascade",
  in: "query" as const,
  required: false,
  schema: { type: "string", enum: ["true", "false"] },
  description: "`true` appends CASCADE: PostgreSQL also drops every object that depends on it (views, foreign keys...). Without it a dependent object fails the drop (409 DEPENDENT_OBJECTS_STILL_EXIST).",
};

/** A catalog route's `{id}`: the TotalBase resource id. */
export const RESOURCE_ID_PARAM = {
  description: "The TotalBase resource id (uuid), or the object's numeric PostgreSQL OID. Anything else, or an id that matches nothing: 404.",
  schema: STRING,
};

const INLINE_FOREIGN_KEY: JsonSchema = object(
  {
    targetSchema: IDENTIFIER,
    targetTable: IDENTIFIER,
    targetColumn: IDENTIFIER,
    onDelete: FK_ACTION,
    onUpdate: FK_ACTION,
  },
  ["targetSchema", "targetTable", "targetColumn"],
);

export const CATALOG_SCHEMAS: Record<string, JsonSchema> = {
  CatalogObject: object({
    oid: { type: "integer", description: "PostgreSQL OID - stable across a rename, new after drop + create." },
    schema: STRING,
    name: STRING,
    relationKind: { type: "string", enum: ["ordinary_table", "partitioned_table", "view", "materialized_view", "function", "procedure"] },
    resourceType: { type: "string", enum: ["TABLE", "VIEW", "FUNCTION"] },
  }),
  CatalogFunction: object({
    oid: { type: "integer", description: "PostgreSQL OID - one per overload." },
    schema: STRING,
    name: STRING,
    relationKind: { type: "string", enum: ["function"] },
    resourceType: { type: "string", enum: ["FUNCTION"] },
    arguments: { type: "string", description: "Identity arguments (pg_get_function_identity_arguments), e.g. `value integer, extra integer`; empty without parameters." },
  }),
  CatalogRelationColumns: object({
    oid: { type: "integer" },
    schema: STRING,
    name: STRING,
    resourceType: { type: "string", enum: ["TABLE", "VIEW"] },
    columns: { type: "array", items: STRING, description: "Column names in attnum order." },
  }),
  CatalogColumn: object({
    name: STRING,
    attnum: { type: "integer", description: "pg_attribute.attnum - survives a rename." },
    dataType: { type: "string", description: "format_type(), e.g. `character varying(255)`." },
    typeName: { type: "string", description: "The type alone, no modifier: `character varying`, `numeric`, `text[]`." },
    typeLength: { type: ["integer", "null"], description: "A character type's declared length (`varchar(255)` → 255)." },
    typePrecision: { type: ["integer", "null"], description: "A numeric's declared precision (`numeric(12,2)` → 12)." },
    typeScale: { type: ["integer", "null"], description: "A numeric's declared scale (`numeric(12,2)` → 2)." },
    domain: { type: ["string", "null"], description: "The domain the column is declared with (`cuit`); `dataType` and the parts are then its base type's. Null for a plain type." },
    nullable: BOOLEAN,
    isIdentity: BOOLEAN,
    isGenerated: BOOLEAN,
    defaultExpression: { type: ["string", "null"], description: "The DEFAULT as PostgreSQL renders it." },
    protected: { type: "boolean", description: "Never readable or writable through the Data API whatever a grant says (a password hash, a token hash, a file's storage key) - shown disabled in a field-grant checklist. Only on a table's or a view's detail." },
  }),
  CatalogRelationDetail: object({
    columns: arrayOf(ref("CatalogColumn")),
    primaryKey: { ...arrayOf(STRING), description: "Primary key columns, in key order; empty without one." },
    relations: {
      ...arrayOf(object({
        name: { type: "string", description: "Constraint name (what the DROP route takes)." },
        sourceColumn: STRING,
        targetSchema: STRING,
        targetTable: STRING,
        targetColumn: STRING,
        message: { type: ["string", "null"], description: "The constraint's COMMENT - the error message shown when it fails." },
      })),
      description: "Single-column foreign keys from this table. Composite ones are not listed.",
    },
    uniqueConstraints: { ...arrayOf(arrayOf(STRING)), description: "Each UNIQUE constraint's columns, in declared order." },
    uniqueConstraintNames: { ...arrayOf(STRING), description: "The name of each `uniqueConstraints` entry, same index." },
    uniqueConstraintMessages: { ...arrayOf({ type: ["string", "null"] }), description: "The COMMENT of each `uniqueConstraints` entry, same index - the error message shown when it fails; null without one." },
    checkConstraints: arrayOf(object({
      name: STRING,
      expression: { type: "string", description: "As PostgreSQL renders it, e.g. `CHECK ((price > (0)::numeric))`." },
      message: { type: ["string", "null"], description: "The constraint's COMMENT - the error message shown when it fails." },
      columns: { ...arrayOf(STRING), description: "The columns the expression names (pg_constraint.conkey) - one for a single-column CHECK." },
    })),
    owner: { type: "string", description: "The PostgreSQL role that owns it." },
    canAlter: {
      type: "boolean",
      description: "The configured PostgreSQL role owns it or is a member of its owner role, so it may alter or drop it. A hint for the editor - PostgreSQL still decides.",
    },
  }),
  CatalogIndex: object({
    name: STRING,
    columns: { ...arrayOf(STRING), description: "Indexed columns in key order (expression keys are not listed)." },
    keys: { ...arrayOf(object({ name: STRING, direction: { type: "string", enum: ["asc", "desc"] } })), description: "The same keys with their direction - what rebuilds the index." },
    isUnique: BOOLEAN,
    isPrimary: BOOLEAN,
    method: { type: "string", description: "Access method: btree, hash, gin, gist, spgist, brin." },
    predicate: { type: ["string", "null"], description: "A partial index's WHERE, as PostgreSQL renders it; null for a whole-table index." },
  }),
  CatalogRecord: object({
    catalog: {
      ...object({
        columns: arrayOf(ref("CatalogColumn")),
        primaryKey: arrayOf(STRING),
        relations: arrayOf(object({ name: STRING, sourceColumn: STRING, targetSchema: STRING, targetTable: STRING, targetColumn: STRING, message: { type: ["string", "null"] } })),
        uniqueConstraints: arrayOf(arrayOf(STRING)),
        uniqueConstraintNames: arrayOf(STRING),
        uniqueConstraintMessages: arrayOf({ type: ["string", "null"] }),
        checkConstraints: arrayOf(object({ name: STRING, expression: STRING, message: { type: ["string", "null"] }, columns: arrayOf(STRING) })),
      }),
      description: "The table's detail, as `/admin/api/catalog/table/{id}` without `owner`/`canAlter`.",
    },
    writable: object({ create: arrayOf(STRING), update: arrayOf(STRING) }),
    patterns: { type: "object", additionalProperties: true, description: "Per column: the regular expressions its CHECKs hold." },
    bounds: { type: "object", additionalProperties: true, description: "Per column: the ranges its CHECKs hold (`price >= 0`, `length(code) <= 10`)." },
    dateBounds: { type: "object", additionalProperties: true, description: "Per date column: the days its CHECKs allow." },
    values: { type: "object", additionalProperties: true, description: "Per column: its CHECK list's values - a select's options." },
  }),
  CatalogRowsPage: object({
    columns: arrayOf(object({ name: STRING, dataType: { type: "string", description: "format_type() of the result column." } })),
    rows: arrayOf({ type: "object", additionalProperties: true }),
    hasMore: { type: "boolean", description: "Another page follows." },
    durationMs: INTEGER,
  }),
  CatalogFunctionDetail: object({
    parameters: arrayOf(object({
      name: { type: "string", description: "`argN` for an unnamed parameter." },
      dataType: STRING,
      hasDefault: { type: "boolean", description: "PostgreSQL supplies a DEFAULT when the caller omits it." },
    })),
    returnsRows: { type: "boolean", description: "SETOF/TABLE or a composite return - yields rows rather than one value." },
    resultColumns: {
      oneOf: [arrayOf(object({ name: STRING, dataType: STRING })), { type: "null" }],
      description: "A row result's columns as `SELECT * FROM f()` names them; null when PostgreSQL declares none (`SETOF record`) or the result is a scalar.",
    },
    resultType: { type: ["string", "null"], description: "A scalar result's type; null for rows and for a pseudo-type (`void`, `record`)." },
    owner: { type: "string", description: "The PostgreSQL role that owns it." },
    canAlter: {
      type: "boolean",
      description: "The configured PostgreSQL role owns it or is a member of its owner role, so it may alter or drop it. A hint for the editor - PostgreSQL still decides.",
    },
  }),
  CatalogSyncResult: object({
    discovered: { type: "integer", description: "New resources (hidden until exposed)." },
    reactivated: { type: "integer" },
    missing: { type: "integer", description: "Resources whose object no longer exists (now MISSING)." },
    purged: { type: "integer" },
    columns: object({ discovered: INTEGER, renamed: INTEGER, removed: INTEGER }),
    dataviewsSynced: { type: "integer", description: "DataViews that got a column their source gained, as their New table columns say (DataViews.md §4.2)." },
    descriptions: {
      type: ["object", "null"],
      description: "null unless catalog.track_comments is on.",
      properties: { filledFromComment: INTEGER, filledFromDescription: INTEGER },
    },
    presentedColumns: { type: ["integer", "null"], description: "Columns Suggest presentation filled (by type and constraints, never changing a value of their own) - null unless autoPresentation was asked." },
    brokenReferences: {
      anyOf: [{ $ref: "#/components/schemas/BrokenReferences" }, { type: "null" }],
      description: "What still names what this sync found gone - only when a column was renamed or removed, or a resource went MISSING; null otherwise.",
    },
  }),
  BrokenReferences: object({
    dashboards: {
      type: "array",
      description: "Dashboard widgets whose query PostgreSQL refuses - a column, a table or view, or a function it names is gone - or whose click opens what's gone (CLICK_TARGET_MISSING: a DataView, a dashboard, its tab or variable). version null: the draft; a number: the live version.",
      items: object({
        dashboard: object({ id: { type: "string", format: "uuid" }, name: { type: "string" }, slug: { type: "string" } }),
        widget: object({ id: { type: "string", format: "uuid" }, label: { type: ["string", "null"] }, type: { type: "string" } }),
        version: { type: ["integer", "null"] },
        code: { type: "string", enum: ["UNDEFINED_COLUMN", "UNDEFINED_TABLE", "UNDEFINED_FUNCTION", "CLICK_TARGET_MISSING"] },
        message: { type: "string", description: "PostgreSQL's own - or what the click names that is gone." },
        query: { type: ["string", "null"] },
      }),
    },
    dataviews: {
      type: "array",
      description: "DataViews whose layout (a formula, a picked column) or Filter names a column their source no longer has - or whose source is gone (part source, column null).",
      items: object({
        dataview: object({ id: { type: "string", format: "uuid" }, name: { type: "string" }, slug: { type: "string" } }),
        resource: { type: ["string", "null"], format: "uuid" },
        version: { type: ["integer", "null"] },
        part: { type: "string", description: "card_layout.titleFormula, base_where, source..." },
        column: { type: ["string", "null"] },
      }),
    },
  }),
};

const COLUMN_DEFINITION_PROPERTIES: Record<string, JsonSchema> = {
  name: IDENTIFIER,
  dataType: DATA_TYPE,
  nullable: { type: "boolean", description: "`false` adds NOT NULL. Default: nullable." },
  default: { type: "string", description: `DEFAULT expression, e.g. \`now()\`, \`0\`, \`gen_random_uuid()\`, \`'draft'\`. ${SQL_EXPRESSION_RULES}` },
  primaryKey: { type: "boolean", description: "Create table only: this column is (part of) the primary key, named `<table>_pkey`. Ignored when adding a column." },
  unique: { type: "boolean", description: "Adds a single-column UNIQUE named `<table>_<column>_key`." },
  check: { type: "string", description: `Single-column CHECK, named \`<table>_<column>_check\`, e.g. \`price > 0\`. ${SQL_EXPRESSION_RULES}` },
  foreignKey: { ...INLINE_FOREIGN_KEY, description: "Single-column REFERENCES, named `<table>_<column>_fkey`." },
  checkMessage: { type: "string", description: "The inline CHECK's message - what a user reads when a write breaks it (its COMMENT), set in the same transaction." },
  uniqueMessage: { type: "string", description: "The inline UNIQUE's message." },
  foreignKeyMessage: { type: "string", description: "The inline foreign key's message." },
  identity: { type: "string", enum: ["ALWAYS", "BY DEFAULT"], description: "An identity column (an integer type): PostgreSQL numbers each row - ALWAYS refuses a written value, BY DEFAULT takes one. Not with `default` or `generated`." },
  generated: { type: "string", description: `A stored generated column: PostgreSQL computes it from the row, e.g. \`quantity * price\` - never written. Not with \`default\` or \`identity\`. ${SQL_EXPRESSION_RULES}` },
};

export const SCHEMA_SCHEMAS: Record<string, JsonSchema> = {
  SchemaColumnDefinition: {
    ...object(COLUMN_DEFINITION_PROPERTIES, ["name", "dataType"]),
    description: "One column. Inline unique/check/foreignKey are part of the same statement: the column and its constraints are created together or not at all.",
  },
  SchemaCheckCondition: {
    ...object(
      {
        field: { ...IDENTIFIER, description: "A column of the table." },
        operator: { type: "string", enum: ["_eq", "_neq", "_gt", "_gte", "_lt", "_lte", "_like", "_ilike", "_regex", "_in", "_nin", "_between", "_null", "_nnull", "_contains", "_contained_by", "_overlap"] },
        value: { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 }], description: "None for _null/_nnull; [from, to] for _between; one string otherwise (comma-separated for _in/_nin)." },
      },
      ["field", "operator"],
    ),
    description: "One built CHECK condition - the server writes `(\"field\" op value)` with the value as the column's kind of literal; several are AND-joined.",
  },
  SchemaAddColumn: {
    ...object(
      {
        ...COLUMN_DEFINITION_PROPERTIES,
        dataType: { ...DATA_TYPE, description: `${DATA_TYPE.description} Required unless \`creation\` is sent (then derived from the entry).` },
        input: { type: "string", description: "Optional: the column input catalog entry it is edited with (its presentation's `input` - e.g. number-field, email, relation-select; password marks a password column). Omitted: Automatic - by its type and constraints." },
        creation: {
          type: "object",
          additionalProperties: true,
          description:
            "With `input`: the entry's creation config (`CreationConfig` - unique, minLength/maxLength/pattern, min/max, numberType/decimals, options, ratingLength, pinLength, uidSource, relation). " +
            "The server derives dataType, check, foreignKey, uid and unique from it - the entry's own DDL, never the client's; those keys sent beside it are ignored.",
        },
        config: { type: "object", additionalProperties: true, description: "With `widget`: the column's presentation (same shape as PUT /admin/api/resources/{id}/columns/{column}/presentation). Validated before the DDL runs." },
        uid: {
          ...object({ source: { ...IDENTIFIER, description: "The column of the same table the value is generated from." } }, ["source"]),
          description: "A UID column (`dataType` text, with `unique`): the shared set_uid trigger fills it with the slug of `source` - diacritics stripped, lowercase, hyphens - whenever a row is written with it empty, appending -2, -3... when taken.",
        },
      },
      ["name"],
    ),
  },
  SchemaColumnPatch: {
    ...object({
      rename: IDENTIFIER,
      dataType: { ...DATA_TYPE, description: `New type (ALTER COLUMN ... TYPE, PostgreSQL's own implicit cast - no USING). ${DATA_TYPE.description}` },
      nullable: { type: "boolean", description: "`false`: SET NOT NULL (fails if a row holds NULL); `true`: DROP NOT NULL." },
      default: { type: ["string", "null"], description: `New DEFAULT expression, or null to drop it. Omitted: left unchanged. ${SQL_EXPRESSION_RULES}` },
    }),
    description: "Only the keys present are changed. Applied in order - type, nullability, default, rename - in one transaction: all or none.",
  },
  SchemaIndexColumn: object({ name: IDENTIFIER, direction: { type: "string", enum: ["asc", "desc"] } }, ["name"]),
  SchemaEditOperation: {
    description: "One change in an Edit Table batch, picked by `kind`.",
    oneOf: [
      object({ kind: { const: "rename_table" }, newName: IDENTIFIER }, ["kind", "newName"]),
      object({ kind: { const: "add_column" }, column: ref("SchemaColumnDefinition") }, ["kind", "column"]),
      object({ kind: { const: "alter_column" }, column: IDENTIFIER, patch: ref("SchemaColumnPatch") }, ["kind", "column", "patch"]),
      object({ kind: { const: "drop_column" }, column: IDENTIFIER, cascade: BOOLEAN }, ["kind", "column"]),
      object({ kind: { const: "set_primary_key" }, columns: arrayOf(IDENTIFIER) }, ["kind", "columns"]),
      object({ kind: { const: "add_unique" }, columns: arrayOf(IDENTIFIER), name: IDENTIFIER }, ["kind", "columns"]),
      object(
        {
          kind: { const: "add_foreign_key" },
          column: IDENTIFIER,
          targetSchema: IDENTIFIER,
          targetTable: IDENTIFIER,
          targetColumn: IDENTIFIER,
          onDelete: FK_ACTION,
          onUpdate: FK_ACTION,
          name: IDENTIFIER,
        },
        ["kind", "column", "targetSchema", "targetTable", "targetColumn"],
      ),
      object({ kind: { const: "add_check" }, name: IDENTIFIER, expression: { type: "string", description: SQL_EXPRESSION_RULES }, message: { type: ["string", "null"], description: "What a user reads when a write breaks it - its COMMENT." } }, ["kind", "name", "expression"]),
      object({ kind: { const: "set_constraint_message" }, name: IDENTIFIER, message: { type: ["string", "null"], description: "What a user reads when a write breaks it (its COMMENT); null removes it." } }, ["kind", "name", "message"]),
      object({ kind: { const: "drop_constraint" }, name: IDENTIFIER }, ["kind", "name"]),
      object(
        {
          kind: { const: "create_index" },
          name: IDENTIFIER,
          columns: arrayOf({ oneOf: [IDENTIFIER, ref("SchemaIndexColumn")] }),
          method: { type: "string", enum: ["btree", "hash", "gist", "gin", "spgist", "brin"] },
          unique: BOOLEAN,
          where: { type: "string", description: `Partial index predicate. ${SQL_EXPRESSION_RULES}` },
          concurrently: { type: "boolean", description: "CREATE INDEX CONCURRENTLY - runs after the transactional batch, on its own." },
        },
        ["kind", "columns"],
      ),
      object({ kind: { const: "drop_index" }, name: IDENTIFIER, concurrently: BOOLEAN }, ["kind", "name"]),
    ],
  },
  SchemaTableEditPlan: object({
    transactional: { ...arrayOf(STRING), description: "Statements run together in one transaction - all or nothing." },
    concurrent: { ...arrayOf(STRING), description: "CONCURRENTLY statements, run one by one after the transaction (PostgreSQL forbids them inside one)." },
  }),
  SchemaIndex: object({
    name: STRING,
    definition: { type: "string", description: "pg_get_indexdef() - the full CREATE INDEX statement." },
    isUnique: BOOLEAN,
    isPrimary: BOOLEAN,
  }),
};

export const NAMED: JsonSchema = object({ name: { type: "string", description: "The constraint's name." } });
