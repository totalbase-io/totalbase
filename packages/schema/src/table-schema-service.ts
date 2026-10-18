import { buildCheckExpression, type CheckCondition } from "@totalbase/tb-catalog";
import type { Database, Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { Knex } from "knex";
import { runDdl, type DdlAuditor } from "./ddl-audit.js";
import { knex } from "./knex-compiler.js";
import { FK_ACTIONS, quoteIdentifier, validateDataType, validateFkAction, validateIdentifier, validateSqlExpression } from "./validation.js";

function qualified(schema: string, table: string): string {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

/** Inline, single-column shorthand for a same-statement `col REFERENCES target (col)` - not a named sub-resource on its own; addForeignKey below still owns composite/multi-column FKs and post-creation management. */
export interface InlineForeignKeyInput {
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  onDelete?: (typeof FK_ACTIONS)[number] | undefined;
  onUpdate?: (typeof FK_ACTIONS)[number] | undefined;
}

export interface ColumnInput {
  name: string;
  dataType: string;
  nullable?: boolean | undefined;
  /** Raw SQL expression, e.g. "now()", "0", "gen_random_uuid()" - validated, never parameterized (PostgreSQL can't parameterize DDL). */
  default?: string | undefined;
  /** createTable only: marks this column as (part of) the new table's PRIMARY KEY. */
  primaryKey?: boolean | undefined;
  /**
   * Inline single-column UNIQUE/CHECK/REFERENCES - folded into the same
   * CREATE TABLE / ALTER TABLE ADD COLUMN statement as the rest of the
   * column definition, so a table with a foreign key either comes into
   * being fully formed or not at all. Table creation feeds straight into
   * exposing endpoints afterward - a column that exists but whose
   * relationship silently failed to attach is worse than the whole
   * operation failing up front. Postgres names these exactly as it would
   * if added via addUniqueConstraint/addForeignKey separately afterward
   * (`table_column_key`/`table_column_fkey`), so they're still fully
   * manageable (viewable, droppable) through the existing named
   * constraint endpoints once the table exists.
   */
  unique?: boolean | undefined;
  check?: string | undefined;
  foreignKey?: InlineForeignKeyInput | undefined;
  /**
   * What a user reads when a write breaks the column's inline CHECK, UNIQUE or
   * FOREIGN KEY - each constraint's COMMENT, set in the same transaction (the
   * names are the fixed ones above), instead of a second call that has to know them.
   */
  checkMessage?: string | undefined;
  uniqueMessage?: string | undefined;
  foreignKeyMessage?: string | undefined;
  /** An identity column - PostgreSQL numbers it (an order number); ALWAYS refuses a written value, BY DEFAULT takes one. */
  identity?: "ALWAYS" | "BY DEFAULT" | undefined;
  /** A stored generated column - PostgreSQL computes it from the row (`quantity * price`); never written. */
  generated?: string | undefined;
  /**
   * addColumn only: a UID column (Specification_DataViews.md §16.3) - the
   * shared totalbase.set_uid() trigger fills it with the slug of
   * `source`, a column of the same table, whenever a row is written with
   * it empty.
   */
  uid?: { source: string } | undefined;
}

export interface CreateTableInput {
  schema: string;
  name: string;
  columns: ColumnInput[];
  /** Table-level UNIQUE constraints over several columns, each named `<table>_<col>_<col>_key` - a junction table's pair (Specification_Administration.md §3.4). */
  uniques?: string[][] | undefined;
}

export interface AlterColumnInput {
  rename?: string | undefined;
  dataType?: string | undefined;
  nullable?: boolean | undefined;
  /** undefined = leave default untouched; null = drop the default; string = set it. */
  default?: string | null | undefined;
}

export interface ForeignKeyInput {
  name?: string | undefined;
  column: string;
  targetSchema: string;
  targetTable: string;
  targetColumn: string;
  onDelete?: (typeof FK_ACTIONS)[number] | undefined;
  onUpdate?: (typeof FK_ACTIONS)[number] | undefined;
}

/**
 * Applies one column - and its inline unique/check/foreign-key, if any -
 * to a Knex table builder (shared by buildCreateTableSql and
 * buildAddColumnStatements, both of which build inside a `knex.schema
 * ...(table, (t) => ...)` callback). `dataType` is always a free-form,
 * pre-validated raw type string (never a structured Knex type call) via
 * `specificType()` - this is what lets ColumnInput.dataType stay an
 * arbitrary string (as it always has been) instead of forcing every
 * caller to map onto Knex's own builder-method-per-type API.
 *
 * Inline UNIQUE/FOREIGN KEY/CHECK all get an explicit constraint name
 * matching Postgres's own default-naming convention
 * (`${table}_${column}_key`/`_fkey`/`_check`) rather than Knex's own
 * naming (`${table}_${column}_unique`/`_foreign`, or - for an unnamed
 * check specifically inside `alterTable` - a genuinely malformed name,
 * verified empirically) - see the `check` branch below for that
 * specific bug. Callers (dropConstraint, the Edit Table drawer) already
 * assume the Postgres-convention name for unique/FK; check's own name
 * was never relied on before Knex, so this is a new (better) guarantee,
 * not a preserved one.
 */
function applyColumnDefinition(t: Knex.TableBuilder, table: string, column: ColumnInput): void {
  validateIdentifier(column.name, "column");
  if (column.uid) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "A UID column can only be added on its own (Add Column).");
  }
  validateDataType(column.dataType);
  const computed = [column.identity && "identity", column.generated !== undefined && "generated", column.default !== undefined && "default"].filter(Boolean);
  if (computed.length > 1) throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `Column "${column.name}" takes one of identity, generated or default, not ${computed.join(" and ")}.`);
  if (column.identity !== undefined && column.identity !== "ALWAYS" && column.identity !== "BY DEFAULT") {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `identity is ALWAYS or BY DEFAULT, not "${String(column.identity)}".`);
  }
  if (column.generated !== undefined) validateSqlExpression(column.generated, "GENERATED");
  // PostgreSQL's own clauses after the (validated) type - Knex has no builder for them.
  const type = column.identity
    ? `${column.dataType} GENERATED ${column.identity} AS IDENTITY`
    : column.generated !== undefined
      ? `${column.dataType} GENERATED ALWAYS AS (${column.generated}) STORED`
      : column.dataType;
  const col = t.specificType(column.name, type);
  if (column.nullable === false) col.notNullable();
  if (column.default !== undefined) {
    validateSqlExpression(column.default, "DEFAULT");
    col.defaultTo(knex.raw(column.default));
  }
  if (column.unique) {
    t.unique([column.name], { indexName: `${table}_${column.name}_key` });
  }
  if (column.check !== undefined) {
    validateSqlExpression(column.check, "CHECK");
    // Explicit name, not left to Postgres's own auto-naming (unlike
    // unnamed inline checks in a plain CREATE TABLE) - Knex's `alterTable`
    // path (used by addColumn) has a real bug auto-naming an unnamed
    // check constraint (emits a malformed name embedding the quoted
    // qualified table reference) - verified empirically. createTable's
    // own path doesn't hit this bug, but using one explicit convention
    // everywhere avoids depending on that path-dependent difference.
    t.check(knexLiteral(column.check), {}, `${table}_${column.name}_check`);
  }
  if (column.foreignKey) {
    const fk = column.foreignKey;
    validateIdentifier(fk.targetSchema, "schema");
    validateIdentifier(fk.targetTable, "table");
    validateIdentifier(fk.targetColumn, "column");
    const constraintName = `${table}_${column.name}_fkey`;
    const reference = t
      .foreign(column.name, constraintName)
      .references(fk.targetColumn)
      .inTable(`${fk.targetSchema}.${fk.targetTable}`);
    if (fk.onDelete) reference.onDelete(validateFkAction(fk.onDelete, "ON DELETE action"));
    if (fk.onUpdate) reference.onUpdate(validateFkAction(fk.onUpdate, "ON UPDATE action"));
  }
}

