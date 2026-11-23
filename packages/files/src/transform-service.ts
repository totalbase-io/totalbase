import { FILE_THUMBNAIL_QUERY, UUID_PATTERN } from "@totalbase/shared";
import type { Queryable } from "@totalbase/database";
import { TotalBaseError } from "@totalbase/errors";
import type { SettingsService } from "@totalbase/settings";
import { ConcurrencyLimiter } from "./concurrency-limiter.js";
import { transformImage } from "./image-transform.js";
import { detectMimeType } from "./mime-detection.js";
import type { FilesStorageProvider } from "./storage-provider.js";
import { DERIVATIVES_PREFIX, parseTransformParams, transformCacheKey, type TransformPreset } from "./transform-params.js";

export interface TransformedFile {
  buffer: Buffer;
  contentType: string;
}

export interface DerivativePurgeResult {
  /** Derivatives older than files.transforms.cache_ttl_seconds. */
  expired: number;
  /** Derivative folders of files that no longer exist (or of an unrecognized layout). */
  orphanedFiles: number;
}


/**
 * Orchestrates dynamic image transformations for Files, ported from
 * @totalbase/assets' TransformService: parameter validation/limits, cache
 * lookup, pipeline execution, cache write. Authorization happens before
 * this is ever called - this assumes the caller already has access to the
 * file.
 */
/** New renditions a file may get per hour: far more than a page's sizes, far fewer than a flood of parameter sets. */
export const MAX_NEW_RENDITIONS_PER_HOUR = 64;

export class FilesTransformService {
  private readonly limiter = new ConcurrencyLimiter();
  /** New renditions made per file in the current hour (Administration.md §10.8) - each a sharp run and a stored file. */
  private readonly renditionsMade = new Map<string, { hour: number; count: number }>();

  constructor(
    private readonly settings: SettingsService,
    private readonly storage: () => Promise<FilesStorageProvider>,
  ) {}

  private async presets(): Promise<Record<string, TransformPreset>> {
    const raw = await this.settings.get("files.transforms.presets_json");
    try {
      return JSON.parse(raw) as Record<string, TransformPreset>;
    } catch {
      return {};
    }
  }

  /**
   * Returns undefined when the query carries no transformation parameters
   * at all - the caller should serve the original file content unmodified
   * in that case.
   */
  async resolve(params: {
    fileId: string;
    sourceHash: string;
    mimeType: string;
    query: Record<string, string | undefined>;
    readOriginal: () => Promise<Buffer>;
  }): Promise<TransformedFile | undefined> {
    const [enabled, maxWidth, maxHeight, maxPixels, maxOperations, timeoutMs, maxConcurrent] = await Promise.all([
      this.settings.get("files.transforms.enabled"),
      this.settings.get("files.transforms.max_width"),
      this.settings.get("files.transforms.max_height"),
      this.settings.get("files.transforms.max_pixels"),
      this.settings.get("files.transforms.max_operations"),
      this.settings.get("files.transforms.timeout_ms"),
      this.settings.get("files.transforms.max_concurrent"),
    ]);

    const presets = await this.presets();
    const transformParams = parseTransformParams({
      query: params.query,
      presets,
      maxWidth,
      maxHeight,
      maxPixels,
      maxOperations,
    });
    if (!transformParams) return undefined;

    if (!enabled) {
      throw new TotalBaseError("TRANSFORM_DISABLED", "Image transformations are disabled.");
    }
    if (!params.mimeType.startsWith("image/")) {
      throw new TotalBaseError("TRANSFORM_NOT_APPLICABLE", "Transformation query parameters only apply to image files.");
    }

    const storage = await this.storage();
    const cacheKey = transformCacheKey(params.fileId, params.sourceHash, transformParams);
    if (await storage.exists(cacheKey)) {
      const buffer = await storage.read(cacheKey);
      return { buffer, contentType: sniffContentType(buffer, params.mimeType) };
    }

    return this.limiter.run(maxConcurrent, async () => {
      // Re-check inside the limiter: two concurrent requests for the same
      // derivative could both miss the cache before either finishes.
      if (await storage.exists(cacheKey)) {
        const buffer = await storage.read(cacheKey);
        return { buffer, contentType: sniffContentType(buffer, params.mimeType) };
      }
      this.countRendition(params.fileId);
      const original = await params.readOriginal();
      const result = await transformImage(original, transformParams, timeoutMs);
      await storage.store(cacheKey, result.buffer);
      return { buffer: result.buffer, contentType: result.contentType };
    }, timeoutMs);
  }

