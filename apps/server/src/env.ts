/**
 * Non-database environment variables.
 * See Specification.md §14 (Bootstrap).
 */
export interface ServerEnv {
  /** TOTALBASE_ADMIN_EMAIL / _PASSWORD - both set: the instance owner is created at start; else the first-start setup (setup.ts). */
  adminEmail: string | undefined;
  adminPassword: string | undefined;
  /** TOTALBASE_SETUP_CODE - the setup's code, when a program (TotalBase Manager) sets it; else one kept in the data directory. */
  setupCode: string | undefined;
  /** TOTALBASE_MASTER_KEY - unset: the one in the data directory, or a new one (master-key.ts). */
  masterKey: string | undefined;
  /** TOTALBASE_DATA_DIR - where the server keeps what it owns on disk (its master key); /var/lib/totalbase by default. */
  dataDir: string;

  host: string;
  port: number;
  nodeEnv: string;
  logLevel: string;

  /** TOTALBASE_PUBLIC_URL - this instance's own externally-reachable origin, until system.public_url is set (the setup asks for it); unset: http://localhost:<port>. Required for OAuth (the redirect_uri registered with a provider must be a stable, known-good URL - never derived from a request's Host header, which a caller controls). */
  publicUrl: string | undefined;

  /** Serve the built apps/admin SPA under /admin/ from this same process (default) - set to "false" to run this instance API-only. */
  adminUiEnabled: boolean;
  /** Override for where the built admin SPA lives; defaults to the apps/admin workspace sibling (see admin-ui.ts). */
  adminUiDir: string | undefined;
  /** Local dev only: origin of a `nuxt dev` process (e.g. http://localhost:3001) to reverse-proxy /admin/* to, so the API and the hot-reloading UI both answer on this same port instead of two. Unset in prod - the static build is served directly. */
  adminUiDevProxyTarget: string | undefined;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** TOTALBASE_PORT: 3050 when unset (the same default as .env.example, scripts/dev.sh and the Dockerfile); anything but a port refuses to boot. */
function portFromEnv(): number {
  const raw = process.env["TOTALBASE_PORT"];
  if (raw === undefined || raw === "") return 3050;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TOTALBASE_PORT must be a port number (1-65535), got "${raw}".`);
  }
  return port;
}

export function loadServerEnv(): ServerEnv {
  return {
    adminEmail: process.env["TOTALBASE_ADMIN_EMAIL"] || undefined,
    adminPassword: process.env["TOTALBASE_ADMIN_PASSWORD"] || undefined,
    setupCode: process.env["TOTALBASE_SETUP_CODE"] || undefined,
    masterKey: process.env["TOTALBASE_MASTER_KEY"] || undefined,
    dataDir: process.env["TOTALBASE_DATA_DIR"] || "/var/lib/totalbase",

    host: process.env["TOTALBASE_HOST"] ?? "0.0.0.0",
    port: portFromEnv(),
    nodeEnv: process.env["NODE_ENV"] ?? "development",
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    publicUrl: process.env["TOTALBASE_PUBLIC_URL"] || undefined,

    adminUiEnabled: process.env["TOTALBASE_ADMIN_UI_ENABLED"] !== "false",
    adminUiDir: process.env["TOTALBASE_ADMIN_UI_DIR"],
    adminUiDevProxyTarget: process.env["TOTALBASE_ADMIN_UI_DEV_PROXY_TARGET"],
  };
}
