import { readFileSync } from "node:fs";

/**
 * PostgreSQL connection and pool configuration.
 * See Foundations.md §14 (Bootstrap) and Administration.md §7.4 (pool.*).
 */
export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /**
   * TLS to PostgreSQL (POSTGRES_SSL): off (the default), `require` (encrypted, the server's certificate not
   * verified - a managed PostgreSQL with its provider's certificate), or `verify-full` (verified against
   * POSTGRES_SSL_CA, a PEM file path, else the system's authorities).
   */
  ssl: false | { rejectUnauthorized: boolean; ca?: string };

  /** pool.max */
  poolMax: number;
  /** pool.idle_timeout_ms */
  poolIdleTimeoutMs: number;
  /** pool.connection_timeout_ms */
  poolConnectionTimeoutMs: number;
  /** pool.max_lifetime_ms */
  poolMaxLifetimeMs: number;

  /**
   * statement_timeout for a statement on the pool and for a transaction given a context without its own (the Data
   * API passes api.request_timeout_ms) - every connection starts with it, so no statement runs unbounded.
   */
  statementTimeoutMs: number;
}

const DEFAULTS = {
  poolMax: 20,
  poolIdleTimeoutMs: 30_000,
  poolConnectionTimeoutMs: 5_000,
  poolMaxLifetimeMs: 3_600_000,
  statementTimeoutMs: 30_000,
} as const;

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** POSTGRES_SSL as the pool's `ssl`: off, require or verify-full (POSTGRES_SSL_CA a PEM file read once). */
function sslFromEnv(): DatabaseConfig["ssl"] {
  const mode = (process.env["POSTGRES_SSL"] ?? "off").trim().toLowerCase();
  if (mode === "" || mode === "off" || mode === "false" || mode === "disable") return false;
  if (mode === "require" || mode === "true") return { rejectUnauthorized: false };
  if (mode === "verify-full" || mode === "verify-ca") {
    const caPath = process.env["POSTGRES_SSL_CA"];
    return { rejectUnauthorized: true, ...(caPath ? { ca: readFileSync(caPath, "utf8") } : {}) };
  }
  throw new Error(`POSTGRES_SSL must be off, require or verify-full - got "${mode}".`);
}

/** Reads database configuration from process.env (POSTGRES_*), with the pool on its defaults. */
export function loadDatabaseConfigFromEnv(): DatabaseConfig {
  const port = int("POSTGRES_PORT", Number.NaN);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    if (process.env["POSTGRES_PORT"]) throw new Error(`POSTGRES_PORT must be a port number - got "${process.env["POSTGRES_PORT"]}".`);
  }
  return {
    host: required("POSTGRES_HOST"),
    port: Number.isInteger(port) ? port : 5432,
    database: required("POSTGRES_DB"),
    user: required("POSTGRES_USER"),
    password: required("POSTGRES_PASSWORD"),
    ssl: sslFromEnv(),

    // pool.* are TotalBase settings (AGENTS.md section 19B), stored in the
    // database this pool connects to: it starts on the registry defaults
    // and apps/server's bootstrap rebuilds it from the stored values once
    // they can be read (Database.reconfigurePool).
    poolMax: DEFAULTS.poolMax,
    poolIdleTimeoutMs: DEFAULTS.poolIdleTimeoutMs,
    poolConnectionTimeoutMs: DEFAULTS.poolConnectionTimeoutMs,
    poolMaxLifetimeMs: DEFAULTS.poolMaxLifetimeMs,

    statementTimeoutMs: int("TOTALBASE_STATEMENT_TIMEOUT_MS", DEFAULTS.statementTimeoutMs),
  };
}

/**
 * The same connection for PostgreSQL's own client tools - `pg_dump`, `pg_restore` (Administration.md §12): the
 * libpq variables (PGHOST, PGPORT, PGDATABASE, PGUSER, PGPASSWORD, PGSSLMODE, PGSSLROOTCERT) from POSTGRES_*, read
 * as `loadDatabaseConfigFromEnv` reads them - the password in the child's environment, never on its command line.
 */
export function postgresClientEnv(): Record<string, string> {
  const config = loadDatabaseConfigFromEnv();
  const mode = (process.env["POSTGRES_SSL"] ?? "off").trim().toLowerCase();
  const caPath = process.env["POSTGRES_SSL_CA"];
  return {
    PGHOST: config.host,
    PGPORT: String(config.port),
    PGDATABASE: config.database,
    PGUSER: config.user,
    PGPASSWORD: config.password,
    // libpq's own names: require encrypts without verifying; verify-full checks the certificate and the host.
    PGSSLMODE: config.ssl === false ? "disable" : config.ssl.rejectUnauthorized ? (mode === "verify-ca" ? "verify-ca" : "verify-full") : "require",
    // Verified against POSTGRES_SSL_CA, else - as the pool does - the system's authorities (libpq 16+'s `system`).
    ...(config.ssl !== false && config.ssl.rejectUnauthorized ? { PGSSLROOTCERT: caPath || "system" } : {}),
  };
}
