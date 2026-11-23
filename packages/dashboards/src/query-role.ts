import { parameterText, quoteIdentifier, type QueryResult, type ReadOnlyQueryable, type ResultField } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { DashboardsContext } from "./dashboards-types.js";

/**
 * Widget SQL as a role of the operator's (Dashboards.md §2.10). With `dashboards.query_role` set, every author-written
 * statement - a widget's query, its totals and pivot, a variable's options, the editor's plan, probe and EXPLAIN - runs
 * inside `totalbase.dashboards_query`, a SECURITY DEFINER function whose owner is that role: it reads only what the
 * role may, and PostgreSQL refuses `set_config('role', ...)` inside a security-definer function, so the query can't
 * return to TotalBase's own role. Unset, the statement runs as it always has, on TotalBase's connection.
 */

const QUERY_FUNCTION = "totalbase.dashboards_query(text, text[], name)";
const TEXT_ARRAY_OID = 1009;
/** The function's refusal when its owner isn't the role the caller means (the migration's RAISE). */
const OWNER_MISMATCH_SQLSTATE = "TB001";

/** Why a role can't run widget SQL, or what it can do that it shouldn't - Status words each (Administration.md §1.6). */
export type QueryRoleProblem = "missing" | "own_role" | "superuser" | "not_granted" | "bypassrls" | "reads_totalbase";

interface RoleFacts {
  exists: boolean;
  own: boolean;
  superuser: boolean;
  member: boolean;
  bypassrls: boolean;
  readsTotalbase: boolean;
  owner: string;
}

async function roleFacts(database: { query: ReadOnlyQueryable["query"] }, role: string): Promise<RoleFacts> {
  const { rows } = await database.query<RoleFacts>(
    `SELECT r.oid IS NOT NULL AS exists,
            coalesce(r.rolname = current_user, false) AS own,
            coalesce(r.rolsuper, false) AS superuser,
            -- Its privileges, inherited (the function's EXECUTE is the role's once it owns it), and - PostgreSQL 16+,
            -- where a grant can withhold it - SET ROLE, which ALTER FUNCTION ... OWNER TO needs. 15: a member has both
            -- but for a NOINHERIT role, which USAGE catches.
            coalesce(pg_has_role(current_user, r.oid, 'USAGE')
                     AND CASE WHEN current_setting('server_version_num')::int >= 160000 THEN pg_has_role(current_user, r.oid, 'SET') ELSE true END, false) AS member,
            coalesce(r.rolbypassrls, false) AS bypassrls,
            coalesce(has_schema_privilege(r.oid, 'totalbase', 'USAGE'), false) AS "readsTotalbase",
            (SELECT pg_get_userbyid(proowner) FROM pg_proc WHERE oid = $2::regprocedure) AS owner
       FROM (SELECT 1) AS one LEFT JOIN pg_roles r ON r.rolname = $1`,
    [role, QUERY_FUNCTION],
  );
  return rows[0]!;
}

/** The problems that stop `role` from running widget SQL - the first is the one a run says. */
function blocking(facts: RoleFacts): QueryRoleProblem[] {
  if (!facts.exists) return ["missing"];
  return [
    ...(facts.own ? ["own_role" as const] : []),
    ...(facts.superuser ? ["superuser" as const] : []),
    ...(facts.member ? [] : ["not_granted" as const]),
  ];
}

function unavailable(role: string, problem: QueryRoleProblem): TotalBaseError {
  const settings = "Settings › Features › Dashboards › Widget query role";
  const message = {
    missing: `The widget query role "${role}" doesn't exist in PostgreSQL - create it (CREATE ROLE ... NOLOGIN) and grant it to TotalBase's role, or clear ${settings}.`,
    own_role: `The widget query role "${role}" is TotalBase's own role - name a role with less, or clear ${settings}.`,
    superuser: `The widget query role "${role}" is a superuser - it would read everything; name a role with less.`,
    not_granted: `TotalBase's PostgreSQL role can't use the widget query role "${role}" - GRANT "${role}" TO TotalBase's role (PostgreSQL 16+: WITH INHERIT TRUE, SET TRUE; TotalBase's role not NOINHERIT).`,
  }[problem as "missing" | "own_role" | "superuser" | "not_granted"];
  return new TotalBaseError("DASHBOARD_QUERY_ROLE_UNAVAILABLE", message);
}

/**
 * The role widget SQL runs as, its function handed to it - or null when `dashboards.query_role` is empty. The first
 * use of a role in this process checks it (it exists, isn't TotalBase's own or a superuser, TotalBase's role is a
 * member of it that inherits its privileges and may SET ROLE to it) and, when the function belongs to someone else, makes it the owner: ALTER FUNCTION ... OWNER TO needs
 * the new owner's CREATE on the schema, granted and revoked again within the same transaction. Outside the read-only
 * transaction it serves - DDL - and only when the owner changes.
 */
