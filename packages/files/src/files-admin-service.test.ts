import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesAdminService } from "./files-admin-service.js";
import { FilesLocalStorageProvider } from "./local-storage-provider.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

async function pngBuffer(width = 20, height = 10): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();
}

describe("FilesAdminService (integration)", () => {
  let database: Database;
  let service: FilesAdminService;
  let basePath: string;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });

    basePath = await mkdtemp(path.join(tmpdir(), "totalbase-files-test-"));
    service = new FilesAdminService(database, new SettingsService(database), new FilesLocalStorageProvider(basePath));
  });

  afterEach(async () => {
    await database.query(`DELETE FROM totalbase.files WHERE name LIKE 'pkg-test-%'`);
  });

  afterAll(async () => {
    await rm(basePath, { recursive: true, force: true });
    await database.close();
  });

  it("detects the real MIME type by signature rather than trusting the declared Content-Type", async () => {
    const png = await pngBuffer();
    const file = await service.upload({
      content: png,
      filename: "pkg-test-logo.png",
      declaredContentType: "application/octet-stream", // deliberately wrong - detection must win
    });
    expect(file.mime_type).toBe("image/png");
  });

  it("captures width/height for an uploaded image and leaves them null for a non-image", async () => {
    const png = await pngBuffer(321, 123);
    const image = await service.upload({ content: png, filename: "pkg-test-dims.png" });
    expect(image.width).toBe(321);
    expect(image.height).toBe(123);

    const text = await service.upload({
      content: Buffer.from("hello"),
      filename: "pkg-test-note.txt",
      declaredContentType: "text/plain",
    });
    expect(text.width).toBeNull();
    expect(text.height).toBeNull();
  });

  it("refreshes width/height when content is replaced via updateContent", async () => {
    const initial = await service.upload({ content: await pngBuffer(100, 50), filename: "pkg-test-replace.png" });
    expect(initial.width).toBe(100);

    const updated = await service.updateContent(initial.id, await pngBuffer(64, 64));
    expect(updated.width).toBe(64);
    expect(updated.height).toBe(64);
  });
});
