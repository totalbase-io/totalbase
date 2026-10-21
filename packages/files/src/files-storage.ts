import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { FilesLocalStorageProvider } from "./local-storage-provider.js";
import type { S3Connection } from "./s3-connection.js";
import type { FilesStorageProvider } from "./storage-provider.js";

/** Files' folder in the S3 storage connection's bucket. */
const S3_FOLDER = "files";

/**
 * Files' storage providers (Administration.md §10.2). New content goes to
 * `current()` - files.storage_provider; a file's content is read, replaced and
 * deleted where its row says it is (`of(storage_provider)`), so switching
 * provider leaves earlier files where they were, still served. Built per call:
 * a settings change applies without a restart.
 */
export class FilesStorage {
  constructor(
    private readonly settings: SettingsService,
    private readonly s3?: S3Connection,
    private readonly override?: FilesStorageProvider,
  ) {}

  /** Always this one provider, whatever the settings - for tests. */
  static fixed(provider: FilesStorageProvider): FilesStorage {
    return new FilesStorage(undefined as never, undefined, provider);
  }

  async current(): Promise<FilesStorageProvider> {
    if (this.override) return this.override;
    return this.of(await this.settings.get("files.storage_provider"));
  }

  async of(name: string): Promise<FilesStorageProvider> {
    if (this.override) return this.override;
    if (name === "local") return new FilesLocalStorageProvider(await this.settings.get("files.storage_local_path"));
    if (name === "s3" && this.s3) return this.s3.provider(S3_FOLDER);
    throw new TotalBaseError("INVALID_SETTING", `Unsupported files storage provider: ${name}`);
  }
}
