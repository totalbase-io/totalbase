import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { restoreBackup } from "@totalbase/backups";
import { Database, loadDatabaseConfigFromEnv, postgresClientEnv } from "@totalbase/database";
import { MIGRATIONS_DIR } from "./bootstrap.js";
import { fingerprint } from "./master-key.js";

/**
 * The image's command line - `totalbase <command>` (/usr/local/bin/totalbase runs this file).
 *
 *   totalbase restore <archive>   a backup into an empty database (Administration.md §12.5)
 *
 * Run where the server would run, with its environment (POSTGRES_*, TOTALBASE_MASTER_KEY or
 * TOTALBASE_DATA_DIR/master.key), while no server is running against that database.
 */
const USAGE = `Usage: totalbase restore <archive.tar>

Restores a TotalBase backup into the empty database POSTGRES_* name, with the master key
TOTALBASE_MASTER_KEY (or TOTALBASE_DATA_DIR/master.key) holds - the backup's own. Then start
the server as usual.
`;

const print = (line: string) => process.stdout.write(`${line}\n`);

/** The master key the restored instance will start with - as the server finds it (master-key.ts). */
async function masterKey(dataDir: string): Promise<string> {
  const fromEnv = process.env["TOTALBASE_MASTER_KEY"];
  if (fromEnv) return fromEnv;
  const path = join(dataDir, "master.key");
  try {
    return (await readFile(path, "utf8")).trim();
  } catch {
    throw new Error(`No master key: set TOTALBASE_MASTER_KEY, or put the backup's key in ${path}. Without it the restored secrets can't be read.`);
  }
}

async function main(args: string[]): Promise<number> {
  const [command, archive] = args;
  if (command !== "restore" || !archive) {
    process.stdout.write(USAGE);
    return command === undefined || command === "help" || command === "--help" ? 0 : 2;
  }
  const dataDir = process.env["TOTALBASE_DATA_DIR"] || "/var/lib/totalbase";
  const key = await masterKey(dataDir);
  const database = new Database({ ...loadDatabaseConfigFromEnv(), poolMax: 2 });
  try {
    await restoreBackup({
      archive,
      database,
      clientEnv: postgresClientEnv(),
      pgBinDir: process.env["TOTALBASE_PG_BIN"] || undefined,
      masterKeyVerifier: fingerprint(key),
      migrationsDir: MIGRATIONS_DIR,
      workDir: join(dataDir, "tmp"),
      log: print,
    });
    return 0;
  } finally {
    await database.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`totalbase: ${(error as Error).message}\n`);
    process.exit(1);
  },
);
