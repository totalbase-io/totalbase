import type { Database } from "@totalbase/database";

export interface FunctionParameter {
  name: string;
  dataType: string;
  /** True when PostgreSQL will supply a DEFAULT if the caller omits this argument. */
  hasDefault: boolean;
}

export interface FunctionDetail {
  parameters: FunctionParameter[];
  /** True for SETOF/table functions, or a composite (row-type) return - both yield multiple output columns/rows. */
  returnsRows: boolean;
}

/**
 * Introspects a function's IN parameters and return shape by OID. See
 * Foundations.md §12 (function parameters, returns, overloads).
 *
 * V1 scope: only simple IN parameters are supported (no OUT/INOUT,
 * variadic, or TABLE-returning parameter lists) - see AGENTS.md
 * section 27 for why this is a documented simplification rather than a
 * silent gap.
 */
export async function getFunctionDetail(database: Database, oid: number): Promise<FunctionDetail> {
  const [parameters, returnShape] = await Promise.all([
    getParameters(database, oid),
    getReturnShape(database, oid),
  ]);
  return { parameters, returnsRows: returnShape.returnsSet || returnShape.isComposite };
}

async function getParameters(database: Database, oid: number): Promise<FunctionParameter[]> {
  const { rows } = await database.query<{ name: string; data_type: string; has_default: boolean }>(
    `SELECT
       COALESCE(p.proargnames[i], 'arg' || i) AS name,
       format_type(p.proargtypes[i - 1], NULL) AS data_type,
       i > (p.pronargs - p.pronargdefaults) AS has_default
     FROM pg_proc p
     CROSS JOIN LATERAL generate_series(1, p.pronargs) AS i
     WHERE p.oid = $1
     ORDER BY i`,
    [oid],
  );
  return rows.map((row) => ({ name: row.name, dataType: row.data_type, hasDefault: row.has_default }));
}

async function getReturnShape(
  database: Database,
  oid: number,
): Promise<{ returnsSet: boolean; isComposite: boolean }> {
  const { rows } = await database.query<{ returns_set: boolean; type_kind: string }>(
    `SELECT p.proretset AS returns_set, t.typtype AS type_kind
     FROM pg_proc p
     JOIN pg_type t ON t.oid = p.prorettype
     WHERE p.oid = $1`,
    [oid],
  );
  const row = rows[0];
  return { returnsSet: row?.returns_set ?? false, isComposite: row?.type_kind === "c" };
}

/**
 * Each function's identity arguments (`pg_get_function_identity_arguments`,
 * e.g. `value integer, extra integer`), by OID - what tells one overload
 * from another when several share a name (Admin_UI.md §11.5).
 * An OID that no longer exists is simply absent.
 */
export async function listFunctionArguments(database: Database, oids: number[]): Promise<Map<number, string>> {
  if (oids.length === 0) return new Map();
  const { rows } = await database.query<{ oid: number; arguments: string }>(
    `SELECT p.oid::int AS oid, pg_get_function_identity_arguments(p.oid) AS arguments FROM pg_proc p WHERE p.oid = ANY($1::oid[])`,
    [oids],
  );
  return new Map(rows.map((row) => [row.oid, row.arguments]));
}
