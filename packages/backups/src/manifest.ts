/** The archive's own description (Administration.md §12.2) - `manifest.json`, first in the archive. */
export interface BackupManifest {
  format: 1;
  /** The backup's id - its row in the database the archive holds. */
  backup: string;
  createdAt: string;
  totalbaseVersion: string;
  /** The last migration applied (its version) - an image without it can't restore the archive. */
  migration: string;
  /** PostgreSQL's version the dump was taken from (`server_version`, `server_version_num`). */
  postgresVersion: string;
  postgresVersionNum: number;
  database: string;
  /** Whether `files.tar` is in the archive, and where they were kept (`files.storage_local_path`). */
  files: boolean;
  filesPath: string;
  /** `system.master_key_verifier` - a restore checks the key it is given against it; never the key itself. */
  masterKeyVerifier: string | null;
}

export const MANIFEST_FILE = "manifest.json";
export const DATABASE_FILE = "database.dump";
export const FILES_FILE = "files.tar";

/** A manifest read back from an archive - its shape checked, or why it isn't one. */
export function parseManifest(text: string): BackupManifest {
  let value: Partial<BackupManifest>;
  try {
    value = JSON.parse(text) as Partial<BackupManifest>;
  } catch {
    throw new Error("The archive's manifest.json is not JSON - not a TotalBase backup.");
  }
  if (value.format !== 1 || typeof value.backup !== "string" || typeof value.migration !== "string" || typeof value.postgresVersionNum !== "number" || typeof value.files !== "boolean") {
    throw new Error("The archive's manifest.json is not a TotalBase backup's (format 1).");
  }
  return value as BackupManifest;
}
