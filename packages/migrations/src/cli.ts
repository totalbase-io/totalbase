import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "./runner.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../../migrations/totalbase");
const TOTALBASE_VERSION = "0.1.0";

async function main() {
  const database = new Database(loadDatabaseConfigFromEnv());
  try {
    const result = await runMigrations(database, {
      migrationsDir: MIGRATIONS_DIR,
      totalbaseVersion: TOTALBASE_VERSION,
    });
    console.log(`Applied: ${result.applied.length}`, result.applied);
    console.log(`Already applied: ${result.alreadyApplied.length}`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
