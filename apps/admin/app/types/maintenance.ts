export type MaintenanceTableKind = 'TABLE' | 'PARTITIONED_TABLE' | 'MATERIALIZED_VIEW'

export interface MaintenanceTable {
  oid: number
  schema: string
  name: string
  kind: MaintenanceTableKind
  totalBytes: number
  tableBytes: number
  indexBytes: number
  toastBytes: number
  estimatedRows: number | null
  liveRows: number | null
  deadRows: number | null
  lastVacuum: string | null
  lastAutovacuum: string | null
  lastAnalyze: string | null
  lastAutoanalyze: string | null
  owner: string
  canMaintain: boolean
  /** OIDs of its invalid indexes. */
  invalidIndexes: number[]
}

export interface MaintenanceIndex {
  oid: number
  name: string
  bytes: number
  scans: number
  primary: boolean
  unique: boolean
  valid: boolean
  definition: string
}

export interface MaintenanceOverview {
  database: string
  version: string
  sizeBytes: number
  tables: MaintenanceTable[]
}

export type MaintenanceOperation = 'VACUUM' | 'ANALYZE' | 'REINDEX'

export interface MaintenanceRun {
  id: string
  operation: MaintenanceOperation
  tableOid: number
  indexOid: number | null
  label: string
  batchId: string | null
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  progress: { phase: string, percent: number | null } | null
  error: string | null
  queuedBy: string
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

export type MaintenanceBatchItemStatus = 'PENDING' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELLED'

export interface MaintenanceBatch {
  id: string
  operation: MaintenanceOperation
  active: boolean
  total: number
  done: number
  failed: number
  cancelled: number
  pending: number
  current: { label: string, progress: { phase: string, percent: number | null } | null } | null
  startedBy: string
  createdAt: string
  items: Array<{
    id: string
    tableOid: number
    indexOid: number | null
    label: string
    status: MaintenanceBatchItemStatus
    error: string | null
    startedAt: string | null
    completedAt: string | null
  }>
}

/** What a batch will run, shown before it starts. */
export interface MaintenanceBatchPlan {
  operation: MaintenanceOperation
  title: string
  targets: Array<{ table: number, index?: number, label: string }>
  /** Left out, with the reason - e.g. owned by another role. */
  skipped: Array<{ label: string, reason: string }>
  /** One line under the list: what's skipped by rule rather than listed, a disk-space note, ... */
  note?: string
}