/**
 * Structured DDL for tables/columns/PK/UNIQUE/simple FK/CHECK
 * (Specification_Administration.md §3, Specification.md §7.3). The client
 * never sends raw DDL (Specification_Administration.md §3.2) - every
 * method here takes structured input, validates it (validation.ts), and
 * builds the wrapping statement itself.
 *
 * Does not manage totalbase.resources - callers must trigger a catalog
 * refresh (@totalbase/resources' reconcileResources) after a structural
 * change so new/renamed/dropped tables are reflected there.
 *
 * Every mutation is a `buildXSql` pure function plus a thin `async`
 * method that runs it - not just createTable/buildCreateTableSql. The
 * Edit Table drawer previews a whole batch of these (rename + column +
 * constraint changes) before running any of them in one transaction, and
 * a preview that's a second, separate implementation of the same SQL
 * risks drifting from what actually executes. One builder per operation,
 * used by both the preview and the real run, is the only way that risk
 * doesn't exist.
 */
/**
 * A Knex schema builder's statements one by one - `.toString()` joins
 * them with `;`, which only the simple query protocol accepts.
 */
function statementsOf(builder: Knex.SchemaBuilder): string[] {
  const compiled = builder.toSQL();
  return (Array.isArray(compiled) ? compiled : [compiled]).map(({ sql, bindings }) => knex.raw(sql, bindings ?? []).toString());
}

