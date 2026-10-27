import type { FastifyRequest } from "fastify";
import type { Queryable } from "@totalbase/database";
import type { FieldNode } from "@totalbase/query-engine";
import type { ResolvedApiResource } from "@totalbase/resources";
import { TotalBaseError } from "@totalbase/errors";
import type { AppContext } from "./context.js";
import type { DataPrincipal } from "./data-principal.js";

/**
 * READ audit for the Data API (Security.md §11: "READ is
 * configurable per resource" - resources.audit_read). Only a
 * resource with audit_read on writes anything; ResolvedApiResource already
 * carries the flag from the lookup every Data API read makes, so a resource
 * with it off costs nothing extra.
 *
 * What a READ row records is the operation, never the data (Security.md §11.5:
 * "READ never stores returned rows"): `fields` (the requested paths),
 * `where_clause` (the request's own filter, in the filter-object grammar -
 * the same shape the grid's EXPORT/PRINT events store), and in `metadata`
 * the number of rows returned (`rowCount`, plus `count` when the caller
 * asked for the total, `search`, and `pk` for a by-key read). No `payload`.
 *
 * The EXECUTED row is written inside the read's own transaction: if it
 * can't be written, the read fails instead of returning data the log
 * never saw. DENIED/FAILED rows go through a fresh connection,
 * best-effort, never masking the original error (the same rule
 * recordMutationFailure follows for writes).
 */
export interface ReadAuditDetail {
  fields?: FieldNode[] | undefined;
  where?: unknown;
  search?: string | undefined;
  pk?: string | undefined;
}

/** Where a read comes from, for its audit row - an HTTP request's, or whatever reads without one. */
export interface ReadOrigin {
  requestId: string;
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export function readOrigin(request: FastifyRequest): ReadOrigin {
  return { requestId: request.id, ip: request.ip, userAgent: request.headers["user-agent"] };
}

export class ReadAudit {
  private readonly startedAt = new Date();

  constructor(
    private readonly context: AppContext,
    private readonly origin: ReadOrigin,
    private readonly resource: ResolvedApiResource,
    private readonly dataPrincipal: DataPrincipal,
  ) {}

  private base(detail: ReadAuditDetail) {
    return {
      requestId: this.origin.requestId,
      principal: this.dataPrincipal.principal,
      resourceId: this.resource.id,
      action: "READ" as const,
      source: "api",
      ip: this.origin.ip,
      userAgent: this.origin.userAgent,
      fields: detail.fields?.map((field) => field.path.join(".")),
      whereClause: detail.where,
      startedAt: this.startedAt,
    };
  }

  /** The EXECUTED row, on the read's own transaction client. */
  async executed(client: Queryable, detail: ReadAuditDetail, rowCount: number, count?: number): Promise<void> {
    if (!this.resource.auditRead) return;
    await this.context.audit.record(client, {
      ...this.base(detail),
      status: "EXECUTED",
      metadata: {
        rowCount,
        ...(count !== undefined && { count }),
        ...(detail.search !== undefined && { search: detail.search }),
        ...(detail.pk !== undefined && { pk: detail.pk }),
      },
      finishedAt: new Date(),
    });
  }

  /** A DENIED or FAILED row - best-effort, on a fresh connection. */
  async failed(status: "DENIED" | "FAILED", detail: ReadAuditDetail, error: unknown): Promise<void> {
    if (!this.resource.auditRead) return;
    try {
      await this.context.audit.record(this.context.database, {
        ...this.base(detail),
        status,
        metadata: detail.pk !== undefined ? { pk: detail.pk } : undefined,
        error:
          error instanceof TotalBaseError
            ? { code: error.code, sqlstate: error.sqlstate, message: error.message, detail: error.detail, hint: error.hint }
            : { message: error instanceof Error ? error.message : String(error) },
        finishedAt: new Date(),
      });
    } catch {
      // Audit logging must never mask or replace the original error.
    }
  }
}
