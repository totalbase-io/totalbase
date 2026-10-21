/**
 * The commands Restore… hands an administrator (Administration.md §12.5): a
 * backup restored into a new, empty database of a Docker Compose setup, the
 * instance then switched to it. Nothing runs from the admin - the restore
 * replaces the instance, so it's done with the server stopped, by its own
 * `totalbase restore`. No password or key ever appears: they come from the
 * Compose setup's own configuration.
 */

export interface RestoreBackup {
  name: string
  destination: 'LOCAL' | 'S3'
  /** The database it was taken from, whether files are in it, and where they were kept - its manifest's. */
  database: string
  files: boolean
  filesPath: string
  createdAt: string
}

export interface RestoreOptions {
  /** The new, empty database the backup goes into. */
  database: string
  /** The PostgreSQL role TotalBase connects as - the new database's owner. */
  user: string
  /** PostgreSQL is a service of the same Compose project (the installation guide's first setup). */
  postgresInCompose: boolean
  appService: string
  dbService: string
  /** Where local backups are written (backups.local_path) - inside the container. */
  localPath: string
}

export interface RestoreCommand {
  /** What the step does - an i18n key under settings.backups.restore.steps. */
  step: 'create' | 'createSql' | 'download' | 'stop' | 'restore' | 'switch' | 'start' | 'rollback'
  command: string
}

/** A PostgreSQL identifier or a Compose service name these commands take as is: no quoting, no shell. */
const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/
const SERVICE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/
export const isRestoreIdentifier = (value: string) => IDENTIFIER.test(value)
export const isComposeService = (value: string) => SERVICE.test(value)

/** `acme_restored_20261021` - the backup's database and day, cut to PostgreSQL's 63 characters. */
export function proposedDatabase(backup: Pick<RestoreBackup, 'database' | 'createdAt'>): string {
  const day = backup.createdAt.slice(0, 10).replaceAll('-', '')
  const base = backup.database.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^([^a-z_])/, '_$1')
  const suffix = `_restored_${day}`
  return `${base.slice(0, 63 - suffix.length)}${suffix}`
}

/** The day a restore moves the current files aside under: `files.before-restore-20261021`. */
function asideSuffix(today: Date): string {
  return `before-restore-${today.toISOString().slice(0, 10).replaceAll('-', '')}`
}

export function restoreCommands(backup: RestoreBackup, options: RestoreOptions, today = new Date()): RestoreCommand[] {
  const { appService: app, dbService: db, database, user } = options
  const archive = backup.destination === 'S3' ? `/restore/${backup.name}` : `${options.localPath.replace(/\/+$/, '')}/${backup.name}`
  const mount = backup.destination === 'S3' ? ' -v "$PWD":/restore' : ''
  const aside = `${backup.filesPath}.${asideSuffix(today)}`
  // The current files moved aside first - nothing deleted -, so the backup's unpack into an empty directory.
  const restore = backup.files
    ? `sh -c "mv ${backup.filesPath} ${aside} && totalbase restore ${archive}"`
    : `totalbase restore ${archive}`
  const sql = `CREATE DATABASE ${database} OWNER ${user};`
  return [
    options.postgresInCompose
      ? { step: 'create', command: `docker compose exec ${db} psql -U postgres -c "${sql}"` }
      : { step: 'createSql', command: sql },
    ...(backup.destination === 'S3' ? [{ step: 'download' as const, command: backup.name }] : []),
    { step: 'stop', command: `docker compose stop ${app}` },
    { step: 'restore', command: `docker compose run --rm -e POSTGRES_DB=${database}${mount} ${app} ${restore}` },
    { step: 'switch', command: `POSTGRES_DB: ${database}` },
    { step: 'start', command: `docker compose up -d ${app}` },
    {
      step: 'rollback',
      command: backup.files
        ? `docker compose stop ${app}\n# docker-compose.yml: POSTGRES_DB: ${backup.database}\ndocker compose run --rm ${app} sh -c "mv ${backup.filesPath} ${backup.filesPath}.restored && mv ${aside} ${backup.filesPath}"\ndocker compose up -d ${app}`
        : `docker compose stop ${app}\n# docker-compose.yml: POSTGRES_DB: ${backup.database}\ndocker compose up -d ${app}`
    }
  ]
}
