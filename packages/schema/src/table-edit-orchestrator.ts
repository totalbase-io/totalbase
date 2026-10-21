import type { Database } from "@totalbase/database";
import type { DdlAuditor } from "./ddl-audit.js";
import { buildCreateIndexSql, buildDropIndexSql, type CreateIndexInput } from "./index-service.js";
import {
  buildAddCheckConstraintSql,
  buildClearConstraintCommentSql,
  buildCommentOnConstraintSql,
  buildAddColumnStatements,
  buildAddForeignKeySql,
  buildAddUniqueConstraintSql,
  buildAlterColumnSql,
  buildDropColumnSql,
  buildDropConstraintSql,
  buildRenameTableSql,
  buildSetPrimaryKeySql,
  type AlterColumnInput,
  type ColumnInput,
  type ForeignKeyInput,
} from "./table-schema-service.js";

/**
 * One admin-facing "Save" on the Edit Table drawer is a batch of these -
 * a rename, several column changes, constraint changes, index changes,
 * all decided by diffing the drawer's draft against the table's original
 * state client-side. This type is the wire format for that batch.
 */
export type TableEditOperation =
  | { kind: "rename_table", newName: string }
  | { kind: "add_column", column: ColumnInput }
  | { kind: "alter_column", column: string, patch: AlterColumnInput }
  | { kind: "drop_column", column: string, cascade?: boolean | undefined }
  /** Replaces whatever PRIMARY KEY exists (if any) - looked up at plan-build time, since the client doesn't carry the current constraint's name. */
  | { kind: "set_primary_key", columns: string[] }
  | { kind: "add_unique", columns: string[], name?: string | undefined }
  | { kind: "add_foreign_key", input: ForeignKeyInput }
  | { kind: "add_check", name: string, expression: string, message?: string | null | undefined }
  /** The message a user reads when the constraint fails (its COMMENT, Administration.md §3.9) - null removes it. */
  | { kind: "set_constraint_message", name: string, message: string | null }
  | { kind: "drop_constraint", name: string }
  | { kind: "create_index", input: Omit<CreateIndexInput, "schema" | "table"> }
  | { kind: "drop_index", name: string, concurrently?: boolean | undefined };

export interface TableEditPlan {
  /** Runs together in one transaction - all succeed or the whole batch rolls back. */
  transactional: string[];
  /**
   * CONCURRENTLY statements - PostgreSQL forbids these inside a
   * transaction block, so they run afterward, each on its own, outside
   * the transactional batch above. See AGENTS.md's Edit Table notes.
   */
  concurrent: string[];
}

async function findConstraintName(database: Database, schema: string, table: string, contype: string): Promise<string | null> {
  const { rows } = await database.query<{ conname: string }>(
    `SELECT c.conname FROM pg_constraint c
     JOIN pg_class t ON t.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = $1 AND t.relname = $2 AND c.contype = $3
     LIMIT 1`,
    [schema, table, contype],
  );
  return rows[0]?.conname ?? null;
}

/**
 * Builds every statement a batch implies, without running any of them -
 * async only because set_primary_key needs to look up whichever PK
 * constraint currently exists (if any) to drop it first; the same
 * function backs both the dry-run preview and the real execution below,
 * so a preview can never drift from what actually runs.
 *
 * Operations apply in the order given, and each one addresses the table
 * by the name it has at that point: after a rename_table, the new one.
 * The CONCURRENTLY statements run after the commit, so they use the
 * table's final name.
 */
export async function buildTableEditPlan(database: Database, schema: string, table: string, operations: TableEditOperation[]): Promise<TableEditPlan> {
  const transactional: string[] = [];
  const concurrent: Array<(finalName: string) => string> = [];
  let current = table;

  for (const op of operations) {
    switch (op.kind) {
      case "rename_table":
        transactional.push(buildRenameTableSql(schema, current, op.newName));
        current = op.newName;
        break;
      case "add_column":
        transactional.push(...buildAddColumnStatements(schema, current, op.column));
        break;
      case "alter_column":
        transactional.push(...buildAlterColumnSql(schema, current, op.column, op.patch));
        break;
      case "drop_column":
        transactional.push(buildDropColumnSql(schema, current, op.column, op.cascade));
        break;
      case "set_primary_key": {
        // PostgreSQL still knows the table by its name before this batch.
        const existing = await findConstraintName(database, schema, table, "p");
        if (existing) transactional.push(buildDropConstraintSql(schema, current, existing));
        transactional.push(buildSetPrimaryKeySql(schema, current, op.columns));
        break;
      }
      case "add_unique":
        transactional.push(buildAddUniqueConstraintSql(schema, current, op.columns, op.name).sql);
        break;
      case "add_foreign_key":
        transactional.push(buildAddForeignKeySql(schema, current, op.input).sql);
        break;
      case "add_check":
        transactional.push(buildAddCheckConstraintSql(schema, current, op.name, op.expression));
        if (op.message?.trim()) transactional.push(buildCommentOnConstraintSql(schema, current, op.name, op.message.trim()));
        break;
      case "set_constraint_message":
        transactional.push(op.message?.trim()
          ? buildCommentOnConstraintSql(schema, current, op.name, op.message.trim())
          : buildClearConstraintCommentSql(schema, current, op.name));
        break;
      case "drop_constraint":
        transactional.push(buildDropConstraintSql(schema, current, op.name));
        break;
      case "create_index":
        if (op.input.concurrently) concurrent.push((finalName) => buildCreateIndexSql({ ...op.input, schema, table: finalName }));
        else transactional.push(buildCreateIndexSql({ ...op.input, schema, table: current }));
        break;
      case "drop_index":
        if (op.concurrently) concurrent.push(() => buildDropIndexSql(schema, op.name, true));
        else transactional.push(buildDropIndexSql(schema, op.name, false));
        break;
    }
  }

  return { transactional, concurrent: concurrent.map((build) => build(current)) };
}

/**
 * Runs a plan for real: the transactional half in one BEGIN/COMMIT, then the CONCURRENTLY half afterward, each statement on its own (required - PostgreSQL rejects CONCURRENTLY inside a transaction block).
 *
 * `audit` (ddl-audit.ts) records the transactional half inside its
 * transaction, and each CONCURRENTLY statement right after it ran.
 */
export async function applyTableEditPlan(database: Database, plan: TableEditPlan, audit?: DdlAuditor): Promise<void> {
  // Over the extended protocol (query(), never queryRaw()), like every DDL
  // the schema package runs: each statement is one statement, so PostgreSQL
  // itself refuses a stacked `...; DROP ...` the validation might miss.
  if (plan.transactional.length > 0) {
    await database.transaction(async (client) => {
      for (const sql of plan.transactional) {
        await client.query(sql);
      }
      if (audit) await audit(client, { operation: "edit_table", statements: plan.transactional });
    });
  }
  for (const sql of plan.concurrent) {
    await database.query(sql);
    if (audit) await audit(database, { operation: "edit_table", statements: [sql], concurrent: true });
  }
}
