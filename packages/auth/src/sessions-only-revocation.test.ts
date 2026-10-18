import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv, type Queryable } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

interface SessionRow {
  id: string;
  user: string;
  token_hash: string;
  ip: string | null;
  user_agent: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  last_seen_at: Date | null;
}

/**
 * The `sessions_only_revocation` trigger (Specification_Security.md §10.3):
 * a write made on someone's behalf - `totalbase.actor_user_id` set, as every
 * Data API write is - may only revoke a session. It can't move it, extend it,
 * rewrite where it came from or un-revoke it, and the revocation time is
 * PostgreSQL's clock. TotalBase's own bookkeeping (no actor) is untouched.
 */
describe("sessions_only_revocation trigger (integration)", () => {
  const suffix = Date.now().toString(36);
  let database: Database;
  let userId: string;
  let otherUserId: string;
  const sessionIds: string[] = [];

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ($1), ($2) RETURNING id`,
      [`sessions-trigger-${suffix}@example.com`, `sessions-trigger-other-${suffix}@example.com`],
    );
    userId = rows[0]!.id;
    otherUserId = rows[1]!.id;
  });

  afterAll(async () => {
    if (sessionIds.length) await database.query(`DELETE FROM totalbase.sessions WHERE id = ANY($1::uuid[])`, [sessionIds]);
    if (userId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [userId]);
    if (otherUserId) await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [otherUserId]);
    await database.close();
  });

  async function createSession(): Promise<SessionRow> {
    const { rows } = await database.query<SessionRow>(
      `INSERT INTO totalbase.sessions ("user", token_hash, ip, user_agent, expires_at)
       VALUES ($1, $2, '10.0.0.1', 'trigger-test', now() + interval '1 hour')
       RETURNING id, "user", token_hash, ip, user_agent, expires_at, revoked_at, last_seen_at`,
      [userId, `hash-${suffix}-${sessionIds.length}`],
    );
    sessionIds.push(rows[0]!.id);
    return rows[0]!;
  }

  async function read(id: string): Promise<SessionRow> {
    const { rows } = await database.query<SessionRow>(
      `SELECT id, "user", token_hash, ip, user_agent, expires_at, revoked_at, last_seen_at FROM totalbase.sessions WHERE id = $1`,
      [id],
    );
    return rows[0]!;
  }

  /** Runs `fn` as a write made on `actor`'s behalf - the setting is transaction-local, like the Data API's. */
  function asActor<T>(actor: string, fn: (client: Queryable) => Promise<T>): Promise<T> {
    return database.transaction(async (client) => {
      await client.query(`SELECT set_config('totalbase.actor_user_id', $1, true)`, [actor]);
      return fn(client);
    });
  }

  it("lets TotalBase's own bookkeeping (no actor) change anything", async () => {
    const session = await createSession();
    await database.query(
      `UPDATE totalbase.sessions SET expires_at = now() + interval '2 days', last_seen_at = now(), user_agent = 'renewed' WHERE id = $1`,
      [session.id],
    );
    const after = await read(session.id);
    expect(after.expires_at.getTime()).toBeGreaterThan(session.expires_at.getTime());
    expect(after.user_agent).toBe("renewed");
    expect(after.last_seen_at).not.toBeNull();
  });

  it("keeps a session's identity, origin and expiry when an actor writes it", async () => {
    const session = await createSession();
    await asActor(userId, (client) =>
      client.query(
        `UPDATE totalbase.sessions
         SET "user" = $2, token_hash = 'rewritten', ip = '192.0.2.1', user_agent = 'rewritten', expires_at = now() + interval '30 days', last_seen_at = now()
         WHERE id = $1`,
        [session.id, otherUserId],
      ),
    );
    const after = await read(session.id);
    expect(after.user).toBe(userId);
    expect(after.token_hash).toBe(session.token_hash);
    expect(after.ip).toBe(session.ip);
    expect(after.user_agent).toBe(session.user_agent);
    expect(after.expires_at.getTime()).toBe(session.expires_at.getTime());
    expect(after.last_seen_at).toEqual(session.last_seen_at);
    expect(after.revoked_at).toBeNull();
  });

  it("revokes at PostgreSQL's clock, whatever time the actor sent", async () => {
    const session = await createSession();
    const before = Date.now();
    await asActor(userId, (client) =>
      client.query(`UPDATE totalbase.sessions SET revoked_at = '2000-01-01T00:00:00Z' WHERE id = $1`, [session.id]),
    );
    const after = await read(session.id);
    expect(after.revoked_at).not.toBeNull();
    // Within the test's own window, not the year 2000 the statement asked for (the clock is the transaction's start).
    expect(after.revoked_at!.getTime()).toBeGreaterThan(before - 60_000);
  });

  it("never un-revokes or re-dates a revoked session for an actor", async () => {
    const session = await createSession();
    await database.query(`UPDATE totalbase.sessions SET revoked_at = now() - interval '1 day' WHERE id = $1`, [session.id]);
    const revoked = await read(session.id);
    await asActor(userId, (client) => client.query(`UPDATE totalbase.sessions SET revoked_at = NULL WHERE id = $1`, [session.id]));
    expect((await read(session.id)).revoked_at?.getTime()).toBe(revoked.revoked_at!.getTime());
    await asActor(userId, (client) => client.query(`UPDATE totalbase.sessions SET revoked_at = now() WHERE id = $1`, [session.id]));
    expect((await read(session.id)).revoked_at?.getTime()).toBe(revoked.revoked_at!.getTime());
  });
});
