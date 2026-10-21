import { createReadStream } from "node:fs";
import { access, copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";
import type { Database } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { matchesCron, nextOccurrences, parseCronExpression, wallClockInZone } from "@totalbase/shared";
import { DATABASE_FILE, FILES_FILE, MANIFEST_FILE, type BackupManifest } from "./manifest.js";
import { pgTool, runCommand } from "./process.js";

export type BackupStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED";
export type BackupTrigger = "SCHEDULED" | "MANUAL";
export type BackupDestination = "LOCAL" | "S3";

export interface Backup {
  id: string;
  status: BackupStatus;
  trigger: BackupTrigger;
  scheduledFor: Date | null;
  requestedBy: string | null;
  destination: BackupDestination;
  name: string;
  sizeBytes: number | null;
  manifest: BackupManifest | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}

/** What a backup's S3 destination does - the S3 storage connection under `backups/` (@totalbase/files' provider). */
export interface BackupObjectStore {
  storeFile: (key: string, path: string) => Promise<void>;
  readStream: (key: string) => Promise<Readable>;
  delete: (key: string) => Promise<void>;
}

/** What happened to a backup - for the audit log (`BACKUP`). */
export interface BackupEvent {
  event: "QUEUED" | "COMPLETED" | "FAILED" | "DELETED" | "DOWNLOADED";
  backup: Backup;
  /** The administrator who did it - none for what the schedule and the worker do. */
  adminId?: string | undefined;
  requestId?: string | undefined;
}

export interface BackupsContext {
  database: Database;
  settings: SettingsService;
  /** The S3 destination - built per use from the s3.* settings, so a change applies without a restart. */
  s3Store: () => Promise<BackupObjectStore>;
  /** The libpq environment pg_dump connects with (@totalbase/database's postgresClientEnv). */
  clientEnv: () => Record<string, string>;
  /** PostgreSQL's client tools' directory - the image's; unset, they are found on PATH. */
  pgBinDir?: string | undefined;
  /** Where an archive is put together before it reaches its destination (`TOTALBASE_DATA_DIR/tmp`). */
  workDir: string;
  totalbaseVersion: string;
  /** This process, in `locked_by`. */
  workerId: string;
  onEvent?: (event: BackupEvent) => Promise<void>;
}

interface BackupRow {
  id: string;
  status: BackupStatus;
  trigger: BackupTrigger;
  scheduled_for: Date | null;
  requested_by: string | null;
  destination: BackupDestination;
  name: string;
  size_bytes: string | null;
  manifest: BackupManifest | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

const COLUMNS = `id, status, trigger, scheduled_for, requested_by, destination, name, size_bytes, manifest, error, created_at, started_at, completed_at`;

function toBackup(row: BackupRow): Backup {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    scheduledFor: row.scheduled_for,
    requestedBy: row.requested_by,
    destination: row.destination,
    name: row.name,
    sizeBytes: row.size_bytes === null ? null : Number(row.size_bytes),
    manifest: row.manifest,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

/** How often a running backup renews its lock, and how old a lock is before its backup counts as interrupted. */
const HEARTBEAT_MS = 30_000;
const STALE_AFTER = "5 minutes";
const ERROR_MAX = 2000;

async function exists(path: string): Promise<boolean> {
  return access(path).then(() => true, () => false);
}

/**
 * Built-in backups (Administration.md §12): each backup is a row of
 * `totalbase.backups` - its queue entry, then its record. The schedule
 * queues an occurrence once (UNIQUE scheduled_for), whichever process sees
 * its minute first; a worker claims it (FOR UPDATE SKIP LOCKED), and
 * PostgreSQL keeps it to one queued or running backup per instance (the
 * partial unique index `backups_one_active`).
 *
 * A backup is one tar archive: `manifest.json`, `database.dump` (pg_dump
 * -Fc, a consistent snapshot) and `files.tar` (the files kept on the local
 * disk), taken in that order - files uploaded meanwhile are in it, rows
 * pointing at files never miss them. Never the master key.
 */
export class BackupsService {
  constructor(private readonly ctx: BackupsContext) {}

  /** Newest first, a page at a time. */
  async list(limit = 100, offset = 0): Promise<Backup[]> {
    const { rows } = await this.ctx.database.query<BackupRow>(`SELECT ${COLUMNS} FROM totalbase.backups ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    return rows.map(toBackup);
  }

  async count(): Promise<number> {
    const { rows } = await this.ctx.database.query<{ n: number }>(`SELECT count(*)::int AS n FROM totalbase.backups`);
    return rows[0]!.n;
  }

  async get(id: string): Promise<Backup> {
    const { rows } = await this.ctx.database.query<BackupRow>(`SELECT ${COLUMNS} FROM totalbase.backups WHERE id = $1`, [id]);
    if (!rows[0]) throw new TotalBaseError("BACKUP_NOT_FOUND", "Backup not found.");
    return toBackup(rows[0]);
  }

  /** The schedule as it stands: on or off, its next occurrence, where new backups go. */
  async overview(now = new Date()): Promise<{ enabled: boolean; schedule: string; nextAt: Date | null; destination: BackupDestination; timezone: string }> {
    const [enabled, schedule, destination, timezone] = await Promise.all([
      this.ctx.settings.get("backups.enabled"),
      this.ctx.settings.get("backups.schedule"),
      this.ctx.settings.get("backups.destination"),
      this.timezone(),
    ]);
    const nextAt = enabled ? nextOccurrences(parseCronExpression(schedule), timezone, now, 1)[0] ?? null : null;
    return { enabled, schedule, nextAt, destination: destination === "s3" ? "S3" : "LOCAL", timezone };
  }

  /** For the admin's Status: when the last backup completed, whether the latest one to end failed, the next one. */
  async summary(now = new Date()): Promise<{ lastCompletedAt: Date | null; latestFailed: boolean; nextAt: Date | null }> {
    const [{ rows }, overview] = await Promise.all([
      this.ctx.database.query<{ last_completed_at: Date | null; latest_failed: boolean }>(
        `SELECT (SELECT max(completed_at) FROM totalbase.backups WHERE status = 'COMPLETED') AS last_completed_at,
                coalesce((SELECT status = 'FAILED' FROM totalbase.backups WHERE status IN ('COMPLETED', 'FAILED') ORDER BY created_at DESC LIMIT 1), false) AS latest_failed`,
      ),
      this.overview(now),
    ]);
    return { lastCompletedAt: rows[0]!.last_completed_at, latestFailed: rows[0]!.latest_failed, nextAt: overview.nextAt };
  }

  /** Back up now: queued for the worker - refused while backups are off, or another is queued or running. */
  async requestNow(adminId: string, requestId?: string): Promise<Backup> {
    if (!(await this.ctx.settings.get("backups.enabled"))) throw new TotalBaseError("BACKUPS_DISABLED", "Backups are off - turn them on under Settings › PostgreSQL › Backups.");
    const backup = await this.queue("MANUAL", null, adminId);
    if (!backup) throw new TotalBaseError("BACKUP_ALREADY_QUEUED", "A backup is already queued or running - wait for it to finish.");
    await this.ctx.onEvent?.({ event: "QUEUED", backup, adminId, requestId });
    return backup;
  }

  /**
   * The schedule's tick: when backups.enabled and `now`'s minute is one of
   * backups.schedule's (in system.timezone), its occurrence is queued - once,
   * whatever the number of processes; skipped while another backup is queued
   * or running. Never catches up on a minute missed while the server was down.
   */
  async scheduleTick(now = new Date()): Promise<Backup | null> {
    if (!(await this.ctx.settings.get("backups.enabled"))) return null;
    const schedule = parseCronExpression(await this.ctx.settings.get("backups.schedule"));
    if (!matchesCron(schedule, wallClockInZone(now, await this.timezone()))) return null;
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    return this.queue("SCHEDULED", minute, null);
  }

  /** A backup the server stopped in the middle of - its lock stale - is FAILED, never run twice. */
  async reclaimStale(): Promise<number> {
    const { rowCount } = await this.ctx.database.query(
      `UPDATE totalbase.backups SET status = 'FAILED', completed_at = now(), error = 'Interrupted: the server stopped while it ran.', locked_at = NULL, locked_by = NULL
       WHERE status = 'RUNNING' AND locked_at < now() - interval '${STALE_AFTER}'`,
    );
    return rowCount ?? 0;
  }

  /** Claims the queued backup, if any, and runs it to the end - true when one ran. */
  async processNext(): Promise<boolean> {
    const { rows } = await this.ctx.database.query<BackupRow>(
      `UPDATE totalbase.backups SET status = 'RUNNING', started_at = now(), locked_at = now(), locked_by = $1
       WHERE id = (SELECT id FROM totalbase.backups WHERE status = 'PENDING' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING ${COLUMNS}`,
      [this.ctx.workerId],
    );
    if (!rows[0]) return false;
    await this.run(toBackup(rows[0]));
    return true;
  }

  /** The archive, to download - a completed backup's only. */
  async download(id: string, adminId: string, requestId?: string): Promise<{ backup: Backup; stream: Readable }> {
    const backup = await this.get(id);
    if (backup.status === "PENDING" || backup.status === "RUNNING") throw new TotalBaseError("BACKUP_RUNNING", "The backup hasn't finished yet.");
    if (backup.status !== "COMPLETED") throw new TotalBaseError("BACKUP_NOT_FOUND", "The backup failed - it has no archive.");
    let stream: Readable;
    if (backup.destination === "S3") {
      stream = await (await this.ctx.s3Store()).readStream(backup.name);
    } else {
      const path = join(await this.ctx.settings.get("backups.local_path"), backup.name);
      if (!(await exists(path))) throw new TotalBaseError("BACKUP_NOT_FOUND", `The archive is no longer at ${path}.`);
      stream = createReadStream(path);
    }
    await this.ctx.onEvent?.({ event: "DOWNLOADED", backup, adminId, requestId });
    return { backup, stream };
  }

  /** Deletes a backup and its archive - never one queued or running. */
  async delete(id: string, adminId?: string, requestId?: string): Promise<void> {
    const backup = await this.get(id);
    if (backup.status === "PENDING" || backup.status === "RUNNING") throw new TotalBaseError("BACKUP_RUNNING", "A backup can't be deleted while it is queued or running.");
    if (backup.status === "COMPLETED") await this.removeArchive(backup);
    await this.ctx.database.query(`DELETE FROM totalbase.backups WHERE id = $1`, [id]);
    await this.ctx.onEvent?.({ event: "DELETED", backup, adminId, requestId });
  }

  private async timezone(): Promise<string> {
    return (await this.ctx.settings.get("system.timezone")) || "UTC";
  }

  /** A new row - null when another backup is queued or running, or the occurrence is queued already. */
  private async queue(trigger: BackupTrigger, scheduledFor: Date | null, adminId: string | null): Promise<Backup | null> {
    const destination = (await this.ctx.settings.get("backups.destination")) === "s3" ? "S3" : "LOCAL";
    const { rows } = await this.ctx.database.query<BackupRow>(
      `WITH id AS (SELECT gen_random_uuid() AS id)
       INSERT INTO totalbase.backups (id, trigger, scheduled_for, requested_by, destination, name)
       SELECT id.id, $1, $2, $3, $4, 'totalbase-' || to_char(now() AT TIME ZONE 'UTC', 'YYYYMMDD-HH24MISS') || '-' || left(id.id::text, 8) || '.tar' FROM id
       ON CONFLICT DO NOTHING
       RETURNING ${COLUMNS}`,
      [trigger, scheduledFor, adminId, destination],
    );
    return rows[0] ? toBackup(rows[0]) : null;
  }

  private async removeArchive(backup: Backup): Promise<void> {
    if (backup.destination === "S3") await (await this.ctx.s3Store()).delete(backup.name);
    else await rm(join(await this.ctx.settings.get("backups.local_path"), backup.name), { force: true });
  }

  private async run(backup: Backup): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.ctx.database.query(`UPDATE totalbase.backups SET locked_at = now() WHERE id = $1 AND status = 'RUNNING'`, [backup.id]).catch(() => undefined);
    }, HEARTBEAT_MS);
    await mkdir(this.ctx.workDir, { recursive: true });
    const work = await mkdtemp(join(this.ctx.workDir, "backup-"));
    try {
      const { manifest, archive } = await this.assemble(backup, work);
      const { size } = await stat(archive);
      if (backup.destination === "S3") {
        await (await this.ctx.s3Store()).storeFile(backup.name, archive);
      } else {
        const directory = await this.ctx.settings.get("backups.local_path");
        await mkdir(directory, { recursive: true });
        // Written beside its final name, then renamed: a half-copied archive is never listed as one.
        const partial = join(directory, `.${backup.name}.partial`);
        try {
          // Another disk than the work directory's: copied instead.
          await rename(archive, partial).catch(() => copyFile(archive, partial));
          await rename(partial, join(directory, backup.name));
        } catch (error) {
          await rm(partial, { force: true });
          throw error;
        }
      }
      const { rows } = await this.ctx.database.query<BackupRow>(
        `UPDATE totalbase.backups SET status = 'COMPLETED', completed_at = now(), size_bytes = $2, manifest = $3, locked_at = NULL, locked_by = NULL
         WHERE id = $1 RETURNING ${COLUMNS}`,
        [backup.id, size, JSON.stringify(manifest)],
      );
      await this.ctx.onEvent?.({ event: "COMPLETED", backup: toBackup(rows[0]!) });
      await this.applyRetention();
    } catch (error) {
      const message = ((error as Error).message || String(error)).slice(0, ERROR_MAX);
      const { rows } = await this.ctx.database.query<BackupRow>(
        `UPDATE totalbase.backups SET status = 'FAILED', completed_at = now(), error = $2, locked_at = NULL, locked_by = NULL WHERE id = $1 RETURNING ${COLUMNS}`,
        [backup.id, message],
      );
      if (rows[0]) await this.ctx.onEvent?.({ event: "FAILED", backup: toBackup(rows[0]) }).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      await rm(work, { recursive: true, force: true });
    }
  }

  /** manifest.json, database.dump and files.tar in `work`, then the archive holding them. */
  private async assemble(backup: Backup, work: string): Promise<{ manifest: BackupManifest; archive: string }> {
    const env = this.ctx.clientEnv();
    // A consistent snapshot of the whole database; a lock it can't get in a minute fails the backup instead of waiting on DDL.
    await runCommand(pgTool("pg_dump", this.ctx.pgBinDir), ["--format=custom", "--no-password", "--lock-wait-timeout=60000", `--file=${join(work, DATABASE_FILE)}`], env);

    const [filesPath, includeFiles] = await Promise.all([this.ctx.settings.get("files.storage_local_path"), this.ctx.settings.get("backups.include_files")]);
    const withFiles = includeFiles && (await exists(filesPath));
    // After the dump: every file a dumped row points at is already there.
    if (withFiles) await runCommand("tar", ["-cf", join(work, FILES_FILE), "-C", filesPath, "."], {});

    const { rows } = await this.ctx.database.query<{ server_version: string; server_version_num: string; database: string; migration: string | null; verifier: string | null }>(
      `SELECT current_setting('server_version') AS server_version, current_setting('server_version_num') AS server_version_num, current_database() AS database,
              (SELECT max(version)::text FROM totalbase.migrations) AS migration,
              (SELECT value #>> '{}' FROM totalbase.settings WHERE key = 'system.master_key_verifier') AS verifier`,
    );
    const facts = rows[0]!;
    const manifest: BackupManifest = {
      format: 1,
      backup: backup.id,
      createdAt: new Date().toISOString(),
      totalbaseVersion: this.ctx.totalbaseVersion,
      migration: facts.migration ?? "0",
      postgresVersion: facts.server_version,
      postgresVersionNum: Number(facts.server_version_num),
      database: facts.database,
      files: withFiles,
      filesPath,
      masterKeyVerifier: facts.verifier,
    };
    await writeFile(join(work, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + "\n");
    const archive = join(work, backup.name);
    await runCommand("tar", ["-cf", archive, "-C", work, MANIFEST_FILE, DATABASE_FILE, ...(withFiles ? [FILES_FILE] : [])], {});
    return { manifest, archive };
  }

  /** The newest backups.keep completed backups stay; older ones go, archive first - and failures older than them. */
  private async applyRetention(): Promise<void> {
    const keep = await this.ctx.settings.get("backups.keep");
    const { rows } = await this.ctx.database.query<BackupRow>(
      `SELECT ${COLUMNS} FROM totalbase.backups WHERE status = 'COMPLETED' ORDER BY created_at DESC OFFSET $1`,
      [keep],
    );
    for (const row of rows) {
      const backup = toBackup(row);
      try {
        await this.removeArchive(backup);
        await this.ctx.database.query(`DELETE FROM totalbase.backups WHERE id = $1`, [backup.id]);
        await this.ctx.onEvent?.({ event: "DELETED", backup });
      } catch {
        // Its archive couldn't be removed (the destination away): kept, and tried again after the next backup.
      }
    }
    await this.ctx.database.query(
      `DELETE FROM totalbase.backups WHERE status = 'FAILED'
       AND created_at < (SELECT min(created_at) FROM (SELECT created_at FROM totalbase.backups WHERE status = 'COMPLETED' ORDER BY created_at DESC LIMIT $1) kept)`,
      [keep],
    );
  }
}