/** CREATE TABLE plus whatever Knex adds after it (e.g. an inline foreign key's own ALTER TABLE). */
export function buildCreateTableStatements(input: CreateTableInput): string[] {
  validateIdentifier(input.schema, "schema");
  validateIdentifier(input.name, "table");
  if (input.columns.length === 0) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "A table needs at least one column.");
  }

  const builder = knex.schema.withSchema(input.schema).createTable(input.name, (t) => {
    for (const column of input.columns) {
      applyColumnDefinition(t, input.name, column);
    }
    const pkColumns = input.columns.filter((c) => c.primaryKey).map((c) => c.name);
    if (pkColumns.length > 0) {
      t.primary(pkColumns, { constraintName: `${input.name}_pkey` });
    }
    for (const columns of input.uniques ?? []) {
      if (columns.length < 2) throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "A table-level UNIQUE spans at least two columns - a single column's goes on the column.");
      for (const column of columns) {
        validateIdentifier(column, "column");
        if (!input.columns.some((c) => c.name === column)) throw new TotalBaseError("INVALID_SCHEMA_OPERATION", `UNIQUE names "${column}", which isn't one of the table's columns.`);
      }
      t.unique(columns, { indexName: `${input.name}_${columns.join("_")}_key` });
    }
  });
  return [...statementsOf(builder), ...input.columns.flatMap((column) => inlineConstraintMessages(input.schema, input.name, column))];
}

/** The COMMENT of each inline constraint the column asks a message for - named as applyColumnDefinition names them. */
function inlineConstraintMessages(schema: string, table: string, column: ColumnInput): string[] {
  const missing = (what: string) => new TotalBaseError("INVALID_SCHEMA_OPERATION", `Column "${column.name}" has a ${what} message but no ${what}.`);
  const statements: string[] = [];
  if (column.checkMessage) {
    if (column.check === undefined) throw missing("check");
    statements.push(buildCommentOnConstraintSql(schema, table, `${table}_${column.name}_check`, column.checkMessage));
  }
  if (column.uniqueMessage) {
    if (!column.unique) throw missing("unique");
    statements.push(buildCommentOnConstraintSql(schema, table, `${table}_${column.name}_key`, column.uniqueMessage));
  }
  if (column.foreignKeyMessage) {
    if (!column.foreignKey) throw missing("foreign key");
    statements.push(buildCommentOnConstraintSql(schema, table, `${table}_${column.name}_fkey`, column.foreignKeyMessage));
  }
  return statements;
}

/** The create table preview (POST .../tables/preview): the same statements as one script. */
export function buildCreateTableSql(input: CreateTableInput): string {
  return buildCreateTableStatements(input).join(";\n");
}

