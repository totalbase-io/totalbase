import type { Database } from "@totalbase/database";

export interface FunctionParameter {
  name: string;
  dataType: string;
  /** True when PostgreSQL will supply a DEFAULT if the caller omits this argument. */
  hasDefault: boolean;
}

export interface FunctionResultColumn {
  name: string;
  dataType: string;
}

export interface FunctionDetail {
  parameters: FunctionParameter[];
  /** True for SETOF/table functions, or a composite (row-type) return - both yield multiple output columns/rows. */
  returnsRows: boolean;
  /**
   * A row result's columns as `SELECT * FROM f()` names them: the OUT/TABLE parameters, a composite type's
   * attributes, or the function's own name for SETOF a scalar. Null when PostgreSQL doesn't declare them
   * (`SETOF record`) - or when the result is a scalar: null.
   */
  resultColumns: FunctionResultColumn[] | null;
  /** A scalar result's type (`format_type`); null for rows, and for a pseudo-type (`void`, `record`, `anyelement`). */
  resultType: string | null;
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
  const returnsRows = returnShape.returnsSet || returnShape.isComposite;
  if (!returnsRows) return { parameters, returnsRows, resultColumns: null, resultType: returnShape.resultType };
  return { parameters, returnsRows, resultColumns: returnShape.columns.length > 0 ? returnShape.columns : null, resultType: null };
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
): Promise<{ returnsSet: boolean; isComposite: boolean; resultType: string | null; columns: FunctionResultColumn[] }> {
  const { rows } = await database.query<{ returns_set: boolean; type_kind: string; result_type: string; columns: FunctionResultColumn[] }>(
    `SELECT p.proretset AS returns_set, t.typtype AS type_kind, format_type(p.prorettype, NULL) AS result_type,
            COALESCE(
              -- OUT, INOUT and TABLE parameters, when there are any: they are the columns.
              (SELECT json_agg(json_build_object('name', a.name, 'dataType', format_type(a.type, NULL)) ORDER BY a.i)
                 FROM unnest(p.proallargtypes, p.proargmodes, p.proargnames) WITH ORDINALITY AS a(type, mode, name, i)
                WHERE a.mode IN ('o', 'b', 't')),
              -- A composite type's attributes.
              (SELECT json_agg(json_build_object('name', at.attname, 'dataType', format_type(at.atttypid, at.atttypmod)) ORDER BY at.attnum)
                 FROM pg_attribute at
                WHERE t.typtype = 'c' AND at.attrelid = t.typrelid AND at.attnum > 0 AND NOT at.attisdropped),
              -- SETOF a scalar: one column, named after the function.
              CASE WHEN t.typtype <> 'p' AND t.typtype <> 'c' THEN json_build_array(json_build_object('name', p.proname, 'dataType', format_type(p.prorettype, NULL))) END,
              '[]'::json
            ) AS columns
     FROM pg_proc p
     JOIN pg_type t ON t.oid = p.prorettype
     WHERE p.oid = $1`,
    [oid],
  );
  const row = rows[0];
  return {
    returnsSet: row?.returns_set ?? false,
    isComposite: row?.type_kind === "c",
    resultType: row && row.type_kind !== "p" ? row.result_type : null,
    // An unnamed OUT parameter has no name to read it by.
    columns: row && row.columns.every((column) => column.name) ? row.columns : [],
  };
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
