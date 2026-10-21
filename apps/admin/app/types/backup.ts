/** A backup as GET /admin/api/backups lists it (Administration.md §12). */
export interface Backup {
  id: string
  status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED'
  trigger: 'SCHEDULED' | 'MANUAL'
  scheduledFor: string | null
  requestedBy: string | null
  destination: 'LOCAL' | 'S3'
  name: string
  sizeBytes: number | null
  /** What the archive holds (its manifest.json) - the database it was taken from, whether files are in it and where they were kept. */
  manifest: { totalbaseVersion: string, postgresVersion: string, database: string, files: boolean, filesPath: string } | null
  error: string | null
  createdAt: string
  startedAt: string | null
  completedAt: string | null
}

/** The schedule as it stands - `meta` of GET /admin/api/backups. */
export interface BackupsOverview {
  enabled: boolean
  schedule: string
  timezone: string
  nextAt: string | null
  destination: 'LOCAL' | 'S3'
}
