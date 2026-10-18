import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { Database, loadDatabaseConfigFromEnv } from "@totalbase/database";
import { runMigrations } from "@totalbase/migrations";
import { SettingsService } from "@totalbase/settings";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FilesLocalStorageProvider } from "./local-storage-provider.js";
import { FilesTransformService } from "./transform-service.js";
import { transformCacheKey } from "./transform-params.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/totalbase", import.meta.url));

async function testImage(width = 200, height = 100): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 10, g: 200, b: 10 } } })
    .png()
    .toBuffer();
}

describe("FilesTransformService (integration)", () => {
  let database: Database;
  let settings: SettingsService;
  let basePath: string;
  let transformService: FilesTransformService;

  beforeAll(async () => {
    database = new Database(loadDatabaseConfigFromEnv());
    await runMigrations(database, { migrationsDir: MIGRATIONS_DIR, totalbaseVersion: "0.0.0-test" });
    settings = new SettingsService(database);
    basePath = await mkdtemp(path.join(tmpdir(), "totalbase-files-transform-test-"));
    const storage = new FilesLocalStorageProvider(basePath);
    transformService = new FilesTransformService(settings, async () => storage);
  });

  afterEach(async () => {
    // Reset through the service (not a raw DELETE) so its in-process
    // cache is actually invalidated - the settings it may have set were
    // read through the same cached instance every other test shares.
    await settings.set("files.transforms.enabled", true);
    await settings.set("files.transforms.presets_json", "{}");
  });

  afterAll(async () => {
    await rm(basePath, { recursive: true, force: true });
    await database.close();
  });

  it("returns undefined for a plain content request with no transform params", async () => {
    const source = await testImage();
    let reads = 0;
    const result = await transformService.resolve({
      fileId: "file-1",
      sourceHash: "hash-1",
      mimeType: "image/png",
      query: {},
      readOriginal: async () => {
        reads++;
        return source;
      },
    });
    expect(result).toBeUndefined();
    expect(reads).toBe(0); // never even touches the original when there's nothing to do
  });

  it("transforms on a cache miss, then serves from cache without re-reading the original", async () => {
    const source = await testImage(200, 100);
    let reads = 0;
    const query = { width: "100" };

    const first = await transformService.resolve({
      fileId: "file-cache-1",
      sourceHash: "hash-cache-1",
      mimeType: "image/png",
      query,
      readOriginal: async () => {
        reads++;
        return source;
      },
    });
    expect(first?.contentType).toBe("image/png");
    expect(reads).toBe(1);

    const second = await transformService.resolve({
      fileId: "file-cache-1",
      sourceHash: "hash-cache-1",
      mimeType: "image/png",
      query,
      readOriginal: async () => {
        reads++;
        return source;
      },
    });
    expect(reads).toBe(1); // cache hit - readOriginal not called again
    expect(second?.buffer.equals(first!.buffer)).toBe(true);
  });

  it("rejects transformation query params on a non-image file", async () => {
    await expect(
      transformService.resolve({
        fileId: "file-pdf",
        sourceHash: "hash-pdf",
        mimeType: "application/pdf",
        query: { width: "100" },
        readOriginal: async () => Buffer.from("%PDF-fake"),
      }),
    ).rejects.toMatchObject({ code: "TRANSFORM_NOT_APPLICABLE" });
  });

  it("rejects when transformations are disabled via settings", async () => {
    await settings.set("files.transforms.enabled", false);
    await expect(
      transformService.resolve({
        fileId: "file-disabled",
        sourceHash: "hash-disabled",
        mimeType: "image/png",
        query: { width: "100" },
        readOriginal: async () => testImage(),
      }),
    ).rejects.toMatchObject({ code: "TRANSFORM_DISABLED" });
  });

  it("expands presets from the settings-stored JSON registry", async () => {
    await settings.set(
      "files.transforms.presets_json",
      JSON.stringify({ thumb: { width: 50, height: 50, fit: "cover" } }),
    );
    const source = await testImage(200, 200);
    const result = await transformService.resolve({
      fileId: "file-preset",
      sourceHash: "hash-preset",
      mimeType: "image/png",
      query: { preset: "thumb" },
      readOriginal: async () => source,
    });
    expect(result).toBeDefined();
    const metadata = await sharp(result!.buffer).metadata();
    expect(metadata.width).toBe(50);
    expect(metadata.height).toBe(50);
  });

  it("answers the configured cache lifetime with every derivative", async () => {
    await settings.set("files.transforms.cache_ttl_seconds", 600);
    try {
      const result = await transformService.resolve({
        fileId: "file-ttl",
        sourceHash: "hash-ttl",
        mimeType: "image/png",
        query: { width: "20" },
        readOriginal: () => testImage(),
      });
      expect(result!.cacheTtlSeconds).toBe(600);
    } finally {
      await settings.reset("files.transforms.cache_ttl_seconds");
    }
  });

  it("purges derivatives past the cache lifetime and those of deleted files", async () => {
    const storage = new FilesLocalStorageProvider(basePath);
    const { rows } = await database.query<{ id: string }>(
      `INSERT INTO totalbase.files (name, mime_type, size_bytes, storage_provider, storage_key, checksum)
       VALUES ('derivative-purge.png', 'image/png', 1, 'local', $1, 'hash-live') RETURNING id`,
      [`test-derivative-purge-${Date.now()}`],
    );
    const liveFile = rows[0]!.id;
    const deletedFile = crypto.randomUUID(); // no row: its file was deleted
    try {
      const make = async (fileId: string, width: string) => {
        await transformService.resolve({ fileId, sourceHash: "hash-live", mimeType: "image/png", query: { width }, readOriginal: () => testImage() });
        return transformCacheKey(fileId, "hash-live", { width: Number(width) });
      };
      const fresh = await make(liveFile, "30");
      const stale = await make(liveFile, "31");
      const orphan = await make(deletedFile, "32");
      const old = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      await utimes(path.join(basePath, stale), old, old);

      const result = await transformService.purgeDerivatives(database);
      expect(result.expired).toBe(1);
      expect(result.orphanedFiles).toBeGreaterThanOrEqual(1);
      expect(await storage.exists(fresh)).toBe(true);
      expect(await storage.exists(stale)).toBe(false);
      expect(await storage.exists(orphan)).toBe(false);
    } finally {
      await database.query(`DELETE FROM totalbase.files WHERE id = $1`, [liveFile]);
    }
  });
});
