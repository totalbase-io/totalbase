export type AuditStatus = 'EXECUTED' | 'DENIED' | 'FAILED'

/**
 * An audit log entry: GET /audit/logs for an administrator, or a
 * logs row through the Data API (useAuditLogs) - there a column
 * the viewer may not read is simply absent.
 */
export interface AuditLog {
  id: string
  requestId: string
  principalType: string
  principalId: string | null
  session: string | null
  resource: string | null
  action: string
  status: AuditStatus
  source: string
  ip: string | null
  userAgent: string | null
  fields: string[] | null
  whereClause: unknown
  payload: unknown
  changes: unknown
  metadata: unknown
  /** `metadata.event`, as the table's own generated column - what a viewer without `metadata` still reads. */
  event?: string | null
  /** `schema.name` of `resource`, through the relation path - for a viewer who can't read the registry. */
  resourceName?: string | null
  sqlText: string | null
  sqlParams: unknown
  errorCode: string | null
  sqlstate: string | null
  errorMessage: string | null
  errorDetail: string | null
  errorHint: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  createdAt: string
}
