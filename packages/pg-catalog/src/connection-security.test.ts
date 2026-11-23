import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getConnectionSecurity } from "./connection-security.js";

describe("getConnectionSecurity", () => {
  let database: Database;
  beforeAll(() => {
    database = new Database(loadDatabaseConfigFromEnv());
  });
  afterAll(async () => {
    await database.close();
  });

  it("reads the connection's role, password hashing, TLS and network from PostgreSQL", async () => {
    const security = await getConnectionSecurity(database);
    const { rows } = await database.query<{ superuser: boolean; createrole: boolean; replication: boolean; encryption: string }>(
      `SELECT rolsuper AS superuser, rolcreaterole AS createrole, rolreplication AS replication, current_setting('password_encryption') AS encryption
         FROM pg_roles WHERE rolname = current_user`,
    );
    expect(security.superuser).toBe(rows[0]!.superuser);
    // The test role holds CREATEROLE and REPLICATION (scripts/test-matrix.sh), never a superuser's.
    if (!rows[0]!.superuser) {
      expect(security.privileges.includes("CREATEROLE")).toBe(rows[0]!.createrole);
      expect(security.privileges.includes("REPLICATION")).toBe(rows[0]!.replication);
    }
    expect(security.passwordEncryption).toBe(rows[0]!.encryption);
    expect(typeof security.ssl).toBe("boolean");
    // The test servers run on this machine or its Docker network.
    expect(security.privateNetwork).toBe(true);
  });
});
