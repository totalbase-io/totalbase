import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { setupTestApp, uniqueSuffix } from "./test-support.js";

const COMPANY = "reg_cols_test_company";
const SLUG = "reg_cols_test_slug";
const PASSWORD = "a-strong-enough-password";

/**
 * Registration columns (Security.md §2.7): `auth.registration_columns` names the project's columns a
 * self-registration may set through `extra`, written in the account's own INSERT - where a BEFORE INSERT
 * trigger reads them; any other column is refused, and the setting refuses TotalBase's columns.
 */
describe("registration columns", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  const emails: string[] = [];
  const saved: { enabled: boolean; verification: boolean } = { enabled: false, verification: true };

  const register = (payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/auth/register", payload });
  const email = () => {
    const value = `reg-cols-${uniqueSuffix()}@example.com`;
    emails.push(value);
    return value;
  };

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    saved.enabled = await context.settings.get("auth.registration_enabled");
    saved.verification = await context.settings.get("auth.email_verification_required");
    await context.settings.set("auth.registration_enabled", true);
    await context.settings.set("auth.email_verification_required", false);
    await context.settings.set("smtp.host", "");
    await database.query(`ALTER TABLE totalbase.users ADD COLUMN IF NOT EXISTS ${COMPANY} text, ADD COLUMN IF NOT EXISTS ${SLUG} text`);
    // The pattern of the multitenancy guide: a trigger that reads the sign-up form's column from NEW.
    await database.query(`CREATE OR REPLACE FUNCTION public.reg_cols_test_slug() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.${SLUG} := lower(coalesce(NEW.${COMPANY}, 'none')); RETURN NEW; END $$`);
    await database.query(`DROP TRIGGER IF EXISTS reg_cols_test ON totalbase.users`);
    await database.query(`CREATE TRIGGER reg_cols_test BEFORE INSERT ON totalbase.users FOR EACH ROW EXECUTE FUNCTION public.reg_cols_test_slug()`);
  });

  afterAll(async () => {
    await database.query(`DROP TRIGGER IF EXISTS reg_cols_test ON totalbase.users`);
    await database.query(`DROP FUNCTION IF EXISTS public.reg_cols_test_slug()`);
    for (const value of emails) await database.query(`DELETE FROM totalbase.users WHERE email = $1`, [value]);
    await database.query(`ALTER TABLE totalbase.users DROP COLUMN IF EXISTS ${COMPANY}, DROP COLUMN IF EXISTS ${SLUG}`);
    await context.settings.reset("auth.registration_columns");
    await context.settings.set("auth.registration_enabled", saved.enabled);
    await context.settings.set("auth.email_verification_required", saved.verification);
    await context.settings.reset("smtp.host");
    await app.close();
  });

  it("the setting takes the project's columns only", async () => {
    await expect(context.settings.set("auth.registration_columns", ["email"])).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(context.settings.set("auth.registration_columns", ["no_such_column"])).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await expect(context.settings.set("auth.registration_columns", ["Drop Table"])).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await context.settings.set("auth.registration_columns", [COMPANY]);
  });

  it("writes the listed columns in the account's INSERT, where a trigger reads them; refuses any other", async () => {
    const mine = email();
    const res = await register({ email: mine, password: PASSWORD, name: "Ana", extra: { [COMPANY]: "Acme" } });
    expect(res.statusCode, res.body).toBe(200);
    const { rows } = await database.query<{ company: string; slug: string }>(`SELECT ${COMPANY} AS company, ${SLUG} AS slug FROM totalbase.users WHERE email = $1`, [mine]);
    expect(rows[0]).toEqual({ company: "Acme", slug: "acme" });

    const other = email();
    const refused = await register({ email: other, password: PASSWORD, extra: { [SLUG]: "forced" } });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().errors[0].code).toBe("INVALID_FIELD");
    expect((await database.query(`SELECT 1 FROM totalbase.users WHERE email = $1`, [other])).rowCount).toBe(0);

    const plain = email();
    expect((await register({ email: plain, password: PASSWORD })).statusCode).toBe(200);
  });
});
