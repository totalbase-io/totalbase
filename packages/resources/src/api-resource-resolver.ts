import { TotalBaseError } from "@totalbase/errors";
import type { DataApiMethod } from "./resources-admin-service.js";
import type { Queryable } from "@totalbase/database";

export interface ResolvedApiResource {
  id: string;
  postgresOid: number;
  schema: string;
  name: string;
  /**
   * resources.audit_read (Specification_Security.md §11.5: "READ is configurable
   * per resource") - loaded by the same lookup that resolves the resource,
   * so a Data API read learns whether to audit itself without a query of
   * its own.
   */
  auditRead: boolean;
  /** resources.require_idempotency_key (Specification_Data_API.md §9.1): its write never runs without an Idempotency-Key. */
  requireIdempotencyKey: boolean;
  /** resources.default_sort (Specification.md §11.7): the order a read without `order_by` uses. */
  defaultSort: { column: string; direction: "asc" | "desc" }[];
}

interface ResolvedRow {
  id: string;
  postgres_oid: number;
  audit_read: boolean;
  require_idempotency_key: boolean;
  default_sort: { column: string; direction: "asc" | "desc" }[];
}

function toResolved(row: ResolvedRow, schema: string, name: string): ResolvedApiResource {
  return {
    id: row.id,
    postgresOid: row.postgres_oid,
    schema,
    name,
    auditRead: row.audit_read,
    requireIdempotencyKey: row.require_idempotency_key,
    defaultSort: row.default_sort ?? [],
  };
}

async function resolveSingle(
  context: { database: Queryable },
  schema: string,
  name: string,
  type: "TABLE" | "VIEW",
  method: DataApiMethod,
): Promise<ResolvedApiResource> {
  const { rows } = await context.database.query<ResolvedRow>(
    `SELECT id, postgres_oid, audit_read, require_idempotency_key, default_sort FROM totalbase.resources
     WHERE "schema" = $1 AND name = $2 AND type = $3 AND status = 'ACTIVE' AND $4 = ANY(exposed_methods)`,
    [schema, name, type, method],
  );
  const row = rows[0];
  if (!row) {
    throw new TotalBaseError("RESOURCE_NOT_FOUND", `Resource not found: ${schema}.${name}`);
  }
  return toResolved(row, schema, name);
}

/**
 * Resolves {schema}/table/{resource} to an ACTIVE, exposed TABLE resource
 * with `method` mounted. `method` is required, not inferred, so every call
 * site has to say out loud which verb it's serving - the admin's per-verb
 * "exposed_methods" gate (a hard ceiling below role permissions, e.g.
 * "DELETE never exists for this table") lives here, in the one place every
 * Data API route already funnels through. Hidden/MISSING/wrong-type/
 * disabled-method resources are all indistinguishable from "does not
 * exist" (Specification_Data_API.md §11.5).
 */
export async function resolveTableResource(
  context: { database: Queryable },
  schema: string,
  name: string,
  method: DataApiMethod,
): Promise<ResolvedApiResource> {
  return resolveSingle(context, schema, name, "TABLE", method);
}

/** Resolves {schema}/view/{resource} to an ACTIVE, exposed VIEW resource with GET mounted. */
export async function resolveViewResource(
  context: { database: Queryable },
  schema: string,
  name: string,
): Promise<ResolvedApiResource> {
  return resolveSingle(context, schema, name, "VIEW", "GET");
}

/**
 * Resolves {schema}/function/{resource} to every ACTIVE, exposed, POST-
 * mounted FUNCTION resource sharing that schema+name - each PostgreSQL
 * overload is its own TotalBase resource (identity is per-OID,
 * Specification.md §11.7), so a name can match zero, one, or several candidates.
 */
export async function resolveFunctionCandidates(
  context: { database: Queryable },
  schema: string,
  name: string,
): Promise<ResolvedApiResource[]> {
  const { rows } = await context.database.query<ResolvedRow>(
    `SELECT id, postgres_oid, audit_read, require_idempotency_key, default_sort FROM totalbase.resources
     WHERE "schema" = $1 AND name = $2 AND type = 'FUNCTION' AND status = 'ACTIVE' AND 'POST' = ANY(exposed_methods)`,
    [schema, name],
  );
  return rows.map((row) => toResolved(row, schema, name));
}
