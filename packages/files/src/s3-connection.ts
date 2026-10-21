import { randomUUID } from "node:crypto";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { FilesS3StorageProvider } from "./s3-storage-provider.js";
import type { FilesStorageProvider } from "./storage-provider.js";

/**
 * The S3 storage connection - the s3.* settings (Administration.md §7.9):
 * one bucket shared by what stores objects outside the database, each use
 * under its own folder of s3.prefix (Files: `files/`). Built per call, so a
 * settings change applies without a restart.
 */
export class S3Connection {
  constructor(
    private readonly settings: SettingsService,
    /** Decrypts a Settings → Secrets entry - the secret access key. */
    private readonly decryptSecret: (key: string) => Promise<string>,
  ) {}

  /** A provider under `<s3.prefix><folder>/`. Refused while S3 storage is off - unless `whileDisabled`, for Test connection. */
  async provider(folder: string, options: { whileDisabled?: boolean } = {}): Promise<FilesS3StorageProvider> {
    const [enabled, endpoint, region, bucket, prefix, pathStyle, accessKeyId, secretKey] = await Promise.all([
      this.settings.get("s3.enabled"),
      this.settings.get("s3.endpoint"),
      this.settings.get("s3.region"),
      this.settings.get("s3.bucket"),
      this.settings.get("s3.prefix"),
      this.settings.get("s3.path_style"),
      this.settings.get("s3.access_key_id"),
      this.settings.get("s3.secret_key"),
    ]);
    if (!enabled && !options.whileDisabled) {
      throw new TotalBaseError("INVALID_SETTING", "S3 storage is turned off - enable it under Settings › S3 storage.");
    }
    if (!endpoint || !bucket || !accessKeyId || !secretKey) {
      throw new TotalBaseError(
        "INVALID_SETTING",
        "S3 storage is not configured - set its endpoint, bucket, access key ID and secret access key under Settings › S3 storage.",
      );
    }
    const base = prefix && !prefix.endsWith("/") ? `${prefix}/` : prefix;
    return new FilesS3StorageProvider({
      endpoint,
      region,
      bucket,
      prefix: `${base}${folder}/`,
      pathStyle,
      accessKeyId,
      secretAccessKey: await this.decryptSecret(secretKey),
    });
  }

  /**
   * Writes, reads back, finds and deletes one probe object under `verify/` -
   * the admin's Test connection, usable before S3 storage is turned on. A
   * failure is FILE_STORAGE_ERROR with the service's reason, or INVALID_SETTING.
   */
  async verify(): Promise<void> {
    const storage = await this.provider("verify", { whileDisabled: true });
    const key = randomUUID();
    const content = Buffer.from("TotalBase storage check");
    await storage.store(key, content);
    try {
      const read = await storage.read(key);
      if (!read.equals(content)) throw new TotalBaseError("FILE_STORAGE_ERROR", "The content read back differs from what was written.");
      if (!(await storage.exists(key))) throw new TotalBaseError("FILE_STORAGE_ERROR", "The object written is not found.");
    } finally {
      await storage.delete(key).catch(() => undefined);
    }
  }
}