export function buildRenameTableSql(schema: string, table: string, newName: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(newName, "table");
  return knex.schema.withSchema(schema).renameTable(table, newName).toString();
}

export function buildDropTableSql(schema: string, table: string, cascade = false): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  const sql = knex.schema.withSchema(schema).dropTable(table).toString();
  // Knex's schema builder has no CASCADE option (Postgres-specific) -
  // appended directly onto its own compiled output rather than
  // hand-building the whole statement just for this one suffix.
  return cascade ? `${sql} CASCADE` : sql;
}

/**
 * The trigger that makes `column` a UID column generated from `source`.
 * It names both columns by attnum - not by name - so renaming either keeps
 * it working; both are read from pg_attribute on the transaction that
 * creates the column, which is why this isn't one of the plain statement
 * builders above.
 */
export async function buildUidTriggerSql(client: Queryable, schema: string, table: string, column: string, source: string): Promise<string> {
  validateIdentifier(source, "column");
  if (source === column) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "A UID column is generated from another column, not from itself.");
  }
  const { rows } = await client.query<{ attname: string; attnum: number }>(
    `SELECT attname, attnum::int AS attnum FROM pg_attribute
      WHERE attrelid = to_regclass($1) AND attname = ANY($2) AND attnum > 0 AND NOT attisdropped`,
    [qualified(schema, table), [column, source]],
  );
  const attnum = (name: string) => rows.find((row) => row.attname === name)?.attnum;
  const sourceAttnum = attnum(source);
  const columnAttnum = attnum(column);
  if (sourceAttnum === undefined) {
    throw new TotalBaseError("UNDEFINED_COLUMN", `Column "${source}" does not exist in ${schema}.${table}.`);
  }
  if (columnAttnum === undefined) {
    throw new TotalBaseError("UNDEFINED_COLUMN", `Column "${column}" does not exist in ${schema}.${table}.`);
  }
  return `CREATE TRIGGER ${quoteIdentifier(`${table}_${column}_uid`)} BEFORE INSERT OR UPDATE ON ${qualified(schema, table)} `
    + `FOR EACH ROW EXECUTE FUNCTION totalbase.set_uid('${columnAttnum}', '${sourceAttnum}')`;
}

/** ADD COLUMN, then one statement per inline UNIQUE/CHECK/FOREIGN KEY. */
export function buildAddColumnStatements(schema: string, table: string, column: ColumnInput): string[] {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  return [
    ...statementsOf(
      knex.schema.withSchema(schema).alterTable(table, (t) => {
        applyColumnDefinition(t, table, column);
      }),
    ),
    ...inlineConstraintMessages(schema, table, column),
  ];
}

/**
 * Each requested change is its own statement - PostgreSQL doesn't allow
 * combining RENAME COLUMN with other ALTER COLUMN clauses.
 *
 * Deliberately NOT built via Knex, unlike every other builder in this
 * file: Knex's `.alter()` column-redefinition model always resets a
 * column's DEFAULT (and NOT NULL) before reapplying it, even when the
 * requested change is only to one of the other, unrelated aspects
 * (verified empirically - `.alter({alterNullable: true})` alone still
 * emits `ALTER COLUMN ... DROP DEFAULT` first). That's a silent data-loss
 * bug for exactly the "patch only what changed" contract this function
 * exists for: altering only nullable would otherwise wipe an existing
 * default. Safely using Knex here would require first reading the
 * column's full current definition and re-supplying every unspecified
 * aspect on each call - a real scope expansion, not a drop-in swap - so
 * this stays hand-built.
 */
