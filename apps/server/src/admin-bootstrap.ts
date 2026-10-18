import type { Database } from "@totalbase/database";
import { hashPassword } from "@totalbase/auth";
import { ADMINISTRATORS_ROLE_NAME } from "@totalbase/permissions";

/**
 * The instance owner (Specification.md §14): the first user to hold the reserved Administrators role, created
 * once - at start from TOTALBASE_ADMIN_EMAIL/PASSWORD, or later by the first-start setup (setup.ts). Gated on
 * "no user holds the role", not "totalbase.users is empty" - a developer may already have data-plane users
 * before ever starting the server. Changing the variables later never touches an existing administrator.
 */

/** The reserved Administrators role - seeded by the baseline; ensured here, defensively. */
async function administratorsRole(database: Database): Promise<string> {
  const { rows } = await database.query<{ id: string }>(
    `INSERT INTO totalbase.roles (name, reserved) VALUES ($1, true)
     ON CONFLICT (name) DO UPDATE SET reserved = true
     RETURNING id`,
    [ADMINISTRATORS_ROLE_NAME],
  );
  return rows[0]!.id;
}

/** Whether some user holds Administrators - the instance is set up. */
export async function hasAdministrator(database: Database): Promise<boolean> {
  const { rows } = await database.query(
    `SELECT 1 FROM totalbase.users_roles ur JOIN totalbase.roles r ON r.id = ur.role WHERE r.name = $1 AND r.reserved LIMIT 1`,
    [ADMINISTRATORS_ROLE_NAME],
  );
  return rows.length > 0;
}

/**
 * Creates the instance owner - unless some user holds Administrators already, then nothing (null). Under a
 * transaction-scoped lock, so two at once (two setup tabs, two server processes) never make two owners.
 */
export async function createInstanceOwner(database: Database, input: { email: string; name: string; password: string }): Promise<string | null> {
  const roleId = await administratorsRole(database);
  const passwordHash = await hashPassword(input.password);
  return database.transaction(async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('totalbase.instance_owner'))`);
    const { rows: held } = await client.query(`SELECT 1 FROM totalbase.users_roles WHERE role = $1 LIMIT 1`, [roleId]);
    if (held.length > 0) return null;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO totalbase.users (email, name, password_hash, owner, email_verified_at)
       VALUES ($1, $2, $3, true, now())
       RETURNING id`,
      [input.email, input.name, passwordHash],
    );
    const userId = rows[0]!.id;
    await client.query(`INSERT INTO totalbase.users_roles ("user", role) VALUES ($1, $2)`, [userId, roleId]);
    return userId;
  });
}

/** At start: the owner from the variables when both are set; otherwise only the role (the setup creates the owner). */
export async function bootstrapFirstAdmin(database: Database, email: string | undefined, password: string | undefined): Promise<void> {
  await administratorsRole(database);
  if (email && password) await createInstanceOwner(database, { email, name: "Administrator", password });
}
