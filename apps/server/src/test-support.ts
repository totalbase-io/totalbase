import type { FastifyInstance } from "fastify";
import { relationDetailCache } from "@totalbase/pg-catalog";
import type { Database } from "@totalbase/database";
import pino from "pino";
import type { AppContext } from "./context.js";
import { bootstrap } from "./bootstrap.js";
import { buildContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { buildServer } from "./server.js";

/**
 * Test-only bootstrap: runs the real startup sequence (migrations,
 * master key, first admin, catalog reconciliation) against whatever
 * POSTGRES_DB is currently pointed at (totalbase_test via
 * scripts/test-integration.sh), then builds the real Fastify app for
 * in-process testing via app.inject() - no HTTP server actually listens.
 */
// Integration tests change tables with raw SQL (ALTER/RENAME/DROP COLUMN); in the product every schema change
// goes through a reconcile that clears the relation-detail cache, so here it is simply off.
relationDetailCache.enabled = false;

export async function setupTestApp(): Promise<{ app: FastifyInstance; context: AppContext; database: Database }> {
  const env = loadServerEnv();
  const logger = pino({ level: "silent" });

  const { database } = await bootstrap(env, logger);
  const context = buildContext(database, logger, testMasterKey(env.masterKey), env.publicUrl!, env.nodeEnv);
  const app = await buildServer(context, "silent");
  await app.ready();

  return { app, context, database };
}

/**
 * Test-only shorthand for what most suites need as a Data Plane
 * principal: a throwaway user holding `roleId`, with a plane="API"
 * personal token (totalbase.tokens) - tokens have
 * no roles of their own, they resolve their owning user's roles live.
 * Caller is responsible for cleaning up both the token and the user
 * (e.g. `DELETE FROM totalbase.users WHERE id = $1` cascades the token).
 */
export async function createTestApiToken(
  context: AppContext,
  input: { name: string; roleId: string; email: string },
): Promise<{ plainKey: string; tokenId: string; userId: string }> {
  const user = await context.auth.users.create({ email: input.email });
  await context.roleAssignments.assignRoleToUser(user.id, input.roleId);
  const created = await context.usersApis.create({ userId: user.id, name: input.name, plane: "API" });
  return { plainKey: created.plainKey, tokenId: created.userApi.id, userId: user.id };
}

let suffixCounter = 0;

/**
 * A short identifier unique to this process and call (`Date.now()` in
 * base 36 plus a per-process counter). Use it to suffix every name a
 * test creates - a role name, an email, a slug, a key - so two runs (or
 * two files sharing a name) never collide, and a run that dies halfway
 * leaves rows a later run doesn't trip over.
 */
export function uniqueSuffix(): string {
  suffixCounter += 1;
  return `${Date.now().toString(36)}${suffixCounter.toString(36)}`;
}

/**
 * Polls `predicate` until it resolves to a truthy value or `timeoutMs`
 * elapses, and returns that value. Replaces a fixed sleep when a test
 * waits for something written after the response (an audit row, an
 * outbox event, a worker's result): it returns as soon as the row is
 * there instead of always paying the sleep, and fails with a clear
 * message instead of flaking when the machine is slow.
 */
export async function waitFor<T>(
  predicate: () => Promise<T> | T,
  { timeoutMs = 5_000, intervalMs = 25 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value as NonNullable<T>;
    if (Date.now() >= deadline) throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const tracked: Array<{ table: string; id: string }> = [];

/**
 * Records a row this test created so `cleanupTracked()` deletes it by
 * primary key. `table` is the bare internal table name (`"users"`,
 * `"roles"` - in the `totalbase` schema). Track in creation
 * order: cleanup runs in reverse, so a child is deleted before its parent
 * even where no FK cascades.
 */
export function track(table: string, id: string): string {
  tracked.push({ table, id });
  return id;
}

/**
 * Deletes every row tracked with `track()` by its primary key, most
 * recent first, and clears the list. Each delete is guarded: a row a
 * cascade already removed, or one the test deleted itself, is not an
 * error. Call it from `afterAll` (or `afterEach` for per-test rows).
 */
export async function cleanupTracked(database: Database): Promise<void> {
  const rows = tracked.splice(0).reverse();
  for (const { table, id } of rows) {
    try {
      await database.query(`DELETE FROM totalbase.${table} WHERE id = $1`, [id]);
    } catch {
      // Row already gone or table missing: nothing to clean.
    }
  }
}

const adminTokens = new WeakMap<AppContext, Promise<string>>();

/**
 * A session token for the environment's first administrator
 * (`TOTALBASE_ADMIN_EMAIL` / `TOTALBASE_ADMIN_PASSWORD`), memoized per
 * app context so a file logs in once however many suites ask. Use it as
 * `authorization: Bearer <token>` on `/admin/api/*` calls.
 */
export function adminToken(context: AppContext): Promise<string> {
  let pending = adminTokens.get(context);
  if (!pending) {
    const env = loadServerEnv();
    pending = context.auth.login({ email: env.adminEmail!, password: env.adminPassword! }).then((s) => s.token);
    adminTokens.set(context, pending);
  }
  return pending;
}

/** Integration tests run with TOTALBASE_MASTER_KEY set (the .env's) - never a key generated on disk. */
function testMasterKey(masterKey: string | undefined): string {
  if (!masterKey) throw new Error("Integration tests need TOTALBASE_MASTER_KEY (source .env).");
  return masterKey;
}
