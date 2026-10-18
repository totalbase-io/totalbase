export interface PostgresNotice {
  severity: string
  message: string
  detail?: string
  hint?: string
  code?: string
}

/** A failed SQL Console run, as the result panel shows it: PostgreSQL's message and diagnostics, and where the error is in the editor. */
export interface SqlConsoleError {
  message: string
  detail?: string
  hint?: string
  sqlstate?: string
  /** 1-based line/column in the editor - from PostgreSQL's position (utils/sql-error-position.ts). */
  location?: { line: number, column: number }
}

export interface ResultColumn {
  name: string
  dataType: string
}

/** A successful run - a failed one answers the error envelope instead. `rows` keep their PostgreSQL column names. */
export interface SqlExecuteResult {
  status: 'EXECUTED'
  rows: Record<string, unknown>[]
  rowCount: number
  /** `rows` was cut to sql_console.max_rows - `rowCount` is the real total. */
  truncated?: boolean
  columns: ResultColumn[]
  notices: PostgresNotice[]
  durationMs: number
}

export interface SqlHistoryEntry {
  id: string
  admin: string
  sqlText: string
  status: 'EXECUTED' | 'FAILED'
  durationMs: number | null
  errorMessage: string | null
  createdAt: string
}
