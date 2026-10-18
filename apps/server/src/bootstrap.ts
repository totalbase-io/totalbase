import type pino from "pino";
import { buildCatalogSnapshot } from "@totalbase/pg-catalog";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { reconcileResources } from "@totalbase/resources";
import { SettingsService } from "@totalbase/settings";
import { bootstrapFirstAdmin } from "./admin-bootstrap.js";
import type { ServerEnv } from "./env.js";
import { resolveMasterKey, type MasterKeyOrigin } from "./master-key.js";
import { resolveSetup, type SetupState } from "./setup.js";
import { assertSupportedPostgresVersion } from "./postgres-version.js";

const TOTALBASE_VERSION = "0.1.0-beta.1";
const MIGRATIONS_DIR = new URL("../../../migrations/totalbase", import.meta.url).pathname;

export interface BootstrapResult {
  database: Database;
  ready: boolean;
  masterKey: string;
  masterKeyOrigin: MasterKeyOrigin;
  setup: SetupState;
}

/**
 * Executes the first-startup sequence.
 * See Specification.md §14 (steps 1-12).
 */
export async function bootstrap(env: ServerEnv, logger: pino.Logger): Promise<BootstrapResult> {
  // 1. Connect PostgreSQL
  const database = new Database(loadDatabaseConfigFromEnv());
  await database.ping();
  logger.info("connected to PostgreSQL");

  // 2. Validate supported PostgreSQL version
  await assertSupportedPostgresVersion(database);
  logger.info("PostgreSQL version supported");

  // 3-4. Verify an existing totalbase schema is TotalBase's (its marker or
  //      migration ledger - TOTALBASE_SCHEMA_CONFLICT otherwise), create and
  //      mark it when absent, run migrations - all inside runMigrations.
  const migrationResult = await runMigrations(database, {
    migrationsDir: MIGRATIONS_DIR,
    totalbaseVersion: TOTALBASE_VERSION,
  });
  logger.info(
    { applied: migrationResult.applied, alreadyApplied: migrationResult.alreadyApplied.length },
    "migrations applied",
  );
  // A migration's report - what it moved, what it left out (RAISE NOTICE).
  for (const notice of migrationResult.notices) logger.warn(notice, "migration notice");

  // 5b. Rebuild the pool from the pool.* settings, now that the settings
  //     table exists (AGENTS.md section 19B: pool configuration is a
  //     TotalBase setting). Before this point it ran on the defaults.
  const settings = new SettingsService(database);
  const [poolMax, poolIdleTimeoutMs, poolConnectionTimeoutMs, poolMaxLifetimeMs] = await Promise.all([
    settings.get("pool.max"),
    settings.get("pool.idle_timeout_ms"),
    settings.get("pool.connection_timeout_ms"),
    settings.get("pool.max_lifetime_ms"),
  ]);
  const poolSettings = { poolMax, poolIdleTimeoutMs, poolConnectionTimeoutMs, poolMaxLifetimeMs };
  if (await database.reconfigurePool(poolSettings)) logger.info(poolSettings, "connection pool configured from settings");

  // 6. Validate master key
  const { masterKey, source, path } = await resolveMasterKey(database, env.masterKey, env.dataDir, logger);
  const masterKeyOrigin: MasterKeyOrigin = { source: source === "ENV" ? "ENV" : "FILE", path };
  logger.info({ source }, "master key validated");

  // 7. The instance owner: from TOTALBASE_ADMIN_* when set; else the first-start setup's code (§14.1)
  await bootstrapFirstAdmin(database, env.adminEmail, env.adminPassword);
  const setup = await resolveSetup(database, env.setupCode, env.dataDir, logger, publicUrlFor(env));
  logger.info({ setupPending: setup.code !== null }, "first admin ensured");

  // 8. Introspect catalog
  const catalog = await buildCatalogSnapshot(database);
  logger.info({ objects: catalog.length }, "catalog introspected");

  // 9-10. Reconcile resources; newly discovered resources start hidden
  const reconciliation = await reconcileResources(database, catalog);
  logger.info(reconciliation, "resources reconciled");

  // 11. Build caches - no in-memory cache yet in Phase 1; placeholder for later phases.

  // 12. READY
  return { database, ready: true, masterKey, masterKeyOrigin, setup };
}

/** Where the instance answers before system.public_url is set: TOTALBASE_PUBLIC_URL, else this machine on its port. */
export function publicUrlFor(env: ServerEnv): string {
  return (env.publicUrl ?? `http://localhost:${env.port}`).replace(/\/+$/, "");
}
