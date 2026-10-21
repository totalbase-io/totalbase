import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { loadServerEnv } from "./env.js";
import { setupTestApp } from "./test-support.js";

/**
 * The viewer's effective time zone is their transactions' TimeZone
 * (Security.md §4.2): their profile's, else the
 * instance's, else the browser's `X-TotalBase-Timezone` - never the
 * server's. Read back through a function returning PostgreSQL's own
 * `current_setting('TimeZone')`, so `$PERIOD.*` and `date_trunc` cut days
 * where the viewer sees them.
 */
describe("effective time zone", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let adminToken: string;
  let adminId: string;
  let resourceId: string;

  const zoneOf = async (headers: Record<string, string> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/public/function/tz_test_current",
      headers: { authorization: `Bearer ${adminToken}`, ...headers },
      payload: { data: {} },
    });
    expect(res.statusCode).toBe(200);
    return res.json().data as string;
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    await database.query(`DROP FUNCTION IF EXISTS public.tz_test_current()`);
    await database.query(`CREATE FUNCTION public.tz_test_current() RETURNS text LANGUAGE sql AS $$ SELECT current_setting('TimeZone') $$`);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.resources (postgres_oid, "schema", name, type, status, exposed_methods)
       VALUES (to_regprocedure('public.tz_test_current()')::oid, 'public', 'tz_test_current', 'FUNCTION', 'ACTIVE', ARRAY['POST'])
       RETURNING id`,
    );
    resourceId = rows[0]!.id;
    const env = loadServerEnv();
    const login = await context.auth.login({ email: env.adminEmail!, password: env.adminPassword! });
    adminToken = login.token;
    adminId = login.user.id;
    await context.auth.users.updatePreferences(adminId, { timezone: null });
    await context.settings.reset("system.timezone");
  });

  afterAll(async () => {
    await context.auth.users.updatePreferences(adminId, { timezone: null });
    await context.settings.reset("system.timezone");
    await context.settings.reset("system.timezone_user_choice");
    await database.query(`DELETE FROM totalbase.resources WHERE id = $1`, [resourceId]);
    await database.query(`DROP FUNCTION IF EXISTS public.tz_test_current()`);
    await app.close();
  });

  it("takes the browser's zone only when neither the profile nor the instance has one - and only a zone PostgreSQL knows", async () => {
    const serverDefault = await zoneOf();
    expect(await zoneOf({ "x-totalbase-timezone": "Asia/Tokyo" })).toBe("Asia/Tokyo");
    expect(await zoneOf({ "x-totalbase-timezone": "Not/AZone'; DROP TABLE x" })).toBe(serverDefault);
  });

  it("takes the instance's zone over the browser's", async () => {
    await context.settings.set("system.timezone", "America/Argentina/Buenos_Aires");
    expect(await zoneOf({ "x-totalbase-timezone": "Asia/Tokyo" })).toBe("America/Argentina/Buenos_Aires");
  });

  it("takes the profile's zone over the instance's when users may choose - and an empty profile follows the instance again", async () => {
    await context.settings.set("system.timezone_user_choice", true);
    await context.auth.users.updatePreferences(adminId, { timezone: "Europe/Madrid" });
    expect(await zoneOf({ "x-totalbase-timezone": "Asia/Tokyo" })).toBe("Europe/Madrid");
    await context.auth.users.updatePreferences(adminId, { timezone: null });
    expect(await zoneOf()).toBe("America/Argentina/Buenos_Aires");
  });

  it("locks everyone to the instance's zone when users may not choose - their own is kept, not used", async () => {
    const prefs = (method: "GET" | "PATCH", payload?: Record<string, unknown>) =>
      app.inject({ method, url: "/app/api/me/preferences", headers: { authorization: `Bearer ${adminToken}` }, ...(payload ? { payload: { data: payload } } : {}) });
    await context.settings.set("system.timezone", "America/Argentina/Buenos_Aires");
    await context.auth.users.updatePreferences(adminId, { timezone: "Europe/Madrid" });
    await context.settings.set("system.timezone_user_choice", false);
    try {
      expect(await zoneOf()).toBe("America/Argentina/Buenos_Aires");
      const state = (await prefs("GET")).json().data;
      expect(state).toMatchObject({ timezoneLocked: true, preferences: { timezone: "Europe/Madrid" }, effective: { timezone: "America/Argentina/Buenos_Aires" } });
      const refused = await prefs("PATCH", { timezone: "Asia/Tokyo" });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().errors[0].code).toBe("USER_TIMEZONE_LOCKED");
      // Formats stay each user's own.
      expect((await prefs("PATCH", { dateFormat: "yyyy-MM-dd" })).statusCode).toBe(200);
      // With no instance zone there's nothing to lock to: the user's own counts again.
      await context.settings.reset("system.timezone");
      expect(await zoneOf()).toBe("Europe/Madrid");
    } finally {
      await context.settings.reset("system.timezone_user_choice");
      await context.auth.users.updatePreferences(adminId, { timezone: null, dateFormat: null });
    }
  });

  it("keeps the zone inside the request's transaction - the pool's connections stay as they were", async () => {
    await context.settings.reset("system.timezone");
    const before = (await database.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0]!.tz;
    await zoneOf({ "x-totalbase-timezone": "Pacific/Auckland" });
    const after = (await database.query<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`)).rows[0]!.tz;
    expect(after).toBe(before);
  });
});
