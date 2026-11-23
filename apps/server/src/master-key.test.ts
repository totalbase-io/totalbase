import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Database } from "@totalbase/database";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { decryptSecret, legacyMasterKeyVerifier, masterKeyVerifier, unboundMasterKeyVerifier } from "@totalbase/secrets";
import { assertValidMasterKey, resolveMasterKey } from "./master-key.js";
import { setupTestApp, testBootstrapDataDir } from "./test-support.js";

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

  it("starts the tests from a data directory of their own, never the development instance's", async () => {
    // A marker the test database left in /var/lib/totalbase made the development database refuse to start (§15).
    const own = testBootstrapDataDir();
    expect(own).not.toBe(process.env["TOTALBASE_DATA_DIR"] || "/var/lib/totalbase");
    expect((await readFile(join(own, "ciphertext-format"), "utf8")).trim()).toBe("v3");
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
  // Security regression (Foundations.md §15): the verifier an installation kept was the encryption key itself. One
  // that still keeps it moves to the current format on start: every stored ciphertext re-encrypted, then the
  // verifier replaced by one that decrypts nothing.
  // Security regression (SEC-102): ciphertexts were bound to no purpose. An installation of that format (v2) moves once:
  // each re-encrypted for what it is, and a v2 one is never read again - not even one put back by SQL later.
  it("moves a v2 installation to purpose-bound ciphertexts, once", async () => {
    const verifier = async () => (await database.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM totalbase.settings WHERE key = 'system.master_key_verifier'`)).rows[0]?.value;
    const v2Encrypt = (plaintext: string) => {
      const iv = randomBytes(12);
      const key = Buffer.from(hkdfSync("sha256", Buffer.from(envKey, "utf8"), Buffer.alloc(0), "totalbase:secrets:aes-256-gcm", 32));
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return `v2:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64")}`;
    };
    const secretKey = `master-key-v2-${randomBytes(4).toString("hex")}`;
    try {
      await database.query(`UPDATE totalbase.settings SET value = to_jsonb($1::text) WHERE key = 'system.master_key_verifier'`, [unboundMasterKeyVerifier(envKey)]);
      const captured = v2Encrypt("client-secret");
      await database.query(`INSERT INTO totalbase.secrets (key, ciphertext, scope) VALUES ($1, $2, 'AUTH_PROVIDERS')`, [secretKey, captured]);
      const data = await dir();
      await assertValidMasterKey(database, envKey, logger, data);
      expect(await verifier()).toBe(masterKeyVerifier(envKey));
      expect((await readFile(join(data, "ciphertext-format"), "utf8")).trim()).toBe("v3");
      // Round 8: SQL setting the old verifier back no longer gets a move - the data directory says it happened.
      await database.query(`UPDATE totalbase.settings SET value = to_jsonb($1::text) WHERE key = 'system.master_key_verifier'`, [unboundMasterKeyVerifier(envKey)]);
      await expect(assertValidMasterKey(database, envKey, logger, data)).rejects.toMatchObject({ code: "INVALID_MASTER_KEY" });
      await database.query(`UPDATE totalbase.settings SET value = to_jsonb($1::text) WHERE key = 'system.master_key_verifier'`, [masterKeyVerifier(envKey)]);
      const moved = (await database.query<{ ciphertext: string }>(`SELECT ciphertext FROM totalbase.secrets WHERE key = $1`, [secretKey])).rows[0]!.ciphertext;
      expect(decryptSecret(envKey, moved, "secret:AUTH_PROVIDERS")).toBe("client-secret");
      // Copied by SQL into another feature, it doesn't decrypt there; the v2 one put back later isn't read at all.
      await database.query(`INSERT INTO totalbase.secrets (key, ciphertext, scope) VALUES ($1, $2, 'SMTP'), ($3, $4, 'SMTP')`, [`${secretKey}-copy`, moved, `${secretKey}-old`, captured]);
      await assertValidMasterKey(database, envKey, logger);
      for (const key of [`${secretKey}-copy`, `${secretKey}-old`]) {
        const ciphertext = (await database.query<{ ciphertext: string }>(`SELECT ciphertext FROM totalbase.secrets WHERE key = $1`, [key])).rows[0]!.ciphertext;
        expect(() => decryptSecret(envKey, ciphertext, "secret:SMTP"), key).toThrow(expect.objectContaining({ code: "SECRET_DECRYPTION_FAILED" }));
      }
    } finally {
      await database.query(`DELETE FROM totalbase.secrets WHERE key LIKE $1`, [`${secretKey}%`]);
    }
  });

  it("moves an installation keeping the old verifier: re-encrypts its secrets, factors and embed links, then replaces the verifier", async () => {
    const legacyEncrypt = (key: string, plaintext: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(key, "utf8").digest(), iv);
      const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
    };
    const verifier = async () => (await database.query<{ value: string }>(`SELECT value #>> '{}' AS value FROM totalbase.settings WHERE key = 'system.master_key_verifier'`)).rows[0]?.value;
    const secretKey = `master-key-test-${randomBytes(4).toString("hex")}`;
    const { rows: [user] } = await database.query<{ id: string }>(`INSERT INTO totalbase.users (email, name) VALUES ($1, 'Key test') RETURNING id`, [`${secretKey}@example.com`]);
    try {
      await database.query(`UPDATE totalbase.settings SET value = to_jsonb($1::text) WHERE key = 'system.master_key_verifier'`, [legacyMasterKeyVerifier(envKey)]);
      await database.query(`INSERT INTO totalbase.secrets (key, ciphertext, scope) VALUES ($1, $2, 'SMTP'), ($3, $4, 'WORKFLOWS')`, [secretKey, legacyEncrypt(envKey, "smtp-password"), `${secretKey}-other`, legacyEncrypt("another-key-of-at-least-thirty-two-chars", "x")]);
      await database.query(`INSERT INTO totalbase.factors ("user", secret) VALUES ($1, $2)`, [user!.id, legacyEncrypt(envKey, "JBSWY3DPEHPK3PXP")]);
      const slug = secretKey.slice(-12);
      const { rows: [dashboard] } = await database.query<{ id: string }>(`INSERT INTO totalbase.dashboards (name, slug) VALUES ($1, $1) RETURNING id`, [slug]);
      await database.query(`INSERT INTO totalbase.dashboards_embeds (dashboard, name, type, link_hash, link_ciphertext) VALUES ($1, 'Link', 'LINK', 'h', $2)`, [dashboard!.id, legacyEncrypt(envKey, "embed-link-secret")]);

      await assertValidMasterKey(database, envKey, logger);

      expect(await verifier()).toBe(masterKeyVerifier(envKey));
      const secret = (await database.query<{ ciphertext: string }>(`SELECT ciphertext FROM totalbase.secrets WHERE key = $1`, [secretKey])).rows[0]!.ciphertext;
      expect(secret.startsWith("v3:")).toBe(true);
      expect(decryptSecret(envKey, secret, "secret:SMTP")).toBe("smtp-password");
      const factor = (await database.query<{ secret: string }>(`SELECT secret FROM totalbase.factors WHERE "user" = $1`, [user!.id])).rows[0]!.secret;
      expect(factor.startsWith("v3:")).toBe(true);
      expect(decryptSecret(envKey, factor, "factor")).toBe("JBSWY3DPEHPK3PXP");
      const link = (await database.query<{ link_ciphertext: string }>(`SELECT link_ciphertext FROM totalbase.dashboards_embeds WHERE dashboard = $1`, [dashboard!.id])).rows[0]!.link_ciphertext;
      expect(decryptSecret(envKey, link, "embed-link")).toBe("embed-link-secret");
      // One it couldn't read was never readable with this key: left as it was.
      expect((await database.query<{ ciphertext: string }>(`SELECT ciphertext FROM totalbase.secrets WHERE key = $1`, [`${secretKey}-other`])).rows[0]!.ciphertext.startsWith("v3:")).toBe(false);

      // Once moved: the same key passes, another is refused.
      await assertValidMasterKey(database, envKey, logger);
      await expect(assertValidMasterKey(database, "another-key-of-at-least-thirty-two-chars", logger)).rejects.toMatchObject({ code: "INVALID_MASTER_KEY" });
    } finally {
      await database.query(`DELETE FROM totalbase.secrets WHERE key LIKE $1`, [`${secretKey}%`]);
      await database.query(`DELETE FROM totalbase.dashboards WHERE slug = $1`, [secretKey.slice(-12)]);
      await database.query(`DELETE FROM totalbase.users WHERE id = $1`, [user!.id]);
    }
  });
});
