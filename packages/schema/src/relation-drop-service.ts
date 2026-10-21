import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import { runDdl, type DdlAuditor } from "./ddl-audit.js";

/**
 * DROP for VIEW/FUNCTION resources, requested alongside the admin UI's
 * per-resource "Drop" action (Admin_UI.md — Resources grid
 * actions). Tables already have full DDL management (table-schema-service.ts,
 * Administration.md §3); views/functions are otherwise
 * introspect-only (Administration.md §4), but the UI needs to be able to remove a
 * stale/unwanted one same as it can a table.
 *
 * Both methods resolve the oid to its canonical, already-quoted identifier
 * via a cast (`::regclass` / `::regprocedure`) in a parameterized SELECT
 * first, then splice that resolved text into the DROP statement — the oid
 * itself is the only untrusted input (an integer, not identifier text), and
 * PostgreSQL is the one producing the identifier syntax, not the caller.
 * `::regprocedure` in particular resolves overload signatures automatically
 * (Foundations.md §11.7 / Data_API.md §7 — functions can be overloaded), which
 * plain name-based DROP FUNCTION couldn't do without a separate argument-list
 * lookup.
 */
export class RelationDropService {
  constructor(private readonly database: Database) {}

  /** `audit`: the drop's audit record, on the same transaction (ddl-audit.ts). */
  async dropView(oid: number, cascade = false, audit?: DdlAuditor): Promise<void> {
    const ident = await this.resolveIdentifier(oid, "regclass", "View");
    await runDdl(this.database, "drop_view", [`DROP VIEW ${ident}${cascade ? " CASCADE" : ""}`], audit);
  }

  async dropFunction(oid: number, cascade = false, audit?: DdlAuditor): Promise<void> {
    const ident = await this.resolveIdentifier(oid, "regprocedure", "Function");
    await runDdl(this.database, "drop_function", [`DROP FUNCTION ${ident}${cascade ? " CASCADE" : ""}`], audit);
  }

  // Casting an unknown oid to ::regclass/::regprocedure raises a native
  // PostgreSQL error ("OID ... does not exist"), which the app's existing
  // postgres-error-mapper.ts turns into a POSTGRESQL-source error same as
  // any other DDL failure here - no special-casing needed, unlike
  // pg_get_viewdef()/pg_get_functiondef() (pg-catalog/src/ddl.ts) which return
  // NULL instead of raising and so need their own not-found check.
  private async resolveIdentifier(oid: number, cast: "regclass" | "regprocedure", label: string): Promise<string> {
    if (!Number.isInteger(oid) || oid <= 0) {
      throw new TotalBaseError("RESOURCE_NOT_FOUND", `${label} not found: oid ${oid}`);
    }
    const { rows } = await this.database.query<{ ident: string }>(
      `SELECT $1::oid::${cast}::text AS ident`,
      [oid],
    );
    return rows[0]!.ident;
  }
}