export function buildAlterColumnSql(schema: string, table: string, column: string, patch: AlterColumnInput): string[] {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(column, "column");
  const target = qualified(schema, table);
  const quotedColumn = quoteIdentifier(column);
  const statements: string[] = [];

  if (patch.dataType !== undefined) {
    validateDataType(patch.dataType);
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${quotedColumn} TYPE ${patch.dataType}`);
  }
  if (patch.nullable !== undefined) {
    statements.push(`ALTER TABLE ${target} ALTER COLUMN ${quotedColumn} ${patch.nullable ? "DROP NOT NULL" : "SET NOT NULL"}`);
  }
  if (patch.default !== undefined) {
    statements.push(
      patch.default === null
        ? `ALTER TABLE ${target} ALTER COLUMN ${quotedColumn} DROP DEFAULT`
        : (validateSqlExpression(patch.default, "DEFAULT"), `ALTER TABLE ${target} ALTER COLUMN ${quotedColumn} SET DEFAULT ${patch.default}`),
    );
  }
  if (patch.rename !== undefined) {
    validateIdentifier(patch.rename, "column");
    statements.push(`ALTER TABLE ${target} RENAME COLUMN ${quotedColumn} TO ${quoteIdentifier(patch.rename)}`);
  }
  return statements;
}

export function buildDropColumnSql(schema: string, table: string, column: string, cascade = false): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(column, "column");
  const sql = knex.schema
    .withSchema(schema)
    .alterTable(table, (t) => {
      t.dropColumn(column);
    })
    .toString();
  // Same CASCADE caveat as buildDropTableSql - no builder option for it.
  return cascade ? `${sql} CASCADE` : sql;
}

export function buildSetPrimaryKeySql(schema: string, table: string, columns: string[], name?: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  if (columns.length === 0) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "PRIMARY KEY requires at least one column.");
  }
  const constraintName = name ?? `${table}_pkey`;
  validateIdentifier(constraintName, "constraint");
  for (const c of columns) validateIdentifier(c, "column");
  return knex.schema
    .withSchema(schema)
    .alterTable(table, (t) => {
      t.primary(columns, { constraintName });
    })
    .toString();
}

/**
 * Deliberately NOT built via Knex: this drops a constraint by name alone,
 * whatever kind it is (UNIQUE, FOREIGN KEY, or CHECK) - Knex has no
 * single generic "drop constraint" builder method, only kind-specific
 * ones (dropUnique/dropForeign/dropChecks), which would require every
 * caller (admin-schema.ts, the Edit Table drawer) to also know and pass
 * the constraint's kind - a real contract change, out of scope here.
 * Postgres's own DROP CONSTRAINT is already kind-agnostic, which is
 * exactly what this preserves.
 */
export function buildDropConstraintSql(schema: string, table: string, name: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(name, "constraint");
  return `ALTER TABLE ${qualified(schema, table)} DROP CONSTRAINT ${quoteIdentifier(name)}`;
}

export function buildAddUniqueConstraintSql(schema: string, table: string, columns: string[], name?: string): { sql: string, constraintName: string } {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  if (columns.length === 0) {
    throw new TotalBaseError("INVALID_SCHEMA_OPERATION", "UNIQUE requires at least one column.");
  }
  const constraintName = name ?? `${table}_${columns.join("_")}_key`;
  validateIdentifier(constraintName, "constraint");
  for (const c of columns) validateIdentifier(c, "column");
  const sql = knex.schema
    .withSchema(schema)
    .alterTable(table, (t) => {
      t.unique(columns, { indexName: constraintName });
    })
    .toString();
  return { sql, constraintName };
}

export function buildAddForeignKeySql(schema: string, table: string, input: ForeignKeyInput): { sql: string, constraintName: string } {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(input.column, "column");
  validateIdentifier(input.targetSchema, "schema");
  validateIdentifier(input.targetTable, "table");
  validateIdentifier(input.targetColumn, "column");
  const onDelete = input.onDelete ? validateFkAction(input.onDelete, "ON DELETE action") : undefined;
  const onUpdate = input.onUpdate ? validateFkAction(input.onUpdate, "ON UPDATE action") : undefined;

  const constraintName = input.name ?? `${table}_${input.column}_fkey`;
  validateIdentifier(constraintName, "constraint");

  const sql = knex.schema
    .withSchema(schema)
    .alterTable(table, (t) => {
      const reference = t
        .foreign(input.column, constraintName)
        .references(input.targetColumn)
        .inTable(`${input.targetSchema}.${input.targetTable}`);
      if (onDelete) reference.onDelete(onDelete);
      if (onUpdate) reference.onUpdate(onUpdate);
    })
    .toString();
  return { sql, constraintName };
}

/**
 * An SQL expression as Knex's raw text: Knex reads every `?` as a binding - a regex quantifier (`https?`) in a CHECK
 * would ask for a binding it never gets. `\?` is Knex's literal question mark.
 */
function knexLiteral(expression: string): string {
  return expression.replace(/\?/g, "\\?");
}

export function buildAddCheckConstraintSql(schema: string, table: string, name: string, expression: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(name, "constraint");
  validateSqlExpression(expression, "CHECK");
  return knex.schema
    .withSchema(schema)
    .alterTable(table, (t) => {
      t.check(knexLiteral(expression), {}, name);
    })
    .toString();
}

/**
 * "Error Message": stored as the
 * constraint's own real PostgreSQL COMMENT - not a TotalBase-side column,
 * so it's still there if this constraint was created outside TotalBase,
 * and gone automatically once the constraint itself is dropped (Postgres
 * drops a dependent comment with its object). @totalbase/database's
 * error mapper reads it back by name when a CHECK_VIOLATION fires, in
 * place of Postgres's own generic message.
 */
/**
 * A trigger that keeps a self-referencing column from making a cycle - a row under itself, at any depth
 * (Specification_DataViews.md §5.14, a TREE DataView): BEFORE INSERT OR UPDATE OF the parent column, it
 * walks up from the new parent and refuses a write that would reach the row itself (check_violation).
 * PostgreSQL enforces it for every writer; CREATE OR REPLACE, so offering it again is harmless.
 */
export function buildCycleGuardStatements(schema: string, table: string, keyColumn: string, parentColumn: string): string[] {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(keyColumn, "column");
  validateIdentifier(parentColumn, "column");
  const name = `${table}_${parentColumn}_no_cycle`.slice(0, 63);
  const fn = qualified(schema, name);
  const t = qualified(schema, table);
  const key = quoteIdentifier(keyColumn);
  const parent = quoteIdentifier(parentColumn);
  return [
    `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $cycle$
BEGIN
  IF NEW.${parent} IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.${parent} = NEW.${key} OR EXISTS (
    WITH RECURSIVE up(id) AS (
      SELECT p.${parent} FROM ${t} p WHERE p.${key} = NEW.${parent}
      UNION
      SELECT p.${parent} FROM ${t} p JOIN up ON p.${key} = up.id WHERE p.${parent} IS NOT NULL
    )
    SELECT 1 FROM up WHERE up.id = NEW.${key}
  ) THEN
    RAISE EXCEPTION USING ERRCODE = 'check_violation', COLUMN = '${parentColumn}', MESSAGE = 'A row can''t be placed under itself or under one of its own descendants.';
  END IF;
  RETURN NEW;
END
$cycle$`,
    `CREATE OR REPLACE TRIGGER ${quoteIdentifier(name)} BEFORE INSERT OR UPDATE OF ${parent} ON ${t} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
  ];
}

