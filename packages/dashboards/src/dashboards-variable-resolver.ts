import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { BoundVariable, DateRangePart, SqlVariableRef } from "./sql-variables.js";
import { dateRangeBoundsSql, normalizeVariableValue, type DashboardVariable, type DateRangeValue } from "./variables.js";
import type { DashboardQueryContext } from "./dashboards-types.js";

/** Columns never exposed through `$USER.*` - a widget query could otherwise just SELECT them. */
export const DENIED_USER_FIELDS = new Set(["password_hash"]);

/**
 * Resolves `$USER.*` / `$VAR.*` for one execution, inside its read-only
 * transaction. Everything is looked up lazily and cached per execution:
 * only a query that uses `$USER.*` reads the user row, and a DATE_RANGE
 * is computed once even if `.from` and `.to` are both used.
 */
export class VariableResolver {
  private userColumns: Map<string, string> | null = null;
  private userRow: Record<string, unknown> | null = null;
  private readonly dateBounds = new Map<string, Record<DateRangePart, unknown>>();

  /** `probe`: every variable NULL of its type - a query checked, never run for a viewer (brokenWidgets). */
  constructor(
    private readonly client: Queryable,
    private readonly context: DashboardQueryContext,
    private readonly probe = false,
  ) {}

  async resolve(ref: SqlVariableRef): Promise<BoundVariable> {
    return ref.kind === "USER" ? this.resolveUser(ref.field) : this.resolveVar(ref.name, ref.part);
  }

  /** `$USER.<column>` - the caller's real users row, cast to that column's real type (Specification_Data_API.md §3.7). */
  private async resolveUser(field: string): Promise<BoundVariable> {
    if (DENIED_USER_FIELDS.has(field)) {
      throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `$USER.${field} is not available to widget queries.`);
    }
    if (!this.context.userId && !this.probe) {
      throw new TotalBaseError("DASHBOARD_QUERY_INVALID", "$USER.* needs a signed-in user.");
    }
    if (!this.userColumns) {
      const { rows } = await this.client.query<{ name: string; type: string }>(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a
         WHERE a.attrelid = 'totalbase.users'::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
      );
      this.userColumns = new Map(rows.map((r) => [r.name, r.type]));
    }
    const type = this.userColumns.get(field);
    if (!type) throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `Unknown $USER field: ${field}`);
    if (this.probe) return { value: null, cast: type };
    if (!this.userRow) {
      const { rows } = await this.client.query(`SELECT * FROM totalbase.users WHERE id = $1`, [this.context.userId]);
      if (!rows[0]) throw new TotalBaseError("DASHBOARD_QUERY_INVALID", "$USER.* - the current user no longer exists.");
      this.userRow = rows[0];
    }
    return { value: this.userRow[field] ?? null, cast: type };
  }

  /** A variable's default for this viewer (D22): a constant, or a field of their own user row - none without one. */
  async defaultValue(variable: DashboardVariable): Promise<unknown> {
    const def = variable.default;
    if (!def) return null;
    if (def.source === "constant") return def.value;
    if (this.probe || !this.context.userId) return null;
    return (await this.resolveUser(def.field)).value;
  }

  /** `$VAR.<name>[.from|.to|.prev_from|.prev_to]` - a viewer-chosen value (or the default), validated for its type, never trusted as security. */
  private async resolveVar(name: string, part: DateRangePart | null): Promise<BoundVariable> {
    const variable = this.context.variables.find((v) => v.name === name);
    if (!variable) throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `Undefined variable $VAR.${name}.`);
    const raw = Object.prototype.hasOwnProperty.call(this.context.values, name) ? this.context.values[name] : await this.defaultValue(variable);
    const value = this.probe ? null : normalizeVariableValue(variable, raw);

    if (variable.type === "DATE_RANGE") {
      if (!part) {
        throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `$VAR.${name} is a date range - use $VAR.${name}.from and $VAR.${name}.to.`);
      }
      let bounds = this.dateBounds.get(name);
      if (!bounds) {
        if (value === null) {
          bounds = { from: null, to: null, prev_from: null, prev_to: null };
        } else {
          const { sql, params } = dateRangeBoundsSql(value as DateRangeValue);
          const { rows } = await this.client.query<Record<DateRangePart, unknown>>(sql, params);
          bounds = rows[0]!;
        }
        this.dateBounds.set(name, bounds);
      }
      return { value: bounds[part], cast: "timestamptz" };
    }

    if (part) {
      throw new TotalBaseError("DASHBOARD_QUERY_INVALID", `$VAR.${name}.${part} - only date ranges have .from/.to/.prev_from/.prev_to.`);
    }
    const cast = variable.type === "NUMBER" ? "numeric" : variable.type === "SELECT" && variable.multiple ? "text[]" : "text";
    return { value, cast };
  }
}