  /**
   * Every distinct set of parameters is a new rendition - an image processed, a file stored - and a PUBLIC file's are
   * asked for by anyone: at most MAX_NEW_RENDITIONS_PER_HOUR new ones per file an hour, every one already made still
   * served from the cache. Past it, RATE_LIMIT_EXCEEDED.
   */
  private countRendition(fileId: string): void {
    const hour = Math.floor(Date.now() / 3_600_000);
    const made = this.renditionsMade.get(fileId);
    const count = made && made.hour === hour ? made.count : 0;
    if (count >= MAX_NEW_RENDITIONS_PER_HOUR) {
      throw new TotalBaseError("RATE_LIMIT_EXCEEDED", `This file has had ${MAX_NEW_RENDITIONS_PER_HOUR} new renditions this hour - ask for one already made, or later.`);
    }
    this.renditionsMade.set(fileId, { hour, count: count + 1 });
    if (this.renditionsMade.size > 10_000) {
      for (const [key, value] of this.renditionsMade) if (value.hour !== hour) this.renditionsMade.delete(key);
    }
  }

  /**
   * Makes a stored image's list thumbnail (FILE_THUMBNAIL, Administration.md §10.8) ahead of its first view, so a
   * grid shows it at once. Best-effort, never awaited by a write: transformations off, a file that isn't an image or
   * an image that can't be read is simply left to the first request.
   */
  async warmThumbnail(file: { id: string; checksum: string | null; mime_type: string }, content: Buffer): Promise<void> {
    if (!file.checksum || !file.mime_type.startsWith("image/")) return;
    try {
      await this.resolve({ fileId: file.id, sourceHash: file.checksum, mimeType: file.mime_type, query: FILE_THUMBNAIL_QUERY, readOriginal: async () => content });
    } catch {
      // The first request makes it, as before.
    }
  }

  /**
   * The derivative cache's cleanup (the server's hourly retention job,
   * Administration.md §10.8): removes every derivative older
   * than files.transforms.cache_ttl_seconds - the next request for it
   * regenerates it - and the derivative folder of every file that no
   * longer exists. Storage I/O only, never inside a transaction; `database`
   * is read to know which files still exist.
   */
  async purgeDerivatives(database: Queryable, now = new Date()): Promise<DerivativePurgeResult> {
    const storage = await this.storage();
    const ttlSeconds = await this.settings.get("files.transforms.cache_ttl_seconds");
    const objects = await storage.list(DERIVATIVES_PREFIX);
    const folders = new Set(objects.map((object) => object.key.split("/")[1]!).filter(Boolean));

    const candidates = [...folders].filter((folder) => UUID_PATTERN.test(folder));
    const { rows } = candidates.length === 0
      ? { rows: [] as { id: string }[] }
      : await database.query<{ id: string }>(`SELECT id FROM totalbase.files WHERE id = ANY($1::uuid[])`, [candidates]);
    const live = new Set(rows.map((row) => row.id.toLowerCase()));

    let orphanedFiles = 0;
    for (const folder of folders) {
      if (live.has(folder.toLowerCase())) continue;
      await storage.deletePrefix(`${DERIVATIVES_PREFIX}/${folder}`);
      orphanedFiles++;
    }

    let expired = 0;
    const cutoff = now.getTime() - ttlSeconds * 1000;
    for (const object of objects) {
      const folder = object.key.split("/")[1]!;
      if (!live.has(folder.toLowerCase()) || object.modifiedAt.getTime() >= cutoff) continue;
      await storage.delete(object.key);
      expired++;
    }
    return { expired, orphanedFiles };
  }
}

// The derivative cache stores bytes only, not a content-type sidecar - on
// a cache hit we determine it the same way uploads do (magic-byte
// detection), rather than guessing from the request's transform params,
// which may not even include `format`. Falls back to the original file's
// own mime type only if the derivative's signature isn't one
// mime-detection.ts recognizes (e.g. a re-encoded GIF).
function sniffContentType(buffer: Buffer, fallback: string): string {
  return detectMimeType(buffer) ?? fallback;
}