/** Removes a constraint's message (its COMMENT). */
export function buildClearConstraintCommentSql(schema: string, table: string, name: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(name, "constraint");
  return `COMMENT ON CONSTRAINT ${quoteIdentifier(name)} ON ${qualified(schema, table)} IS NULL`;
}

export function buildCommentOnConstraintSql(schema: string, table: string, name: string, message: string): string {
  validateIdentifier(schema, "schema");
  validateIdentifier(table, "table");
  validateIdentifier(name, "constraint");
  // COMMENT ON's grammar takes a string constant, not an expression, so
  // the literal is inlined, safely, with standard SQL single-quote doubling.
  const literal = `'${message.replace(/'/g, "''")}'`;
  return `COMMENT ON CONSTRAINT ${quoteIdentifier(name)} ON ${qualified(schema, table)} IS ${literal}`;
}

/**
 * Runs the statements built above. Every method takes an optional
 * `audit` (ddl-audit.ts): the operation's audit record, written on the same
 * transaction as its DDL (Specification_Administration.md §3.14) - every
 * method runs in a transaction for that, a single statement included.
 */
export class TableSchemaService {
  constructor(private readonly database: Database) {}

  async createTable(input: CreateTableInput, audit?: DdlAuditor): Promise<void> {
    await runDdl(this.database, "create_table", buildCreateTableStatements(input), audit);
  }

