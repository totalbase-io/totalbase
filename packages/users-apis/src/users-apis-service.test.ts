import { fileURLToPath } from "node:url";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { ADMINISTRATORS_ROLE_NAME, RoleAssignmentsService, RolesService } from "@totalbase/permissions";
import { SettingsService } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USER_API_MAX_TTL_DAYS, UsersApisService } from "./users-apis-service.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

describe("UsersApisService (integration)", () => {
  let database: Database;
  let usersApis: UsersApisService;
  let roles: RolesService;
  let roleAssignments: RoleAssignmentsService;
  let userId: string;
  let apiRoleId: string;
  let adminUserId: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    roles = new RolesService(database);
    roleAssignments = new RoleAssignmentsService(database);
    usersApis = new UsersApisService(database, new SettingsService(database), roles, roleAssignments);

    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ('users-apis-pkg-test@example.com') RETURNING id`,
    );
    userId = rows[0]!.id;
    // plane=API tokens need a role granting API access.
    apiRoleId = (await roles.create("users-apis-pkg-test-api", { apiAccess: true })).id;
    await roleAssignments.assignRoleToUser(userId, apiRoleId);

    const { rows: adminRows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ('users-apis-pkg-test-admin@example.com') RETURNING id`,
    );
    adminUserId = adminRows[0]!.id;
    const administratorsRoleId = await roles.getAdministratorsRoleId();
    await roleAssignments.assignRoleToUser(adminUserId, administratorsRoleId);
  });

  afterAll(async () => {
    await database.query(`DELETE FROM totalbase.users WHERE email LIKE 'users-apis-pkg-test%'`);
    await database.query(`DELETE FROM totalbase.roles WHERE name LIKE 'users-apis-pkg-test-%'`);
    await database.close();
  });

  it("creates a plane=API token, validates it, and never re-exposes the plaintext", async () => {
    const { plainKey, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-1", plane: "API" });

    expect(plainKey.startsWith("tb_")).toBe(true);
    expect(userApi.keyPrefix).toBe(plainKey.slice(0, 12));
    expect(userApi.plane).toBe("API");

    const result = await usersApis.validate(plainKey, undefined);
    expect(result?.id).toBe(userApi.id);
    expect(result?.userId).toBe(userId);
  });

  it("rejects an unknown token", async () => {
    expect(await usersApis.validate("tb_does-not-exist", undefined)).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { plainKey, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-2", plane: "API" });
    await usersApis.revoke(userApi.id);
    expect(await usersApis.validate(plainKey, undefined)).toBeNull();
  });

  it("rotate() invalidates the old token and issues a new one", async () => {
    const { plainKey: original, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-3", plane: "API" });
    const { plainKey: rotated } = await usersApis.rotate(userApi.id);

    expect(await usersApis.validate(original, undefined)).toBeNull();
    expect((await usersApis.validate(rotated, undefined))?.id).toBe(userApi.id);
  });

  it("rotate() sets a new expiry and renews an expired token, but never a revoked one", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { plainKey: original, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-renew", plane: "API", ttlDays: 1 });
    await database.query(`UPDATE totalbase.tokens SET expires_at = now() - interval '1 day' WHERE id = $1`, [userApi.id]);
    expect(await usersApis.validate(original, undefined)).toBeNull();

    const renewed = await usersApis.rotate(userApi.id, 90);
    expect(Math.round((renewed.userApi.expiresAt!.getTime() - Date.now()) / day)).toBe(90);
    expect(renewed.userApi.name).toBe("users-apis-pkg-test-renew");
    expect((await usersApis.validate(renewed.plainKey, undefined))?.id).toBe(userApi.id);

    await expect(usersApis.rotate(userApi.id, 0)).rejects.toMatchObject({ code: "INVALID_TOKEN_EXPIRY" });
    await usersApis.revoke(userApi.id);
    await expect(usersApis.rotate(userApi.id)).rejects.toMatchObject({ code: "RESOURCE_NOT_FOUND" });
  });

  it("rotate() with a grace window keeps the old secret working until then - each secret with its own expiry", async () => {
    const { plainKey: original, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-grace", plane: "API" });
    const rolled = await usersApis.rotate(userApi.id, 30, 24);
    expect(rolled.userApi.previousExpiresAt).not.toBeNull();
    expect(Math.round((rolled.userApi.previousExpiresAt!.getTime() - Date.now()) / 3_600_000)).toBe(24);
    expect((await usersApis.validate(original, undefined))?.id).toBe(userApi.id);
    expect((await usersApis.validate(rolled.plainKey, undefined))?.id).toBe(userApi.id);

    // The window over: only the new secret.
    await database.query(`UPDATE totalbase.tokens SET previous_expires_at = now() - interval '1 second' WHERE id = $1`, [userApi.id]);
    expect(await usersApis.validate(original, undefined)).toBeNull();
    expect((await usersApis.validate(rolled.plainKey, undefined))?.id).toBe(userApi.id);

    // Regenerating again without grace drops the previous secret; a revoked token takes both down.
    const again = await usersApis.rotate(userApi.id, 30, 1);
    const last = await usersApis.rotate(userApi.id, 30);
    expect(last.userApi.previousExpiresAt).toBeNull();
    expect(await usersApis.validate(again.plainKey, undefined)).toBeNull();
    const graced = await usersApis.rotate(userApi.id, 30, 1);
    await usersApis.revoke(userApi.id);
    expect(await usersApis.validate(last.plainKey, undefined)).toBeNull();
    expect(await usersApis.validate(graced.plainKey, undefined)).toBeNull();
  });

  it("rotate() gives an already-expired secret no grace, and refuses a window beyond seven days", async () => {
    const { plainKey: original, userApi } = await usersApis.create({ userId, name: "users-apis-grace-expired", plane: "API", ttlDays: 1 });
    await database.query(`UPDATE totalbase.tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`, [userApi.id]);
    const rolled = await usersApis.rotate(userApi.id, 30, 24);
    expect(rolled.userApi.previousExpiresAt).toBeNull();
    expect(await usersApis.validate(original, undefined)).toBeNull();
    await expect(usersApis.rotate(userApi.id, 30, 169)).rejects.toMatchObject({ code: "INVALID_TOKEN_EXPIRY" });
  });

  it("resolves the owning user's roles live, not frozen at creation", async () => {
    const role = await roles.create("users-apis-pkg-test-role");
    const { plainKey, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-4", plane: "API" });

    expect((await usersApis.validate(plainKey, undefined))?.roleIds).toEqual([apiRoleId]);

    await roleAssignments.assignRoleToUser(userId, role.id);
    expect((await usersApis.validate(plainKey, undefined))?.roleIds.sort()).toEqual([apiRoleId, role.id].sort());

    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [userId, role.id]);
    expect((await usersApis.validate(plainKey, undefined))?.roleIds).toEqual([apiRoleId]);

    await usersApis.delete(userApi.id);
  });

  it("requires API access to hold a plane=API token, checked live", async () => {
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.users (email) VALUES ('users-apis-pkg-test-noapi@example.com') RETURNING id`,
    );
    await expect(usersApis.create({ userId: rows[0]!.id, name: "users-apis-pkg-test-7", plane: "API" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });

    const { plainKey, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-8", plane: "API" });
    await roles.update(apiRoleId, { apiAccess: false });
    try {
      expect(await usersApis.validate(plainKey, undefined)).toBeNull();
    } finally {
      await roles.update(apiRoleId, { apiAccess: true });
    }
    await roles.update(apiRoleId, { active: false });
    try {
      expect(await usersApis.validate(plainKey, undefined)).toBeNull();
    } finally {
      await roles.update(apiRoleId, { active: true });
    }
    expect(await usersApis.validate(plainKey, undefined)).not.toBeNull();
    await usersApis.delete(userApi.id);
  });

  it("rejects creating a plane=ADMIN token for a user without the Administrators role", async () => {
    await expect(usersApis.create({ userId, name: "users-apis-pkg-test-5", plane: "ADMIN" })).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
    });
  });

  it("allows creating a plane=ADMIN token for a user holding Administrators, and revokes it live if the role is removed", async () => {
    const { plainKey, userApi } = await usersApis.create({ userId: adminUserId, name: "users-apis-pkg-test-6", plane: "ADMIN" });
    expect((await usersApis.validate(plainKey, undefined))?.plane).toBe("ADMIN");

    const administratorsRoleId = await roles.getAdministratorsRoleId();
    await database.query(`DELETE FROM totalbase.users_roles WHERE "user" = $1 AND role = $2`, [adminUserId, administratorsRoleId]);
    expect(await usersApis.validate(plainKey, undefined)).toBeNull();

    // Restore for any later test relying on adminUserId still holding it.
    await roleAssignments.assignRoleToUser(adminUserId, administratorsRoleId);
    await usersApis.delete(userApi.id);
  });

  it("allowed addresses: the token is accepted from them only, an address or a range, and refused without an address (Security.md §3.5)", async () => {
    const { plainKey, userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-ips", plane: "API", allowedIps: [" 203.0.113.7 ", "10.20.0.0/16", "2001:db8::/32"] });
    expect(userApi.allowedIps).toEqual(["203.0.113.7", "10.20.0.0/16", "2001:db8::/32"]);

    expect((await usersApis.validate(plainKey, "203.0.113.7"))?.id).toBe(userApi.id);
    expect((await usersApis.validate(plainKey, "10.20.30.40"))?.id).toBe(userApi.id);
    expect((await usersApis.validate(plainKey, "2001:db8::1"))?.id).toBe(userApi.id);

    // Security regression: a valid secret from elsewhere, or from a caller that knows no address, is refused.
    await expect(usersApis.validate(plainKey, "203.0.113.8")).rejects.toMatchObject({ code: "TOKEN_IP_NOT_ALLOWED" });
    await expect(usersApis.validate(plainKey, "10.21.0.1")).rejects.toMatchObject({ code: "TOKEN_IP_NOT_ALLOWED" });
    await expect(usersApis.validate(plainKey, "2001:db9::1")).rejects.toMatchObject({ code: "TOKEN_IP_NOT_ALLOWED" });
    await expect(usersApis.validate(plainKey, undefined)).rejects.toMatchObject({ code: "TOKEN_IP_NOT_ALLOWED" });
    // A refused use is not a use.
    const { rows } = await database.query<{ last_used_at: Date | null }>(`SELECT last_used_at FROM totalbase.tokens WHERE id = $1`, [userApi.id]);
    expect(rows[0]!.last_used_at).not.toBeNull();
    await usersApis.delete(userApi.id);

    const refusedOnly = await usersApis.create({ userId, name: "users-apis-pkg-test-ips-2", plane: "API", allowedIps: ["192.0.2.1"] });
    await expect(usersApis.validate(refusedOnly.plainKey, "192.0.2.2")).rejects.toMatchObject({ code: "TOKEN_IP_NOT_ALLOWED" });
    const after = await database.query<{ last_used_at: Date | null }>(`SELECT last_used_at FROM totalbase.tokens WHERE id = $1`, [refusedOnly.userApi.id]);
    expect(after.rows[0]!.last_used_at).toBeNull();
    await usersApis.delete(refusedOnly.userApi.id);
  });

  it("allowed addresses: none, null or an empty list is anywhere; PostgreSQL refuses what is not an address, and more than 50", async () => {
    const open = await usersApis.create({ userId, name: "users-apis-pkg-test-ips-open", plane: "API", allowedIps: [] });
    expect(open.userApi.allowedIps).toBeNull();
    expect((await usersApis.validate(open.plainKey, "198.51.100.9"))?.id).toBe(open.userApi.id);
    expect((await usersApis.validate(open.plainKey, undefined))?.id).toBe(open.userApi.id);
    await usersApis.delete(open.userApi.id);

    await expect(usersApis.create({ userId, name: "users-apis-pkg-test-ips-bad", plane: "API", allowedIps: ["not-an-address"] })).rejects.toMatchObject({ code: "INVALID_TEXT_REPRESENTATION" });
    await expect(usersApis.create({ userId, name: "users-apis-pkg-test-ips-bad", plane: "API", allowedIps: "10.0.0.1" as unknown as string[] })).rejects.toMatchObject({ code: "INVALID_QUERY" });
    const many = Array.from({ length: 51 }, (_, i) => `10.0.0.${i + 1}`);
    await expect(usersApis.create({ userId, name: "users-apis-pkg-test-ips-many", plane: "API", allowedIps: many })).rejects.toMatchObject({ code: "CHECK_VIOLATION" });
  });

  it("names are unique per user, case-insensitively - enforced by PostgreSQL", async () => {
    await usersApis.create({ userId, name: "users-apis-pkg-test-dup", plane: "API" });
    await expect(usersApis.create({ userId, name: "USERS-APIS-PKG-TEST-DUP", plane: "API" })).rejects.toMatchObject({
      code: "USER_API_NAME_DUPLICATE",
    });
    // Another user may reuse the name.
    const other = await usersApis.create({ userId: adminUserId, name: "users-apis-pkg-test-dup", plane: "ADMIN" });
    expect(other.userApi.name).toBe("users-apis-pkg-test-dup");
  });

  it("every token expires: ttlDays sets expires_at, the setting is the default, out-of-range is rejected", async () => {
    const day = 24 * 60 * 60 * 1000;
    const { userApi } = await usersApis.create({ userId, name: "users-apis-pkg-test-ttl", plane: "API", ttlDays: 30 });
    expect(Math.round((userApi.expiresAt!.getTime() - userApi.createdAt.getTime()) / day)).toBe(30);

    const { userApi: byDefault } = await usersApis.create({ userId, name: "users-apis-pkg-test-ttl-default", plane: "API" });
    expect(byDefault.expiresAt).not.toBeNull();

    for (const ttlDays of [0, -5, 1.5, USER_API_MAX_TTL_DAYS + 1]) {
      await expect(usersApis.create({ userId, name: `users-apis-pkg-test-bad-${ttlDays}`, plane: "API", ttlDays })).rejects.toMatchObject({
        code: "INVALID_TOKEN_EXPIRY",
      });
    }
  });

  it("ADMINISTRATORS_ROLE_NAME matches the seeded reserved role", async () => {
    const administratorsRoleId = await roles.getAdministratorsRoleId();
    const role = await roles.findById(administratorsRoleId);
    expect(role?.name).toBe(ADMINISTRATORS_ROLE_NAME);
    expect(role?.reserved).toBe(true);
  });
});
