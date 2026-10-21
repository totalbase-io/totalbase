import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveMasterKey } from "./master-key.js";
import { setupTestApp } from "./test-support.js";

/**
 * The master key (Foundations.md §15): the variable when set, else the file in the data directory, else - only
 * for an installation with none yet - a new one kept there. Never a new key for an installation that has one.
 */
describe("the master key", () => {
  let database: Database;
  let close: () => Promise<void>;
  let envKey: string;
  let fingerprint: unknown;
  const logger = pino({ level: "silent" });
  const dirs: string[] = [];
  const dir = async () => {
    const path = await mkdtemp(join(tmpdir(), "totalbase-key-"));
    dirs.push(path);
    return path;
  };

  beforeAll(async () => {
    const setup = await setupTestApp();
    database = setup.database;
    close = async () => {
      await setup.app.close();
      await database.close();
    };
    envKey = process.env["TOTALBASE_MASTER_KEY"]!;
    fingerprint = (await database.query<{ value: unknown }>(`SELECT value FROM totalbase.settings WHERE key = 'system.master_key_verifier'`)).rows[0]?.value;
  });

  afterAll(async () => {
    // The test database's own fingerprint, as it was.
    await database.query(`DELETE FROM totalbase.settings WHERE key = 'system.master_key_verifier'`);
    await database.query(`INSERT INTO totalbase.settings (key, value) VALUES ('system.master_key_verifier', $1::jsonb)`, [JSON.stringify(fingerprint)]);
    for (const path of dirs) await rm(path, { recursive: true, force: true });
    await close();
  });

  it("uses the variable when set, and refuses one shorter than 32 characters - offering a good one", async () => {
    expect(await resolveMasterKey(database, envKey, await dir(), logger)).toMatchObject({ masterKey: envKey, source: "ENV", path: null });
    await expect(resolveMasterKey(database, "too-short", await dir(), logger)).rejects.toThrow(/at least 32.*TOTALBASE_MASTER_KEY=[A-Za-z0-9_-]{43}/);
  });

  it("reads the file in the data directory when there is no variable", async () => {
    const data = await dir();
    await writeFile(join(data, "master.key"), envKey + "\n");
    expect(await resolveMasterKey(database, undefined, data, logger)).toMatchObject({ masterKey: envKey, source: "FILE", path: join(data, "master.key") });
  });

  it("never generates a key for an installation that has one: no file is written", async () => {
    const data = await dir();
    await expect(resolveMasterKey(database, undefined, data, logger)).rejects.toMatchObject({ code: "INVALID_MASTER_KEY" });
    await expect(stat(join(data, "master.key"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("generates one for a new installation, readable by the process only, and reads it back next time", async () => {
    await database.query(`DELETE FROM totalbase.settings WHERE key = 'system.master_key_verifier'`);
    const data = await dir();
    const first = await resolveMasterKey(database, undefined, data, logger);
    expect(first).toMatchObject({ source: "GENERATED", path: join(data, "master.key") });
    expect(first.masterKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await stat(join(data, "master.key"))).mode & 0o777).toBe(0o600);
    expect((await readFile(join(data, "master.key"), "utf8")).trim()).toBe(first.masterKey);
    expect(await resolveMasterKey(database, undefined, data, logger)).toMatchObject({ masterKey: first.masterKey, source: "FILE" });
    // Its fingerprint is the installation's now: another key is refused.
    await expect(resolveMasterKey(database, envKey, data, logger)).rejects.toMatchObject({ code: "INVALID_MASTER_KEY" });
  });
});
