import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";

/**
 * Who owns a table, view or function, and whether the configured
 * PostgreSQL role may change its structure (Administration.md
 * §3.15). ALTER, DROP, CREATE INDEX and adding constraints all require
 * ownership: being the owner or a member of the owner role (superusers
 * included). 'USAGE', not 'MEMBER': PostgreSQL's owner check needs the
 * owner's privileges without a SET ROLE, so a NOINHERIT membership doesn't
 * count.
 * A hint for the UI only: PostgreSQL still decides every statement.
 */
export interface ObjectOwnership {
  owner: string;
  canAlter: boolean;
}

/** A relation (table, view, materialized view) by pg_class OID. */
export async function getRelationOwnership(database: Database, oid: number): Promise<ObjectOwnership> {
  return ownership(database, `SELECT pg_get_userbyid(relowner) AS owner, pg_has_role(relowner, 'USAGE') AS can_alter FROM pg_class WHERE oid = $1`, oid);
}

/** A function or procedure by pg_proc OID. */
export async function getFunctionOwnership(database: Database, oid: number): Promise<ObjectOwnership> {
  return ownership(database, `SELECT pg_get_userbyid(proowner) AS owner, pg_has_role(proowner, 'USAGE') AS can_alter FROM pg_proc WHERE oid = $1`, oid);
}

async function ownership(database: Database, sql: string, oid: number): Promise<ObjectOwnership> {
  const { rows } = await database.query<{ owner: string; can_alter: boolean }>(sql, [oid]);
  const row = rows[0];
  if (!row) throw new TotalBaseError("RESOURCE_NOT_FOUND", `No PostgreSQL object with OID ${oid}.`);
  return { owner: row.owner, canAlter: row.can_alter };
}