  async createSchema(name: string, audit?: DdlAuditor): Promise<void> {
    validateIdentifier(name, "schema");
    await runDdl(this.database, "create_schema", [`CREATE SCHEMA ${quoteIdentifier(name)}`], audit);
  }

  async renameTable(schema: string, table: string, newName: string, audit?: DdlAuditor): Promise<void> {
    await runDdl(this.database, "rename_table", [buildRenameTableSql(schema, table, newName)], audit);
  }

  async dropTable(schema: string, table: string, cascade = false, audit?: DdlAuditor): Promise<void> {
    await runDdl(this.database, "drop_table", [buildDropTableSql(schema, table, cascade)], audit);
  }

  /**
   * `alongside` runs in the same transaction, after the column exists - a
   * write that belongs with it (its admin presentation) and that, failing,
   * takes the column back with it.
   */
  async addColumn(schema: string, table: string, column: ColumnInput, alongside?: (client: Queryable) => Promise<void>, audit?: DdlAuditor): Promise<void> {
    const { uid, ...plain } = column;
    const statements = buildAddColumnStatements(schema, table, plain);
    // A UID column's trigger needs the new column's attnum, so it's built
    // on the transaction itself - and recorded with the rest of the DDL.
    const withUid = uid
      ? async (client: Queryable) => {
          const trigger = await buildUidTriggerSql(client, schema, table, column.name, uid.source);
          await client.query(trigger);
          statements.push(trigger);
          if (alongside) await alongside(client);
        }
      : alongside;
    await runDdl(this.database, "add_column", statements, audit, withUid);
  }

  /** Type, nullability, default and rename in one transaction - PostgreSQL applies all of them or none. */
  async alterColumn(schema: string, table: string, column: string, patch: AlterColumnInput, audit?: DdlAuditor): Promise<void> {
    await runDdl(this.database, "alter_column", buildAlterColumnSql(schema, table, column, patch), audit);
  }

  /** A UID trigger naming the column - as the UID column or as its source - goes with it. */
  async dropColumn(schema: string, table: string, column: string, cascade = false, audit?: DdlAuditor): Promise<void> {
    const sql = buildDropColumnSql(schema, table, column, cascade);
    const { rows } = await this.database.query<{ tgname: string }>(
      `SELECT t.tgname FROM pg_trigger t
         JOIN pg_attribute a ON a.attrelid = t.tgrelid AND a.attname = $2
        WHERE t.tgrelid = to_regclass($1)
          AND t.tgfoid = to_regproc('totalbase.set_uid')
          AND a.attnum::text = ANY (string_to_array(encode(t.tgargs, 'escape'), '\\000'))`,
      [qualified(schema, table), column],
    );
    const triggers = rows.map((row) => `DROP TRIGGER ${quoteIdentifier(row.tgname)} ON ${qualified(schema, table)}`);
    await runDdl(this.database, "drop_column", [...triggers, sql], audit);
  }

  /** Replaces the key in one transaction: a new key PostgreSQL rejects leaves the old one in place. */
  async setPrimaryKey(schema: string, table: string, columns: string[], name?: string, audit?: DdlAuditor): Promise<void> {
    const sql = buildSetPrimaryKeySql(schema, table, columns, name);
    const existing = await this.findConstraintName(schema, table, "p");
    await runDdl(this.database, "set_primary_key", [...(existing ? [buildDropConstraintSql(schema, table, existing)] : []), sql], audit);
  }

  async dropPrimaryKey(schema: string, table: string, audit?: DdlAuditor): Promise<void> {
    validateIdentifier(schema, "schema");
    validateIdentifier(table, "table");
    const existing = await this.findConstraintName(schema, table, "p");
    if (!existing) {
      throw new TotalBaseError("UNDEFINED_OBJECT", `${schema}.${table} has no PRIMARY KEY.`);
    }
    await runDdl(this.database, "drop_primary_key", [buildDropConstraintSql(schema, table, existing)], audit);
  }

