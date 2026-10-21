/**
 * Shapes of the Admin API response envelope.
 * Admin_UI.md §2 — grounded in the real, running server, not
 * guessed. Error codes themselves are NOT re-enumerated here: the exhaustive
 * list lives server-side in packages/errors/src/error-codes.ts and the UI
 * must not fork it — we treat `code` as an opaque string and `message` as
 * the human-readable text the server already produced.
 */

export interface AdminApiError {
  source: 'TOTALBASE' | 'POSTGRESQL'
  code: string
  message: string
  /** The column it's about, when PostgreSQL names one (a NOT NULL, a one-column UNIQUE or CHECK). */
  field?: string
  /** PostgreSQL's own diagnostics - only the SQL Console's routes send them (Administration.md §5.2). */
  detail?: string
  hint?: string
  sqlstate?: string
  /** 1-based character offset into the SQL sent. */
  position?: number
  /** Where in a document it is - a dashboard spec's (`widgets[3].config.roles.value`, `name`). */
  path?: string
  /** What the caller needs to go on - a sign-in's MFA challenge (`{ challenge, expiresAt }`, Security.md §2.17). */
  meta?: Record<string, unknown>
}

export interface AdminApiErrorEnvelope {
  errors: AdminApiError[]
}

export interface AdminApiSuccessEnvelope<T> {
  data: T
  meta?: {
    count?: number
    total?: number
    [key: string]: unknown
  }
}

export type AdminApiEnvelope<T> = AdminApiSuccessEnvelope<T> | AdminApiErrorEnvelope

export function isErrorEnvelope(body: unknown): body is AdminApiErrorEnvelope {
  return typeof body === 'object' && body !== null && 'errors' in body
}
