import { describe, expect, it } from 'vitest'
import { isRestoreIdentifier, proposedDatabase, restoreCommands, type RestoreBackup, type RestoreOptions } from '~/utils/backup-restore-commands'

const BACKUP: RestoreBackup = { name: 'totalbase-20261021-030000-1a2b3c4d.tar', destination: 'LOCAL', database: 'acme', files: true, filesPath: '/var/lib/totalbase/files', createdAt: '2026-10-21T03:00:00.000Z' }
const OPTIONS: RestoreOptions = { database: 'acme_restored_20261021', user: 'totalbase', postgresInCompose: true, appService: 'totalbase', dbService: 'postgres', localPath: '/var/lib/totalbase/backups' }
const TODAY = new Date('2026-10-22T10:00:00Z')
const command = (commands: ReturnType<typeof restoreCommands>, step: string) => commands.find(c => c.step === step)?.command

describe('restoreCommands', () => {
  it('creates the database owned by TotalBase\'s role, moves the current files aside, restores from the data volume, then switches', () => {
    const commands = restoreCommands(BACKUP, OPTIONS, TODAY)
    expect(commands.map(c => c.step)).toEqual(['create', 'stop', 'restore', 'switch', 'start', 'rollback'])
    expect(command(commands, 'create')).toBe('docker compose exec postgres psql -U postgres -c "CREATE DATABASE acme_restored_20261021 OWNER totalbase;"')
    expect(command(commands, 'restore')).toBe(
      'docker compose run --rm -e POSTGRES_DB=acme_restored_20261021 totalbase sh -c "mv /var/lib/totalbase/files /var/lib/totalbase/files.before-restore-20261022 && totalbase restore /var/lib/totalbase/backups/totalbase-20261021-030000-1a2b3c4d.tar"'
    )
    expect(command(commands, 'switch')).toBe('POSTGRES_DB: acme_restored_20261021')
    // Going back: the old database, the files put back.
    expect(command(commands, 'rollback')).toContain('POSTGRES_DB: acme')
    expect(command(commands, 'rollback')).toContain('mv /var/lib/totalbase/files.before-restore-20261022 /var/lib/totalbase/files')
  })

  it('takes an S3 backup from the current directory once downloaded, and gives the SQL alone for a PostgreSQL elsewhere', () => {
    const commands = restoreCommands({ ...BACKUP, destination: 'S3', files: false }, { ...OPTIONS, postgresInCompose: false }, TODAY)
    expect(commands.map(c => c.step)).toEqual(['createSql', 'download', 'stop', 'restore', 'switch', 'start', 'rollback'])
    expect(command(commands, 'createSql')).toBe('CREATE DATABASE acme_restored_20261021 OWNER totalbase;')
    // No files in it: the current ones stay where they are.
    expect(command(commands, 'restore')).toBe('docker compose run --rm -e POSTGRES_DB=acme_restored_20261021 -v "$PWD":/restore totalbase totalbase restore /restore/totalbase-20261021-030000-1a2b3c4d.tar')
  })

  it('proposes a database name PostgreSQL takes as is', () => {
    expect(proposedDatabase(BACKUP)).toBe('acme_restored_20261021')
    expect(proposedDatabase({ database: 'Acme-Prod', createdAt: BACKUP.createdAt })).toBe('acme_prod_restored_20261021')
    expect(proposedDatabase({ database: 'x'.repeat(80), createdAt: BACKUP.createdAt })).toHaveLength(63)
    expect(isRestoreIdentifier('acme; DROP')).toBe(false)
  })
})