export async function queryRole(ctx: DashboardsContext): Promise<string | null> {
  const role = (await ctx.queryRole?.()) ?? "";
  if (!role) return null;
  if (ctx.queryRoleReady === role) return role;
  await ctx.database.transaction(async (client) => {
    const facts = await roleFacts(client, role);
    const problem = blocking(facts)[0];
    if (problem) throw unavailable(role, problem);
    if (facts.owner !== role) {
      const quoted = quoteIdentifier(role);
      await client.query(`GRANT CREATE ON SCHEMA totalbase TO ${quoted}`);
      await client.query(`ALTER FUNCTION ${QUERY_FUNCTION} OWNER TO ${quoted}`);
      await client.query(`REVOKE CREATE ON SCHEMA totalbase FROM ${quoted}`);
    }
  });
  ctx.queryRoleReady = role;
  return role;
}

/** What Status says of the widget query role (Administration.md §1.6): nothing when unset or fine. */
export async function queryRoleProblems(ctx: DashboardsContext): Promise<QueryRoleProblem[]> {
  const role = (await ctx.queryRole?.()) ?? "";
  if (!role) return [];
  const facts = await roleFacts(ctx.database, role);
  const problems = blocking(facts);
  if (problems.includes("missing")) return problems;
  return [...problems, ...(facts.bypassrls ? ["bypassrls" as const] : []), ...(facts.readsTotalbase ? ["reads_totalbase" as const] : [])];
}

/**
 * A variable's placeholder in widget SQL (bindSqlVariables): its own positional parameter on TotalBase's role, an
 * element of the one `text[]` the function passes on (`EXECUTE ... USING`) under a query role - cast either way.
 */
export function variablePlaceholder(role: string | null): ((index: number, cast: string) => string) | undefined {
  return role ? (index, cast) => `($1[${index}]::${cast})` : undefined;
}

/**
 * Runs one author-written statement - as TotalBase's role, or inside the query function as `role`. Under a role its
 * columns come from PostgreSQL's description of it (Parse/Describe, nothing run): their names, their origin (a
 * table's column, for the widget's presentation) and their exact types, written out as the call's column list
 * (`format_type`, typmods included) so node-postgres parses every value as it would from the statement itself. The
 * rows come back by position (`c1`, `c2`...), so two columns of one name stay what they are. A query is cast to those
 * types inside the function: the description gives a domain's column as its base type (`email` as `text`), and
 * RETURN QUERY takes nothing but the exact type. `explain`: the statement is an EXPLAIN, which can't be wrapped - its
 * one `json` column needs no cast.
 */
export async function runWidgetStatement(client: ReadOnlyQueryable, role: string | null, sql: string, params: unknown[], ctx: DashboardsContext, explain = false): Promise<QueryResult> {
  if (!role) return client.query(sql, params);
  const fields = await client.describe(sql, [TEXT_ARRAY_OID]);
  if (fields.length === 0) throw new TotalBaseError("DASHBOARD_QUERY_INVALID", "The query returns no columns.");
  const { rows: types } = await client.query<{ type: string; pseudo: boolean }>(
    `SELECT format_type(t.oid, u.mod) AS type, t.typtype = 'p' AS pseudo
       FROM unnest($1::oid[], $2::int4[]) WITH ORDINALITY AS u(oid, mod, position)
       JOIN pg_type t ON t.oid = u.oid
      ORDER BY u.position`,
    [fields.map((field) => field.dataTypeId), fields.map((field) => field.dataTypeModifier)],
  );
  const pseudo = types.findIndex((type) => type.pseudo);
  if (pseudo !== -1) {
    throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `Column "${fields[pseudo]!.name}" is of type ${types[pseudo]!.type} - under a widget query role a column needs a real type: cast it (::text, ::jsonb).`);
  }
  const columns = types.map((type, index) => `c${index + 1} ${type.type}`).join(", ");
  const cast = explain
    ? sql
    : `SELECT ${types.map((type, index) => `q.c${index + 1}::${type.type}`).join(", ")} FROM (\n${sql}\n) AS q(${types.map((_type, index) => `c${index + 1}`).join(", ")})`;
  try {
    const result = await client.query(
      `SELECT * FROM totalbase.dashboards_query($1, $2::text[], $3) AS dashboard_widget_query(${columns})`,
      [cast, params.map(parameterText), role],
    );
    const named = (row: Record<string, unknown>) => Object.fromEntries(fields.map((field, index) => [field.name, row[`c${index + 1}`]]));
    return { ...result, rows: result.rows.map(named), fields: fields.map(({ dataTypeModifier: _mod, ...field }): ResultField => field) };
  } catch (error) {
    // Its owner changed under this process (by hand, a restore): checked again on the next run.
    if (error instanceof TotalBaseError && error.sqlstate === OWNER_MISMATCH_SQLSTATE) {
      ctx.queryRoleReady = null;
      throw new TotalBaseError("DASHBOARD_QUERY_ROLE_UNAVAILABLE", `The widget query function no longer belongs to "${role}" - run the widget again.`);
    }
    throw error;
  }
}