  async addUniqueConstraint(schema: string, table: string, columns: string[], name?: string, audit?: DdlAuditor): Promise<string> {
    const { sql, constraintName } = buildAddUniqueConstraintSql(schema, table, columns, name);
    await runDdl(this.database, "add_unique", [sql], audit);
    return constraintName;
  }

  async addForeignKey(schema: string, table: string, input: ForeignKeyInput, audit?: DdlAuditor): Promise<string> {
    const { sql, constraintName } = buildAddForeignKeySql(schema, table, input);
    await runDdl(this.database, "add_foreign_key", [sql], audit);
    return constraintName;
  }

  /**
   * The constraint and its message (a COMMENT) in one transaction. `check` is the boolean expression itself, or the
   * conditions the admin built (column, operator, value - `CheckCondition`): then the expression is built here, over
   * the table's real columns and their types, never in the browser (AGENTS.md §6).
   */
  async addCheckConstraint(schema: string, table: string, name: string, check: string | readonly CheckCondition[], message?: string | null, audit?: DdlAuditor): Promise<void> {
    const expression = typeof check === "string" ? check : await this.checkExpression(schema, table, check);
    const sql = buildAddCheckConstraintSql(schema, table, name, expression);
    const comment = message ? buildCommentOnConstraintSql(schema, table, name, message) : undefined;
    await runDdl(this.database, "add_check", comment ? [sql, comment] : [sql], audit);
  }

  /** The cycle guard of a self-referencing column (buildCycleGuardStatements), its key being the table's single-column primary key. */
  async addCycleGuard(schema: string, table: string, parentColumn: string, audit?: DdlAuditor): Promise<void> {
    const { rows } = await this.database.query<{ key: string }>(
      `SELECT a.attname AS key FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = to_regclass($1) AND i.indisprimary AND array_length(i.indkey::int2[], 1) = 1`,
      [`${quoteIdentifier(schema)}.${quoteIdentifier(table)}`],
    );
    const key = rows[0]?.key;
    if (!key) throw new TotalBaseError("INVALID_QUERY", "A cycle guard needs a table with a single-column primary key.");
    await runDdl(this.database, "add_cycle_guard", buildCycleGuardStatements(schema, table, key, parentColumn), audit);
  }

  /** Drops any named constraint (UNIQUE, FOREIGN KEY, or CHECK - use dropPrimaryKey for PK, which has no client-chosen name). */
  async dropConstraint(schema: string, table: string, name: string, audit?: DdlAuditor): Promise<void> {
    await runDdl(this.database, "drop_constraint", [buildDropConstraintSql(schema, table, name)], audit);
  }

  /** Built conditions as one boolean expression - a column not in the table, or a shape the builder can't write, is INVALID_QUERY. */
  private async checkExpression(schema: string, table: string, conditions: readonly CheckCondition[]): Promise<string> {
    validateIdentifier(schema, "schema");
    validateIdentifier(table, "table");
    if (conditions.length === 0) throw new TotalBaseError("INVALID_QUERY", "A CHECK needs at least one condition.");
    const { rows } = await this.database.query<{ name: string; data_type: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS data_type
         FROM pg_attribute a
        WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
      [qualified(schema, table)],
    );
    if (rows.length === 0) throw new TotalBaseError("RESOURCE_NOT_FOUND", `Table not found: ${schema}.${table}`);
    try {
      return buildCheckExpression(conditions, rows.map((row) => ({ name: row.name, dataType: row.data_type })));
    } catch (error) {
      throw new TotalBaseError("INVALID_QUERY", error instanceof Error ? error.message : "Invalid CHECK conditions.");
    }
  }

  private async findConstraintName(schema: string, table: string, contype: string): Promise<string | null> {
    const { rows } = await this.database.query<{ conname: string }>(
      `SELECT c.conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = $3
       LIMIT 1`,
      [schema, table, contype],
    );
    return rows[0]?.conname ?? null;
  }
}
