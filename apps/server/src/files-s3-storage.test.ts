import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Database } from "@totalbase/database";
import type { SettingKey } from "@totalbase/settings";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AppContext } from "./context.js";
import { adminToken, setupTestApp, uniqueSuffix } from "./test-support.js";

/**
 * S3-compatible file storage end to end (Administration.md §10.2), against a
 * real service when one is given - the same TOTALBASE_TEST_S3_* variables as
 * @totalbase/files' s3-storage-provider.test.ts (a bucket that exists).
 */
const LIVE = process.env["TOTALBASE_TEST_S3_ENDPOINT"];
const KEYS: SettingKey[] = [
  "files.storage_provider",
  "files.storage_local_path",
  "s3.enabled",
  "s3.endpoint",
  "s3.region",
  "s3.bucket",
  "s3.prefix",
  "s3.path_style",
  "s3.access_key_id",
  "s3.secret_key",
];

describe.skipIf(!LIVE)("S3-compatible file storage", () => {
  let app: FastifyInstance;
  let context: AppContext;
  let database: Database;
  let token: string;
  let localPath: string;
  const secretKey = `files-s3-test-${uniqueSuffix()}`;
  const fileIds: string[] = [];
  let saved: Array<{ key: string; value: unknown }> = [];

  const verify = () => app.inject({ method: "POST", url: "/admin/api/settings/s3/verify", headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    ({ app, context, database } = await setupTestApp());
    token = await adminToken(context);
    saved = (await database.query<{ key: string; value: unknown }>(`SELECT key, value FROM totalbase.settings WHERE key = ANY($1)`, [KEYS])).rows;
    localPath = await mkdtemp(path.join(tmpdir(), "totalbase-files-s3-"));
    await context.settings.set("files.storage_local_path", localPath);
    await context.settings.set("files.storage_provider", "local");
  });

  afterAll(async () => {
    await context.settings.set("files.storage_provider", "local").catch(() => undefined);
    for (const id of fileIds) await context.filesAdmin.remove(id).catch(() => undefined);
    await database.query(`DELETE FROM totalbase.settings WHERE key = ANY($1)`, [KEYS]);
    for (const { key, value } of saved) {
      await database.query(`INSERT INTO totalbase.settings (key, value) VALUES ($1, $2::jsonb)`, [key, JSON.stringify(value)]);
    }
    await context.secrets.delete(secretKey);
    await rm(localPath, { recursive: true, force: true });
    await app.close();
    await database.close();
  });

  it("refuses S3 that isn't configured, then verifies, stores and serves through it - an earlier local file still served", async () => {
    const local = await context.filesAdmin.upload({ content: Buffer.from("on disk"), filename: "files-s3-local.txt", declaredContentType: "text/plain" });
    fileIds.push(local.id);
    expect(local.storage_provider).toBe("local");

    const unconfigured = await verify();
    expect([unconfigured.statusCode, unconfigured.json().errors?.[0]?.code]).toEqual([400, "INVALID_SETTING"]);

    await context.secrets.set(secretKey, "not-the-secret");
    await context.settings.set("s3.endpoint", LIVE!);
    await context.settings.set("s3.region", process.env["TOTALBASE_TEST_S3_REGION"] ?? "us-east-1");
    await context.settings.set("s3.bucket", process.env["TOTALBASE_TEST_S3_BUCKET"] ?? "");
    await context.settings.set("s3.prefix", `test-${uniqueSuffix()}`);
    await context.settings.set("s3.path_style", process.env["TOTALBASE_TEST_S3_PATH_STYLE"] !== "false");
    await context.settings.set("s3.access_key_id", process.env["TOTALBASE_TEST_S3_ACCESS_KEY_ID"] ?? "");
    await context.settings.set("s3.secret_key", secretKey);
    const refused = await verify();
    expect([refused.statusCode, refused.json().errors?.[0]?.code]).toEqual([502, "FILE_STORAGE_ERROR"]);

    // Checked before turning it on; Files can't use it until it is.
    await context.secrets.set(secretKey, process.env["TOTALBASE_TEST_S3_SECRET_ACCESS_KEY"] ?? "");
    expect((await verify()).statusCode).toBe(204);
    await expect(context.settings.set("files.storage_provider", "s3")).rejects.toMatchObject({ code: "INVALID_SETTING" });
    await context.settings.set("s3.enabled", true);
    await context.settings.set("files.storage_provider", "s3");

    const remote = await context.filesAdmin.upload({ content: Buffer.from("in the bucket"), filename: "files-s3-remote.txt", declaredContentType: "text/plain" });
    fileIds.push(remote.id);
    expect(remote.storage_provider).toBe("s3");
    expect((await context.filesAdmin.readContent(remote.id)).content.toString()).toBe("in the bucket");
    expect((await context.filesAdmin.readContent(local.id)).content.toString()).toBe("on disk");

    await context.filesAdmin.updateContent(remote.id, Buffer.from("replaced"));
    expect((await context.filesAdmin.readContent(remote.id)).content.toString()).toBe("replaced");
  });

  it("keeps serving and deleting an S3 file once new uploads go back to the local disk", async () => {
    await context.settings.set("files.storage_provider", "local");
    const remoteId = fileIds[1]!;
    const file = await context.filesAdmin.get(remoteId);
    expect((await context.filesAdmin.readContent(remoteId)).content.toString()).toBe("replaced");

    // Still holding a file there, S3 storage stays on.
    await expect(context.settings.set("s3.enabled", false)).rejects.toMatchObject({ code: "INVALID_SETTING" });

    const s3 = await context.filesStorage.of("s3");
    expect(await s3.exists(file.storage_key)).toBe(true);
    await context.filesAdmin.remove(remoteId);
    expect(await s3.exists(file.storage_key)).toBe(false);
    await context.settings.set("s3.enabled", false);
  });
});
