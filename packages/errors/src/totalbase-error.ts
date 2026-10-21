import { ERROR_CODE_HTTP_STATUS, type TotalBaseErrorCode } from "./error-codes.js";

/** Error source, per Data_API.md §11.1. */
export type ErrorSource = "TOTALBASE" | "POSTGRESQL";

export interface TotalBaseErrorOptions {
  source?: ErrorSource | undefined;
  httpStatus?: number | undefined;
  detail?: string | undefined;
  hint?: string | undefined;
  /** PostgreSQL's error position: the 1-based character offset into the statement text. Only the SQL Console's toAdminJSON() serializes it. */
  position?: number | undefined;
  sqlstate?: string | undefined;
  /** The PostgreSQL constraint (or unique index) a violation came from - for a service to tell which rule broke without reading the message, which a constraint's COMMENT may replace. Never serialized. */
  constraint?: string | undefined;
  /** The column the error is about, when PostgreSQL names exactly one (a NOT NULL, a one-column UNIQUE or CHECK) - a form shows it on that field. */
  field?: string | undefined;
  /** A transaction's operation it came from, by key (Data_API.md §8) - a form shows it on that line. */
  operation?: string | undefined;
  /**
   * Every problem of a document checked as a whole (a dashboard's spec, DM2), each at its path - sent as the
   * response's `errors`, in place of this one. This error's own code and message summarize them.
   */
  all?: { code: TotalBaseErrorCode; message: string; path: string }[] | undefined;
  /** What the caller needs to go on, sent as the error's `meta` - an MFA challenge (Security.md §2.17). */
  meta?: Record<string, unknown> | undefined;
  cause?: unknown;
}

/**
 * Canonical internal error type for TotalBase.
 * See Data_API.md §11.1, §11.2 and AGENTS.md section 20.
 *
 * The Data API serializes this as:
 * { "errors": [{ "source", "code", "message", "field"?, "operation"?, "meta"? }] }
 */
export class TotalBaseError extends Error {
  readonly code: TotalBaseErrorCode;
  readonly source: ErrorSource;
  readonly httpStatus: number;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly position: number | undefined;
  readonly sqlstate: string | undefined;
  readonly constraint: string | undefined;
  readonly field: string | undefined;
  readonly operation: string | undefined;
  readonly all: { code: TotalBaseErrorCode; message: string; path: string }[] | undefined;
  readonly meta: Record<string, unknown> | undefined;

  constructor(code: TotalBaseErrorCode, message: string, options: TotalBaseErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "TotalBaseError";
    this.code = code;
    this.source = options.source ?? "TOTALBASE";
    this.httpStatus = options.httpStatus ?? ERROR_CODE_HTTP_STATUS[code] ?? 500;
    this.detail = options.detail;
    this.hint = options.hint;
    this.position = options.position;
    this.sqlstate = options.sqlstate;
    this.constraint = options.constraint;
    this.field = options.field;
    this.operation = options.operation;
    this.all = options.all;
    this.meta = options.meta;
  }

  /** What the response's `errors` carries: each of `all` at its path, else this one. */
  toPublicErrors(): Record<string, unknown>[] {
    return this.all?.length ? this.all.map((e) => ({ source: "TOTALBASE", code: e.code, message: e.message, path: e.path })) : [this.toPublicJSON()];
  }

  /** The same error, naming the transaction's operation it came from. */
  inOperation(operation: string): TotalBaseError {
    return new TotalBaseError(this.code, this.message, {
      source: this.source, httpStatus: this.httpStatus, detail: this.detail, hint: this.hint, position: this.position,
      sqlstate: this.sqlstate, constraint: this.constraint, field: this.field, operation, cause: this.cause,
    });
  }

  /**
   * Public Data API representation.
   * Must never expose generated SQL (AGENTS.md section 20).
   */
  toPublicJSON() {
    return {
      source: this.source,
      code: this.code,
      message: this.message,
      ...(this.field ? { field: this.field } : {}),
      ...(this.operation ? { operation: this.operation } : {}),
      ...(this.meta ? { meta: this.meta } : {}),
    };
  }

  /**
   * Richer representation for the Admin SQL Console only, which may
   * expose PostgreSQL's own diagnostics (AGENTS.md section 20,
   * Administration.md §5.6): DETAIL, HINT, SQLSTATE and the
   * error position - present only when PostgreSQL gave them.
   */
  toAdminJSON() {
    return {
      ...this.toPublicJSON(),
      ...(this.detail !== undefined ? { detail: this.detail } : {}),
      ...(this.hint !== undefined ? { hint: this.hint } : {}),
      ...(this.sqlstate !== undefined ? { sqlstate: this.sqlstate } : {}),
      ...(this.position !== undefined ? { position: this.position } : {}),
    };
  }
}

/** Who a permission error is about, before the server knows better - "Seeing as" names the role (view-as.ts). */
export const DENIED_FOR_CALLER = "for your roles";

/**
 * A permission refusal's message (ACTION_DENIED): the action and the resource the caller asked for - no more than
 * they named - so the fix reads at once: "No READ grant on public.customers for your roles."
 */
export function deniedMessage(action: string, schema: string, resource: string): string {
  return `No ${action} grant on ${schema}.${resource} ${DENIED_FOR_CALLER}.`;
}
